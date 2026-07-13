//! Spawnable terminal sessions: each one a REAL interactive shell on a Windows
//! pseudo-console (ConPTY, via `portable-pty`). This is the user's escape-hatch
//! shell - for the things Claude can't or shouldn't do (sudo, REPLs, interactive
//! tools, poking around) - driven only by the human and kept separate from Claude's
//! sessions.
//!
//! The frontend creates terminals via `terminal_spawn`, writes raw keystrokes via
//! `terminal_write`, resizes via `terminal_resize`, and receives RAW output bytes
//! (base64, batched) through `terminal://{id}/output` events (xterm.js renders
//! them, with real echo and ANSI from the shell itself - no faked prompt). Process
//! exit emits `terminal://{id}/exit`. A per-session generation prevents a dead
//! reader from emitting onto a recycled id.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine as _;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

// PTY output batching: a fast-scrolling shell (a build, `type` on a big file)
// produces a burst of small reads, and emitting each one was a separate IPC event
// plus a separate xterm.write - the dominant cost of terminal scroll. Chunks that
// arrive within this window of the first are coalesced into one event, capped so a
// sustained firehose still flushes promptly. 8 ms stays under a 120 Hz frame, so
// interactive echo latency is imperceptible.
const BATCH_WINDOW: Duration = Duration::from_millis(8);
const BATCH_CAP_BYTES: usize = 64 * 1024;

struct TerminalSession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    generation: u64,
}

#[derive(Default)]
pub struct TerminalState {
    // A std Mutex (not async): every op is a quick blocking PTY call, and the std
    // reader thread needs to check liveness without a tokio runtime.
    sessions: Mutex<HashMap<String, TerminalSession>>,
}

#[derive(Clone, Serialize)]
struct TermOutput {
    id: String,
    /// Raw PTY bytes, base64-encoded (a JSON `Vec<u8>` writes every byte as a
    /// decimal number, ~4x the wire size at scroll volumes).
    data: String,
}

#[derive(Clone, Serialize)]
struct TermExit {
    id: String,
}

#[tauri::command]
pub async fn terminal_spawn(
    app: AppHandle,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<String, String> {
    let dir = cwd.unwrap_or_else(|| std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\".into()));
    if !std::path::Path::new(&dir).is_dir() {
        return Err(format!("not a directory: {dir}"));
    }

    let size = PtySize {
        rows: rows.unwrap_or(24),
        cols: cols.unwrap_or(80),
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|e| format!("openpty: {e}"))?;

    let mut cmd = CommandBuilder::new("powershell.exe");
    cmd.cwd(&dir);
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn shell: {e}"))?;
    drop(pair.slave); // the child holds the slave; we only keep the master

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("pty reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("pty writer: {e}"))?;

    let id = format!("term-{}", NEXT_ID.fetch_add(1, Ordering::SeqCst));
    let generation = 1u64;
    {
        let state = app.state::<TerminalState>();
        let mut sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
        sessions.insert(
            id.clone(),
            TerminalSession { writer, master: pair.master, child, generation },
        );
    }

    // Reader thread: blocking PTY reads, forwarded chunk-by-chunk to the emitter.
    // Dropping the sender on EOF/error is the exit signal.
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => return, // EOF: the shell exited (or the PTY died)
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        return; // emitter gone (never happens before channel close)
                    }
                }
            }
        }
    });

    // Emitter thread: coalesce chunk bursts into one event per BATCH_WINDOW (see
    // the constants above), base64-encode, and emit. Owns the exit notification.
    let app2 = app.clone();
    let id2 = id.clone();
    std::thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let batch = drain_batch(&rx, first, BATCH_WINDOW, BATCH_CAP_BYTES);
            if !is_session_alive(&app2, &id2, generation) {
                return; // superseded/killed: stay silent
            }
            let _ = app2.emit(
                &format!("terminal://{}/output", id2),
                TermOutput {
                    id: id2.clone(),
                    data: base64::engine::general_purpose::STANDARD.encode(&batch),
                },
            );
        }
        // Channel closed: the reader saw EOF. Announce the exit and drop the session.
        if is_session_alive(&app2, &id2, generation) {
            let _ = app2.emit(&format!("terminal://{}/exit", id2), TermExit { id: id2.clone() });
            let state = app2.state::<TerminalState>();
            let mut sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
            sessions.remove(&id2);
        }
    });

    Ok(id)
}

