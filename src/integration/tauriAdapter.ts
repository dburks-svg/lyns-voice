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
import { OrbAvatar, themeToPalette } from '../avatar/OrbAvatar';
import {
  AvatarController,
  type AvatarState,
  type ControllableAvatar,
} from '../avatar/AvatarController';
import { MediaTts, type MediaTtsOptions, type MediaTtsLike } from '../audio/MediaTts';
import { SttCapture } from '../audio/SttCapture';
import { MoodController } from '../mood/MoodController';
import { parseMoodMarker } from '../mood/moodProtocol';
import { THEME_PALETTES, type ThemeName } from '../config/config';
import { prefersReducedMotion, safeSetText } from './dom';
import { deriveState, type VoiceSignals } from './signals';
import { createConductorVoice } from './conductorVoice';
import { parseConductor } from './conductorProtocol';
import { createReplyStreamer } from './replyStreamer';
import { matchWake } from './wakeWord';

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
 * Three.js `Avatar` and the `OrbAvatar` satisfy it, so either can be injected.
 */
export interface AvatarLike extends ControllableAvatar {
  reducedMotion: boolean;
  beforeRender: ((time: number) => void) | null;
  mount(container: HTMLElement): void;
  start(): void;
  stop(): void;
  resize(width: number, height: number): void;
  dispose(): void;
}

/** Builds the renderer for the host; defaults to the `OrbAvatar`. */
export type AvatarFactory = (options?: AvatarOptions) => AvatarLike;

const defaultAvatarFactory: AvatarFactory = (options) => new OrbAvatar(options);

/** How long to wait for a Claude reply before recovering from a hung Thinking. */
const WATCHDOG_MS = 120_000;
/**
 * A real ultracode turn fans out many sub-agents and runs for minutes, so while ultracode is
 * the active effort the conductor's watchdog gets a much longer budget (the 30s reassurance
 * ticks keep it from looking frozen). It still eventually recovers a genuinely hung UI.
 */
const ULTRACODE_WATCHDOG_MS = 900_000;
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
 * push the deadline out. `ms` may be a function, resolved at `arm()` time, so the
 * deadline can vary per turn (e.g. a longer budget for an ultracode turn). An optional
 * `progress` fires `onTick` every `everyMs` until the turn resolves (clear) or the
 * deadline fires, so a long turn can reassure the user instead of looking frozen. Pure
 * but for the injected timer; unit-tested.
 */
