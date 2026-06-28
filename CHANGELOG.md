# Changelog

All notable changes to Q are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and this project adheres to
[Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-06-27

First public release, under the MIT License. Q is the voice and face of Claude Code: a
holographic orb that listens, thinks, and speaks, with a multi-session conductor.

### Added
- **Neural TTS (Kokoro)**: in-process Kokoro neural voice (via ONNX Runtime + misaki-rs
  grapheme-to-phoneme) is now the default, with native Windows SAPI as a settings toggle;
  the model and voices download once on first use (checksummed / size-capped).
- **"Hey Q" wake word**: an optional, fully on-device wake phrase keeps the mic armed so a
  turn can start without a tap.
- **Streamed speech**: replies are spoken sentence-by-sentence as they arrive, so Q starts
  talking before the full turn completes.
- **The conductor (multi-session)**: Q runs a fleet of Claude sessions.
  - **Background multi-session** (Alt+N): spawn additional sessions, each its own panel you
    watch and type into, running in parallel with the primary voice session.
  - **Voice arbitration**: a worker's finished turn is announced through Q's single voice,
    courteously - an error interrupts at the next pause; successes batch into a digest.
  - **Marker orchestration**: the primary session can spawn and steer workers itself, by
    voice, via `<<spawn:...>>` / `<<tell:...>>` / `<<propose:...>>` markers (parsed and
    stripped exactly like the mood marker; the vocabulary is injected into its system prompt
    at spawn, so only the primary emits markers and there is no recursive spawning).
  - **Propose-then-approve**: Q proposes a parallel split; you approve or decline with a
    click before any fan-out (N sessions = N-times the spend).
  - **Fleet telemetry**: a combined cost readout across all live sessions.
- **Per-session terminal panels**: each Claude session shows its live stream scrolling
  by (assistant narration, the tools it runs, and command output) with a multi-line
  compose box (Enter sends, Shift+Enter for newlines) so long pasted prompts work.
- **Attach-by-path**: pick a file and stage a `Read the file at "<path>"` reference in
  the compose box (no copy into the project root).
- **Barge-in interrupt**: Escape always cuts off an in-flight turn (stop speaking, or
  cancel thinking); optional voice "speak-over" (settings toggle, default off).
- **Per-session model + effort** chosen at spawn (`--model` / `--effort`), with settings
  selectors; stored on the session so cancel/relaunch reuses them.
- **Real ConPTY shell**: the spawnable terminals are now genuine interactive Windows
  pseudo-consoles (real echo, ANSI, working resize), the user's escape hatch.
- **Directory picker** for the project folder (native dialog).
- **STT model download** resumes from the partial on a flaky network (HTTP Range) with
  bounded retry, and surfaces progress.
- `SECURITY.md` documenting the capability surface, blast radius, and HITL model.

### Changed
- **Public release**: stamped version 1.0.0 across all manifests, added the MIT `LICENSE`,
  and set the bundle publisher/copyright. The app identifier is now `com.qavatar.app`.
- The Claude bridge is keyed by **session id** with namespaced `claude://{id}/*` events
  (multi-session-ready foundation) plus a `claude_cancel` primitive.
- **Watchdog** timeout is configurable and shows a "Still working..." reassurance during
  long turns instead of a silent frozen orb.
- The **mic oscilloscope** is docked under the TAP TO TALK control instead of a large
  free-floating panel.

### Fixed
- TTS and CI failures now surface to the user (toast / dot tooltip) instead of console-only.
- The Rust backend is clippy-clean (`--all-targets`); download resume logic and the
  command-output / session bridge are unit-tested.

### Verified-not-shipped
- Per-tool read-and-click permission cards: `claude` 2.1.183 exposes no
  `--permission-prompt-tool` and `--permission-mode default` emits no answerable event in
  headless stream-json, so this requires the Claude Agent SDK (out of scope). The
  allowlist + per-tool visibility + barge-in remain the HITL surface.

## [0.5.0]
- Command Center + QOL release: shortcuts, snap-to-edge, copy, auto-reconnect, dir
  history, transcript persistence, notifications, compact/mini (PiP) mode, three themes
  with full HUD + orb sync.
