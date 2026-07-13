//! Claude Code bridge: drive one or more `claude` CLI stream-json sidecars.
//!
//! Validated empirically against claude 2.1.183: one process started with
//! `claude --print --input-format stream-json --output-format stream-json
//! --verbose` reads newline-delimited user messages from stdin and KEEPS the
//! conversation context across messages (multi-turn confirmed). It emits NDJSON
//! events on stdout:
//! - {"type":"system","subtype":"init","session_id":...}
//! - {"type":"rate_limit_event",...} (ignored)
//! - {"type":"assistant","message":{"content":[{text...},{tool_use...}]}}
//! - {"type":"result","subtype":"success","is_error":false,"result":<final>}
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
use std::time::{Duration, Instant};

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
    model: Option<String>,
    effort: Option<String>,
    /// The primary "conductor" session gets the orchestration system prompt; kept so an
    /// in-place relaunch (claude_cancel) preserves it.
    conductor: bool,
    /// MCP servers the user disabled in the Library panel (everything registered is
    /// allowed by default); kept so an in-place relaunch preserves the choice.
    disabled_mcp: Vec<String>,
    /// Hook ids the user disabled in the Library panel; same relaunch contract.
    disabled_hooks: Vec<String>,
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

/// One line of a session's live stream (what scrolls by in a real `claude`
/// terminal): `narration` is the assistant's prose, `output` is command output
/// (stdout/stderr from the tools it runs). Drives the per-session panel.
#[derive(Clone, Serialize)]
struct StreamLine {
    kind: &'static str,
    text: String,
}