export function createWatchdog(
  view: TimerView,
  ms: number | (() => number),
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
      // Resolve the deadline at arm time so it can vary per turn (ultracode gets a longer budget).
      const deadline = typeof ms === 'function' ? ms() : ms;
      timer = view.setTimeout(() => {
        timer = null;
        clearTick();
        onTimeout();
      }, deadline);
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

/** Callback that provides current TTS settings for each synthesis call. `engine`
 *  selects the backend ('kokoro' default, 'sapi' for the Windows fallback); when
 *  omitted the Rust side defaults to Kokoro. */
export type TtsSettingsGetter = () => { rate: number; pitch: number; voice: string; engine?: string };

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
      if (s.engine) args.engine = s.engine;
      const raw = await invoke<unknown>('tts_synthesize', args);
      const bytes = toArrayBuffer(raw);
      return { ok: true, arrayBuffer: async () => bytes };
    } catch (e) {
      // Graceful fallback to text-only, but log the real Rust error string (e.g. a
      // SAPI HRESULT or "text too long") so a silent voice has a diagnosable cause.
      console.warn('[tauri-tts] tts_synthesize failed; falling back to text-only:', e);
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
  /** Injectable renderer factory; defaults to the `OrbAvatar`. */
  avatarFactory?: AvatarFactory;
  /** Injectable TTS player factory; defaults to `new MediaTts`. Lets tests drive the
   *  speech pump with a fake whose synth/playback timing they control. */
  mediaTtsFactory?: (opts: MediaTtsOptions) => MediaTtsLike;
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
  /** Whether auto-reconnect is enabled (default true). Getter so the toggle is live. */
  autoReconnect?: () => boolean;
  /** Show a system notification when a turn ends while backgrounded (default true).
   *  Getter so the toggle is live. */
  notifyOnTurnEnd?: () => boolean;
  /** Override the Thinking watchdog timeout in ms (default 120000). */
  watchdogMs?: number;
  /** Voice barge-in: a spoken utterance during a reply cuts it off. Getter so the
   *  settings toggle takes effect live (default treated as off when absent). */
  bargeIn?: () => boolean;
  /** Wake word enabled: require a leading wake phrase before an utterance acts on Oracle
   *  (continuous listening). Getter so the settings toggle takes effect live. */
  wakeWordEnabled?: () => boolean;
  /** MCP servers disabled in the Library (read live at session spawn). Everything
   *  the user registered user-scope is allowed by default; see claude.rs. */
  mcpDisabled?: () => string[];
  /** Hook ids disabled in the Library (read live at session spawn); matching hooks
   *  are removed from the session via a --settings hooks override (claude.rs). */
  hooksDisabled?: () => string[];
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
  /** Cancel the in-flight turn without disconnecting (barge-in / Escape). Resolves
   *  once the session has been relaunched and can accept a new submit. */
  cancelClaude(): Promise<void>;
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
    // ultracode turns fan out and run for minutes; give the conductor a longer budget while it
    // is the active effort. `lastEffort` is read lazily at arm time (after it is initialized).
    () => (lastEffort === 'ultracode' ? ULTRACODE_WATCHDOG_MS : (options.watchdogMs ?? WATCHDOG_MS)),
    () => {
      if (signals.pendingResponse && !signals.speaking) {
        console.warn('[tauri-claude] watchdog: no reply in time; recovering from Thinking');
        safeSetText(
          options.caption ?? null,
          'Claude did not respond in time; the turn was dropped. Please try again.',
        );
        signals.pendingResponse = false;
        turnOpen = false;
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
  // Synthesis pipeline: up to PREFETCH_DEPTH chunks are synthesized ahead of
  // playback. One-ahead was not enough: a paragraph's short closing sentence
  // finishes playing before the next paragraph's long opener finishes
  // synthesizing, and the pipeline stalls exactly at the paragraph seam
  // (live-test report: "seriously long pause between paragraphs"). Synth starts
  // are CHAINED (next begins when the previous resolves) so the serialized Rust
  // engine receives chunks strictly in playback order.
  const PREFETCH_DEPTH = 3;
  interface PrefetchedChunk {
    text: string;
    promise: Promise<AudioBuffer | null>;
    /** Set when the synth resolved (used to log real gaps, not scheduling noise). */
    done: boolean;
  }
  let synthPipeline: PrefetchedChunk[] = [];
  // Serializes synth starts; each new entry chains on the previous one's synth.
  let synthChain: Promise<unknown> = Promise.resolve();
  // Bumped on every stop/clear so a synth that resolves AFTER a barge-in/turn-cut
  // is abandoned rather than played.
  let speechGen = 0;
  // True from the moment a synth starts until its playback starts. Together with
  // mediaTts.isSpeaking (true during playback) it serializes the pump: streamed
  // replies call pumpSpeech once PER sentence, and without this a sentence arriving
  // during the first synth (isSpeaking still false) would start a second, parallel
  // synth, shift itself out of the queue, then be dropped by the isSpeaking guard -
  // so only the first sentence ever played.
  let pumping = false;
  // Fire the "voice unavailable" notice at most once per reply (not once per chunk).
  let ttsNoticeFired = false;
  // Phase B streaming: the reply text shown in the caption as sentences are spoken,
  // whether any delta arrived this turn, a mute flag so a barged/cancelled turn's
  // late deltas are ignored, and the per-turn sentence streamer (assigned below,
  // once the speech pump exists).
  let captionAccum = '';
  let deltaSeen = false;
  let streamMuted = false;
  // True while a Claude turn is actually generating (submit -> turn-end). Distinct
  // from `signals.pendingResponse`, which streaming clears at the first spoken
  // sentence: barge-in/Escape need to know whether a real cancel is required, and
  // the settle paths need to know the reply is still growing.
  let turnOpen = false;

  // Drop all pending + prefetched speech (call before mediaTts.stop() at every
  // barge-in / turn-cut site so the in-flight prefetch can't play afterwards).
  const clearSpeechQueue = (): void => {
    speechQueue.length = 0;
    synthPipeline = [];
    synthChain = Promise.resolve();
    speechGen++;
    pumping = false; // a stale in-flight synth no-ops on the gen check; let a new turn pump
    deltaSeen = false;
    streamMuted = true; // ignore any late deltas from the aborted turn until next turn
    // (the streamer's stale buffer is cleared at the next turn's thinking:true)
  };
  const noticeTtsUnavailable = (): void => {
    console.warn('[tauri-tts] native synthesis failed; caption shown without audio');
    if (ttsNoticeFired) return;
    ttsNoticeFired = true;
    // Surface it once per reply (toast) so a silent failure is not console-only;
    // the reply text is already in the caption.
    void import('@tauri-apps/plugin-notification')
      .then(({ sendNotification }) => {
        sendNotification({ title: 'LYNS Voice', body: 'Voice output unavailable; the reply is shown as text.' });
      })
      .catch(() => undefined);
  };

  const onSpeakingStart = (): void => {
    signals.speaking = true;
    signals.pendingResponse = false;
    sync();
  };
  const onSpeakingEnd = (): void => {
    if (speechQueue.length > 0 || synthPipeline.length > 0) {
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
  const makeMediaTts = options.mediaTtsFactory ?? ((o: MediaTtsOptions) => new MediaTts(o));
  const mediaTts = makeMediaTts({
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
    if (pumping || mediaTts.isSpeaking) {
      return;
    }
    const gen = speechGen;
    // Keep the synth pipeline full, then play its head (already synthesizing or done).
    fillPipeline();
    const head = synthPipeline.shift();
    const pending = head?.promise ?? null;
    if (!pending) {
      // Always sync on drain (even if every chunk failed and speaking was never
      // set), so the avatar never stays stuck on the prior state. When the turn is
      // already over, also release Thinking: an all-chunks-failed reply is already
      // captioned, and holding pendingResponse here wedged input until the watchdog
      // fired (then mislabeled the visible reply as dropped). While the turn is
      // still generating, Thinking stays (turn-end will settle it).
      signals.speaking = false;
      if (!turnOpen) {
        signals.pendingResponse = false;
      }
      sync();
      return;
    }
    pumping = true; // own the synth->play-start window so streamed chunks can't overlap
    // Instrumentation: if the head's synth has not resolved yet, playback is about
    // to stall - measure the real audible gap and log it (live-tunable evidence).
    const waitStart = head?.done ? 0 : performance.now();
    void pending.then((buf) => {
      // A barge-in / turn-cut landed while synthesizing; clearSpeechQueue reset `pumping`.
      if (gen !== speechGen) {
        return;
      }
      if (waitStart > 0) {
        const waited = Math.round(performance.now() - waitStart);
        if (waited > 75) {
          console.info(
            `[tts] ${waited}ms gap waiting for synthesis (${head?.text.length ?? 0} chars; pipeline ${synthPipeline.length}/${PREFETCH_DEPTH})`,
          );
        }
      }
      pumping = false; // synth done; playBuffer below flips isSpeaking on synchronously
      if (buf === null) {
        noticeTtsUnavailable();
        pumpSpeech(); // skip the failed chunk; keep the reply moving
        return;
      }
      // Top the pipeline back up during this playback, so the following chunks are
      // already synthesized (or synthesizing) when their turns come.
      fillPipeline();
      void mediaTts.playBuffer(buf).then((ok) => {
        if (!ok && gen === speechGen) {
          noticeTtsUnavailable();
          pumpSpeech(); // couldn't start playback; move on
        }
      });
    });
  }

  // Keep up to PREFETCH_DEPTH chunks synthesizing ahead of playback. Starts are
  // chained so the serialized Rust engine gets chunks strictly in playback order;
  // a stale entry (barge-in bumped speechGen) resolves to null and is discarded
  // by the gen checks downstream.
  function fillPipeline(): void {
    while (synthPipeline.length < PREFETCH_DEPTH) {
      let text: string | undefined;
      do {
        text = speechQueue.shift();
      } while (text !== undefined && !text.trim());
      if (text === undefined) {
        return;
      }
      const gen = speechGen;
      const chunk = text;
      const entry: PrefetchedChunk = { text: chunk, done: false, promise: Promise.resolve(null) };
      entry.promise = synthChain.then(() => {
        if (gen !== speechGen) {
          return null; // superseded while queued behind an earlier synth
        }
        const t0 = performance.now();
        return mediaTts.synthesize(chunk).then((buf) => {
          entry.done = true;
          const ms = Math.round(performance.now() - t0);
          const audioMs = buf ? Math.round(buf.duration * 1000) : 0;
          console.debug(`[tts] synth ${ms}ms for ${chunk.length} chars (${audioMs}ms of audio)`);
          return buf;
        });
      });
      synthChain = entry.promise.catch(() => undefined);
      synthPipeline.push(entry);
    }
  }

  // Chunk size for sentence-split speech. Kokoro's model window is 510 phoneme
  // tokens (~400 chars of English), so its chunks stay well under that: every chunk
  // synthesizes in one window, and small chunks keep the one-ahead prefetch pipeline
  // gapless during long reads. SAPI has no such window; its cap only bounds the WAV.
  const KOKORO_CHUNK_CHARS = 330;
  const speechChunkCap = (): number =>
    (options.ttsSettings?.().engine ?? 'kokoro') === 'sapi' ? 4500 : KOKORO_CHUNK_CHARS;

  const speak = async (text: string): Promise<boolean> => {
    // Mood is parsed and STRIPPED here, before the text is spoken or captioned,
    // so the `<<mood:...>>` marker is never heard or shown (the spec contract).
    const parsed = parseMoodMarker(text);
    // Each reply sets its own mood; a reply with no tag reverts to neutral rather than
    // inheriting the previous turn's emotion (so an `error`-red orb does not bleed into
    // later neutral replies). Matches the spec's "no tag keeps the orb neutral".
    mood.setMood(parsed.mood ?? 'neutral');
    safeSetText(options.caption ?? null, parsed.stripped);
    options.onTranscript?.('q', parsed.stripped); // HUD chat log
    const chunks = splitForSpeech(parsed.stripped, speechChunkCap());
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

  // Phase B: turn streamed assistant text deltas into spoken sentences as they
  // arrive. Reuses the same speech pump as speak()/the conductor, so pipelining,
  // barge-in and turn-taking all apply unchanged; onChunk text is already
  // mood/marker-stripped by the streamer.
  const replyStreamer = createReplyStreamer({
    onMood: (m) => mood.setMood(m),
    onChunk: (chunk) => {
      captionAccum = captionAccum ? `${captionAccum} ${chunk}` : chunk;
      safeSetText(options.caption ?? null, captionAccum);
      speechQueue.push(...splitForSpeech(chunk, speechChunkCap()));
      pumpSpeech();
    },
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
    turnOpen = true;
    sync();
    void invoke('claude_submit', { id: currentSessionId, text }).catch((e: unknown) => {
      console.warn('[tauri-claude] submit', e);
      signals.pendingResponse = false;
      turnOpen = false;
      sync();
    });
  }

  // Barge-in: cut off an in-flight turn. While speaking a COMPLETED reply, just stop
  // talking (keeping the session's conversation context). While the turn is still
  // generating (thinking, or speaking a streamed reply whose tail is still arriving),
  // abandon the whole turn via cancelClaude, or its remaining deltas would stream
  // into the next one. Returns whether anything was interrupted, so Escape can fall
  // through to closing a panel.
  function interrupt(): boolean {
    if (signals.speaking && !turnOpen) {
      clearSpeechQueue();
      mediaTts.stop();
      signals.speaking = false;
      sync();
      return true;
    }
    if (signals.speaking || signals.pendingResponse || turnOpen) {
      void cancelClaude();
      return true;
    }
    return false;
  }

  // Wake mode: keep the floor closed until the wake phrase opens it. A bare "Oracle" arms the mic so
  // the NEXT utterance is the command; the arm expires after a short window.
  let wakeArmed = false;
  let wakeArmTimer: ReturnType<typeof setTimeout> | null = null;
  const WAKE_ARM_MS = 8000;
  // Wake-gate sync to Rust: while the gate is active (wake mode on, Q not armed),
  // stt.rs skips decoding utterances too long to be a one-breath command, so long
  // bursts of ambient speech stop costing whisper decodes (and a real "Oracle, ..."
  // stops queueing behind the TV). The transcript gating in the stt://final
  // handler below stays authoritative: a stale gate over there costs a decode,
  // never a command. Synced on mic start, speech onset (which picks up a settings
  // toggle by the next utterance), and every arm/disarm transition.
  let wakeGateSent: boolean | null = null;
  const syncWakeGate = (): void => {
    const active = (options.wakeWordEnabled?.() ?? false) && !wakeArmed;
    if (active === wakeGateSent) return;
    wakeGateSent = active;
    void invoke('stt_set_wake_gate', { active }).catch(() => {
      wakeGateSent = null; // retry on the next sync point rather than staying stale
    });
  };
  const disarmWake = (): void => {
    wakeArmed = false;
    if (wakeArmTimer !== null) {
      clearTimeout(wakeArmTimer);
      wakeArmTimer = null;
    }
    syncWakeGate();
  };
  const armWake = (): void => {
    wakeArmed = true;
    if (wakeArmTimer !== null) clearTimeout(wakeArmTimer);
    wakeArmTimer = setTimeout(() => {
      wakeArmTimer = null;
      disarmWake();
    }, WAKE_ARM_MS);
    syncWakeGate();
  };

  // End-of-speech acknowledgment: the Rust VAD emits `stt://listening {active:false}`
  // the instant it closes an utterance and hands it to whisper. Without feedback the
  // UI sits visibly unchanged through the whole transcription (the "silent dead
  // zone" between the user stopping and the transcript arriving), so acknowledge
  // immediately; `stt://final` (or the failsafe timer, for a noise blip whisper
  // never finalizes) replaces the caption.
  const TRANSCRIBE_FAILSAFE_MS = 60_000;
  let utteranceOpen = false;
  let transcribeCaption = false;
  // Decodes still in flight (utterance closed, no final/error yet). Ambient speech
  // in wake mode yields EMPTY finals; one of those may only blank the
  // "Transcribing" acknowledgment when nothing newer is still decoding, or it
  // blanks an acknowledgment that belongs to the next utterance (live-test
  // regression: the caption flickered set/blank/set under overlapping utterances).
  let decodesInFlight = 0;
  let transcribeClearTimer: ReturnType<typeof setTimeout> | null = null;
  const clearTranscribeCaption = (): void => {
    if (transcribeClearTimer !== null) {
      clearTimeout(transcribeClearTimer);
      transcribeClearTimer = null;
    }
    transcribeCaption = false;
  };
  addListener<{ active: boolean }>('stt://listening', (p) => {
    if (p.active) {
      utteranceOpen = true;
      // The gate value lands in Rust well before this utterance finalizes, so a
      // wake-mode settings toggle takes effect from the very next thing said.
      syncWakeGate();
      return;
    }
    if (!utteranceOpen) return; // worker start/stop chatter, not an utterance boundary
    utteranceOpen = false;
    decodesInFlight++;
    // Never clobber a busier caption (a reply being spoken, or Thinking status while
    // wake-word mode transcribes ambient speech mid-turn).
    if (signals.pendingResponse || signals.speaking) return;
    transcribeCaption = true;
    controller.pulse(); // a visible "heard you" blip on the orb
    safeSetText(options.caption ?? null, 'Transcribing…');
    if (transcribeClearTimer !== null) clearTimeout(transcribeClearTimer);
    transcribeClearTimer = setTimeout(() => {
      transcribeClearTimer = null;
      if (transcribeCaption) {
        transcribeCaption = false;
        safeSetText(options.caption ?? null, '');
      }
    }, TRANSCRIBE_FAILSAFE_MS);
  });
  addListener<{ text: string }>('stt://final', (p) => {
    decodesInFlight = Math.max(0, decodesInFlight - 1);
    const text = (p.text ?? '').trim();
    if (!text) {
      // "Heard nothing usable" (a noise blip / silence / a prefiltered ambient
      // utterance): blank the "Transcribing" acknowledgment, but only once no
      // newer utterance is still decoding (its acknowledgment is showing).
      if (transcribeCaption && decodesInFlight === 0) {
        clearTranscribeCaption();
        safeSetText(options.caption ?? null, '');
      }
      return;
    }
    clearTranscribeCaption(); // the real transcript replaces the acknowledgment below
    // Wake gating: with wake mode on and Q not already armed, an utterance must start
    // with the wake phrase to be heard. "Oracle, <command>" runs in one breath; a bare wake
    // arms Oracle (and chirps "Yes?") so the next utterance is taken as the command.
    let command = text;
    if (options.wakeWordEnabled?.() && !wakeArmed) {
      const wake = matchWake(text);
      if (!wake.woke) {
        return; // ambient speech without the wake phrase; ignore it
      }
      if (!wake.command) {
        armWake();
        safeSetText(options.caption ?? null, 'Yes?');
        return;
      }
      command = wake.command;
    }
    disarmWake();
    if (claudeConnected) {
      // Voice barge-in (opt-in): if Q is mid-reply (speaking) or still generating
      // (thinking), cut that turn off before taking the floor.
      if (options.bargeIn?.() && (signals.speaking || signals.pendingResponse || turnOpen)) {
        if (turnOpen || signals.pendingResponse) {
          // Still generating: abandon the turn (kill + relaunch on the Rust side) and
          // submit only after the relaunched session is registered. Submitting
          // immediately raced the relaunch window (the session is briefly absent from
          // the map) and the interrupting command was silently dropped.
          void cancelClaude().then(() => submitToClaude(command));
        } else {
          // The turn already completed; Q is only reading it out. Stop playback but
          // keep the session (and its conversation context) alive.
          clearSpeechQueue();
          mediaTts.stop();
          signals.speaking = false;
          sync();
          submitToClaude(command);
        }
        return;
      }
      submitToClaude(command);
    } else {
      safeSetText(options.caption ?? null, command);
      options.onTranscript?.('user', command); // HUD chat log
      options.onUtterance?.(command);
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
  // Kokoro voice-model first-run download (parallel to stt://model). Fires only
  // during a real download, so it never clears a reply caption on normal replies.
  let ttsDlLast = 0;
  let ttsDlLastT = 0;
  addListener<{ state: string; file?: string; downloaded: number; total: number }>('tts://model', (p) => {
    if (p.state === 'downloading') {
      const pct = p.total > 0 ? Math.floor((p.downloaded / p.total) * 100) : 0;
      const now = performance.now();
      let suffix = '';
      if (ttsDlLastT > 0 && p.total > 0 && p.downloaded > ttsDlLast) {
        const bps = ((p.downloaded - ttsDlLast) / (now - ttsDlLastT)) * 1000;
        if (bps > 0) {
          const remain = Math.ceil((p.total - p.downloaded) / bps);
          suffix = ` (${(bps / 1e6).toFixed(1)} MB/s, ~${remain}s left)`;
        }
      }
      ttsDlLast = p.downloaded;
      ttsDlLastT = now;
      safeSetText(options.caption ?? null, `Downloading voice model… ${pct}%${suffix}`);
    } else if (p.state === 'ready') {
      safeSetText(options.caption ?? null, '');
    } else if (p.state === 'error') {
      safeSetText(options.caption ?? null, 'Voice model unavailable (see logs)');
    }
  });
  addListener<{ text: string }>('stt://error', (p) => {
    console.warn('[tauri-stt]', p.text);
    decodesInFlight = Math.max(0, decodesInFlight - 1);
    if (transcribeCaption && decodesInFlight === 0) {
      clearTranscribeCaption();
      safeSetText(options.caption ?? null, '');
    }
  });

  const startListening = async (): Promise<boolean> => {
    mediaTts.unlock();
    // Kick off the Rust worker (loads/downloads the model on first run); capture
    // begins in parallel (early frames before the worker exists are dropped).
    void invoke('stt_start').catch((e: unknown) => console.warn('[tauri-stt] start', e));
    syncWakeGate();
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

  // Visibility tracking for background notifications, and -- the CPU win -- pausing
  // the orb's render loop entirely when the window is hidden/minimized. The orb
  // otherwise renders full-tilt forever; while nobody can see it that is pure waste
  // (and on software-WebGL machines it pegs every core). Only `document.hidden`
  // (minimized / occluded / other virtual desktop) pauses; merely losing focus
  // while still visible keeps it animating, so it never freezes on a second monitor.
  let windowFocused = !view.document.hidden;
  const onVisibilityChange = (): void => {
    windowFocused = !view.document.hidden;
    if (view.document.hidden) {
      avatar.stop();
    } else {
      avatar.start();
    }
  };
  view.document.addEventListener('visibilitychange', onVisibilityChange);
  // Read live each turn so the settings toggle takes effect without re-attaching
  // (absent option = default enabled).
  const shouldNotifyOnTurnEnd = (): boolean => options.notifyOnTurnEnd?.() !== false;
  // Ping the user when a reply finishes while the window is backgrounded.
  const notifyTurnEndIfBackground = (): void => {
    if (windowFocused || !shouldNotifyOnTurnEnd()) return;
    void import('@tauri-apps/plugin-notification').then(({ sendNotification }) => {
      sendNotification({ title: 'LYNS Voice', body: 'Response ready.' });
    }).catch(() => undefined);
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      void getCurrentWindow().requestUserAttention(2);
    }).catch(() => undefined);
  };

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
  const shouldAutoReconnect = (): boolean => options.autoReconnect?.() !== false;

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
      if (p.active) {
        // Turn start: reset the streamer + per-turn caption/mood (neutral until a
        // <<mood:...>> streams) and re-arm the once-per-reply voice-unavailable notice.
        replyStreamer.reset();
        captionAccum = '';
        deltaSeen = false;
        streamMuted = false;
        ttsNoticeFired = false;
        mood.setMood('neutral');
      }
      signals.pendingResponse = p.active;
      turnOpen = p.active;
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
    // Phase B: incremental assistant text. Feed the streamer, which speaks complete
    // sentences as they arrive (muted while a barged/cancelled turn drains).
    wire<{ text: string }>('delta', (p) => {
      if (streamMuted) return;
      deltaSeen = true;
      replyStreamer.push(p.text ?? '');
    });
    wire<ClaudeUsage>('usage', (p) => options.onUsage?.(p));
    wire<{ text: string; is_error: boolean }>('turn-end', (p) => {
      turnOpen = false; // generation is over, whatever else this handler decides
      const text = (p.text ?? '').trim();
      const wasStreaming = deltaSeen && !streamMuted;
      if (!text || p.is_error) {
        // Nothing to speak: clear Thinking now; surface an error reply as a caption.
        signals.pendingResponse = false;
        if (text && p.is_error) {
          safeSetText(options.caption ?? null, text);
        }
        replyStreamer.reset();
        deltaSeen = false;
        dispatchedDirectives.clear();
        sync();
        return;
      }
      // The primary session is the conductor: act on any orchestration markers in the final
      // reply not already dispatched while streaming; they are stripped before speaking.
      const speakable = dispatchConductor(text).trim();
      dispatchedDirectives.clear(); // turn over; reset the per-turn dedup
      if (streamMuted) {
        // The turn was barged-in / cancelled: drop its tail, do not speak.
        replyStreamer.reset();
        deltaSeen = false;
        return;
      }
      if (wasStreaming) {
        // Already spoken sentence-by-sentence as it streamed: flush the trailing
        // partial, log the full reply once, and do NOT re-speak it.
        replyStreamer.flush();
        deltaSeen = false;
        const logged = parseMoodMarker(speakable).stripped;
        if (logged) options.onTranscript?.('q', logged);
        // Settle ONLY when nothing is left anywhere in the speech pipeline. flush()
        // may have just started the tail sentence's synthesis (`pumping`), whose
        // playback will clear pendingResponse via onSpeakingStart; treating that
        // window as settled flashed idle between Thinking and Speaking and reopened
        // the input guard on every single-sentence reply.
        if (
          !signals.speaking &&
          !pumping &&
          !mediaTts.isSpeaking &&
          speechQueue.length === 0 &&
          synthPipeline.length === 0
        ) {
          signals.pendingResponse = false; // reply was only markers/empty; settle
          sync();
        }
        notifyTurnEndIfBackground();
        return;
      }
      if (!speakable) {
        // Q only emitted directives (nothing to say): clear Thinking so the orb settles.
        signals.pendingResponse = false;
        sync();
        return;
      }
      // Leave pendingResponse true (Thinking) until onSpeakingStart flips it to
      // Speaking, so there is no idle flicker between Thinking and the spoken reply.
      void speak(speakable);
      notifyTurnEndIfBackground();
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
        // Single source of reconnect scheduling: whether the drop surfaced as this
        // ready{active:false} event or as a failed startClaude retry, exactly one timer
        // is ever in flight (see scheduleReconnect), so attempts cannot double-count.
        scheduleReconnect();
      }
    });
  }

  function unsubscribeClaude(): void {
    for (const un of claudeUnlisteners) {
      un();
    }
    claudeUnlisteners = [];
  }

  // Schedule one reconnect attempt with exponential backoff. Idempotent: if a timer is
  // already pending it is a no-op, so the ready{active:false} event and a failed
  // startClaude retry cannot each schedule the next attempt (the old double-count bug).
  function scheduleReconnect(): void {
    if (reconnectTimer !== null) return; // a reconnect is already pending
    if (userDisconnected || !shouldAutoReconnect() || !lastDir) return;
    if (reconnectAttempts >= MAX_RECONNECT) {
      options.onReconnectStatus?.({ attempting: false, attempt: reconnectAttempts, maxAttempts: MAX_RECONNECT });
      return;
    }
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30_000);
    reconnectAttempts++;
    options.onReconnectStatus?.({ attempting: true, attempt: reconnectAttempts, maxAttempts: MAX_RECONNECT });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (claudeConnected) return; // something else already reconnected meanwhile
      reconnecting = true; // so startClaude does not reset the backoff attempt count
      void startClaude(lastDir).then((ok) => {
        reconnecting = false;
        // A failure that did not emit ready{active:false} reschedules here; one that did
        // is handled by that event. The reconnectTimer===null guard dedupes the two.
        if (!ok) scheduleReconnect();
      });
    }, delay);
  }

  const cancelReconnect = (): void => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectAttempts = 0;
  };

  let reconnecting = false; // an auto-reconnect attempt is the caller of startClaude
  let startingClaude = false; // re-entrancy guard: one start at a time
  const startClaude = async (dir?: string, model?: string, effort?: string): Promise<boolean> => {
    userDisconnected = false;
    // A manual start supersedes any pending auto-reconnect. Without this, the stale
    // backoff timer fired minutes later and silently tore down the fresh session
    // (destroying its conversation context). The auto path itself skips it so the
    // backoff attempt count survives across its own retries.
    if (!reconnecting) cancelReconnect();
    // A user click racing the reconnect timer must not double-start: two live
    // children would both be subscribed (duplicate events and speech).
    if (startingClaude) return false;
    startingClaude = true;
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
      const disabledMcp = options.mcpDisabled?.() ?? [];
      if (disabledMcp.length) args.disabledMcp = disabledMcp;
      const disabledHooks = options.hooksDisabled?.() ?? [];
      if (disabledHooks.length) args.disabledHooks = disabledHooks;
      const id = await invoke<string>('claude_start', args);
      currentSessionId = id;
      subscribeClaude(id);
      claudeConnected = true;
      // Warm the neural TTS while the user forms their first request, so the first
      // reply does not stall on the ONNX session cold start (fire-and-forget; the
      // Rust side is a no-op once loaded). SAPI has no cold start worth warming.
      if ((options.ttsSettings?.().engine ?? 'kokoro') !== 'sapi') {
        void invoke('tts_warmup').catch(() => undefined);
      }
      return true;
    } catch (e: unknown) {
      console.warn('[tauri-claude] start', e);
      claudeConnected = false;
      return false;
    } finally {
      startingClaude = false;
    }
  };
  const cancelClaude = (): Promise<void> => {
    // Abandon the in-flight turn without disconnecting (the barge-in / Escape path in
    // Phase 7 drives this). The reply queue and current playback are dropped too.
    // Resolves once the Rust side has killed AND relaunched the session: a caller
    // that submits next (voice barge-in) must await this, because a submit issued
    // during the relaunch window finds no session and is silently dropped.
    if (!currentSessionId) return Promise.resolve();
    const relaunched = invoke<void>('claude_cancel', { id: currentSessionId })
      .catch((e: unknown) => console.warn('[tauri-claude] cancel', e))
      .then(() => undefined);
    clearSpeechQueue();
    mediaTts.stop();
    signals.pendingResponse = false;
    signals.speaking = false;
    turnOpen = false;
    sync();
    return relaunched;
  };
  const stopClaude = (): void => {
    userDisconnected = true;
    cancelReconnect();
    turnOpen = false;
    claudeConnected = false;
    unsubscribeClaude();
    const prev = currentSessionId;
    currentSessionId = null;
    void invoke('claude_stop', prev ? { id: prev } : {}).catch(() => undefined);
    clearSpeechQueue(); // drop any queued + prefetched reply chunks
    mediaTts.stop(); // cut current playback (fires onSpeakingEnd -> drains to idle)
    signals.pendingResponse = false;
    signals.speaking = false;
    // The last reply's caption outlives nothing: the conversation it belongs to is
    // gone, so a disconnected app returns to a quiet stage (live-test report: the
    // stale caption persisted until the next reply).
    safeSetText(options.caption ?? null, '');
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
      view.document.removeEventListener('visibilitychange', onVisibilityChange);
      view.removeEventListener('resize', fit);
      disarmWake();
      clearTranscribeCaption();
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
