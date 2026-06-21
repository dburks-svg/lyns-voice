//! Claude Code bridge: drive one or more `claude` CLI stream-json sidecars.
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
//! Each session is keyed by a string id (the same per-id pattern as `terminal.rs`),
//! so the conductor can run several in parallel. Events are namespaced
//! `claude://{id}/<kind>` (`thinking`, `turn-end`, `activity`, `diff`, `usage`,
//! `ready`). `claude_start` returns the new id; `claude_submit`/`claude_stop`/
//! `claude_cancel` take it. A per-session monotonic generation makes a superseded
//! reader (after a restart/cancel) inert so it cannot emit onto a newer session.
//!
//! Phase 5 keeps a single active session (the frontend tears the old one down
//! before starting a new one); the map is the seam the multi-session conductor
//! plugs into in Phase 8.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex as AsyncMutex;

/// Source of unique session ids (the webview never has to invent one).
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
/// Globally monotonic generation stamp. Each launch takes the next value; a
/// reader only emits while its session still carries that exact stamp, so a
/// restarted/cancelled session's late events can never touch a newer one.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// One live Claude Code session: the `claude` child + its stdin, plus the
/// generation its reader was launched with and the cwd (kept so `claude_cancel`
/// can relaunch in place).
struct ClaudeSession {
    stdin: ChildStdin,
    child: Child,
    generation: u64,
    cwd: String,
}

#[derive(Default)]
pub struct ClaudeState {
    sessions: AsyncMutex<HashMap<String, ClaudeSession>>,
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

/// A tool the assistant invoked this turn (drives the HUD activity feed).
#[derive(Clone, Serialize)]
struct Activity {
    name: String,
    target: String,
}

/// File diff from an Edit or Write tool (drives the diff viewer panel).
#[derive(Clone, Serialize)]
struct ToolDiff {
    tool: String,
    file_path: String,
    old_string: Option<String>,
    new_string: Option<String>,
    content: Option<String>,
}

/// Per-turn token usage + cost from the `result` event (drives the HUD telemetry).
#[derive(Clone, Serialize)]
struct Usage {
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
    cost_usd: f64,
}

const BASE_ARGS: &[&str] = &[
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    // SECURITY (Phase 4): `dontAsk` is non-interactive (it never blocks on a
    // permission dialog, so the headless sidecar cannot hang) AND it DENIES any
    // tool not on `--allowedTools` below, replacing the old blanket
    // `bypassPermissions` ("bypass ALL checks"). The allowlist is now the explicit,
    // auditable capability surface; the activity HUD shows every tool as it runs.
    // NOTE: this is not an OS sandbox - the required project dir is the intended
    // blast radius, and `claude` still runs real edits/commands within the
    // allowlist. A true per-tool interactive confirm awaits Claude Code's
    // (currently undocumented) `--permission-prompt-tool` protocol.
    "--permission-mode",
    "dontAsk",
];

/// Tools Claude may use unprompted. `dontAsk` auto-DENIES anything not listed
/// (no hang), so this slice is the app's entire capability surface. Tune here.
const ALLOWED_TOOLS: &[&str] = &[
    // Read-only / inspection
    "Read",
    "Grep",
    "Glob",
    "LS",
    "NotebookRead",
    "WebFetch",
    "WebSearch",
    // Mutating (the point of a voice coding assistant) - visible in the HUD feed
    "Edit",
    "MultiEdit",
    "Write",
    "NotebookEdit",
    "Bash",
    // Orchestration
    "Task",
    "TodoWrite",
];

/// Catastrophic shell patterns denied even though `Bash` is allowed (deny wins
/// over allow). Best-effort defense-in-depth against system-destroying commands;
/// NOT a substitute for the project-dir blast radius (it cannot catch every
/// variant, e.g. absolute paths or aliases).
const DISALLOWED_TOOLS: &[&str] = &[
    "Bash(shutdown:*)",
    "Bash(reboot:*)",
    "Bash(mkfs:*)",
    "Bash(diskpart:*)",
    "Bash(format:*)",
    "Bash(dd:*)",
    "Bash(rm:-rf /*)",
];

/// Start a new Claude sidecar with `dir` as its working directory (a project dir
/// is REQUIRED - no silent home-wide default with bypassPermissions). Returns the
/// new session id; the webview subscribes to `claude://{id}/*` with it.
#[tauri::command]
pub async fn claude_start(app: AppHandle, dir: Option<String>) -> Result<String, String> {
    let cwd = match dir {
        Some(d) if !d.trim().is_empty() => PathBuf::from(d.trim()),
        _ => return Err("a project directory is required".into()),
    };
    if !cwd.is_dir() {
        return Err(format!("not a directory: {}", cwd.display()));
    }
    let id = format!("claude-{}", NEXT_ID.fetch_add(1, Ordering::SeqCst));
    launch_session(&app, id.clone(), cwd).await?;
    Ok(id)
}

/// Send one user message into a live session. Flags Thinking ONLY after the write
/// succeeds, so a dead/never-started session returns Err without stranding the
/// avatar in Thinking.
#[tauri::command]
pub async fn claude_submit(app: AppHandle, id: String, text: String) -> Result<(), String> {
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
        let mut sessions = state.sessions.lock().await;
        let session = sessions.get_mut(&id).ok_or("claude session not started")?;
        session
            .stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("claude write: {e}"))?;
        session
            .stdin
            .flush()
            .await
            .map_err(|e| format!("claude flush: {e}"))?;
    }
    let _ = app.emit(&format!("claude://{id}/thinking"), Active { active: true });
    Ok(())
}

