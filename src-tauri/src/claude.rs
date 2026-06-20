//! Claude Code bridge: drive the `claude` CLI as a long-lived stream-json sidecar.
//!
//! Validated empirically against claude 2.1.183: one process started with
//! `claude --print --input-format stream-json --output-format stream-json
//! --verbose` reads newline-delimited user messages from stdin and KEEPS the
//! conversation context across messages (multi-turn confirmed). It emits NDJSON
//! events on stdout:
//!   - {"type":"system","subtype":"init","session_id":...}
//!   - {"type":"rate_limit_event",...}                        (ignored)
//!   - {"type":"assistant","message":{"content":[{"type":"text","text":...},
//!                                                {"type":"tool_use",...}]}}
//!   - {"type":"result","subtype":"success","is_error":false,"result":<final>}
//!
//! Contract to the webview: `claude_submit` writes one user message and (only on a
//! successful write) emits `claude://thinking{active:true}`; each `result` emits
//! `claude://turn-end` with the final reply (spoken with mood by the frontend);
//! the child dying emits `claude://ready{active:false}`. A monotonic generation
//! makes a superseded reader (after restart/stop) inert so it cannot emit onto a
//! newer session.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex as StdMutex;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex as AsyncMutex;

#[derive(Default)]
pub struct ClaudeState {
    stdin: AsyncMutex<Option<ChildStdin>>,
    child: StdMutex<Option<Child>>,
    /// Bumped on every start/stop; a reader task only emits while it matches, so a
    /// superseded session's late events can never touch a newer one.
    generation: AtomicU64,
}

#[derive(Clone, Serialize)]
struct Active {
    active: bool,
}

#[derive(Clone, Serialize)]
struct Ready {
    active: bool,
    cwd: String,
}

#[derive(Clone, Serialize)]
struct TurnEnd {
    text: String,
    is_error: bool,
}

const CLAUDE_ARGS: &[&str] = &[
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    // SECURITY (MVP): headless mode must never block on a permission dialog, so the
    // child runs with full tool autonomy in the chosen project dir. The user is
    // delegating their own machine by voice and is warned in the UI; the dir is
    // required (no silent home default). Phase 4 replaces this with an allowlist +
    // a spoken/visible confirm step for mutating tools.
    "--permission-mode",
    "bypassPermissions",
];

/// Start (or restart) the Claude sidecar with `dir` as its working directory (a
/// project dir is REQUIRED - no silent home-wide default with bypassPermissions).
#[tauri::command]
pub async fn claude_start(app: AppHandle, dir: Option<String>) -> Result<(), String> {
    // Tear down any prior session first (also bumps the generation).
    let _ = claude_stop(app.clone()).await;

    let cwd = match dir {
        Some(d) if !d.trim().is_empty() => PathBuf::from(d.trim()),
        _ => return Err("a project directory is required".into()),
    };
    if !cwd.is_dir() {
        return Err(format!("not a directory: {}", cwd.display()));
    }

    let fallback = app
        .path()
        .home_dir()
        .ok()
        .map(|h| h.join(".local").join("bin").join("claude.exe"));
    let mut child = spawn_claude(&cwd, fallback.as_deref())?;

    let stdin = child.stdin.take().ok_or("claude stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("claude stdout unavailable")?;
    let stderr = child.stderr.take();

    let state = app.state::<ClaudeState>();
    // This session's generation; the reader uses it to ignore superseded events.
    let my_gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    *state.stdin.lock().await = Some(stdin);
    *state
        .child
        .lock()
        .map_err(|_| "claude child lock poisoned")? = Some(child);

    // Drain stderr to the log so a crash/auth failure is diagnosable (it would
    // otherwise be silent).
    if let Some(stderr) = stderr {
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log::warn!("[claude stderr] {line}");
            }
        });
    }

    // Read NDJSON events off stdout and translate them to claude://* events.
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if !is_current(&app2, my_gen) {
                return; // superseded by a restart/stop; stay silent
            }
            handle_event(&app2, &line);
        }
        // stdout closed => the child ended. Report the disconnect only if we are
        // still the current session.
        if is_current(&app2, my_gen) {
            *app2.state::<ClaudeState>().stdin.lock().await = None;
            let _ = app2.emit("claude://thinking", Active { active: false });
            let _ = app2.emit(
                "claude://turn-end",
                TurnEnd { text: "Claude session ended.".into(), is_error: true },
            );
            let _ = app2.emit("claude://ready", Ready { active: false, cwd: String::new() });
        }
    });

    let _ = app.emit(
        "claude://ready",
        Ready { active: true, cwd: cwd.display().to_string() },
    );
    Ok(())
}

