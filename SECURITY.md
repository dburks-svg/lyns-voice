# Security

Q is a local, single-user desktop app that drives the `claude` CLI and runs speech
100% on-device. There is no server, no account system, and no stored API key (it uses
your existing `claude` login). This document describes the security model and its
deliberate boundaries.

## Capability surface (what Claude may do)

The `claude` sidecar is started with `--permission-mode dontAsk` plus an explicit
`--allowedTools` allowlist and a `--disallowedTools` denylist (see `ALLOWED_TOOLS` /
`DISALLOWED_TOOLS` in `src-tauri/src/claude.rs`):

- `dontAsk` is non-interactive: it never blocks on a permission dialog (so the headless
  sidecar cannot hang) AND it **denies any tool not on the allowlist**. The allowlist is
  therefore the entire, auditable capability surface.
- The denylist is best-effort defense-in-depth against catastrophic shell patterns
  (`shutdown`, `mkfs`, `dd`, `rm -rf /`, ...). It is a pattern match, not a sandbox: it
  cannot catch every variant (aliases, absolute paths). It is **not** a substitute for
  the blast-radius boundary below.
- Every tool Claude runs is shown live in the Activity feed and the per-session stream,
  so there is no invisible action.

This is **never** `bypassPermissions`.

## Blast radius

Each Claude session runs with a **required project directory** as its working directory;
that directory is the intended blast radius (defense-in-depth, not an OS sandbox). The
backend keeps sessions in a per-id map, so multiple sessions are each scoped to their own
directory. `claude` still runs real edits and commands within the allowlist, in that dir.

The **conductor** (primary) session is additionally allowed `mcp__wisdom`, a **local** MCP
server (Claude's own epistemics tool under `D:\claudes-wisdom`: stdio + SQLite/ChromaDB, no
network), so its blast radius is its own store. Worker sessions are not given it for now, since
each `claude` child spawns its own wisdom subprocess and the store is not built for concurrent
multi-process writes; fanning it across the fleet awaits a concurrency check.

## Network / CSP

A strict Content-Security-Policy (`src-tauri/tauri.conf.json`) allows no remote origins.
The only egress is:

- the `claude` child process (your existing login), and
- the one-time speech-model downloads done in Rust before use, with HTTP-range resume on a
  flaky network: the Whisper STT model and the Kokoro TTS model are **checksummed (SHA-256)**
  and size-capped; Kokoro's vocab and voice files are HTTPS-fetched and size-capped.

Speech is entirely local: Whisper STT, and TTS via in-process neural Kokoro (the default) or
native Windows SAPI. `getUserMedia` is audio-only, least-privilege, with `echoCancellation`
enabled. When the "hey Q" wake word is enabled, the microphone stays open locally to hear the
phrase; captured audio never leaves the device (no egress, per the CSP above).

## Human-in-the-loop (HITL)

- **Visibility:** every tool and its output streams to the session panel and Activity feed.
- **Control:** Escape (or speaking over, if voice barge-in is enabled) interrupts an
  in-flight turn at any time; the mic is never load-bearing (typed input is a co-equal path).
- **Per-tool approve/deny cards are intentionally NOT implemented.** This was verified, not
  assumed: `claude` 2.1.183 has no `--permission-prompt-tool` flag, and `--permission-mode
  default` does not emit an answerable permission event in headless stream-json. True
  interactive per-tool approval would require migrating from the CLI sidecar to the Claude
  Agent SDK (its `canUseTool` callback) - a foundational re-architecture that is out of
  scope. The allowlist + visibility + interrupt model above is the shipped HITL surface.

## The user-owned shell

The spawnable terminals are real Windows pseudo-consoles (ConPTY) that run with **your**
authority, not Claude's, and are not driven by any Claude session. They are the escape
hatch for things Claude cannot or should not do. The allowlist constrains Claude, not you.

## Plugins / permissions

Tauri capabilities are least-privilege (`src-tauri/capabilities/default.json`): the dialog
plugin is granted only `dialog:allow-open` (file/folder picking), not save/message/etc.

## Dependencies

`npm audit` is kept clean; CI additionally runs `cargo audit`, secret scanning (gitleaks),
and a CodeQL SAST pass. Rust is clippy-clean (`--all-targets`).

## Reporting

Please report security issues privately via this repository's **GitHub Security
Advisories** ("Security" tab -> "Report a vulnerability"), not as a public issue.