/// Cancel the in-flight turn without removing the session from the UI: kill the
/// current child (its reader goes inert via the generation bump in `launch_session`)
/// and relaunch a fresh `claude` in the same cwd under the SAME id. The turn is
/// truly abandoned; conversation context resets. This is the deterministic fallback
/// the barge-in / Escape path needs in Phase 7; if a soft stream-json interrupt that
/// preserves context proves available there, it can replace the relaunch.
#[tauri::command]
pub async fn claude_cancel(app: AppHandle, id: String) -> Result<(), String> {
    let cwd = {
        let state = app.state::<ClaudeState>();
        let mut sessions = state.sessions.lock().await;
        match sessions.remove(&id) {
            Some(mut s) => {
                s.generation = 0; // belt-and-suspenders: also removed from the map
                let _ = s.child.start_kill();
                PathBuf::from(s.cwd)
            }
            None => return Err("claude session not started".into()),
        }
    };
    let _ = app.emit(&format!("claude://{id}/thinking"), Active { active: false });
    launch_session(&app, id, cwd).await
}

/// End a session (`id`), or every session when `id` is None (used on dispose):
/// invalidate the reader, close stdin (EOF), and kill the child.
#[tauri::command]
pub async fn claude_stop(app: AppHandle, id: Option<String>) -> Result<(), String> {
    let state = app.state::<ClaudeState>();
    let mut sessions = state.sessions.lock().await;
    let ids: Vec<String> = match id {
        Some(id) => vec![id],
        None => sessions.keys().cloned().collect(),
    };
    for id in ids {
        if let Some(mut session) = sessions.remove(&id) {
            session.generation = 0; // invalidate the reader (removal already does)
            let _ = session.stdin.shutdown().await; // EOF
            let _ = session.child.start_kill();
            let _ = app.emit(&format!("claude://{id}/thinking"), Active { active: false });
        }
    }
    Ok(())
}

/// Spawn a `claude` child in `cwd`, register it under `id`, and start its stdout
/// reader. Shared by `claude_start` (new id) and `claude_cancel` (same id).
async fn launch_session(app: &AppHandle, id: String, cwd: PathBuf) -> Result<(), String> {
    let fallback = app
        .path()
        .home_dir()
        .ok()
        .map(|h| h.join(".local").join("bin").join("claude.exe"));
    let mut child = spawn_claude(&cwd, fallback.as_deref())?;

    let stdin = child.stdin.take().ok_or("claude stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("claude stdout unavailable")?;
    let stderr = child.stderr.take();

    // This session's generation; the reader uses it to ignore superseded events.
    let my_gen = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let cwd_str = cwd.display().to_string();
    {
        let state = app.state::<ClaudeState>();
        state.sessions.lock().await.insert(
            id.clone(),
            ClaudeSession {
                stdin,
                child,
                generation: my_gen,
                cwd: cwd_str.clone(),
            },
        );
    }

    // Drain stderr to the log so a crash/auth failure is diagnosable (it would
    // otherwise be silent).
    if let Some(stderr) = stderr {
        let id_err = id.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log::warn!("[claude {id_err} stderr] {line}");
            }
        });
    }

    // Read NDJSON events off stdout and translate them to claude://{id}/* events.
    let app2 = app.clone();
    let id2 = id.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if !is_current(&app2, &id2, my_gen).await {
                return; // superseded by a restart/cancel/stop; stay silent
            }
            handle_event(&app2, &id2, &line);
        }
        // stdout closed => the child ended. Report the disconnect only if we are
        // still the current session, and remove ourselves from the map. Reap the
        // child to log a crash (its exit status) vs a clean exit, and defensively
        // kill it in the rare case stdout closed while the process is still alive.
        if is_current(&app2, &id2, my_gen).await {
            if let Some(mut session) =
                app2.state::<ClaudeState>().sessions.lock().await.remove(&id2)
            {
                match session.child.try_wait() {
                    Ok(Some(status)) => log::warn!("[claude {id2}] sidecar exited: {status}"),
                    Ok(None) => {
                        log::warn!("[claude {id2}] stdout closed but sidecar still alive; killing")
                    }
                    Err(e) => log::warn!("[claude {id2}] could not reap sidecar: {e}"),
                }
                let _ = session.child.start_kill();
            }
            let _ = app2.emit(&format!("claude://{id2}/thinking"), Active { active: false });
            let _ = app2.emit(
                &format!("claude://{id2}/turn-end"),
                TurnEnd { text: "Claude session ended.".into(), is_error: true },
            );
            let _ = app2.emit(
                &format!("claude://{id2}/ready"),
                Ready { active: false, cwd: String::new() },
            );
        }
    });

    let _ = app.emit(
        &format!("claude://{id}/ready"),
        Ready { active: true, cwd: cwd_str },
    );
    Ok(())
}

