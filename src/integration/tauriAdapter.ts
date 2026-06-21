/**
 * The Tauri desktop host adapter: the seam between the native backend and the
 * avatar's four-state controller. It produces `VoiceSignals` transitions from
 * Tauri commands/events and feeds them through `deriveState` to the controller.
 *
 * Phase 1 wires only the TTS path: the Rust `tts_synthesize` command renders a
 * mood-stripped line to a WAV byte buffer with native Windows SAPI (no
 * PowerShell child process), and that buffer is played through the EXISTING
 * `MediaTts`. Reusing `MediaTts` is the whole point: its `AnalyserNode` envelope
 * drives the Speaking animation from the real audio amplitude, exactly as the
 * spec wanted ("capture the TTS output stream"), and the mood tag is parsed and
 * stripped before the text is ever spoken or captioned. STT (`stt://*`) and the
 * Claude bridge (`claude://*`) land in Phases 2-3 on this same `signals`/`sync`
 * spine.
 */

import type { AvatarOptions } from '../avatar/Avatar';
import { QOrbAvatar, themeToPalette } from '../avatar/QOrbAvatar';
import {
  AvatarController,
  type AvatarState,
  type ControllableAvatar,
} from '../avatar/AvatarController';
import { MediaTts, type MediaTtsOptions } from '../audio/MediaTts';
import { SttCapture } from '../audio/SttCapture';
import { MoodController } from '../mood/MoodController';
import { parseMoodMarker } from '../mood/moodProtocol';
import { THEME_PALETTES, type ThemeName } from '../config/config';
import { prefersReducedMotion, safeSetText } from './dom';
import { deriveState, type VoiceSignals } from './signals';
import { createConductorVoice } from './conductorVoice';
import { parseConductor } from './conductorProtocol';

/** Args accepted by `invoke`: a JSON record, or a raw binary body (audio frames). */
type InvokeArgs = Record<string, unknown> | ArrayBuffer | Uint8Array;

/** Minimal shape of Tauri's `invoke`; injectable so the unit tests stay headless. */
export type InvokeFn = <T>(cmd: string, args?: InvokeArgs) => Promise<T>;

/** Who said a transcript line: the user (mic) or Q (spoken reply). */
export type TranscriptRole = 'user' | 'q';

/** A tool Claude invoked this turn (from `claude://activity`); feeds the HUD. */
export interface ClaudeActivity {
  name: string;
  target: string;
}

/** A file diff from an Edit or Write tool (from `claude://diff`); feeds the diff viewer. */
export interface ClaudeDiff {
  tool: string;
  file_path: string;
  old_string?: string;
  new_string?: string;
  content?: string;
}

/** Per-turn token usage + cost (from `claude://usage`); feeds the HUD telemetry. */
export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
}

/** Minimal shape of Tauri's event `listen`; injectable for the same reason. */
export type ListenFn = <T>(event: string, handler: (payload: T) => void) => Promise<() => void>;

/**
 * The structural renderer surface the adapter drives: the four-state
 * `ControllableAvatar` contract plus the small lifecycle the host needs. Both the
 * Three.js `Avatar` and the `QOrbAvatar` satisfy it, so either can be injected.
 */
export interface AvatarLike extends ControllableAvatar {
  reducedMotion: boolean;
  beforeRender: ((time: number) => void) | null;
  mount(container: HTMLElement): void;
  start(): void;
  resize(width: number, height: number): void;
  dispose(): void;
}

/** Builds the renderer for the host; defaults to the `QOrbAvatar`. */
export type AvatarFactory = (options?: AvatarOptions) => AvatarLike;

const defaultAvatarFactory: AvatarFactory = (options) => new QOrbAvatar(options);

/** How long to wait for a Claude reply before recovering from a hung Thinking. */
const WATCHDOG_MS = 120_000;
/** How often to reassure ("Still working…") during a long Thinking turn. */
const WATCHDOG_NOTICE_MS = 30_000;

/** The timer surface the watchdog needs (injectable so tests use fake timers). */
type TimerView = Pick<Window, 'setTimeout' | 'clearTimeout'>;

export interface Watchdog {
  /** Start the countdown (no-op if already armed). */
  arm(): void;
  /** Cancel the countdown (no-op if not armed). */
  clear(): void;
}

/**
 * A single-shot, re-armable timeout. `arm()` while already armed is a no-op (the
 * countdown is not restarted), so repeated syncs during one Thinking turn don't
 * push the deadline out. An optional `progress` fires `onTick` every `everyMs`
 * until the turn resolves (clear) or the deadline fires, so a long turn can reassure
 * the user instead of looking frozen. Pure but for the injected timer; unit-tested.
 */