#[tauri::command]
pub async fn terminal_write(app: AppHandle, id: String, data: String) -> Result<(), String> {
    let state = app.state::<TerminalState>();
    let mut sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
    let session = sessions.get_mut(&id).ok_or("terminal session not found")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("terminal write: {e}"))?;
    session.writer.flush().map_err(|e| format!("terminal flush: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn terminal_kill(app: AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<TerminalState>();
    let mut sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(mut session) = sessions.remove(&id) {
        session.generation = 0; // invalidate the reader
        let _ = session.child.kill();
    }
    Ok(())
}

#[tauri::command]
pub async fn terminal_resize(app: AppHandle, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let state = app.state::<TerminalState>();
    let sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(session) = sessions.get(&id) {
        session
            .master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("terminal resize: {e}"))?;
    }
    Ok(())
}

fn is_session_alive(app: &AppHandle, id: &str, gen: u64) -> bool {
    let state = app.state::<TerminalState>();
    let sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
    sessions.get(id).is_some_and(|s| s.generation == gen)
}

/// Append chunks that arrive within `window` of the first onto `first`, stopping
/// early once the batch reaches `cap` bytes (a soft cap: the chunk that crosses it
/// is kept, never split). A closed channel just flushes what accumulated; the
/// caller's next `recv()` sees the disconnect. Pure aside from the clock;
/// unit-tested.
fn drain_batch(rx: &Receiver<Vec<u8>>, first: Vec<u8>, window: Duration, cap: usize) -> Vec<u8> {
    let mut batch = first;
    let deadline = Instant::now() + window;
    while batch.len() < cap {
        let Some(left) = deadline.checked_duration_since(Instant::now()) else {
            break; // window elapsed
        };
        match rx.recv_timeout(left) {
            Ok(chunk) => batch.extend_from_slice(&chunk),
            Err(_) => break, // timeout or disconnected: flush what we have
        }
    }
    batch
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn drain_batch_coalesces_queued_chunks_into_one() {
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        tx.send(vec![2u8; 10]).unwrap();
        tx.send(vec![3u8; 10]).unwrap();
        drop(tx); // then the channel closes: flush, don't hang
        let batch = drain_batch(&rx, vec![1u8; 10], Duration::from_millis(50), 1024);
        assert_eq!(batch.len(), 30);
        assert_eq!(&batch[..10], &[1u8; 10]);
        assert_eq!(&batch[20..], &[3u8; 10]);
    }

    #[test]
    fn drain_batch_stops_at_the_cap_and_leaves_the_rest_queued() {
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        tx.send(vec![0u8; 10]).unwrap();
        tx.send(vec![0u8; 10]).unwrap();
        let batch = drain_batch(&rx, vec![0u8; 10], Duration::from_millis(50), 15);
        // The soft cap keeps the crossing chunk whole (20 >= 15) and stops there.
        assert_eq!(batch.len(), 20);
        assert_eq!(rx.try_recv().expect("one chunk left for the next batch").len(), 10);
    }

    #[test]
    fn drain_batch_returns_the_first_chunk_alone_on_a_quiet_channel() {
        let (_tx, rx) = mpsc::channel::<Vec<u8>>();
        let started = Instant::now();
        let batch = drain_batch(&rx, vec![9u8; 5], Duration::from_millis(10), 1024);
        assert_eq!(batch, vec![9u8; 5]);
        assert!(started.elapsed() < Duration::from_secs(2)); // waited ~the window, not forever
    }
}
