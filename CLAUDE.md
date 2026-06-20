# CLAUDE.md - Q (Tauri desktop app)

A standalone **Tauri v2 desktop app** that is the voice and face of Claude Code: a
holographic orb on a futuristic HUD that listens (local Whisper STT), thinks while the
`claude` CLI works, and speaks the reply (native Windows SAPI TTS), with four live
telemetry panels. Windows is the primary platform; speech runs 100% locally. This repo
was migrated from a browser overlay injected into `mcp-voice-hooks`; that era is retired
(see git history / `master` if you need it).

## Working agreement (how this project is built)

- **Answer open implementation questions as the senior engineer.** Make the call, record
  the rationale here, and proceed.
- **Clean code, security first, tests baked in as you build** (not bolted on after).
- **Phased delivery with a green gate between phases.** Build a phase fully (code + tests
  green), commit it, then begin the next.
- **No em dashes or en dashes** in any generated content (use hyphens, commas, colons,
  parentheses). Scan before delivering.
- The owner flagged that open-ended visual trial-and-error burns tokens: tune visuals
  against a concrete target, one knob per turn.

## The four behavioral states (the contract that never changes)

Idle, Listening, Thinking, Speaking, derived from voice signals with a fixed priority
(speaking > listening > thinking > idle). The seam is small, pure, and host-neutral:

```
VoiceSignals { micActive, speaking, pendingResponse } -> deriveState() -> AvatarController
```

(`src/integration/signals.ts`). Any renderer that implements the `ControllableAvatar`
interface (`src/avatar/AvatarController.ts`) is driven by the controller unchanged. The live
app's renderer is `QOrbAvatar` (the vendored Three.js orb); the demo keeps the legacy
`Avatar`/`reactor`/`head` renderers. `AVATAR_SPEC.md` defines the four states' intent and is
the behavioral source of truth; the rest of that spec predates the Tauri migration. Do not
edit `AVATAR_SPEC.md`.

## Status: voice loop complete (Phases 0-4), shipped as a desktop app

- **Phase 0** mount; **Phase 1** native SAPI TTS; **Phase 2** local Whisper STT + VAD
  auto-send-on-pause; **Phase 3** Claude Code stream-json bridge (the full hands-free loop);
  **Phase 4** security (dontAsk allowlist + Thinking watchdog + strict CSP), deferred tests.
- **FUI overhaul:** the vendored MIT Three.js Q orb centerpiece (full-window) + the
  three-column tactical HUD + four live telemetry panels (transcript / activity / session
  tokens+cost / mic waveform); mood-driven palette (idle navy, active blue).
- **Packaging:** unsigned per-user NSIS build. Private, personal, zero-cost tool, so signing
  and the auto-updater are intentionally dropped.

## Commands

| Task | Command |
| --- | --- |
| Install deps | `npm install` |
| Dev: native window + full voice loop | `LIBCLANG_PATH="C:/Program Files/LLVM/bin" npm run tauri dev` |
| Build: unsigned installer + `app.exe` | `LIBCLANG_PATH="C:/Program Files/LLVM/bin" npm run tauri build` |
| Host-free demo (browser) | `npm run dev` (opens `/demo/`) |
| Unit tests | `npm test` |
| E2E (installs Chromium first) | `npm run e2e:install` then `npm run test:e2e` |
| Lint / type-check | `npm run lint` / `npm run typecheck` |
| Rust backend tests | `cd src-tauri && LIBCLANG_PATH=... cargo test` |

Pre-ship gate (before each commit): `npm run lint && npm run typecheck && npm test`. CI
(`.github/workflows/ci.yml`) additionally runs `npm ci` + `npm run build` on Linux, so keep
`package-lock.json` in sync (regenerate with `npm install` if `npm ci` complains). Build
prerequisites: Node 20+, a Rust toolchain, LLVM/libclang (`LIBCLANG_PATH`) for `whisper-rs`;
the release `target-dir` is redirected to `%LOCALAPPDATA%` via a gitignored `.cargo/config.toml`
(a BitDefender build-script workaround).

## Architecture

