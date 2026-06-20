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
import { JarvisOrbAvatar } from '../avatar/JarvisOrbAvatar';
import {
  AvatarController,
  type AvatarState,
  type ControllableAvatar,
} from '../avatar/AvatarController';
import { MediaTts, type MediaTtsOptions } from '../audio/MediaTts';
import { SttCapture } from '../audio/SttCapture';
import { MoodController } from '../mood/MoodController';
import { parseMoodMarker } from '../mood/moodProtocol';
import { prefersReducedMotion, safeSetText } from './dom';
import { deriveState, type VoiceSignals } from './signals';

/** Args accepted by `invoke`: a JSON record, or a raw binary body (audio frames). */
type InvokeArgs = Record<string, unknown> | ArrayBuffer | Uint8Array;

/** Minimal shape of Tauri's `invoke`; injectable so the unit tests stay headless. */
export type InvokeFn = <T>(cmd: string, args?: InvokeArgs) => Promise<T>;

/** Who said a transcript line: the user (mic) or Jarvis (spoken reply). */
export type TranscriptRole = 'user' | 'jarvis';

/** A tool Claude invoked this turn (from `claude://activity`); feeds the HUD. */
export interface ClaudeActivity {
  name: string;
  target: string;
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
 * Three.js `Avatar` and the `JarvisOrbAvatar` satisfy it, so either can be injected.
 */
export interface AvatarLike extends ControllableAvatar {
  reducedMotion: boolean;
  beforeRender: ((time: number) => void) | null;
  mount(container: HTMLElement): void;
  start(): void;
  resize(width: number, height: number): void;
  dispose(): void;
}

/** Builds the renderer for the host; defaults to the `JarvisOrbAvatar`. */
export type AvatarFactory = (options?: AvatarOptions) => AvatarLike;

const defaultAvatarFactory: AvatarFactory = (options) => new JarvisOrbAvatar(options);

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

/**
 * A `MediaTts` `fetchImpl` that ignores the URL and synthesizes through the Rust
 * `tts_synthesize` command. `MediaTts` posts `{ text }` as the JSON body, so we
 * read the text back out of it; on any failure we report `ok: false` so the
 * caller falls back gracefully (matching the server-route contract).
 */
export function tauriTtsFetch(invoke: InvokeFn): FetchImpl {
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
      const raw = await invoke<unknown>('tts_synthesize', { text });
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
  /** Injectable renderer factory; defaults to the `JarvisOrbAvatar`. */
  avatarFactory?: AvatarFactory;
  /** Injectable `invoke`; defaults to lazy `@tauri-apps/api/core`. */
  invoke?: InvokeFn;
  /** Injectable event `listen`; defaults to lazy `@tauri-apps/api/event`. */
  listen?: ListenFn;
  /** Called with each finalized STT utterance (Phase 3 wires this to Claude). */
  onUtterance?: (text: string) => void;
  /** Transcript stream: user utterances and spoken Jarvis replies (HUD chat). */
  onTranscript?: (role: TranscriptRole, text: string) => void;
  /** Each tool Claude invokes this turn (HUD activity feed). */
  onActivity?: (activity: ClaudeActivity) => void;
  /** Per-turn token usage + cost (HUD telemetry). */
  onUsage?: (usage: ClaudeUsage) => void;
  /** Live mic frequency bands per audio frame (HUD waveform). */
  onBands?: (bands: Float32Array) => void;
  /** Injectable window; defaults to the global `window`. */
  view?: Window;
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
  /** Start the Claude Code sidecar in `dir` (defaults to home). Utterances route to it. */
  startClaude(dir?: string): Promise<boolean>;
  /** Stop the Claude sidecar; utterances revert to caption-only. */
  stopClaude(): void;
  /** Whether the Claude sidecar is connected. */
  isClaudeConnected(): boolean;
  /** Manual state override (debug cluster today; direct control later). */
  setState(state: AvatarState): void;
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

  const avatar = (options.avatarFactory ?? defaultAvatarFactory)(options.avatarOptions);
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
  avatar.beforeRender = (time) => controller.tick(time);
  avatar.start();

  // The stage IS the window in the desktop app, so size the canvas to it.
  const fit = (): void => avatar.resize(view.innerWidth, view.innerHeight);
  fit();
  view.addEventListener('resize', fit);

  const sync = (): void => {
    // While a Claude response is pending (Thinking), suppress the Listening STATE
    // even if the mic is still engaged, so the four-state loop is visible
    // hands-free. The live amplitude still drives the reaction via setMicLevel.
    const micActive = signals.micActive && !signals.pendingResponse;
    controller.setState(deriveState({ ...signals, micActive }));
  };

  // Claude replies can exceed the TTS length cap, so a reply is spoken sentence by
  // sentence from a queue: each chunk is a small WAV, and onSpeakingEnd pumps the
  // next until the queue drains (then -> idle).
  const speechQueue: string[] = [];

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
    }
  };
  const onBoundary = (): void => controller.pulse();

  // Server-audio TTS reused as native TTS: the WAV bytes come from Rust SAPI via
  // `tts_synthesize`, decoded and played through Web Audio, with the Speaking
  // animation driven off the real amplitude envelope.
  const mediaTts = new MediaTts({
    fetchImpl: tauriTtsFetch(invoke),
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
    options.onTranscript?.('jarvis', parsed.stripped); // HUD chat log
    const chunks = splitForSpeech(parsed.stripped);
    if (chunks.length === 0) {
      return true;
    }
    speechQueue.push(...chunks);
    pumpSpeech();
    return true;
  };

  // --- STT (Phase 2): local Whisper + VAD auto-send-on-pause ----------------
  const listen = options.listen ?? defaultListen;

  // One mic stream, dual-tapped: the analyser drives the Listening visual, the
  // worklet pushes 16 kHz Int16 frames to the Rust VAD/STT worker.
  const capture = new SttCapture({
    onFrame: (frame) => {
      // Raw binary body (NOT a JSON number array): pass the ArrayBuffer directly.
      void invoke('stt_push_frame', frame.buffer as ArrayBuffer).catch(() => undefined);
    },
    onLevel: (level) => controller.setMicLevel(level),
    onBands: (bands) => {
      controller.setMicBands(bands);
      options.onBands?.(bands); // HUD waveform reads the live mic spectrum
    },
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
  addListener<{ text: string }>('stt://final', (p) => {
    const text = (p.text ?? '').trim();
    if (!text) {
      return;
    }
    if (claudeConnected) {
      // Turn-taking: ignore input while Claude is thinking or speaking (this also
      // keeps the avatar from picking up its own TTS as a new request).
      if (signals.pendingResponse || signals.speaking) {
        return;
      }
      safeSetText(options.caption ?? null, text);
      options.onTranscript?.('user', text); // HUD chat log
      // Lock the turn synchronously NOW (before claude://thinking round-trips), so
      // a back-to-back utterance is rejected by the guard above. Clear it if the
      // submit IPC rejects, so a failed submit never wedges the UI in Thinking.
      signals.pendingResponse = true;
      sync();
      void invoke('claude_submit', { text }).catch((e: unknown) => {
        console.warn('[tauri-claude] submit', e);
        signals.pendingResponse = false;
        sync();
      });
    } else {
      safeSetText(options.caption ?? null, text);
      options.onTranscript?.('user', text); // HUD chat log
      options.onUtterance?.(text);
    }
  });
  addListener<{ state: string; downloaded: number; total: number }>('stt://model', (p) => {
    if (p.state === 'downloading') {
      const pct = p.total > 0 ? Math.floor((p.downloaded / p.total) * 100) : 0;
      safeSetText(options.caption ?? null, `Downloading speech model… ${pct}%`);
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

  // --- Claude bridge (Phase 3): the full voice loop -------------------------
  // onUtterance -> claude_submit -> Thinking -> spoken reply (with mood) -> idle.
  let claudeConnected = false;

  addListener<{ active: boolean }>('claude://thinking', (p) => {
    signals.pendingResponse = p.active;
    sync();
  });
  // Telemetry: each tool Claude runs this turn, and per-turn token usage + cost.
  addListener<ClaudeActivity>('claude://activity', (p) => options.onActivity?.(p));
  addListener<ClaudeUsage>('claude://usage', (p) => options.onUsage?.(p));
  addListener<{ text: string; is_error: boolean }>('claude://turn-end', (p) => {
    const text = (p.text ?? '').trim();
    if (!text || p.is_error) {
      // Nothing to speak: clear Thinking now; surface an error reply as a caption.
      signals.pendingResponse = false;
      if (text && p.is_error) {
        safeSetText(options.caption ?? null, text);
      }
      sync();
      return;
    }
    // Leave pendingResponse true (Thinking) until onSpeakingStart flips it to
    // Speaking, so there is no idle flicker between Thinking and the spoken reply.
    void speak(text); // parses mood, captions, and queues the reply
  });
  addListener<{ active: boolean; cwd: string }>('claude://ready', (p) => {
    if (p.active) {
      if (p.cwd) {
        safeSetText(options.caption ?? null, `Claude connected: ${p.cwd}`);
      }
    } else {
      // The child exited on its own: stop routing utterances to a dead session and
      // recover the UI (otherwise the next utterance would wedge it in Thinking).
      claudeConnected = false;
      signals.pendingResponse = false;
      sync();
    }
  });

  const startClaude = async (dir?: string): Promise<boolean> => {
    try {
      await invoke('claude_start', dir ? { dir } : {});
      claudeConnected = true;
      return true;
    } catch (e: unknown) {
      console.warn('[tauri-claude] start', e);
      claudeConnected = false;
      return false;
    }
  };
  const stopClaude = (): void => {
    claudeConnected = false;
    void invoke('claude_stop').catch(() => undefined);
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
    isClaudeConnected: () => claudeConnected,
    setState: (state) => controller.setState(state),
    dispose: () => {
      capture.stop();
      void invoke('stt_stop').catch(() => undefined);
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
