# CLAUDE.md - Jarvis Avatar Project Guide

Real-time 3D neon-blue "Jarvis" avatar overlay (Three.js) for the `mcp-voice-hooks`
browser UI. The avatar pulses while idle, reacts to the microphone while listening,
spins/pulses while Claude is thinking, and deforms to speech cadence while Claude
replies. Everything runs 100% locally (browser-native Web Speech API, zero extra
API cost).

## ALWAYS: stay aligned with the spec

`AVATAR_SPEC.md` (repo root) is the source of truth. **On every session start, and
again after any context compaction/summary, re-read `AVATAR_SPEC.md` before
continuing** so the work never drifts from the original architecture, the four
phases, and the four behavioral states (Idle / Listening / Thinking / Speaking).
Do not edit `AVATAR_SPEC.md`.

## Working agreement (how this project is built)

- **Answer open questions as the Senior Engineer.** The owner has delegated
  implementation decisions. Make the call, record the rationale here, and proceed.
- **Clean code, security first, tests baked in as you build** (not bolted on later).
- **Phased delivery with commits between phases.** Build a phase fully (code +
  tests green), commit it, then begin the next phase. Four phases total.
- **Final phase opens the local browser** so the owner can test the avatar live.
- **No em dashes or en dashes** in any generated content (use hyphens, commas,
  colons, parentheses).

## Phase status: COMPLETE (all four phases built, audited, tested)

- [x] Phase 1 - Scaffold, vendored Three.js, idempotent injector, demo harness, this file.
- [x] Phase 2 - Neon-blue pulsing icosahedron with simplex-noise idle breathing.
- [x] Phase 3 - Four-state controller, mic-driven listening, boundary-driven speaking, voice-hooks adapter.
- [x] Phase 4 - Dark neon UI, responsive floating panel, per-state colors, final multi-agent
      security+completeness audit (findings fixed), Playwright e2e smoke, open browser.

Gate: 65 unit tests + 1 e2e smoke pass; lint + typecheck clean; npm audit clean.

## Commands

| Task | Command |
| --- | --- |
| Install deps | `npm install` |
| Vendor Three.js into `vendor/` | `npm run vendor:three` |
| Dev server + demo (opens `/demo/`) | `npm run dev` |
| Build injectable bundle (`dist/avatar.js`) | `npm run build:lib` |
| Type-check | `npm run typecheck` |
| Lint | `npm run lint` |
| Unit tests | `npm test` |
| E2E smoke (installs Chromium first) | `npm run e2e:install` then `npm run test:e2e` |
| Inject into mcp-voice-hooks | `npm run inject -- --path <index.html>` |
| Revert injection | `npm run inject:revert -- --path <index.html>` |

Pre-ship gate (run before each commit): `npm run lint && npm run typecheck && npm test`.

## Architecture

```
src/
  index.ts                  Public API barrel -> global `JarvisAvatar` (IIFE) + ESM for the demo
  avatar/Avatar.ts          Renderer/scene/camera/mesh/loop/resize/dispose (Phase 2)
  avatar/noise.ts           Simplex noise, pure + tested (Phase 2)
  avatar/deformation.ts     Vertex displacement math, pure + tested (Phase 2)
  avatar/shaders.ts         GLSL neon wireframe + fresnel glow (Phase 2)
  avatar/AvatarController.ts  idle|listening|thinking|speaking state machine (Phase 3)
  audio/MicAnalyser.ts      getUserMedia -> AnalyserNode -> amplitude, Listening (Phase 3)
  audio/SpeechReactor.ts    onboundary impulses + envelope, Speaking (Phase 3)
  integration/voiceHooksAdapter.ts  Observes mcp-voice-hooks signals -> controller (Phase 3)
demo/                       Standalone four-state harness (primary dev/test/demo surface)
scripts/inject.mjs          Idempotent, reversible injector CLI
scripts/injector-core.mjs   Pure string transforms for the injector (unit-tested)
vendor/three.min.js         Vendored Three.js r128 UMD (global THREE), committed
```

**Build model:** TypeScript source. The demo imports `src` directly through Vite
for fast iteration. The injectable artifact is a global IIFE (`dist/avatar.js`)
built by `vite.lib.config.ts` with `three` external and bound to the global
`THREE` from `vendor/three.min.js`. Same Three.js version (r128) at dev, test, and
runtime.

## Key decisions and deviations from the literal spec (with rationale)

1. **Repo-owned source + idempotent injector** instead of hand-editing installed
   package files. Editing `node_modules` is brittle (wiped on update) and
   untestable. The injector backs up the original, inserts marked `<script>` tags,
   is idempotent (safe to re-run), and reversible (`--revert`).
2. **Vendored Three.js (no runtime CDN).** Security-first and offline-capable;
   matches the "100% local" requirement. The spec's CDN tag is a documented
   fallback only.
3. **Listening uses a real mic `AnalyserNode`; Speaking uses `onboundary`
   word-impulses + a synthetic envelope.** Browser `speechSynthesis` output cannot
   be routed into an `AnalyserNode`/`MediaStream`, so the spec's "AudioContext
   capture of TTS output" is infeasible for Web Speech synthesis. Mic analysis IS
   feasible and drives Listening; word-boundary events drive Speaking, with a
   time-based envelope fallback for voices that do not emit boundary events.
