# Changelog

All notable changes to Q are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); versions are not yet semver-tagged
(the 1.0.0 stamp waits for the multi-session conductor).

## [Unreleased] - the road to 1.0

### Added
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
