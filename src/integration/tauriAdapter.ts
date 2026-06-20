/**
 * The Tauri desktop host adapter: the seam between the native backend and the
 * avatar's four-state controller. It is the standalone-app counterpart to
 * `voiceHooksAdapter`, producing the SAME `VoiceSignals` transitions from Tauri
 * commands/events instead of DOM/SpeechRecognition heuristics.
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

import { Avatar, type AvatarOptions } from '../avatar/Avatar';
import { AvatarController, type AvatarState } from '../avatar/AvatarController';
import { MediaTts, type MediaTtsOptions } from '../audio/MediaTts';
import { MoodController } from '../mood/MoodController';
import { parseMoodMarker } from '../mood/moodProtocol';
import { prefersReducedMotion, safeSetText } from './dom';
import { deriveState, type VoiceSignals } from './signals';

/** Minimal shape of Tauri's `invoke`; injectable so the unit tests stay headless. */
export type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

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
  /** Passed straight to `new Avatar(...)` (skin, headUrl, gltfLoaderFactory). */
  avatarOptions?: AvatarOptions;
  /** Injectable `invoke`; defaults to lazy `@tauri-apps/api/core`. */
  invoke?: InvokeFn;
  /** Injectable window; defaults to the global `window`. */
  view?: Window;
}

export interface TauriHandle {
  avatar: Avatar;
  controller: AvatarController;
  /** Speak a (possibly mood-tagged) line: tint by mood, caption it, synth + animate. */
  speak(text: string): Promise<boolean>;
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

  const avatar = new Avatar(options.avatarOptions);
  avatar.reducedMotion = prefersReducedMotion(view);
  avatar.mount(options.root);

  // The seam: a host reduces what it observes to these three booleans; the
  // controller renders the priority-ordered state. Phase 1 only flips `speaking`.
  const signals: VoiceSignals = { micActive: false, speaking: false, pendingResponse: false };

  // Mood tints color/glow on top of the activity state; neutral is pass-through.
  const mood = new MoodController();

  const controller = new AvatarController({
    avatar,
    onStateChange: (state) => safeSetText(options.statusLabel ?? null, state),
    moodProvider: mood,
  });
  avatar.beforeRender = (time) => controller.tick(time);
  avatar.start();

  // The stage IS the window in the desktop app, so size the canvas to it.
  const fit = (): void => avatar.resize(view.innerWidth, view.innerHeight);
  fit();
  view.addEventListener('resize', fit);

  const sync = (): void => controller.setState(deriveState(signals));

  const onSpeakingStart = (): void => {
    signals.speaking = true;
    signals.pendingResponse = false;
    sync();
  };
  const onSpeakingEnd = (): void => {
    signals.speaking = false;
    sync();
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

  const speak = async (text: string): Promise<boolean> => {
    // Mood is parsed and STRIPPED here, before the text is spoken or captioned,
    // so the `<<mood:...>>` marker is never heard or shown (the spec contract).
    const parsed = parseMoodMarker(text);
    if (parsed.mood) {
      mood.setMood(parsed.mood);
    }
    safeSetText(options.caption ?? null, parsed.stripped);
    // No native-speechSynthesis fallback on a false result by design: this host's
    // browser speech engine is silent (the very reason MediaTts/SAPI exists), so a
    // fallback would be pointless. The caption stays readable; surface the failure
    // for observability and let the caller react to the boolean.
    const handled = await mediaTts.speak(parsed.stripped);
    if (!handled) {
      console.warn('[tauri-tts] native synthesis failed; caption shown without audio');
    }
    return handled;
  };

  return {
    avatar,
    controller,
    speak,
    setState: (state) => controller.setState(state),
    dispose: () => {
      mediaTts.dispose();
      view.document.removeEventListener('pointerdown', unlockAudio, true);
      view.removeEventListener('resize', fit);
      avatar.dispose();
    },
  };
}

/** Lazy default `invoke`; dynamic import keeps `@tauri-apps/api` out of the demo/test graph. */
async function defaultInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}
