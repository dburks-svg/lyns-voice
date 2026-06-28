//! Spawnable terminal sessions: each one a REAL interactive shell on a Windows
//! pseudo-console (ConPTY, via `portable-pty`). This is the user's escape-hatch
//! shell - for the things Claude can't or shouldn't do (sudo, REPLs, interactive
//! tools, poking around) - driven only by the human and kept separate from Claude's
//! sessions.
//!
//! The frontend creates terminals via `terminal_spawn`, writes raw keystrokes via
//! `terminal_write`, resizes via `terminal_resize`, and receives RAW output bytes
//! through `terminal://{id}/output` events (xterm.js renders them, with real echo
//! and ANSI from the shell itself - no faked prompt). Process exit emits
//! `terminal://{id}/exit`. A per-session generation prevents a dead reader from
//! emitting onto a recycled id.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

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
    data: Vec<u8>,
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

    // Reader thread: stream raw PTY output to the webview (xterm renders the bytes).
    let app2 = app.clone();
    let id2 = id.clone();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF: the shell exited
                Ok(n) => {
                    if !is_session_alive(&app2, &id2, generation) {
                        return; // superseded/killed: stay silent
                    }
                    let _ = app2.emit(
                        &format!("terminal://{}/output", id2),
                        TermOutput { id: id2.clone(), data: buf[..n].to_vec() },
                    );
                }
                Err(_) => break,
            }
        }
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