```
src/
  app/                  Desktop shell: main.ts entry, shell.css (the FUI HUD), index.html (root)
  avatar/
    QOrbAvatar.ts       Adapter: drives the vendored orb through the ControllableAvatar seam
    jarvisOrb/          Vendored MIT Three.js orb (renderer.ts + states.ts; keep its LICENSE)
    AvatarController.ts idle|listening|thinking|speaking state machine (+ mood, FFT bands)
    Avatar.ts, reactor.ts, shaders.ts, gltf.ts, noise.ts, deformation.ts  (demo renderers)
  audio/                MediaTts (WAV playback + amplitude), SttCapture, MicAnalyser, bands
  integration/
    tauriAdapter.ts     attachTauri: Tauri events -> signals -> controller; TTS/STT/Claude + watchdog
    telemetry.ts        The four live HUD panels (transcript / activity / session / waveform)
    signals.ts          Pure VoiceSignals -> deriveState
  mood/                 mood tag parser, color blend, MoodController
  config/               AvatarConfig + safe localStorage store
demo/                   Host-free harness (legacy Three.js reactor/head + all four states)

src-tauri/              Rust backend
  src/tts.rs            Native Windows SAPI synth -> in-memory WAV (no PowerShell child)
  src/stt.rs            Mic frames -> webrtc-vad endpointing -> whisper-rs transcription
  src/claude.rs         The claude CLI stream-json sidecar + NDJSON event parsing
  tauri.conf.json       Window, strict CSP, NSIS bundle
```

## The voice loop (where to look)

- **TTS** (`tts.rs`): `tts_synthesize` renders a mood-stripped line to a WAV buffer via native
  SAPI in-process (no `powershell.exe`), returned as bytes and played through the EXISTING
  `MediaTts`, so the real audio amplitude drives the Speaking animation.
- **STT** (`stt.rs`): the webview pushes 16 kHz Int16 frames; a worker runs `webrtc-vad`
  endpointing then `whisper-rs` on a pause and emits `stt://final`. The model downloads once to
  `app_data_dir` on first run.
- **Claude bridge** (`claude.rs`): a long-lived `claude --print --input-format stream-json
  --output-format stream-json --verbose` child; `handle_event` parses NDJSON into `claude://*`
  events (`thinking`, `turn-end`, plus `activity` from `tool_use` and `usage` from `result`,
  which feed the HUD). A monotonic generation guard makes a superseded session inert.
- **Frontend seam** (`tauriAdapter.ts`): the only substantial glue. It wires the events to the
  controller + `telemetry.ts`, owns the speech queue, the turn-taking guards, and the Thinking
  watchdog, and injects the renderer via `avatarFactory` (default `QOrbAvatar`).

## Security

- The `claude` child runs `--permission-mode dontAsk` plus an explicit `--allowedTools`
  allowlist and a `--disallowedTools` denylist (the `ALLOWED_TOOLS` / `DISALLOWED_TOOLS`
  consts in `claude.rs` - tune them there). It is **never** `bypassPermissions`: anything off
  the allowlist is denied, and the Activity panel shows every tool as it runs. The chosen
  project directory is the intended blast radius (defense-in-depth, not an OS sandbox). A true
  per-tool interactive confirm awaits Claude Code's (currently undocumented)
  `--permission-prompt-tool` protocol.
- Strict **CSP** in `tauri.conf.json` (no remote origins; the only egress is the `claude` child
  and the checksummed model download done in Rust). A **Thinking watchdog** recovers the UI if a
  turn hangs.
- `getUserMedia` is audio-only, least-privilege, cancellation-safe; the `<<mood:...>>` parser is
  bounded; all rendered text uses `textContent` (never `innerHTML`). No API key is stored (the
  app uses the user's existing `claude` login). Keep `npm audit` clean.

## Mood tags (the orb's emotion)

The orb changes color by mood from a marker the Claude session emits at the very start of a
spoken reply:

```
<<mood:NAME>>
```

`NAME` is one of `neutral`, `focused`, `happy`, `concerned`, `error`, `curious`. The marker is
**always stripped** before TTS speaks it and before it shows in the caption, so it is never
heard or seen. No tag keeps the orb `neutral` (zero regression); the parser is tolerant
(case-insensitive, anywhere in the text). Convention for a voice session: begin spoken replies
with the `<<mood:NAME>>` that fits (`happy` on success, `concerned`/`error` on problems,
`focused` while working).

## Reuse, do not reinvent

- Drive any new renderer through the `ControllableAvatar` seam + the `avatarFactory` in
  `tauriAdapter` (that is how the orb replaced earlier renderers with zero controller changes).
- The demo (`/demo/`) and its legacy Three.js renderers + their tests are the host-free harness
  and the primary Vitest/Playwright surface; keep them green when touching shared code.
- `src/config` for settings, `src/mood` for the mood layer, `MediaTts` for amplitude-driven
  speech, `telemetry.ts` for HUD panels.