/// True while the session `id` still exists and carries the `my_gen` stamp.
async fn is_current(app: &AppHandle, id: &str, my_gen: u64) -> bool {
    let state = app.state::<ClaudeState>();
    let sessions = state.sessions.lock().await;
    sessions.get(id).map_or(false, |s| s.generation == my_gen)
}

/// Spawn `claude` from PATH, falling back to the native-installer location so a
/// GUI launch with a thinner PATH still finds it.
fn spawn_claude(cwd: &Path, fallback: Option<&Path>) -> Result<Child, String> {
    let build = |program: &OsStr| {
        let mut c = Command::new(program);
        c.args(BASE_ARGS);
        // `--allowedTools <tools...>` / `--disallowedTools <tools...>` are variadic;
        // each value is a separate argv entry (no shell, so the parens/globs in the
        // patterns are passed literally to claude, not expanded by a shell).
        c.arg("--allowedTools").args(ALLOWED_TOOLS);
        c.arg("--disallowedTools").args(DISALLOWED_TOOLS);
        c.current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        c.creation_flags(0x08000000); // CREATE_NO_WINDOW
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

/// Tolerant parse of one stdout NDJSON line for session `id`. `result` drives the
/// four-state UI (turn-end) plus the telemetry (usage); `assistant` feeds the
/// activity HUD from its tool_use entries. Unknown events keep the current Thinking
/// state. On a normal reply we do NOT emit a standalone thinking:false: turn-end ->
/// speak() drives the Thinking->Speaking handoff with no intervening idle frame.
fn handle_event(app: &AppHandle, id: &str, line: &str) {
    let line = line.trim();
    if line.is_empty() {
        return;
    }
    let v: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return,
    };
    match v.get("type").and_then(Value::as_str) {
        Some("assistant") => emit_tool_activity(app, id, &v),
        Some("result") => {
            emit_usage(app, id, &v);
            let text = v
                .get("result")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let is_error = v.get("is_error").and_then(Value::as_bool).unwrap_or(false)
                || v.get("subtype").and_then(Value::as_str) == Some("error");
            if text.trim().is_empty() || is_error {
                // No spoken reply will take over Thinking; clear it explicitly.
                let _ = app.emit(&format!("claude://{id}/thinking"), Active { active: false });
            }
            let _ = app.emit(&format!("claude://{id}/turn-end"), TurnEnd { text, is_error });
        }
        _ => {}
    }
}

/// Emit `claude://{id}/activity` for each `tool_use` in an assistant message so the
/// HUD can show what Claude is doing ("Read foo.ts", "Bash npm test", ...).
fn emit_tool_activity(app: &AppHandle, id: &str, v: &Value) {
    let content = match v
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
    {
        Some(c) => c,
        None => return,
    };
    for item in content {
        if item.get("type").and_then(Value::as_str) != Some("tool_use") {
            continue;
        }
        let name = item
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("tool")
            .to_string();
        let target = tool_target(&name, item.get("input"));
        let _ = app.emit(
            &format!("claude://{id}/activity"),
            Activity { name: name.clone(), target },
        );
        emit_tool_diff(app, id, &name, item.get("input"));
    }
}

/// Emit `claude://{id}/diff` for Edit/Write tools so the diff viewer panel can show changes.
fn emit_tool_diff(app: &AppHandle, id: &str, name: &str, input: Option<&Value>) {
    let input = match input {
        Some(i) => i,
        None => return,
    };
    let file_path = input
        .get("file_path")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if file_path.is_empty() {
        return;
    }
    let diff = match name {
        "Edit" | "MultiEdit" => ToolDiff {
            tool: name.to_string(),
            file_path,
            old_string: input.get("old_string").and_then(Value::as_str).map(String::from),
            new_string: input.get("new_string").and_then(Value::as_str).map(String::from),
            content: None,
        },
        "Write" => ToolDiff {
            tool: name.to_string(),
            file_path,
            old_string: None,
            new_string: None,
            content: input.get("content").and_then(Value::as_str).map(String::from),
        },
        _ => return,
    };
    let _ = app.emit(&format!("claude://{id}/diff"), diff);
}

/// Pick a human-meaningful target from a tool's input (path, command, pattern, ...).
fn tool_target(name: &str, input: Option<&Value>) -> String {
    let input = match input {
        Some(i) => i,
        None => return String::new(),
    };
    let pick = |keys: &[&str]| -> String {
        for k in keys {
            if let Some(s) = input.get(*k).and_then(Value::as_str) {
                return s.to_string();
            }
        }
        String::new()
    };
    let raw = match name {
        "Bash" => pick(&["command"]),
        "Read" | "Edit" | "Write" | "MultiEdit" => pick(&["file_path"]),
        "NotebookEdit" => pick(&["notebook_path"]),
        "Grep" | "Glob" => pick(&["pattern"]),
        "WebFetch" => pick(&["url"]),
        "WebSearch" => pick(&["query"]),
        "Task" => pick(&["description"]),
        _ => pick(&[
            "file_path",
            "path",
            "command",
            "pattern",
            "url",
            "query",
            "description",
        ]),
    };
    shorten(&raw, 52)
}

/// Truncate to at most `max` chars, keeping the (more informative) tail.
fn shorten(s: &str, max: usize) -> String {
    let s = s.trim();
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= max {
        return s.to_string();
    }
    let tail: String = chars[chars.len() - (max - 1)..].iter().collect();
    format!("\u{2026}{tail}")
}

/// Emit `claude://{id}/usage` from a `result` event's token counts + cost.
fn emit_usage(app: &AppHandle, id: &str, v: &Value) {
    let usage = v.get("usage");
    let get = |k: &str| -> u64 {
        usage
            .and_then(|u| u.get(k))
            .and_then(Value::as_u64)
            .unwrap_or(0)
    };
    let _ = app.emit(
        &format!("claude://{id}/usage"),
        Usage {
            input_tokens: get("input_tokens"),
            output_tokens: get("output_tokens"),
            cache_read_tokens: get("cache_read_input_tokens"),
            cache_creation_tokens: get("cache_creation_input_tokens"),
            cost_usd: v.get("total_cost_usd").and_then(Value::as_f64).unwrap_or(0.0),
        },
    );
}

#[cfg(test)]
mod tests {
    use super::{shorten, tool_target};
    use serde_json::json;

    #[test]
    fn tool_target_picks_a_meaningful_field_per_tool() {
        assert_eq!(
            tool_target("Read", Some(&json!({"file_path": "src/a.ts"}))),
            "src/a.ts"
        );
        assert_eq!(
            tool_target("Bash", Some(&json!({"command": "npm test"}))),
            "npm test"
        );
        assert_eq!(tool_target("Grep", Some(&json!({"pattern": "foo"}))), "foo");
        assert_eq!(
            tool_target("WebFetch", Some(&json!({"url": "https://x.dev"}))),
            "https://x.dev"
        );
        // Unknown tool falls back through the common keys.
        assert_eq!(
            tool_target("Mystery", Some(&json!({"path": "/tmp/z"}))),
            "/tmp/z"
        );
        // Missing input / missing field yields an empty target (never panics).
        assert_eq!(tool_target("Read", None), "");
        assert_eq!(tool_target("Read", Some(&json!({"other": 1}))), "");
    }

    #[test]
    fn shorten_keeps_the_tail_under_the_cap() {
        assert_eq!(shorten("short", 52), "short");
        let long = "x".repeat(80);
        let out = shorten(&long, 52);
        assert!(out.chars().count() <= 52);
        assert!(out.starts_with('\u{2026}'));
        assert!(out.ends_with("xxxx"));
    }
}
