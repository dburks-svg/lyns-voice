# Graph Report - .  (2026-08-23)

## Corpus Check
- 145 files · ~141,231 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1118 nodes · 2282 edges · 65 communities (55 shown, 10 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 27 edges (avg confidence: 0.81)
- Token cost: 211,776 input · 9,500 output

## Community Hubs (Navigation)
- Claude CLI Bridge (Rust)
- Whisper STT Engine
- Legacy Avatar Renderer
- Orb Renderer Internals
- CI, Specs and Security Docs
- Mic Audio Analysis
- ConPTY Terminal View
- TypeScript Build Config Refs
- Kokoro Neural TTS
- Avatar Config Store
- ConPTY Backend (Rust)
- Tauri Bundle Config
- SAPI TTS (Rust)
- Tauri Adapter Seam
- Speech Reactor
- Mood Color System
- Voice Signals and State
- Dev Dependencies
- Diff Viewer Panel
- App Shell and Settings
- GLTF Head Loader
- Speaking Screenshot HUD
- Tauri Window Permissions
- Session Manager
- Transcript Persistence
- Telemetry Panel Wiring
- Claude Bridge E2E Tests
- MediaTts Playback
- Avatar Controller Seam
- Runtime Dependencies
- Reply Sentence Streamer
- Package Metadata
- TTS Adapter Tests
- Telemetry Formatters
- NPM Scripts
- MediaTts Test Doubles
- Conductor Voice Arbitration
- Library Panel
- Project Dir History
- TTS Interface Types
- Mini PiP Mode
- Fleet Cost Meter
- Keyboard Shortcuts
- Conductor Protocol Markers
- Oracle Wake Word
- CI Status Polling (Rust)
- PCM Audio Worklet
- Propose Card UI
- Memory Logging (Rust)
- App Icon Identity
- ESLint Dep
- Happy DOM Dep
- TypeScript ESLint Dep
- Feature Request Form
- Claude Sidecar Doc

## God Nodes (most connected - your core abstractions)
1. `attachTauri()` - 37 edges
2. `bootstrap()` - 30 edges
3. `Avatar` - 27 edges
4. `AvatarController` - 24 edges
5. `compilerOptions` - 21 edges
6. `SpeechReactor` - 19 edges
7. `MediaTts` - 18 edges
8. `OrbAvatar` - 17 edges
9. `createRenderer()` - 17 edges
10. `TauriHandle` - 17 edges

## Surprising Connections (you probably didn't know these)
- `Issue template contact links (discussions + private security advisories)` --semantically_similar_to--> `SECURITY.md security model`  [INFERRED] [semantically similar]
  .github/ISSUE_TEMPLATE/config.yml → SECURITY.md
- `Per-tool permission cards: verified-not-shipped` --semantically_similar_to--> `Human-in-the-loop model (visibility + interrupt)`  [INFERRED] [semantically similar]
  CHANGELOG.md → SECURITY.md
- `Host-free demo harness HTML` --semantically_similar_to--> `Desktop app shell HTML (HUD, settings drawer, stage, caption)`  [INFERRED] [semantically similar]
  demo/index.html → index.html
- `setup()` --calls--> `attachTauri()`  [EXTRACTED]
  tests/tauriAdapter.test.ts → src/integration/tauriAdapter.ts
- `LYNS Voice` --conceptually_related_to--> `mcp-voice-hooks (retired browser-overlay host)`  [INFERRED]
  README.md → AVATAR_SPEC.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **GitHub Actions quality and security gates**  -  _github_workflows_ci_build_job, _github_workflows_ci_rust_job, _github_workflows_ci_security_job, _github_workflows_codeql_analyze_job [EXTRACTED 1.00]
- **Voice loop pipeline (STT -> Claude bridge -> TTS)**  -  readme_whisper_stt, readme_claude_bridge_sidecar, readme_kokoro_neural_tts, readme_voice_loop [EXTRACTED 1.00]
- **Dependabot remediation session 2026-08-23**  -  notes_security_2026_08_23_dependabot_fixes_postcss, notes_security_2026_08_23_dependabot_fixes_brace_expansion, notes_security_2026_08_23_dependabot_fixes_glib_dismissal [EXTRACTED 1.00]
- **Speaking state presentation: the orb centerpiece animates while the streaming caption renders the spoken reply beneath it**  -  docs_screenshots_speaking_holographic_orb, docs_screenshots_speaking_spoken_caption, docs_screenshots_speaking_speaking_state [INFERRED 0.85]
- **Oracle introduces itself as a voice conductor that spawns and steers parallel worker sessions**  -  docs_screenshots_speaking_oracle_session_panel, docs_screenshots_speaking_oracle_conductor, docs_screenshots_speaking_multi_session_conductor [EXTRACTED 1.00]

## Communities (65 total, 10 thin omitted)

### Community 0 - "Claude CLI Bridge (Rust)"
Cohesion: 0.08
Nodes (67): AsyncMutex, ChildStdin, HashSet, Active, Activity, allowed_tools_for(), allowed_tools_include_the_base_surface_plus_mcp_entries(), blank_to_none() (+59 more)

### Community 1 - "Whisper STT Engine"
Cohesion: 0.07
Nodes (55): AtomicBool, AtomicU32, Default, Request, Self, Sender, Active, audio_ctx_for() (+47 more)

### Community 2 - "Legacy Avatar Renderer"
Cohesion: 0.06
Nodes (31): bootstrap(), wireSpeakTest(), Avatar, defaultAmplitudeScale(), DEFAULTS, IDLE_PARAMS, RendererFactory, DeformationParams (+23 more)

### Community 3 - "Orb Renderer Internals"
Cohesion: 0.06
Nodes (48): AvatarOptions, GLTFLoaderFactory, colorUniform(), createCoreMaterial(), createDashedRing(), createDataPacketField(), createDataPacketMaterial(), createFilaments() (+40 more)

### Community 4 - "CI, Specs and Security Docs"
Cohesion: 0.06
Nodes (47): Bug report issue form, Issue template contact links (discussions + private security advisories), CI build job (lint, typecheck, unit, build, e2e), CI rust job (cargo test --lib), CI security job (npm audit, cargo audit, gitleaks), CodeQL analyze job (javascript-typescript), AVATAR_SPEC: real-time 3D desktop avatar overlay specification, Expected behavior rules for the four avatar states (+39 more)

### Community 5 - "Mic Audio Analysis"
Cohesion: 0.08
Nodes (11): wireMicTest(), computeBands(), edge(), computeLevel(), GetUserMedia, MicAnalyser, MicAnalyserOptions, SttCapture (+3 more)

### Community 6 - "ConPTY Terminal View"
Cohesion: 0.08
Nodes (17): base64ToBytes(), TauriApi, TauriEvent, TerminalInstance, UnlistenFn, PanelEntry, shortenPath(), TauriApi (+9 more)

### Community 7 - "TypeScript Build Config Refs"
Cohesion: 0.05
Nodes (39): demo, dist, dist-demo, DOM, DOM.Iterable, e2e, ES2022, node (+31 more)

### Community 8 - "Kokoro Neural TTS"
Cohesion: 0.17
Nodes (33): G2P, Session, download_file(), ensure_and_load(), ensure_voice(), f32_to_i16_clamps_and_scales(), KokoroState, load_vocab() (+25 more)

### Community 9 - "Avatar Config Store"
Cohesion: 0.12
Nodes (26): BreathingConfig, cloneConfig(), DEFAULT_CONFIG, FeatureFlags, GlowMode, MeshConfig, MoodSource, RotationConfig (+18 more)

### Community 10 - "ConPTY Backend (Rust)"
Cohesion: 0.12
Nodes (28): Box, Duration, MasterPty, Receiver, Send, drain_batch(), drain_batch_coalesces_queued_chunks_into_one(), drain_batch_returns_the_first_chunk_alone_on_a_quiet_channel() (+20 more)

### Community 11 - "Tauri Bundle Config"
Cohesion: 0.07
Nodes (28): icons/128x128@2x.png, icons/128x128.png, icons/32x32.png, icons/icon.icns, icons/icon.ico, nsis, debugApplicationIdSuffix, app (+20 more)

### Community 12 - "SAPI TTS (Rust)"
Cohesion: 0.20
Nodes (22): ISpVoice, Response, build_wav(), category_id_utf16(), dedupe_keeps_first_seen_order_and_drops_case_insensitive_dups(), dedupe_preserving_order(), list_voices(), lists_real_voices() (+14 more)

### Community 13 - "Tauri Adapter Seam"
Cohesion: 0.11
Nodes (4): attachTauri(), AvatarLike, TauriHandle, Watchdog

### Community 14 - "Speech Reactor"
Cohesion: 0.13
Nodes (3): SpeakFn, SpeechReactor, SpeechReactorOptions

### Community 15 - "Mood Color System"
Cohesion: 0.18
Nodes (13): clamp01(), lerp(), lerpHex(), packRgb(), toRgb(), MoodController, ParsedMood, parseMoodMarker() (+5 more)

### Community 16 - "Voice Signals and State"
Cohesion: 0.13
Nodes (15): AvatarState, prefersReducedMotion(), safeSetText(), deriveState(), VoiceSignals, AvatarFactory, ClaudeActivity, ClaudeDiff (+7 more)

### Community 17 - "Dev Dependencies"
Cohesion: 0.10
Nodes (21): @eslint/js, globals, devDependencies, @eslint/js, globals, @playwright/test, @tauri-apps/cli, three (+13 more)

### Community 18 - "Diff Viewer Panel"
Cohesion: 0.13
Nodes (10): DiffEntry, DiffPanel, DiffPanelOptions, RESIZE_DIRS, RESIZE_DIRS, SessionPanelOptions, attachDragResize(), computeSnap() (+2 more)

### Community 19 - "App Shell and Settings"
Cohesion: 0.19
Nodes (14): panelId(), wireSettings(), showOnboarding(), AppSettings, clampEffortToModel(), DEFAULT_SETTINGS, EFFORT_BY_MODEL, effortLevelsForModel() (+6 more)

### Community 20 - "GLTF Head Loader"
Cohesion: 0.21
Nodes (7): extractHeadGeometry(), GLTFLoaderLike, GLTFResultLike, loadHeadGeometry(), LoadHeadOptions, normalizeHeadGeometry(), VERSION

### Community 21 - "Speaking Screenshot HUD"
Cohesion: 0.17
Nodes (17): Claude Code Hooks Listing (bun index.ts handlers), CLAUDE CONNECTED Status Indicator, Cyan Tactical HUD Theme, Floating Diffs Panel, Holographic Orb Avatar, Library Panel (MCP servers + hooks), MCP Servers (railway, wisdom), Multi-Session Conductor (parallel worker sessions) (+9 more)

### Community 22 - "Tauri Window Permissions"
Cohesion: 0.12
Nodes (15): core:default, core:window:allow-outer-position, core:window:allow-request-user-attention, core:window:allow-set-always-on-top, core:window:allow-set-min-size, core:window:allow-set-position, core:window:allow-set-size, dialog:allow-open (+7 more)

### Community 23 - "Session Manager"
Cohesion: 0.20
Nodes (4): ManagedSession, SessionManager, SessionManagerDeps, SessionPanel

### Community 24 - "Transcript Persistence"
Cohesion: 0.35
Nodes (14): AppHandle, Option, PathBuf, Result, String, Vec, transcript_cleanup(), transcript_load_latest() (+6 more)

### Community 26 - "Claude Bridge E2E Tests"
Cohesion: 0.24
Nodes (4): emitTauriEvent(), getInvokeCalls(), installTauriMock(), seedOnboarded()

### Community 28 - "Avatar Controller Seam"
Cohesion: 0.16
Nodes (5): AvatarControllerOptions, ControllableAvatar, AvatarConfig, PaletteConfig, MoodLayer

### Community 29 - "Runtime Dependencies"
Cohesion: 0.15
Nodes (13): dependencies, @tauri-apps/api, @tauri-apps/plugin-dialog, @tauri-apps/plugin-notification, @xterm/addon-fit, @xterm/addon-webgl, @xterm/xterm, @tauri-apps/api (+5 more)

### Community 30 - "Reply Sentence Streamer"
Cohesion: 0.19
Nodes (6): createReplyStreamer(), emittableBoundary(), findBoundary(), ReplyStreamer, ReplyStreamerOptions, collect()

### Community 31 - "Package Metadata"
Cohesion: 0.17
Nodes (11): author, description, engines, node, license, name, repository, type (+3 more)

### Community 32 - "TTS Adapter Tests"
Cohesion: 0.20
Nodes (8): MediaTtsOptions, InvokeFn, ListenFn, splitForSpeech(), tauriTtsFetch(), toArrayBuffer(), setup(), speakingFactory()

### Community 33 - "Telemetry Formatters"
Cohesion: 0.26
Nodes (9): formatCost(), formatDuration(), formatTokens(), peakLevel(), TelemetryOptions, TelemetryRefs, TranscriptEntry, trimZero() (+1 more)

### Community 34 - "NPM Scripts"
Cohesion: 0.18
Nodes (11): scripts, build, dev, e2e:install, lint, preview, tauri, test (+3 more)

### Community 35 - "MediaTts Test Doubles"
Cohesion: 0.20
Nodes (6): AnalyserLike, AudioContextLike, BufferSourceLike, FetchLike, FetchResponseLike, FakeSource

### Community 36 - "Conductor Voice Arbitration"
Cohesion: 0.35
Nodes (7): ConductorVoice, ConductorVoiceDeps, createConductorVoice(), criticalLine(), digestLine(), joinNames(), harness()

### Community 37 - "Library Panel"
Cohesion: 0.29
Nodes (5): HookEntry, LibraryPanel, LibraryPanelOptions, RESIZE_DIRS, shortCommand()

### Community 38 - "Project Dir History"
Cohesion: 0.47
Nodes (9): DirHistory, history_load(), history_path(), history_save(), AppHandle, PathBuf, Result, String (+1 more)

### Community 39 - "TTS Interface Types"
Cohesion: 0.22
Nodes (3): MediaTtsLike, ThemeName, TauriAdapterOptions

### Community 41 - "Fleet Cost Meter"
Cohesion: 0.32
Nodes (3): createFleetMeter(), FleetMeter, formatCost()

### Community 42 - "Keyboard Shortcuts"
Cohesion: 0.48
Nodes (3): attachShortcuts(), isTextFocused(), ShortcutActions

### Community 43 - "Conductor Protocol Markers"
Cohesion: 0.43
Nodes (5): ConductorDirective, isWithinDir(), parseConductor(), ParsedConductor, toDirective()

### Community 44 - "Oracle Wake Word"
Cohesion: 0.43
Nodes (5): GREETING_WAKE, matchWake(), NAME, VOCATIVE_WAKE, WakeResult

### Community 46 - "CI Status Polling (Rust)"
Cohesion: 0.60
Nodes (4): ci_status(), CiStatus, Result, String

### Community 49 - "Memory Logging (Rust)"
Cohesion: 0.67
Nodes (3): log_rss(), process_mem_bytes(), Option

### Community 50 - "App Icon Identity"
Cohesion: 0.67
Nodes (3): LYNS Voice App Icon, Dialogue Duality Symbolism (Human-AI Voice Loop), Interlocking Rings Motif (Amber and Cyan)

## Knowledge Gaps
- **184 isolated node(s):** `name`, `version`, `license`, `author`, `type` (+179 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **10 thin communities (<3 nodes) omitted from report**  -  run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `devDependencies` connect `Dev Dependencies` to `ESLint Dep`, `Happy DOM Dep`, `TypeScript ESLint Dep`, `Package Metadata`?**
  _High betweenness centrality (0.036) - this node is a cross-community bridge._
- **Why does `MediaTts` connect `MediaTts Playback` to `Voice Signals and State`, `MediaTts Test Doubles`, `GLTF Head Loader`, `TTS Interface Types`?**
  _High betweenness centrality (0.028) - this node is a cross-community bridge._
- **Why does `bootstrap()` connect `Telemetry Panel Wiring` to `ConPTY Terminal View`, `Mini PiP Mode`, `Fleet Cost Meter`, `Keyboard Shortcuts`, `Conductor Protocol Markers`, `Tauri Adapter Seam`, `Mood Color System`, `Propose Card UI`, `Diff Viewer Panel`, `App Shell and Settings`, `Session Manager`?**
  _High betweenness centrality (0.021) - this node is a cross-community bridge._
- **What connects `name`, `version`, `license` to the rest of the system?**
  _184 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Claude CLI Bridge (Rust)` be split into smaller, more focused modules?**
  _Cohesion score 0.07724764686790003 - nodes in this community are weakly interconnected._
- **Should `Whisper STT Engine` be split into smaller, more focused modules?**
  _Cohesion score 0.07367641614216956 - nodes in this community are weakly interconnected._
- **Should `Legacy Avatar Renderer` be split into smaller, more focused modules?**
  _Cohesion score 0.05754475703324808 - nodes in this community are weakly interconnected._