/// One incremental assistant text delta (Phase B), emitted only with
/// `--include-partial-messages`. Lets the webview speak sentence-by-sentence as the
/// reply generates instead of waiting for `turn-end`.
#[derive(Clone, Serialize)]
struct Delta {
    text: String,
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
    // Phase B: stream partial assistant text deltas (content_block_delta) so the
    // webview speaks sentence-by-sentence as the reply generates. Requires --print
    // + stream-json (present); the complete `assistant` + `result` events still come.
    "--include-partial-messages",
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
    // Ultracode dynamic-workflow orchestration. `Workflow` launches a scripted fan-out of
    // background sub-agents; the Task*/Monitor tools let the turn poll, inspect, and stop that
    // background work. Same project-dir blast radius as `Task` above (the spawned agents inherit
    // this exact allowlist), so this adds no new external capability - it just lets ultracode
    // (`--settings {"ultracode":true}`) actually orchestrate instead of being denied by dontAsk.
    "Workflow",
    "Monitor",
    "TaskCreate",
    "TaskGet",
    "TaskList",
    "TaskOutput",
    "TaskStop",
    "TaskUpdate",
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
pub async fn claude_start(
    app: AppHandle,
    dir: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    conductor: Option<bool>,
    disabled_mcp: Option<Vec<String>>,
    disabled_hooks: Option<Vec<String>>,
) -> Result<String, String> {
    let cwd = match dir {
        Some(d) if !d.trim().is_empty() => PathBuf::from(d.trim()),
        _ => return Err("a project directory is required".into()),
    };
    if !cwd.is_dir() {
        return Err(format!("not a directory: {}", cwd.display()));
    }
    let id = format!("claude-{}", NEXT_ID.fetch_add(1, Ordering::SeqCst));
    launch_session(
        &app,
        id.clone(),
        cwd,
        blank_to_none(model),
        blank_to_none(effort),
        conductor.unwrap_or(false),
        disabled_mcp.unwrap_or_default(),
        disabled_hooks.unwrap_or_default(),
    )
    .await?;
    Ok(id)
}

/// Treat an empty/whitespace string from the webview as "use claude's default" (None).
fn blank_to_none(s: Option<String>) -> Option<String> {
    s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
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
    let (cwd, model, effort, conductor, disabled_mcp, disabled_hooks) = {
        let state = app.state::<ClaudeState>();
        let mut sessions = state.sessions.lock().await;
        match sessions.remove(&id) {
            Some(mut s) => {
                s.generation = 0; // belt-and-suspenders: also removed from the map
                let _ = s.child.start_kill();
                (
                    PathBuf::from(s.cwd),
                    s.model,
                    s.effort,
                    s.conductor,
                    s.disabled_mcp,
                    s.disabled_hooks,
                )
            }
            None => return Err("claude session not started".into()),
        }
    };
    let _ = app.emit(&format!("claude://{id}/thinking"), Active { active: false });
    launch_session(&app, id, cwd, model, effort, conductor, disabled_mcp, disabled_hooks).await
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
async fn launch_session(
    app: &AppHandle,
    id: String,
    cwd: PathBuf,
    model: Option<String>,
    effort: Option<String>,
    conductor: bool,
    disabled_mcp: Vec<String>,
    disabled_hooks: Vec<String>,
) -> Result<(), String> {
    // The user's registered MCP servers, minus the ones disabled in the Library.
    // Re-read at every (re)launch so a server added in the terminal shows up on the
    // next session without restarting Q.
    let mcp_servers: Vec<String> = read_user_mcp_names(app)
        .into_iter()
        .filter(|n| !disabled_mcp.contains(n))
        .collect();
    // Hooks override: only when a Library disable actually matches a configured
    // hook does the session get a rebuilt hooks object; otherwise the user's
    // file-based hooks apply untouched (see rebuild_hooks).
    let hooks_override = if disabled_hooks.is_empty() {
        None
    } else {
        let disabled: std::collections::HashSet<String> = disabled_hooks.iter().cloned().collect();
        rebuild_hooks(&hook_sources(app, &cwd), &disabled)
    };
    let fallback = app
        .path()
        .home_dir()
        .ok()
        .map(|h| h.join(".local").join("bin").join("claude.exe"));
    let mut child = spawn_claude(
        &cwd,
        fallback.as_deref(),
        model.as_deref(),
        effort.as_deref(),
        conductor,
        &mcp_servers,
        hooks_override.as_ref(),
    )?;

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
                model,
                effort,
                conductor,
                disabled_mcp,
                disabled_hooks,
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
        let mut sstate = StreamState::default();
        while let Ok(Some(line)) = lines.next_line().await {
            if !is_current(&app2, &id2, my_gen).await {
                return; // superseded by a restart/cancel/stop; stay silent
            }
            handle_event(&app2, &id2, &line, &mut sstate);
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
    sessions.get(id).is_some_and(|s| s.generation == my_gen)
}

/// Spawn `claude` from PATH, falling back to the native-installer location so a
/// GUI launch with a thinner PATH still finds it.
/// Appended to the PRIMARY session's system prompt so Q can run the floor: it teaches the
/// orchestration markers (the app parses + strips them exactly like `<<mood:...>>`). Workers
/// never receive this, so only the conductor emits markers and there is no recursive spawning.
const CONDUCTOR_PROMPT: &str = "\
You are Oracle, a voice conductor coordinating several Claude Code sessions for the user. You spawn \
and steer worker sessions by emitting markers in your reply; the app parses and strips them \
before anything is spoken, exactly like the mood markers. \
To spawn a worker: <<spawn:NAME|DIR|TASK>> where NAME is a short label (letters, digits, spaces, \
hyphens), DIR is an existing directory path, and TASK is its opening instruction. \
To send a follow-up to a worker: <<tell:NAME|MESSAGE>>. \
To propose splitting work into parallel sessions, emit <<propose:SUMMARY>> and wait for the \
user to approve or decline. \
CRITICAL: to run work in parallel you MUST emit a SEPARATE <<spawn:...>> marker for EACH \
session - one per branch, folder, or component - and let each worker do its own piece. Do NOT \
do the parallel work yourself in this session, and never put two pieces into one worker. Emit \
the spawn markers right where you announce the plan, before doing the work, so each piece opens \
in its own window. If two branches share one repo, give each its own git worktree directory and \
point that worker's DIR at it. Only parallelize work with clear separation; one coherent task \
stays in one session, and you propose before fanning out since each session costs separately. \
Put each marker on its own line, never inside a code block. \
Begin every spoken reply with a mood marker the app strips before it is spoken or shown: \
<<mood:NAME>> where NAME is one of neutral, focused, happy, concerned, error, or curious \
(happy on success, concerned or error on problems, focused while working, curious when \
exploring). Put it at the very start of the reply.";

/// Build the per-session effort argv fragment.
///
/// `ultracode` is NOT a valid `--effort` value: it is a Claude Code session setting (sends
/// `xhigh` to the model AND turns on dynamic-workflow orchestration) enabled via `--settings`,
/// not `--effort`. Passed as an effort level the CLI silently ignores it, so translate it here.
/// `None` (the dropdown's "default effort") adds nothing and lets claude pick its own default.
/// Effort levels are model-dependent; the UI gates them per model, and `ultracode` is Opus-only.
fn effort_args(effort: Option<&str>) -> Vec<&str> {
    match effort {
        Some("ultracode") | None => vec![],
        Some(e) => vec!["--effort", e],
    }
}

/// The per-session `--settings` payload, or None when nothing needs overriding.
/// One flag carries BOTH session settings: `ultracode` (see `effort_args`) and the
/// Library's hooks override. `--settings` merges BY KEY with the settings files,
/// so including `hooks` replaces the session's entire hooks config - that is the
/// mechanism for per-hook disables - and omitting it leaves the user's file-based
/// hooks untouched. Pure; unit-tested.
fn settings_json(effort: Option<&str>, hooks_override: Option<&Value>) -> Option<String> {
    let mut obj = serde_json::Map::new();
    if effort == Some("ultracode") {
        obj.insert("ultracode".into(), Value::Bool(true));
    }
    if let Some(h) = hooks_override {
        obj.insert("hooks".into(), h.clone());
    }
    (!obj.is_empty()).then(|| Value::Object(obj).to_string())
}

/// Names of the user's registered user-scope MCP servers: the keys of the top-level
/// `mcpServers` object in `~/.claude.json` (the exact config the user's terminal
/// sessions run with). Tolerant: malformed JSON or a missing key yields an empty
/// list. Names are validated to `[A-Za-z0-9_-]{1,64}`; anything else is skipped
/// with a warning, so an odd registration can never smuggle a pattern into the
/// argv. Pure; unit-tested.
fn mcp_server_names(claude_json: &str) -> Vec<String> {
    let Ok(v) = serde_json::from_str::<Value>(claude_json) else {
        return vec![];
    };
    let Some(map) = v.get("mcpServers").and_then(Value::as_object) else {
        return vec![];
    };
    let mut out = Vec::new();
    for name in map.keys() {
        let valid = !name.is_empty()
            && name.len() <= 64
            && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
        if valid {
            out.push(name.clone());
        } else {
            log::warn!("[claude] ignoring MCP server with invalid name {name:?}");
        }
    }
    out
}

/// Read `~/.claude.json` and return the registered user-scope MCP server names
/// (empty on any failure - Q then behaves as if none are registered).
fn read_user_mcp_names(app: &AppHandle) -> Vec<String> {
    let Ok(home) = app.path().home_dir() else {
        return vec![];
    };
    match std::fs::read_to_string(home.join(".claude.json")) {
        Ok(s) => mcp_server_names(&s),
        Err(e) => {
            log::info!("[claude] no readable ~/.claude.json ({e}); no MCP servers allowlisted");
            vec![]
        }
    }
}

/// The Library panel's MCP list: every registered user-scope server name. The
/// frontend overlays its own disabled set (settings) - the backend has no opinion.
#[tauri::command]
pub fn library_list_mcp(app: AppHandle) -> Result<Vec<String>, String> {
    Ok(read_user_mcp_names(&app))
}

// --- The Library: hooks -------------------------------------------------------

/// One configured hook command, flattened from the settings files' nested shape
/// (event -> [{matcher, hooks: [{type, command, ...}]}]) for the Library panel.
#[derive(Clone, Serialize)]
pub struct HookEntry {
    pub scope: String,   // "user" | "project" | "local"
    pub event: String,   // e.g. "PreToolUse"
    pub matcher: String, // "" when the group has no matcher
    pub command: String,
    /// Stable content id (scope+event+matcher+command); disables persist in the
    /// user's settings by this id, so editing a hook naturally re-enables it.
    pub id: String,
}

/// FNV-1a 64 as hex: a tiny, dependency-free, version-STABLE content hash for
/// hook ids (std's DefaultHasher is not guaranteed stable across Rust releases,
/// and these ids persist in the user's saved settings).
fn fnv1a_hex(s: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

fn hook_id(scope: &str, event: &str, matcher: &str, command: &str) -> String {
    // \x1f (unit separator) keeps "a"+"bc" and "ab"+"c" from colliding.
    fnv1a_hex(&format!("{scope}\x1f{event}\x1f{matcher}\x1f{command}"))
}

/// Flatten one settings file's `hooks` object into Library entries. Tolerant:
/// malformed JSON or missing/odd-shaped keys yield nothing. Pure; unit-tested.
fn hooks_in(scope: &str, settings_json: &str) -> Vec<HookEntry> {
    let Ok(v) = serde_json::from_str::<Value>(settings_json) else {
        return vec![];
    };
    let Some(events) = v.get("hooks").and_then(Value::as_object) else {
        return vec![];
    };
    let mut out = Vec::new();
    for (event, groups) in events {
        let Some(groups) = groups.as_array() else { continue };
        for g in groups {
            let matcher = g.get("matcher").and_then(Value::as_str).unwrap_or("");
            let Some(hooks) = g.get("hooks").and_then(Value::as_array) else { continue };
            for h in hooks {
                let command = h.get("command").and_then(Value::as_str).unwrap_or("");
                out.push(HookEntry {
                    id: hook_id(scope, event, matcher, command),
                    scope: scope.to_string(),
                    event: event.clone(),
                    matcher: matcher.to_string(),
                    command: command.to_string(),
                });
            }
        }
    }
    out
}

/// Rebuild ONE combined hooks object from the scoped settings files, dropping
/// entries whose ids the user disabled in the Library. Each kept hook's full JSON
/// (timeout, args, ...) and its matcher grouping are preserved; groups and events
/// emptied by drops disappear. Returns None when no disabled id matched anything,
/// so the caller passes no override and the user's file-based hooks apply exactly
/// as in their terminal. Pure; unit-tested.
fn rebuild_hooks(
    scoped: &[(&str, String)],
    disabled: &std::collections::HashSet<String>,
) -> Option<Value> {
    let mut any_dropped = false;
    let mut combined = serde_json::Map::new();
    for (scope, content) in scoped {
        let Ok(v) = serde_json::from_str::<Value>(content) else { continue };
        let Some(events) = v.get("hooks").and_then(Value::as_object) else { continue };
        for (event, groups) in events {
            let Some(groups) = groups.as_array() else { continue };
            for g in groups {
                let matcher = g.get("matcher").and_then(Value::as_str).unwrap_or("");
                let Some(hooks) = g.get("hooks").and_then(Value::as_array) else { continue };
                let kept: Vec<Value> = hooks
                    .iter()
                    .filter(|h| {
                        let command = h.get("command").and_then(Value::as_str).unwrap_or("");
                        let drop = disabled.contains(&hook_id(scope, event, matcher, command));
                        any_dropped |= drop;
                        !drop
                    })
                    .cloned()
                    .collect();
                if kept.is_empty() {
                    continue;
                }
                let mut group = g.as_object().cloned().unwrap_or_default();
                group.insert("hooks".into(), Value::Array(kept));
                combined
                    .entry(event.clone())
                    .or_insert_with(|| Value::Array(vec![]))
                    .as_array_mut()
                    .expect("inserted as array above")
                    .push(Value::Object(group));
            }
        }
    }
    any_dropped.then_some(Value::Object(combined))
}

/// The three hook sources claude reads for a session in `cwd`: user settings, the
/// project's checked-in settings, and the project's local overrides.
fn hook_sources(app: &AppHandle, cwd: &Path) -> Vec<(&'static str, String)> {
    let mut out = Vec::new();
    if let Ok(home) = app.path().home_dir() {
        if let Ok(s) = std::fs::read_to_string(home.join(".claude").join("settings.json")) {
            out.push(("user", s));
        }
    }
    if let Ok(s) = std::fs::read_to_string(cwd.join(".claude").join("settings.json")) {
        out.push(("project", s));
    }
    if let Ok(s) = std::fs::read_to_string(cwd.join(".claude").join("settings.local.json")) {
        out.push(("local", s));
    }
    out
}

/// The Library panel's hooks list for the given project dir (user scope always;
/// project/local when `dir` is set and has a .claude folder).
#[tauri::command]
pub fn library_list_hooks(app: AppHandle, dir: Option<String>) -> Result<Vec<HookEntry>, String> {
    let cwd = PathBuf::from(dir.unwrap_or_default());
    let mut out = Vec::new();
    for (scope, content) in hook_sources(&app, &cwd) {
        out.extend(hooks_in(scope, &content));
    }
    Ok(out)
}

/// Build a session's `--allowedTools` values: the fixed ALLOWED_TOOLS surface plus
/// one `mcp__<name>` entry per (already-filtered) MCP server. Q inherits the user's
/// terminal MCP world by default - the registration is the consent boundary, and
/// the Library panel is the per-server off switch. Pure; unit-tested.
fn allowed_tools_for(mcp_servers: &[String]) -> Vec<String> {
    let mut out: Vec<String> = ALLOWED_TOOLS.iter().map(|s| s.to_string()).collect();
    out.extend(mcp_servers.iter().map(|n| format!("mcp__{n}")));
    out
}

fn spawn_claude(
    cwd: &Path,
    fallback: Option<&Path>,
    model: Option<&str>,
    effort: Option<&str>,
    conductor: bool,
    mcp_servers: &[String],
    hooks_override: Option<&Value>,
) -> Result<Child, String> {
    // MCP: every server the user registered user-scope is allowed (minus Library
    // disables), so Q sees the same tool world as their terminal. Known caveat, now
    // the user's choice exactly as it is in the terminal: a slow-attaching server
    // (e.g. one warming a database behind an exclusive lock) can stall a turn until
    // the Thinking watchdog recovers it. Project-scope .mcp.json servers are NOT
    // auto-allowed: interactive claude gates those behind an approval prompt (they
    // can arrive in a cloned repo), and Q must not be more permissive than the
    // user's own terminal.
    let allowed = allowed_tools_for(mcp_servers);
    let build = |program: &OsStr| {
        let mut c = Command::new(program);
        c.args(BASE_ARGS);
        // `--allowedTools <tools...>` / `--disallowedTools <tools...>` are variadic;
        // each value is a separate argv entry (no shell, so the parens/globs in the
        // patterns are passed literally to claude, not expanded by a shell).
        c.arg("--allowedTools").args(&allowed);
        c.arg("--disallowedTools").args(DISALLOWED_TOOLS);
        // Per-session model/effort, set at spawn; absent => claude's own default.
        if let Some(m) = model {
            c.arg("--model").arg(m);
        }
        // Per-session effort (see `effort_args`; `ultracode` travels via --settings).
        c.args(effort_args(effort));
        // ONE --settings flag carries both ultracode and the Library's hooks
        // override (the flag merges by key with the settings files; see settings_json).
        if let Some(json) = settings_json(effort, hooks_override) {
            c.arg("--settings").arg(json);
        }
        // The primary session runs the floor: teach it the orchestration markers so it can
        // spawn and steer workers by voice. Workers never get this, so only the conductor
        // emits markers and there is no recursive spawning.
        if conductor {
            c.arg("--append-system-prompt").arg(CONDUCTOR_PROMPT);
        }
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

/// Per-reader state for partial-message streaming: maps each content-block `index`
/// to whether it is a spoken TEXT block (vs a thinking/tool_use block, whose deltas
/// must NOT be spoken). Reset at each `message_start` / `result`. Also owns the
/// delta coalescer (below).
#[derive(Default)]
struct StreamState {
    text_blocks: std::collections::HashMap<u64, bool>,
    coalescer: DeltaCoalescer,
}

// Delta coalescing: the CLI emits a `content_block_delta` line every few tokens,
// and forwarding each one was a separate IPC event + webview handler pass + caption
// DOM write - render churn all through a fast generation. Deltas are batched until
// the buffer ages past the window or grows past the cap; any non-delta line drains
// the buffer first, so event order is preserved and the end of a text block is
// never held back (a delta line is always followed by more lines: stop / assistant
// / result). 50 ms ~= 20 caption updates/s, imperceptible next to TTS pacing.
const DELTA_FLUSH_AGE: Duration = Duration::from_millis(50);
const DELTA_FLUSH_BYTES: usize = 256;

/// Buffers spoken-text deltas between flushes. Pure (the clock is injected);
/// unit-tested.
#[derive(Default)]
struct DeltaCoalescer {
    buf: String,
    since: Option<Instant>,
}

impl DeltaCoalescer {
    /// Buffer `text`; returns the accumulated batch once it is due (size or age).
    fn push(&mut self, text: &str, now: Instant) -> Option<String> {
        if self.buf.is_empty() {
            self.since = Some(now);
        }
        self.buf.push_str(text);
        let due = self.buf.len() >= DELTA_FLUSH_BYTES
            || self.since.is_some_and(|t| now.duration_since(t) >= DELTA_FLUSH_AGE);
        due.then(|| self.take())
    }

    /// Drain whatever is buffered (called before any non-delta event).
    fn flush(&mut self) -> Option<String> {
        (!self.buf.is_empty()).then(|| self.take())
    }

    fn take(&mut self) -> String {
        self.since = None;
        std::mem::take(&mut self.buf)
    }
}

/// Decide what (if anything) a single partial `stream_event`'s inner event yields as
/// spoken text, updating per-block type tracking. Pure (no emit) so it is unit-tested.
/// Only `text_delta`s on a block whose `content_block_start` was `type:"text"` speak;
/// thinking deltas and tool `input_json_delta`s return None.
fn stream_delta_text(ev: &Value, state: &mut StreamState) -> Option<String> {
    match ev.get("type").and_then(Value::as_str) {
        Some("message_start") => {
            state.text_blocks.clear();
            None
        }
        Some("content_block_start") => {
            if let Some(idx) = ev.get("index").and_then(Value::as_u64) {
                let is_text = ev
                    .get("content_block")
                    .and_then(|c| c.get("type"))
                    .and_then(Value::as_str)
                    == Some("text");
                state.text_blocks.insert(idx, is_text);
            }
            None
        }
        Some("content_block_delta") => {
            let idx = ev.get("index").and_then(Value::as_u64).unwrap_or(u64::MAX);
            if state.text_blocks.get(&idx).copied() != Some(true) {
                return None; // not a spoken text block (thinking / tool_use / unknown)
            }
            let delta = ev.get("delta")?;
            if delta.get("type").and_then(Value::as_str) != Some("text_delta") {
                return None; // e.g. input_json_delta for a tool call
            }
            let text = delta.get("text").and_then(Value::as_str)?;
            (!text.is_empty()).then(|| text.to_string())
        }
        _ => None,
    }
}

/// Forward a partial `stream_event` to the webview as a (coalesced)
/// `claude://{id}/delta` chunk. Non-delta stream events (block start/stop,
/// message_stop) drain the buffer so a text block's tail is never held back.
fn emit_stream_delta(app: &AppHandle, id: &str, v: &Value, state: &mut StreamState) {
    let ev = match v.get("event") {
        Some(e) => e,
        None => return,
    };
    match stream_delta_text(ev, state) {
        Some(text) => {
            if let Some(batch) = state.coalescer.push(&text, Instant::now()) {
                let _ = app.emit(&format!("claude://{id}/delta"), Delta { text: batch });
            }
        }
        None => flush_delta(app, id, state),
    }
}

/// Emit whatever the coalescer is holding (order-preserving drain before any
/// non-delta event).
fn flush_delta(app: &AppHandle, id: &str, state: &mut StreamState) {
    if let Some(text) = state.coalescer.flush() {
        let _ = app.emit(&format!("claude://{id}/delta"), Delta { text });
    }
}

/// Tolerant parse of one stdout NDJSON line for session `id`. `result` drives the
/// four-state UI (turn-end) plus the telemetry (usage); `assistant` feeds the
/// activity HUD from its tool_use entries. Unknown events keep the current Thinking
/// state. On a normal reply we do NOT emit a standalone thinking:false: turn-end ->
/// speak() drives the Thinking->Speaking handoff with no intervening idle frame.
fn handle_event(app: &AppHandle, id: &str, line: &str, state: &mut StreamState) {
    let line = line.trim();
    if line.is_empty() {
        return;
    }
    let v: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => {
            // A first-party sidecar should never emit a malformed line; log it so a
            // stuck turn (no turn-end) is diagnosable instead of a silent drop.
            log::warn!("[claude {id}] skipping malformed NDJSON line: {e}");
            return;
        }
    };
    let kind = v.get("type").and_then(Value::as_str);
    if kind != Some("stream_event") {
        // Any non-delta line (assistant, result, tool results, system chatter)
        // drains pending delta text first, so the webview sees events in order.
        flush_delta(app, id, state);
    }
    match kind {
        Some("assistant") => emit_assistant(app, id, &v),
        Some("user") => emit_tool_results(app, id, &v),
        Some("stream_event") => emit_stream_delta(app, id, &v, state),
        Some("result") => {
            state.text_blocks.clear(); // turn over; next turn re-tracks block types
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

/// Translate one `assistant` message: stream its narration text (previously
/// discarded - it is the prose that scrolls by in a real `claude` terminal) and
/// emit each tool it invokes (the HUD activity line "Read foo.ts" plus any diff).
fn emit_assistant(app: &AppHandle, id: &str, v: &Value) {
    let content = match v
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
    {
        Some(c) => c,
        None => return,
    };
    for item in content {
        match item.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = item.get("text").and_then(Value::as_str) {
                    let text = text.trim();
                    if !text.is_empty() {
                        let _ = app.emit(
                            &format!("claude://{id}/stream"),
                            StreamLine { kind: "narration", text: text.to_string() },
                        );
                    }
                }
            }
            Some("tool_use") => {
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
            _ => {}
        }
    }
}

/// Extract capped command output (stdout + stderr) from a `user` tool-result message,
/// or None for tool results that are not command output (Read/Grep/...), so the stream
/// is not flooded with file contents. Keys on `tool_use_result.stdout`, which Claude
/// Code emits only for command-style tools. Pure; unit-tested against the live shape.
fn command_output(v: &Value) -> Option<String> {
    let r = v.get("tool_use_result")?;
    let stdout = r.get("stdout").and_then(Value::as_str)?; // only commands carry stdout
    let mut text = String::new();
    let stdout = stdout.trim();
    if !stdout.is_empty() {
        text.push_str(stdout);
    }
    let stderr = r.get("stderr").and_then(Value::as_str).unwrap_or("").trim();
    if !stderr.is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(stderr);
    }
    if text.is_empty() {
        None
    } else {
        Some(cap_output(&text))
    }
}

/// Cap command output, keeping the (usually most informative) tail.
fn cap_output(s: &str) -> String {
    const MAX: usize = 4000;
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= MAX {
        return s.to_string();
    }
    let tail: String = chars[chars.len() - MAX..].iter().collect();
    format!("[\u{2026}output truncated\u{2026}]\n{tail}")
}

/// Emit a session's command output (stdout/stderr) from a `user` tool-result message.
fn emit_tool_results(app: &AppHandle, id: &str, v: &Value) {
    if let Some(text) = command_output(v) {
        let _ = app.emit(&format!("claude://{id}/stream"), StreamLine { kind: "output", text });
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
    use super::{
        allowed_tools_for, cap_output, command_output, effort_args, mcp_server_names,
        settings_json, shorten, tool_target, DeltaCoalescer, ALLOWED_TOOLS, DELTA_FLUSH_AGE,
        DELTA_FLUSH_BYTES,
    };
    use serde_json::json;
    use std::time::{Duration, Instant};

    #[test]
    fn mcp_server_names_reads_the_user_scope_registry() {
        let cfg = r#"{
            "someOtherKey": 1,
            "mcpServers": {
                "wisdom": {"type": "stdio", "command": "node"},
                "github": {"type": "http", "url": "https://example.com"},
                "my-server_2": {"type": "stdio", "command": "x"}
            }
        }"#;
        let mut names = mcp_server_names(cfg);
        names.sort();
        assert_eq!(names, vec!["github", "my-server_2", "wisdom"]);
    }

    #[test]
    fn mcp_server_names_tolerates_junk_and_rejects_invalid_names() {
        assert!(mcp_server_names("").is_empty());
        assert!(mcp_server_names("not json at all").is_empty());
        assert!(mcp_server_names(r#"{"noServersHere": true}"#).is_empty());
        assert!(mcp_server_names(r#"{"mcpServers": []}"#).is_empty()); // wrong shape
        // Invalid names (spaces, glob chars, path-ish, overlong) are skipped; a
        // valid sibling still comes through.
        let cfg = format!(
            r#"{{"mcpServers": {{
                "bad name": {{}},
                "bad*glob": {{}},
                "bad/slash": {{}},
                "{}": {{}},
                "good": {{}}
            }}}}"#,
            "x".repeat(65)
        );
        assert_eq!(mcp_server_names(&cfg), vec!["good"]);
    }

    #[test]
    fn allowed_tools_include_the_base_surface_plus_mcp_entries() {
        // No servers: exactly the fixed surface (zero behavior change).
        let base = allowed_tools_for(&[]);
        assert_eq!(base, ALLOWED_TOOLS.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        // Servers append mcp__<name> entries without touching the base.
        let with = allowed_tools_for(&["wisdom".into(), "github".into()]);
        assert_eq!(with.len(), base.len() + 2);
        assert!(with.contains(&"mcp__wisdom".to_string()));
        assert!(with.contains(&"mcp__github".to_string()));
        assert!(with.contains(&"Bash".to_string()));
    }

    #[test]
    fn allowlist_enables_ultracode_workflow_orchestration() {
        // ultracode (--settings {"ultracode":true}) fans out via the Workflow tool; without
        // Workflow on the allowlist, dontAsk denies the orchestration and ultracode is only
        // half-enabled. Guard the enablement against an accidental removal.
        assert!(ALLOWED_TOOLS.contains(&"Workflow"));
        assert!(ALLOWED_TOOLS.contains(&"Monitor"));
    }

    #[test]
    fn delta_coalescer_batches_until_the_age_window_elapses() {
        let mut c = DeltaCoalescer::default();
        let t0 = Instant::now();
        assert_eq!(c.push("Hel", t0), None); // first chunk starts the window
        assert_eq!(c.push("lo", t0 + Duration::from_millis(10)), None);
        let batch = c.push(" world", t0 + DELTA_FLUSH_AGE);
        assert_eq!(batch.as_deref(), Some("Hello world"));
        assert_eq!(c.flush(), None); // drained: nothing held back
    }

    #[test]
    fn delta_coalescer_flushes_on_size_and_drains_on_demand() {
        let mut c = DeltaCoalescer::default();
        let t0 = Instant::now();
        let big = "x".repeat(DELTA_FLUSH_BYTES);
        assert_eq!(c.push(&big, t0).as_deref(), Some(big.as_str())); // size cap
        assert_eq!(c.push("tail", t0), None);
        // A non-delta event drains the buffer so event order is preserved.
        assert_eq!(c.flush().as_deref(), Some("tail"));
        assert_eq!(c.flush(), None);
    }

    #[test]
    fn stream_delta_text_speaks_only_text_blocks() {
        use super::{stream_delta_text, StreamState};
        let mut st = StreamState::default();
        // A text block: start tracks it; its text_delta is spoken.
        assert_eq!(
            stream_delta_text(
                &json!({"type":"content_block_start","index":0,"content_block":{"type":"text"}}),
                &mut st
            ),
            None
        );
        assert_eq!(
            stream_delta_text(
                &json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}),
                &mut st
            ),
            Some("Hello".to_string())
        );
        // A thinking block: its text_delta must NOT be spoken.
        assert_eq!(
            stream_delta_text(
                &json!({"type":"content_block_start","index":1,"content_block":{"type":"thinking"}}),
                &mut st
            ),
            None
        );
        assert_eq!(
            stream_delta_text(
                &json!({"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"reasoning"}}),
                &mut st
            ),
            None
        );
        // A tool input_json_delta is skipped (not spoken text).
        assert_eq!(
            stream_delta_text(
                &json!({"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{"}}),
                &mut st
            ),
            None
        );
        // message_start resets tracking, so a later delta on index 0 no longer speaks.
        assert_eq!(stream_delta_text(&json!({"type":"message_start"}), &mut st), None);
        assert_eq!(
            stream_delta_text(
                &json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}),
                &mut st
            ),
            None
        );
    }

    #[test]
    fn effort_args_translates_ultracode_to_a_settings_flag() {
        // ultracode is NOT a real `--effort` value; it must travel via `--settings` or the
        // CLI silently ignores it (settings_json below; this guards the split).
        assert!(effort_args(Some("ultracode")).is_empty());
        assert_eq!(
            settings_json(Some("ultracode"), None).as_deref(),
            Some(r#"{"ultracode":true}"#)
        );
        // Ordinary levels pass straight through as `--effort` and add no settings.
        assert_eq!(effort_args(Some("high")), vec!["--effort", "high"]);
        assert_eq!(effort_args(Some("xhigh")), vec!["--effort", "xhigh"]);
        assert_eq!(settings_json(Some("high"), None), None);
        // "default effort" (None) contributes nothing at all.
        assert!(effort_args(None).is_empty());
        assert_eq!(settings_json(None, None), None);
    }

    #[test]
    fn settings_json_carries_a_hooks_override_alone_or_with_ultracode() {
        let hooks = json!({"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "echo hi"}]}]});
        let alone = settings_json(None, Some(&hooks)).expect("hooks alone");
        let parsed: serde_json::Value = serde_json::from_str(&alone).unwrap();
        assert_eq!(parsed.get("hooks"), Some(&hooks));
        assert_eq!(parsed.get("ultracode"), None);
        // Both together travel in ONE --settings payload.
        let both = settings_json(Some("ultracode"), Some(&hooks)).expect("both");
        let parsed: serde_json::Value = serde_json::from_str(&both).unwrap();
        assert_eq!(parsed.get("ultracode"), Some(&serde_json::Value::Bool(true)));
        assert_eq!(parsed.get("hooks"), Some(&hooks));
    }

    #[test]
    fn hooks_in_flattens_the_settings_shape_with_stable_ids() {
        let cfg = r#"{"hooks": {
            "PreToolUse": [
                {"matcher": "Bash|Edit", "hooks": [
                    {"type": "command", "command": "lint.cmd"},
                    {"type": "command", "command": "audit.cmd", "timeout": 5}
                ]}
            ],
            "SessionStart": [
                {"hooks": [{"type": "command", "command": "hello.cmd"}]}
            ]
        }}"#;
        let entries = super::hooks_in("user", cfg);
        assert_eq!(entries.len(), 3);
        let lint = entries.iter().find(|e| e.command == "lint.cmd").unwrap();
        assert_eq!(lint.event, "PreToolUse");
        assert_eq!(lint.matcher, "Bash|Edit");
        assert_eq!(lint.scope, "user");
        // No matcher -> "".
        let hello = entries.iter().find(|e| e.command == "hello.cmd").unwrap();
        assert_eq!(hello.matcher, "");
        // Ids are stable content hashes: same input, same id; distinct inputs differ.
        assert_eq!(lint.id, super::hooks_in("user", cfg)[0].id);
        assert_ne!(lint.id, hello.id);
        // Junk tolerated.
        assert!(super::hooks_in("user", "not json").is_empty());
        assert!(super::hooks_in("user", r#"{"noHooks": 1}"#).is_empty());
    }

    #[test]
    fn rebuild_hooks_drops_disabled_entries_and_preserves_the_rest() {
        let user = r#"{"hooks": {
            "PreToolUse": [
                {"matcher": "Bash", "hooks": [
                    {"type": "command", "command": "keep.cmd", "timeout": 9},
                    {"type": "command", "command": "drop.cmd"}
                ]}
            ]
        }}"#;
        let project = r#"{"hooks": {
            "SessionStart": [{"hooks": [{"type": "command", "command": "proj.cmd"}]}]
        }}"#;
        let scoped = vec![("user", user.to_string()), ("project", project.to_string())];

        // Disabling nothing that exists -> None (no override; files apply untouched).
        let none: std::collections::HashSet<String> =
            [super::hook_id("user", "Nope", "", "ghost.cmd")].into_iter().collect();
        assert!(super::rebuild_hooks(&scoped, &none).is_none());

        // Dropping one entry keeps its siblings (with their extra fields) and the
        // other scope's hooks, grouped under their events.
        let disabled: std::collections::HashSet<String> =
            [super::hook_id("user", "PreToolUse", "Bash", "drop.cmd")].into_iter().collect();
        let rebuilt = super::rebuild_hooks(&scoped, &disabled).expect("an override");
        let pre = rebuilt.get("PreToolUse").and_then(|v| v.as_array()).unwrap();
        assert_eq!(pre.len(), 1);
        let hooks = pre[0].get("hooks").and_then(|v| v.as_array()).unwrap();
        assert_eq!(hooks.len(), 1);
        assert_eq!(hooks[0].get("command").and_then(|v| v.as_str()), Some("keep.cmd"));
        assert_eq!(hooks[0].get("timeout").and_then(|v| v.as_u64()), Some(9));
        let start = rebuilt.get("SessionStart").and_then(|v| v.as_array()).unwrap();
        assert_eq!(start.len(), 1);

        // Dropping a group's last hook removes the whole group/event.
        let all: std::collections::HashSet<String> = [
            super::hook_id("user", "PreToolUse", "Bash", "keep.cmd"),
            super::hook_id("user", "PreToolUse", "Bash", "drop.cmd"),
        ]
        .into_iter()
        .collect();
        let rebuilt = super::rebuild_hooks(&scoped, &all).expect("an override");
        assert!(rebuilt.get("PreToolUse").is_none());
        assert!(rebuilt.get("SessionStart").is_some());
    }

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

    #[test]
    fn command_output_extracts_stdout_then_stderr() {
        // The live shape: a `user` message with a structured tool_use_result.
        let v = json!({
            "type": "user",
            "tool_use_result": { "stdout": "hello\n", "stderr": "", "interrupted": false }
        });
        assert_eq!(command_output(&v).as_deref(), Some("hello"));
        let both = json!({ "tool_use_result": { "stdout": "out", "stderr": "boom" } });
        assert_eq!(command_output(&both).as_deref(), Some("out\nboom"));
    }

    #[test]
    fn command_output_skips_non_command_tool_results() {
        // A Read/Grep result (no stdout) is skipped so file dumps do not flood the stream.
        let read = json!({
            "type": "user",
            "message": { "content": [{ "type": "tool_result", "content": "file contents" }] }
        });
        assert_eq!(command_output(&read), None);
        assert_eq!(command_output(&json!({ "type": "user" })), None);
    }

    #[test]
    fn cap_output_keeps_the_tail_under_the_cap() {
        let long = "x".repeat(5000);
        let out = cap_output(&long);
        assert!(out.contains("truncated"));
        assert!(out.ends_with("xxxx"));
        assert!(out.chars().count() <= 4000 + 40);
    }
}
