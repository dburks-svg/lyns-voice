# Changelog

All notable changes to LYNS Voice are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and this project adheres to
[Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-07-12

First public release, under the MIT License. LYNS Voice is the voice of Claude
Code, part of the [LYNS](https://lyns.dev) family: a holographic orb that
listens, thinks, and speaks. The one you speak with is Oracle.

### Added
- **Hands-free voice loop**: local Whisper STT with VAD auto-send-on-pause;
  replies are spoken sentence-by-sentence as they stream, with a multi-chunk
  synthesis pipeline so long reads stay gapless.
- **"Oracle" wake word**: an optional, fully on-device wake phrase - the
  vocative "Oracle, <command>" or "hey Oracle" - keeps the mic armed so a turn
  can start without a tap.
- **Neural TTS (Kokoro)**: in-process Kokoro neural voice (ONNX Runtime +
  misaki-rs grapheme-to-phoneme) by default, with native Windows SAPI as a
  settings toggle; models download once on first use (checksummed, size-capped,
  resumable on a flaky network).
- **The conductor (multi-session)**: the primary voice session spawns and
  steers background Claude Code sessions, each in its own panel, with courteous
  voice arbitration, propose-before-fan-out approval, spawn gating to the
  project directory, and fleet cost telemetry.
- **The Library**: LYNS Voice inherits the MCP servers and hooks you already
  configured for Claude Code, each visible and one-click toggleable per new
  session.
- **Command Center HUD**: live transcript, per-session terminal views with a
  multi-line compose box and attach-by-path, real ConPTY shells, a floating
  diff viewer, token/cost telemetry, CI status dots, three switchable themes,
  keyboard shortcuts, mini (PiP) mode, and first-run onboarding.
- **Barge-in interrupt**: Escape always cuts off an in-flight turn; optional
  voice "speak-over" (settings toggle, default off).
- **Per-session model + effort** chosen at spawn, with settings selectors.
- **Security model**: the `claude` sidecar runs under a dontAsk allowlist
  (never bypassPermissions), a strict CSP with no remote origins, and a
  Thinking watchdog. See `SECURITY.md`.

### Verified-not-shipped
- Per-tool read-and-click permission cards: the `claude` CLI exposes no
  `--permission-prompt-tool` and `--permission-mode default` emits no
  answerable event in headless stream-json, so this requires the Claude Agent
  SDK (out of scope). The allowlist + per-tool visibility + barge-in remain
  the HITL surface.

[1.0.0]: https://github.com/dburks-svg/lyns-voice/releases/tag/v1.0.0