export function createWatchdog(
  view: TimerView,
  ms: number,
  onTimeout: () => void,
  progress?: { everyMs: number; onTick: () => void },
): Watchdog {
  let timer: ReturnType<TimerView['setTimeout']> | null = null;
  let tick: ReturnType<TimerView['setTimeout']> | null = null;
  const clearTick = (): void => {
    if (tick !== null) {
      view.clearTimeout(tick);
      tick = null;
    }
  };
  // Chain setTimeouts (not setInterval) so the injected timer surface stays minimal
  // and fake-timer tests drive it deterministically.
  const scheduleTick = (): void => {
    if (!progress) {
      return;
    }
    tick = view.setTimeout(() => {
      tick = null;
      progress.onTick();
      scheduleTick();
    }, progress.everyMs);
  };
  return {
    arm(): void {
      if (timer !== null) {
        return;
      }
      timer = view.setTimeout(() => {
        timer = null;
        clearTick();
        onTimeout();
      }, ms);
      scheduleTick();
    },
    clear(): void {
      if (timer !== null) {
        view.clearTimeout(timer);
        timer = null;
      }
      clearTick();
    },
  };
}

/** The injectable `fetchImpl` shape `MediaTts` accepts (without exporting its internals). */
type FetchImpl = NonNullable<MediaTtsOptions['fetchImpl']>;

/**
 * Coerce whatever the IPC layer hands back into an `ArrayBuffer` for
 * `decodeAudioData`. A `tauri::ipc::Response` resolves to an `ArrayBuffer`, but
 * we defensively also accept a typed-array view or a plain number array so a
 * change in the IPC byte encoding can never silently break playback.
 */
export function toArrayBuffer(raw: unknown): ArrayBuffer {
  if (raw instanceof ArrayBuffer) {
    return raw;
  }
  if (ArrayBuffer.isView(raw)) {
    const view = raw as ArrayBufferView;
    // Copy into a fresh buffer so the result is always a plain ArrayBuffer
    // (the source could be a view onto a SharedArrayBuffer).
    const out = new Uint8Array(view.byteLength);
    out.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    return out.buffer;
  }
  if (Array.isArray(raw)) {
    return new Uint8Array(raw as number[]).buffer;
  }
  return new ArrayBuffer(0);
}

/** Callback that provides current TTS settings for each synthesis call. */
export type TtsSettingsGetter = () => { rate: number; pitch: number; voice: string };

/**
 * A `MediaTts` `fetchImpl` that ignores the URL and synthesizes through the Rust
 * `tts_synthesize` command. `MediaTts` posts `{ text }` as the JSON body, so we
 * read the text back out of it; on any failure we report `ok: false` so the
 * caller falls back gracefully (matching the server-route contract).
 */
export function tauriTtsFetch(invoke: InvokeFn, getSettings?: TtsSettingsGetter): FetchImpl {
  return async (_input, init) => {
    let text = '';
    if (init?.body) {
      try {
        text = (JSON.parse(init.body) as { text?: string }).text ?? '';
      } catch {
        text = '';
      }
    }
    try {
      const s = getSettings?.() ?? { rate: 0, pitch: 0, voice: '' };
      const args: Record<string, unknown> = { text };
      if (s.rate) args.rate = s.rate;
      if (s.pitch) args.pitch = s.pitch;
      if (s.voice) args.voice = s.voice;
      const raw = await invoke<unknown>('tts_synthesize', args);
      const bytes = toArrayBuffer(raw);
      return { ok: true, arrayBuffer: async () => bytes };
    } catch {
      return { ok: false, arrayBuffer: async () => new ArrayBuffer(0) };
    }
  };
}

