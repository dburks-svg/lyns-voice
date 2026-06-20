//! Spawnable terminal sessions: each one a PowerShell child with piped I/O.
//!
//! The frontend creates terminals via `terminal_spawn`, writes keystrokes via
//! `terminal_write`, and receives output through `terminal://{id}/output` events.
//! Process exit emits `terminal://{id}/exit`. A generation counter per session
//! prevents a killed reader from emitting onto a recycled ID.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex as AsyncMutex;

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

struct TerminalSession {
    stdin: ChildStdin,
    _child: Child,
    generation: u64,
}

#[derive(Default)]
pub struct TerminalState {
    sessions: AsyncMutex<HashMap<String, TerminalSession>>,
}

#[derive(Clone, Serialize)]
struct TermOutput {
    id: String,
    data: String,
}

#[derive(Clone, Serialize)]
struct TermExit {
    id: String,
    code: Option<i32>,
}

fn spawn_shell(cwd: &str) -> Result<Child, String> {
    let mut c = Command::new("cmd.exe");
    c.args(["/Q"]); // /Q disables cmd's own echo; we handle echo on the frontend
    c.current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    c.creation_flags(0x08000000); // CREATE_NO_WINDOW
    c.spawn().map_err(|e| format!("spawn cmd: {e}"))
}

#[tauri::command]
pub async fn terminal_spawn(app: AppHandle, cwd: Option<String>) -> Result<String, String> {
    let dir = cwd.unwrap_or_else(|| {
        std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\".into())
    });
    if !std::path::Path::new(&dir).is_dir() {
        return Err(format!("not a directory: {dir}"));
    }

    let id = format!("term-{}", NEXT_ID.fetch_add(1, Ordering::SeqCst));
    let mut child = spawn_shell(&dir)?;

    let stdin = child.stdin.take().ok_or("terminal stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("terminal stdout unavailable")?;
    let stderr = child.stderr.take();

    let generation = 1u64;

    {
        let state = app.state::<TerminalState>();
        state.sessions.lock().await.insert(
            id.clone(),
            TerminalSession {
                stdin,
                _child: child,
                generation,
            },
        );
    }

    let id2 = id.clone();

    // stdout reader
    let app2 = app.clone();
    let id3 = id.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if !is_session_alive(&app2, &id3, generation).await {
                return;
            }
            let _ = app2.emit(
                &format!("terminal://{}/output", id3),
                TermOutput { id: id3.clone(), data: line },
            );
        }
        if is_session_alive(&app2, &id3, generation).await {
            let _ = app2.emit(
                &format!("terminal://{}/exit", id3),
                TermExit { id: id3.clone(), code: None },
            );
            app2.state::<TerminalState>().sessions.lock().await.remove(&id3);
        }
    });

    // stderr reader (merge into same output stream)
    if let Some(stderr) = stderr {
        let app3 = app.clone();
        let id4 = id.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if !is_session_alive(&app3, &id4, generation).await {
                    return;
                }
                let _ = app3.emit(
                    &format!("terminal://{}/output", id4),
                    TermOutput { id: id4.clone(), data: line },
                );
            }
        });
    }

    Ok(id2)
}

#[tauri::command]
pub async fn terminal_write(app: AppHandle, id: String, data: String) -> Result<(), String> {
    let state = app.state::<TerminalState>();
    let mut sessions = state.sessions.lock().await;
    let session = sessions.get_mut(&id).ok_or("terminal session not found")?;
    session
        .stdin
        .write_all(data.as_bytes())
        .await
        .map_err(|e| format!("terminal write: {e}"))?;
    session
        .stdin
        .flush()
        .await
        .map_err(|e| format!("terminal flush: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn terminal_kill(app: AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<TerminalState>();
    let mut sessions = state.sessions.lock().await;
    if let Some(mut session) = sessions.remove(&id) {
        session.generation = 0; // invalidate readers
        let _ = session.stdin.shutdown().await;
        let _ = session._child.start_kill();
    }
    Ok(())
}

#[tauri::command]
pub async fn terminal_resize(
    _app: AppHandle,
    _id: String,
    _cols: u16,
    _rows: u16,
) -> Result<(), String> {
    // No-op for now; full PTY/conpty support will enable real resize.
    Ok(())
}

async fn is_session_alive(app: &AppHandle, id: &str, gen: u64) -> bool {
    let state = app.state::<TerminalState>();
    let sessions = state.sessions.lock().await;
    sessions.get(id).map_or(false, |s| s.generation == gen)
}