4. **No unattended install of `mcp-voice-hooks` and no edits to the user's MCP
   config.** That is a separately-approved step (see below).

## Security rules

- Vendored dependencies only; no runtime CDN/remote fetch from avatar code; no `eval`.
- Injector: validate the path (reject null bytes / non-`index.html` / symlinks),
  sentinel-verify the target is really an mcp-voice-hooks page, back up before writing,
  idempotent, reversible. Copied assets back up any pre-existing host file of the same
  name and are removed/restored on `--revert` (full reversibility).
- `getUserMedia` requested on a user gesture, least privilege, tracks stopped when
  not listening; `start()` is cancellation-safe so a `stop()` during the permission
  prompt cannot leak the mic; graceful fallback if permission is denied.
- Speech-synthesis and SpeechRecognition patches restore only if we still own the
  slot (never clobber a patcher installed after us) and refuse to double-wrap.
- Any transcript/user text rendered to the DOM uses `textContent`, never `innerHTML`.
- Dev server binds to `127.0.0.1` only.
- Keep the toolchain free of known vulnerabilities (`npm audit` clean).

## Audit (Phase 4)

A four-lens adversarial audit (security / spec-completeness / correctness / coverage)
ran before the final commit. All HIGH/MEDIUM findings were fixed: build now emits
`dist/avatar.css` (host overlay was unstyled); the `MicAnalyser` start/stop race is
closed; the injector rejects symlinks and backs up/restores copied assets; the
speech-recognition/synthesis patches restore conditionally; and idle now shifts to the
spec's dark navy/slate spectrum. Regression tests were added for each fix.

## Mood tags (the avatar's emotion)

The head changes color/glow by mood. The mood comes from a tiny marker the Claude
session emits at the very start of a spoken reply:

```
<<mood:NAME>>
```

`NAME` is one of: `neutral`, `focused`, `happy`, `concerned`, `error`, `curious`.
The avatar reads the mood and ALWAYS strips every `<<mood:...>>` marker before TTS
speaks it and before it shows in the transcript, so it is never heard or seen. No
tag at all keeps the avatar `neutral` (zero regression). The parser is tolerant
(case-insensitive, anywhere in the text) so a stray tag is silently removed, never
spoken.

Convention for the voice session: begin spoken replies with `<<mood:NAME>>` and
nothing else on that marker, choosing the mood that fits (for example
`<<mood:happy>>` on success, `<<mood:concerned>>`/`<<mood:error>>` on problems,
`<<mood:focused>>` while working). Parsing is local and free (it runs off the same
Claude session), with an optional API-key tone-analysis path deferred to a later
phase. Platform note: the marker is stripped on the BROWSER-voice path (Windows
default) and in the transcript; the macOS `system` voice path bypasses the browser
and is not stripped, so use the browser voice when you want the mood feature.

## Live mcp-voice-hooks integration (DONE)

`mcp-voice-hooks` v1.0.40 is installed and the avatar overlays its real Voice Mode UI.
What was wired up (2026-06-19):

- Installed globally: `C:\Users\mstar\AppData\Roaming\npm\node_modules\mcp-voice-hooks`
  (server entry `dist/unified-server.js`, serves `public/index.html` on
  `http://localhost:5111`).
- Avatar injected into its `public/index.html` (idempotent block + copied
  `avatar.js` / `avatar.css` / `three.min.js`; original saved as
  `index.html.avatar-backup`). Verified live: the neon orb floats top-right of the
  conversation area (screenshot at `test-results/voice-hooks-injected.png`).
- Voice hooks installed for this project (`.claude/settings.local.json`, gitignored).
- MCP server registered for project `D:\AI Entity` as `voice-hooks`
  (`claude mcp add voice-hooks -- node <...>\mcp-voice-hooks\bin\cli.js`), pointed at
  the injected global copy so the avatar is what Claude Code serves. `claude mcp list`
  reports it Connected.

### Use it (after a Claude Code restart)

1. Restart Claude Code in `D:\AI Entity` (run `claude`). The `voice-hooks` MCP server
   starts and opens `http://localhost:5111` (the injected UI) after ~3s.
2. Use **Chrome** (browser speech recognition); enable voice responses for TTS.
3. Click **Start Listening** and speak; send one CLI message to begin the conversation.
   The avatar breathes (idle), compresses to your voice (listening), pulses while Claude
   works (thinking), and reacts to word boundaries while Claude speaks.

### Maintain / undo

- Re-inject after a package update: `npm run build:lib` then
  `npm run inject -- --path "C:\Users\mstar\AppData\Roaming\npm\node_modules\mcp-voice-hooks\public\index.html"`.
- Remove the avatar only: `npm run inject:revert -- --path <same path>`.
- Fully unregister: `claude mcp remove voice-hooks` and
  `node <...>\mcp-voice-hooks\bin\cli.js uninstall` (removes the project voice hooks).

### Platform note

`mcp-voice-hooks` is macOS-oriented: browser STT/TTS and the avatar overlay work on
Windows with Chrome, but *system* TTS (`say`) is mac-only, and the delivery hooks use
shell-style commands. If spoken input does not auto-deliver to Claude on Windows, use
the browser's trigger-word/Send control to push utterances. The avatar itself is
platform-independent.

The standalone demo (`npm run dev`) remains available to exercise all four states
without the voice stack.