export interface TauriAdapterOptions {
  /** Mount target for the avatar canvas (full-window in the desktop shell). */
  root: HTMLElement;
  /** Optional caption element; the spoken (mood-stripped) text is shown here. */
  caption?: HTMLElement | null;
  /** Optional label that mirrors the current avatar state (debug). */
  statusLabel?: HTMLElement | null;
  /** Passed straight to the avatar factory (colors, etc.). */
  avatarOptions?: AvatarOptions;
  /** Injectable renderer factory; defaults to the `QOrbAvatar`. */
  avatarFactory?: AvatarFactory;
  /** Injectable `invoke`; defaults to lazy `@tauri-apps/api/core`. */
  invoke?: InvokeFn;
  /** Injectable event `listen`; defaults to lazy `@tauri-apps/api/event`. */
  listen?: ListenFn;
  /** Called with each finalized STT utterance (Phase 3 wires this to Claude). */
  onUtterance?: (text: string) => void;
  /** Transcript stream: user utterances and spoken Q replies (HUD chat). */
  onTranscript?: (role: TranscriptRole, text: string) => void;
  /** Each tool Claude invokes this turn (HUD activity feed). */
  onActivity?: (activity: ClaudeActivity) => void;
  /** File diff from Edit/Write tools (diff viewer panel). */
  onDiff?: (diff: ClaudeDiff) => void;
  /** A live session stream line (assistant narration / command output) for the panel. */
  onStream?: (line: { kind: string; text: string }) => void;
  /** Conductor directive: spawn a worker session (from a `<<spawn:...>>` marker in Q's reply). */
  onConductorSpawn?: (d: { name: string; dir: string; task: string }) => void;
  /** Conductor directive: relay a message to a named worker (`<<tell:...>>`). */
  onConductorTell?: (d: { name: string; message: string }) => void;
  /** Conductor directive: Q proposes splitting work; render an approve card (`<<propose:...>>`). */
  onConductorPropose?: (d: { summary: string }) => void;
  /** Per-turn token usage + cost (HUD telemetry). */
  onUsage?: (usage: ClaudeUsage) => void;
  /** Live mic frequency bands per audio frame (HUD waveform). */
  onBands?: (bands: Float32Array) => void;
  /** Injectable window; defaults to the global `window`. */
  view?: Window;
  /** Provides current TTS settings (rate/pitch/voice) for each synthesis call. */
  ttsSettings?: TtsSettingsGetter;
  /** Provides the preferred mic device ID for STT capture. */
  micDeviceId?: () => string;
  /** Initial theme applied on mount to avoid a 1-frame cyan flash. */
  initialTheme?: ThemeName;
  /** Auto-reconnect status updates (attempt count, success/failure). */
  onReconnectStatus?: (status: { attempting: boolean; attempt: number; maxAttempts: number }) => void;
  /** Whether auto-reconnect is enabled (default true). */
  autoReconnect?: boolean;
  /** Whether to show a system notification when a turn ends while backgrounded. */
  notifyOnTurnEnd?: boolean;
  /** Override the Thinking watchdog timeout in ms (default 120000). */
  watchdogMs?: number;
  /** Voice barge-in: a spoken utterance during a reply cuts it off. Getter so the
   *  settings toggle takes effect live (default treated as off when absent). */
  bargeIn?: () => boolean;
}

export interface TauriHandle {
  avatar: AvatarLike;
  controller: AvatarController;
  /** Speak a (possibly mood-tagged) line: tint by mood, caption it, synth + animate. */
  speak(text: string): Promise<boolean>;
  /** Start mic capture + the Rust STT worker (call from a user gesture). */
  startListening(): Promise<boolean>;
  /** Stop mic capture + the STT worker. */
  stopListening(): void;
  /** Whether the mic is currently capturing. */
  isListening(): boolean;
  /** Start the Claude Code sidecar in `dir` with optional per-session model/effort. */
  startClaude(dir?: string, model?: string, effort?: string): Promise<boolean>;
  /** Stop the Claude sidecar; utterances revert to caption-only. */
  stopClaude(): void;
  /** Cancel the in-flight turn without disconnecting (barge-in / Escape). */
  cancelClaude(): void;
  /** Submit typed text to the live session (typed = voice fallback, same path). */
  submitText(text: string): void;
  /** Interrupt an in-flight turn (barge-in): stop speaking or cancel thinking. Returns
   *  whether anything was interrupted (so Escape can fall through to closing a panel). */
  interrupt(): boolean;
  /** Announce a worker session's finished turn through the conductor voice (error =>
   *  critical interrupt at the next pause; success => batched digest). */
  announce(name: string, isError: boolean): void;
  /** Whether the Claude sidecar is connected. */
  isClaudeConnected(): boolean;
  /** Manual state override (debug cluster today; direct control later). */
  setState(state: AvatarState): void;
  /** Switch the orb's color theme at runtime. */
  setTheme(theme: ThemeName): void;
  /** Cancel any pending auto-reconnect (e.g., user clicked disconnect during retry). */
  cancelReconnect(): void;
  dispose(): void;
}

/**
 * Mount the avatar full-window in the Tauri webview and bind the TTS path. The
 * avatar rendering, controller, mood layer, and `MediaTts` are reused verbatim;
 * only the wiring is new.
 */