/// Send one user message into the live session. Flags Thinking ONLY after the
/// write succeeds, so a dead/never-started session returns Err without stranding
/// the avatar in Thinking.
#[tauri::command]
pub async fn claude_submit(app: AppHandle, text: String) -> Result<(), String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    let msg = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": trimmed },
    });
    let line = format!("{msg}\n");

    {
        let state = app.state::<ClaudeState>();
        let mut guard = state.stdin.lock().await;
        let stdin = guard.as_mut().ok_or("claude session not started")?;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("claude write: {e}"))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("claude flush: {e}"))?;
    }
    let _ = app.emit("claude://thinking", Active { active: true });
    Ok(())
}

/// End the session: invalidate the reader, close stdin (EOF), and kill the child.
#[tauri::command]
pub async fn claude_stop(app: AppHandle) -> Result<(), String> {
    let state = app.state::<ClaudeState>();
    state.generation.fetch_add(1, Ordering::SeqCst); // invalidate the current reader
    *state.stdin.lock().await = None; // closing stdin sends EOF
    if let Some(mut child) = state
        .child
        .lock()
        .map_err(|_| "claude child lock poisoned")?
        .take()
    {
        let _ = child.start_kill();
    }
    let _ = app.emit("claude://thinking", Active { active: false });
    Ok(())
}

fn is_current(app: &AppHandle, my_gen: u64) -> bool {
    app.state::<ClaudeState>().generation.load(Ordering::SeqCst) == my_gen
}

/// Spawn `claude` from PATH, falling back to the native-installer location so a
/// GUI launch with a thinner PATH still finds it.
fn spawn_claude(cwd: &Path, fallback: Option<&Path>) -> Result<Child, String> {
    let build = |program: &OsStr| {
        let mut c = Command::new(program);
        c.args(CLAUDE_ARGS)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        c
    };
    match build(OsStr::new("claude")).spawn() {
        Ok(child) => Ok(child),
        Err(first) => {
            if let Some(exe) = fallback {
                if exe.exists() {
                    return build(exe.as_os_str())
                        .spawn()
                        .map_err(|e| format!("spawn claude ({}): {e}", exe.display()));
                }
            }
            Err(format!("spawn claude (is it on PATH?): {first}"))
        }
    }
}

/// Tolerant parse of one stdout NDJSON line. Only `result` drives the UI; every
/// other (and unknown) event keeps the current Thinking state. On a normal reply
/// we do NOT emit a standalone thinking:false: turn-end -> speak() drives the
/// Thinking->Speaking handoff with no intervening idle frame.
fn handle_event(app: &AppHandle, line: &str) {
    let line = line.trim();
    if line.is_empty() {
        return;
    }
    let v: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return,
    };
    if v.get("type").and_then(Value::as_str) == Some("result") {
        let text = v
            .get("result")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let is_error = v.get("is_error").and_then(Value::as_bool).unwrap_or(false)
            || v.get("subtype").and_then(Value::as_str) == Some("error");
        if text.trim().is_empty() || is_error {
            // No spoken reply will take over Thinking; clear it explicitly.
            let _ = app.emit("claude://thinking", Active { active: false });
        }
        let _ = app.emit("claude://turn-end", TurnEnd { text, is_error });
    }
}