export function attachTauri(options: TauriAdapterOptions): TauriHandle {
  const view = options.view ?? window;
  const invoke = options.invoke ?? defaultInvoke;

  const initialTheme = options.initialTheme;
  const initialPaletteConfig = initialTheme ? THEME_PALETTES[initialTheme] : undefined;
  const avatarOpts = initialPaletteConfig
    ? { ...options.avatarOptions, initialPalette: themeToPalette(initialPaletteConfig) }
    : options.avatarOptions;

  const avatar = (options.avatarFactory ?? defaultAvatarFactory)(avatarOpts);
  avatar.reducedMotion = prefersReducedMotion(view);
  avatar.mount(options.root);

  // The seam: a host reduces what it observes to these three booleans; the
  // controller renders the priority-ordered state. Phase 1 only flips `speaking`.
  const signals: VoiceSignals = { micActive: false, speaking: false, pendingResponse: false };

  // Mood tints color/glow on top of the activity state; neutral is pass-through.
  const mood = new MoodController();

  const controller = new AvatarController({
    avatar,
    onStateChange: (state) => {
      safeSetText(options.statusLabel ?? null, state);
      // Reflect the state onto the body so the FUI layer (panels, HUD) can tint
      // itself per state in pure CSS. Outside the voice path; purely cosmetic.
      const body = view.document.body as HTMLElement | null;
      if (body) {
        body.dataset.state = state;
      }
    },
    moodProvider: mood,
  });
  if (initialPaletteConfig) controller.setPalette(initialPaletteConfig);
  avatar.beforeRender = (time) => controller.tick(time);
  avatar.start();

  // The stage IS the window in the desktop app, so size the canvas to it.
  const fit = (): void => avatar.resize(view.innerWidth, view.innerHeight);
  fit();
  view.addEventListener('resize', fit);

  // Thinking watchdog: a hung Claude turn (the child wedges and never emits a
  // `result`) would otherwise leave the avatar stuck in Thinking forever. When a
  // response is pending (and not yet speaking) the watchdog is armed; if it fires,
  // drop out of Thinking and surface a message. It is cleared the moment the turn
  // resolves (speaking/idle) or on dispose.
  const watchdog = createWatchdog(
    view,
    options.watchdogMs ?? WATCHDOG_MS,
    () => {
      if (signals.pendingResponse && !signals.speaking) {
        console.warn('[tauri-claude] watchdog: no reply in time; recovering from Thinking');
        safeSetText(
          options.caption ?? null,
          'Claude did not respond in time; the turn was dropped. Please try again.',
        );
        signals.pendingResponse = false;
        sync();
      }
    },
    {
      everyMs: WATCHDOG_NOTICE_MS,
      onTick: () => {
        // Reassure during a long turn so a working Claude does not look frozen.
        if (signals.pendingResponse && !signals.speaking) {
          safeSetText(options.caption ?? null, 'Still working…');
        }
      },
    },
  );

  const sync = (): void => {
    // While a Claude response is pending (Thinking), suppress the Listening STATE
    // even if the mic is still engaged, so the four-state loop is visible
    // hands-free. The live amplitude still drives the reaction via setMicLevel.
    const micActive = signals.micActive && !signals.pendingResponse;
    // Arm/disarm the hung-turn watchdog alongside the Thinking state.
    if (signals.pendingResponse && !signals.speaking) {
      watchdog.arm();
    } else {
      watchdog.clear();
    }
    controller.setState(deriveState({ ...signals, micActive }));
  };

  // Claude replies can exceed the TTS length cap, so a reply is spoken sentence by
  // sentence from a queue: each chunk is a small WAV, and onSpeakingEnd pumps the
  // next until the queue drains (then -> idle).
  const speechQueue: string[] = [];
  // Fire the "voice unavailable" notice at most once per reply (not once per chunk).
  let ttsNoticeFired = false;

  const onSpeakingStart = (): void => {
    signals.speaking = true;
    signals.pendingResponse = false;
    sync();
  };
  const onSpeakingEnd = (): void => {
    if (speechQueue.length > 0) {
      pumpSpeech();
    } else {
      signals.speaking = false;
      sync();
      conductorVoice.flush(); // the now-free voice can speak a worker announcement
    }
  };
  const onBoundary = (): void => controller.pulse();

  // Server-audio TTS reused as native TTS: the WAV bytes come from Rust SAPI via
  // `tts_synthesize`, decoded and played through Web Audio, with the Speaking
  // animation driven off the real amplitude envelope.
  const mediaTts = new MediaTts({
    fetchImpl: tauriTtsFetch(invoke, options.ttsSettings),
    onSpeakingStart,
    onSpeakingEnd,
    onBoundary,
  });

  // Resume the audio context on the first gesture so WebView2 autoplay allows
  // playback. Cheap and idempotent; kept live so a later suspend is recovered.
  const unlockAudio = (): void => mediaTts.unlock();
  view.document.addEventListener('pointerdown', unlockAudio, true);

  // Speak the next queued chunk. No native-speechSynthesis fallback by design:
  // this host's browser engine is silent (the whole reason SAPI exists), so a
  // failed chunk is logged and skipped rather than retried elsewhere. Hoisted so
  // onSpeakingEnd (declared above) can call it.
  function pumpSpeech(): void {
    if (mediaTts.isSpeaking) {
      return;
    }
    const next = speechQueue.shift();
    if (next === undefined) {
      // Always sync on drain (even if every chunk failed and speaking was never
      // set), so the avatar never stays stuck on the prior state.
      signals.speaking = false;
      sync();
      return;
    }
    void mediaTts.speak(next).then((ok) => {
      if (!ok) {
        console.warn('[tauri-tts] native synthesis failed; caption shown without audio');
        if (!ttsNoticeFired) {
          ttsNoticeFired = true;
          // Surface it once per reply (toast) so a silent failure is not console-only;
          // the reply text is already in the caption.
          void import('@tauri-apps/plugin-notification').then(({ sendNotification }) => {
            sendNotification({ title: 'Q', body: 'Voice output unavailable; the reply is shown as text.' });
          }).catch(() => undefined);
        }
        pumpSpeech(); // skip the failed chunk; keep the reply moving
      }
    });
  }

  const speak = async (text: string): Promise<boolean> => {
    // Mood is parsed and STRIPPED here, before the text is spoken or captioned,
    // so the `<<mood:...>>` marker is never heard or shown (the spec contract).
    const parsed = parseMoodMarker(text);
    if (parsed.mood) {
      mood.setMood(parsed.mood);
    }
    safeSetText(options.caption ?? null, parsed.stripped);
    options.onTranscript?.('q', parsed.stripped); // HUD chat log
    const chunks = splitForSpeech(parsed.stripped);
    if (chunks.length === 0) {
      return true;
    }
    ttsNoticeFired = false; // re-arm the at-most-once voice-unavailable notice per reply
    speechQueue.push(...chunks);
    pumpSpeech();
    return true;
  };

  // The conductor's single voice across the fleet: a worker session's finished turn is
  // announced here, courteously, only when the voice channel is free (a critical error
  // at the next pause; successes batched into a digest). All via the existing speak().
  const voiceFree = (): boolean =>
    !signals.speaking && !signals.pendingResponse && !mediaTts.isSpeaking && speechQueue.length === 0;
  const conductorVoice = createConductorVoice({
    speak: (t) => void speak(t),
    voiceFree,
    timer: view,
  });

  // --- STT (Phase 2): local Whisper + VAD auto-send-on-pause ----------------
  const listen = options.listen ?? defaultListen;

  // One mic stream, dual-tapped: the analyser drives the Listening visual, the
  // worklet pushes 16 kHz Int16 frames to the Rust VAD/STT worker.
  const capture = new SttCapture({
    onFrame: (frame) => {
      void invoke('stt_push_frame', frame.buffer as ArrayBuffer).catch(() => undefined);
    },
    onLevel: (level) => controller.setMicLevel(level),
    onBands: (bands) => {
      controller.setMicBands(bands);
      options.onBands?.(bands);
    },
    get deviceId() { return options.micDeviceId?.() ?? ''; },
  });

  // The Listening STATE follows the mic being engaged (set in start/stopListening),
  // not the per-phrase VAD: the live amplitude (onLevel) already drives the
  // reaction, so coupling the state to VAD onset/offset would only strobe it to
  // idle during the inter-phrase pauses. `stt://final` delivers the recognized
  // utterance on a pause.
  const unlisteners: Array<() => void> = [];
  const addListener = <T>(event: string, handler: (payload: T) => void): void => {
    void listen<T>(event, handler).then((un) => unlisteners.push(un));
  };
  // Submit text to the live session: turn-taking guard, transcript, lock Thinking,
  // then claude_submit. Shared by voice (stt://final) and typed input (submitText),
  // so the keyboard is a true co-equal path to the mic. Hoisted so both callers and
  // the returned handle can reach it.
  function submitToClaude(text: string): void {
    // Turn-taking: ignore input while Claude is thinking or speaking (this also keeps
    // the avatar from picking up its own TTS as a new request).
    if (signals.pendingResponse || signals.speaking) {
      return;
    }
    safeSetText(options.caption ?? null, text);
    options.onTranscript?.('user', text); // HUD chat log
    // Lock the turn synchronously NOW (before claude://thinking round-trips), so a
    // back-to-back input is rejected by the guard above. Clear it if the submit IPC
    // rejects, so a failed submit never wedges the UI in Thinking.
    signals.pendingResponse = true;
    sync();
    void invoke('claude_submit', { id: currentSessionId, text }).catch((e: unknown) => {
      console.warn('[tauri-claude] submit', e);
      signals.pendingResponse = false;
      sync();
    });
  }

  // Barge-in: cut off an in-flight turn. While speaking, just stop talking (the turn
  // already completed). While thinking, abandon the turn via cancelClaude. Returns
  // whether anything was interrupted, so Escape can fall through to closing a panel.
  function interrupt(): boolean {
    if (signals.speaking) {
      speechQueue.length = 0;
      mediaTts.stop();
      signals.speaking = false;
      sync();
      return true;
    }
    if (signals.pendingResponse) {
      cancelClaude();
      return true;
    }
    return false;
  }

  addListener<{ text: string }>('stt://final', (p) => {
    const text = (p.text ?? '').trim();
    if (!text) {
      return;
    }
    if (claudeConnected) {
      // Voice barge-in (opt-in): if Q is mid-reply, cut him off and take the floor.
      if (options.bargeIn?.() && signals.speaking) {
        interrupt();
      }
      submitToClaude(text);
    } else {
      safeSetText(options.caption ?? null, text);
      options.onTranscript?.('user', text); // HUD chat log
      options.onUtterance?.(text);
    }
  });
  let dlLast = 0;
  let dlLastT = 0;
  addListener<{ state: string; downloaded: number; total: number }>('stt://model', (p) => {
    if (p.state === 'downloading') {
      const pct = p.total > 0 ? Math.floor((p.downloaded / p.total) * 100) : 0;
      // Estimate speed + ETA from the delta since the last progress event so the
      // ~140 MB first-run download is not an opaque percentage.
      const now = performance.now();
      let suffix = '';
      if (dlLastT > 0 && p.total > 0 && p.downloaded > dlLast) {
        const bps = ((p.downloaded - dlLast) / (now - dlLastT)) * 1000;
        if (bps > 0) {
          const remain = Math.ceil((p.total - p.downloaded) / bps);
          suffix = ` (${(bps / 1e6).toFixed(1)} MB/s, ~${remain}s left)`;
        }
      }
      dlLast = p.downloaded;
      dlLastT = now;
      safeSetText(options.caption ?? null, `Downloading speech model… ${pct}%${suffix}`);
    } else if (p.state === 'ready') {
      safeSetText(options.caption ?? null, '');
    } else if (p.state === 'error') {
      // A download/load failure: clear the stuck "Downloading…" caption and drop
      // out of Listening rather than hanging there forever.
      safeSetText(options.caption ?? null, 'Speech model unavailable (see logs)');
      signals.micActive = false;
      sync();
    }
  });
  addListener<{ text: string }>('stt://error', (p) => {
    console.warn('[tauri-stt]', p.text);
  });

  const startListening = async (): Promise<boolean> => {
    mediaTts.unlock();
    // Kick off the Rust worker (loads/downloads the model on first run); capture
    // begins in parallel (early frames before the worker exists are dropped).
    void invoke('stt_start').catch((e: unknown) => console.warn('[tauri-stt] start', e));
    const ok = await capture.start();
    if (ok) {
      signals.micActive = true; // mic engaged => Listening (see note above)
      sync();
    }
    return ok;
  };
  const stopListening = (): void => {
    capture.stop();
    void invoke('stt_stop').catch(() => undefined);
    signals.micActive = false;
    sync();
  };

  // Visibility tracking for background notifications.
  let windowFocused = !view.document.hidden;
  view.document.addEventListener('visibilitychange', () => {
    windowFocused = !view.document.hidden;
  });
  const notifyOnTurnEnd = options.notifyOnTurnEnd !== false;

  // --- Claude bridge (Phase 3): the full voice loop -------------------------
  // onUtterance -> claude_submit -> Thinking -> spoken reply (with mood) -> idle.
  let claudeConnected = false;
  let userDisconnected = false;
  let lastDir = '';
  let lastModel = '';
  let lastEffort = '';
  // The active session's id and its event unlisteners. Claude events are namespaced
  // `claude://{id}/*`, so the subscription is per-session and torn down on stop/replace.
  let currentSessionId: string | null = null;
  let claudeUnlisteners: Array<() => void> = [];
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const MAX_RECONNECT = 5;
  const autoReconnect = options.autoReconnect !== false;

  // Subscribe to one session's namespaced events. Hoisted so `startClaude` (declared
  // below) can call it; its handlers reference `startClaude` only at event time, by
  // which point it is initialized. Unlisteners collect into `claudeUnlisteners` so the
  // set can be torn down independently when the session stops or is replaced.
  function subscribeClaude(id: string): void {
    const wire = <T>(kind: string, handler: (p: T) => void): void => {
      void listen<T>(`claude://${id}/${kind}`, handler).then((un) => {
        claudeUnlisteners.push(un);
      });
    };
    // The conductor's spawn/tell/propose markers can appear in the live narration OR the
    // final reply. Dispatch each once per turn (dedup by content), so a marker caught while
    // streaming is not re-fired at turn-end. The set is cleared when the turn ends.
    const dispatchedDirectives = new Set<string>();
    const dispatchConductor = (raw: string): string => {
      const conducted = parseConductor(raw);
      for (const d of conducted.directives) {
        const key = JSON.stringify(d);
        if (dispatchedDirectives.has(key)) continue;
        dispatchedDirectives.add(key);
        if (d.kind === 'spawn') options.onConductorSpawn?.({ name: d.name, dir: d.dir, task: d.task });
        else if (d.kind === 'tell') options.onConductorTell?.({ name: d.name, message: d.message });
        else options.onConductorPropose?.({ summary: d.summary });
      }
      return conducted.stripped;
    };
    wire<{ active: boolean }>('thinking', (p) => {
      signals.pendingResponse = p.active;
      sync();
    });
    // Telemetry: each tool Claude runs this turn, and per-turn token usage + cost.
    wire<ClaudeActivity>('activity', (p) => options.onActivity?.(p));
    wire<ClaudeDiff>('diff', (p) => options.onDiff?.(p));
    wire<{ kind: string; text: string }>('stream', (p) => {
      // Narration may carry markers as the conductor talks through the plan; act on them
      // live (and strip them from the panel) so a worker spawns the moment he calls for it,
      // not only at turn-end.
      if (p.kind === 'narration' && p.text.includes('<<')) {
        options.onStream?.({ kind: p.kind, text: dispatchConductor(p.text) });
      } else {
        options.onStream?.(p);
      }
    });
    wire<ClaudeUsage>('usage', (p) => options.onUsage?.(p));
    wire<{ text: string; is_error: boolean }>('turn-end', (p) => {
      const text = (p.text ?? '').trim();
      if (!text || p.is_error) {
        // Nothing to speak: clear Thinking now; surface an error reply as a caption.
        signals.pendingResponse = false;
        if (text && p.is_error) {
          safeSetText(options.caption ?? null, text);
        }
        dispatchedDirectives.clear();
        sync();
        return;
      }
      // The primary session is the conductor: act on any orchestration markers in the final
      // reply not already dispatched while streaming; they are stripped before speaking.
      const speakable = dispatchConductor(text).trim();
      dispatchedDirectives.clear(); // turn over; reset the per-turn dedup
      if (!speakable) {
        // Q only emitted directives (nothing to say): clear Thinking so the orb settles.
        signals.pendingResponse = false;
        sync();
        return;
      }
      // Leave pendingResponse true (Thinking) until onSpeakingStart flips it to
      // Speaking, so there is no idle flicker between Thinking and the spoken reply.
      void speak(speakable);
      if (!windowFocused && notifyOnTurnEnd) {
        void import('@tauri-apps/plugin-notification').then(({ sendNotification }) => {
          sendNotification({ title: 'Q', body: 'Response ready.' });
        }).catch(() => undefined);
        void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
          void getCurrentWindow().requestUserAttention(2);
        }).catch(() => undefined);
      }
    });
    wire<{ active: boolean; cwd: string }>('ready', (p) => {
      if (p.active) {
        if (p.cwd) {
          safeSetText(options.caption ?? null, `Claude connected: ${p.cwd}`);
        }
        reconnectAttempts = 0;
        options.onReconnectStatus?.({ attempting: false, attempt: 0, maxAttempts: MAX_RECONNECT });
      } else {
        claudeConnected = false;
        signals.pendingResponse = false;
        sync();
        if (!userDisconnected && autoReconnect && lastDir && reconnectAttempts < MAX_RECONNECT) {
          const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30_000);
          reconnectAttempts++;
          options.onReconnectStatus?.({ attempting: true, attempt: reconnectAttempts, maxAttempts: MAX_RECONNECT });
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            void startClaude(lastDir).then((ok) => {
              if (!ok && reconnectAttempts < MAX_RECONNECT) {
                // startClaude failed without a ready event; trigger next attempt
                const nextDelay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30_000);
                reconnectAttempts++;
                options.onReconnectStatus?.({ attempting: true, attempt: reconnectAttempts, maxAttempts: MAX_RECONNECT });
                reconnectTimer = setTimeout(() => {
                  reconnectTimer = null;
                  void startClaude(lastDir);
                }, nextDelay);
              } else if (!ok) {
                options.onReconnectStatus?.({ attempting: false, attempt: reconnectAttempts, maxAttempts: MAX_RECONNECT });
              }
            });
          }, delay);
        } else if (!userDisconnected && autoReconnect && reconnectAttempts >= MAX_RECONNECT) {
          options.onReconnectStatus?.({ attempting: false, attempt: reconnectAttempts, maxAttempts: MAX_RECONNECT });
        }
      }
    });
  }

  function unsubscribeClaude(): void {
    for (const un of claudeUnlisteners) {
      un();
    }
    claudeUnlisteners = [];
  }

  const cancelReconnect = (): void => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectAttempts = 0;
  };

  const startClaude = async (dir?: string, model?: string, effort?: string): Promise<boolean> => {
    userDisconnected = false;
    if (dir) lastDir = dir;
    // Remember model/effort so a reconnect/relaunch reuses them (undefined = unchanged).
    if (model !== undefined) lastModel = model;
    if (effort !== undefined) lastEffort = effort;
    // Single active session in Phase 5: tear down the previous one (listeners + child)
    // before starting a fresh one, so a reconnect/restart never leaks a session.
    if (currentSessionId) {
      unsubscribeClaude();
      const prev = currentSessionId;
      currentSessionId = null;
      void invoke('claude_stop', { id: prev }).catch(() => undefined);
    }
    try {
      const args: Record<string, unknown> = { conductor: true }; // the primary runs the floor
      if (lastDir) args.dir = lastDir;
      if (lastModel) args.model = lastModel;
      if (lastEffort) args.effort = lastEffort;
      const id = await invoke<string>('claude_start', args);
      currentSessionId = id;
      subscribeClaude(id);
      claudeConnected = true;
      return true;
    } catch (e: unknown) {
      console.warn('[tauri-claude] start', e);
      claudeConnected = false;
      return false;
    }
  };
  const cancelClaude = (): void => {
    // Abandon the in-flight turn without disconnecting (the barge-in / Escape path in
    // Phase 7 drives this). The reply queue and current playback are dropped too.
    if (!currentSessionId) return;
    void invoke('claude_cancel', { id: currentSessionId }).catch((e: unknown) =>
      console.warn('[tauri-claude] cancel', e),
    );
    speechQueue.length = 0;
    mediaTts.stop();
    signals.pendingResponse = false;
    signals.speaking = false;
    sync();
  };
  const stopClaude = (): void => {
    userDisconnected = true;
    cancelReconnect();
    claudeConnected = false;
    unsubscribeClaude();
    const prev = currentSessionId;
    currentSessionId = null;
    void invoke('claude_stop', prev ? { id: prev } : {}).catch(() => undefined);
    speechQueue.length = 0; // drop any queued reply chunks
    mediaTts.stop(); // cut current playback (fires onSpeakingEnd -> drains to idle)
    signals.pendingResponse = false;
    signals.speaking = false;
    sync();
  };

  return {
    avatar,
    controller,
    speak,
    startListening,
    stopListening,
    isListening: () => capture.isActive,
    startClaude,
    stopClaude,
    cancelClaude,
    submitText: (text: string) => {
      const t = (text ?? '').trim();
      if (t && claudeConnected) submitToClaude(t);
    },
    interrupt,
    announce: (name, isError) => conductorVoice.announce(name, isError),
    isClaudeConnected: () => claudeConnected,
    cancelReconnect,
    setState: (state) => controller.setState(state),
    setTheme: (theme: ThemeName) => {
      const palette = THEME_PALETTES[theme];
      if (palette) controller.setPalette(palette);
    },
    dispose: () => {
      cancelReconnect();
      watchdog.clear();
      capture.stop();
      void invoke('stt_stop').catch(() => undefined);
      unsubscribeClaude();
      void invoke('claude_stop').catch(() => undefined);
      for (const un of unlisteners) {
        un();
      }
      mediaTts.dispose();
      view.document.removeEventListener('pointerdown', unlockAudio, true);
      view.removeEventListener('resize', fit);
      avatar.dispose();
    },
  };
}

/**
 * Split a reply into speakable chunks: sentence boundaries first, then hard-wrap
 * any over-long sentence at a space, so each chunk stays under the Rust TTS length
 * cap and each yields a small, quick WAV. Pure; unit-tested.
 */
export function splitForSpeech(text: string, maxLen = 4500): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  const out: string[] = [];
  for (const sentence of trimmed.split(/(?<=[.!?])\s+/)) {
    if (sentence.length <= maxLen) {
      if (sentence.trim()) {
        out.push(sentence);
      }
      continue;
    }
    let rest = sentence;
    while (rest.length > maxLen) {
      let cut = rest.lastIndexOf(' ', maxLen);
      if (cut <= 0) {
        cut = maxLen;
      }
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut).trimStart();
    }
    if (rest.trim()) {
      out.push(rest);
    }
  }
  return out;
}

/** Lazy default `invoke`; dynamic import keeps `@tauri-apps/api` out of the demo/test graph. */
async function defaultInvoke<T>(cmd: string, args?: InvokeArgs): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

/** Lazy default `listen`; resolves each event's `payload` to the handler. */
async function defaultListen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event');
  return listen<T>(event, (e) => handler(e.payload));
}
