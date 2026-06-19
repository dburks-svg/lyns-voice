import { Avatar, type AvatarOptions } from '../avatar/Avatar';
import { AvatarController, type AvatarState } from '../avatar/AvatarController';
import { MicAnalyser } from '../audio/MicAnalyser';
import { SpeechReactor } from '../audio/SpeechReactor';
import { MediaTts } from '../audio/MediaTts';
import { MoodController } from '../mood/MoodController';
import { parseMoodMarker } from '../mood/moodProtocol';
import { prefersReducedMotion, safeSetText } from './dom';
import { TranscriptMoodObserver } from './transcriptMoodObserver';
import { enableTakeover, type TakeoverHandle } from './takeover';

/**
 * Observable signals about the mcp-voice-hooks conversation, mapped to an avatar
 * state. Pure and unit-tested; the priority encodes the spec's behaviour:
 * speaking overrides listening overrides thinking overrides idle.
 */
export interface VoiceSignals {
  micActive: boolean;
  speaking: boolean;
  pendingResponse: boolean;
}

export function deriveState(signals: VoiceSignals): AvatarState {
  if (signals.speaking) {
    return 'speaking';
  }
  if (signals.micActive) {
    return 'listening';
  }
  if (signals.pendingResponse) {
    return 'thinking';
  }
  return 'idle';
}

export interface VoiceHooksHandle {
  avatar: Avatar;
  controller: AvatarController;
  dispose(): void;
}

/** Optional integration behaviours layered on top of the base avatar binding. */
export interface AttachOptions {
  /** Replace the host UI with the full-screen "Jarvis only" view. */
  takeover?: boolean;
}

interface RecognitionLike extends EventTarget {
  start?: () => void;
}
type RecognitionCtor = new () => RecognitionLike;
type PatchedCtor = RecognitionCtor & { __jarvisPatched?: boolean };
interface SpeechWindow {
  SpeechRecognition?: RecognitionCtor;
  webkitSpeechRecognition?: RecognitionCtor;
}

/**
 * Patch the SpeechRecognition constructor so every recogniser created afterwards
 * reports start/end to us (the most reliable Listening signal). Best-effort:
 * recognisers created before this runs are not observed; the mic-button observer
 * below is the fallback.
 *
 * Re-entrancy/teardown safe: refuses to double-wrap an already-patched slot, and
 * the returned unpatch only restores if we still own the slot, so it never
 * clobbers a patcher installed after us. Returns an unpatch function.
 */
function patchSpeechRecognition(
  win: SpeechWindow,
  onStart: () => void,
  onEnd: () => void,
): () => void {
  const key: keyof SpeechWindow | null = win.webkitSpeechRecognition
    ? 'webkitSpeechRecognition'
    : win.SpeechRecognition
      ? 'SpeechRecognition'
      : null;
  if (!key) {
    return () => undefined;
  }
  const current = win[key] as PatchedCtor;
  if (current.__jarvisPatched) {
    return () => undefined;
  }
  const Original = current;
  const Patched = function PatchedRecognition(): RecognitionLike {
    const instance = new Original();
    instance.addEventListener('start', onStart);
    instance.addEventListener('end', onEnd);
    return instance;
  } as unknown as PatchedCtor;
  Patched.prototype = Original.prototype;
  Patched.__jarvisPatched = true;
  win[key] = Patched;
  return () => {
    if (win[key] === Patched) {
      win[key] = Original;
    }
  };
}

/**
 * Mount the avatar onto a live mcp-voice-hooks page and bind it to voice
 * signals: speech-synthesis output (Speaking + word impulses), the mic
 * (Listening level + state), and a thinking window between the two.
 *
 * Defensive: missing host elements degrade gracefully rather than throw. The
 * host-signal heuristics are best-effort and may need tuning per mcp-voice-hooks
 * version; the tested core (controller, reactors, deriveState) is version-proof.
 */
export function attachToVoiceHooks(
  doc: Document = document,
  avatarOptions?: AvatarOptions,
  options: AttachOptions = {},
): VoiceHooksHandle {
  const overlay = doc.createElement('div');
  overlay.id = 'jarvis-avatar-overlay';
  doc.body.appendChild(overlay);

  const avatar = new Avatar(avatarOptions);
  avatar.reducedMotion = prefersReducedMotion(doc.defaultView);
  avatar.mount(overlay);

  const signals: VoiceSignals = { micActive: false, speaking: false, pendingResponse: false };
  const statusLabel = doc.getElementById('jarvis-avatar-status');

  // Mood layer: activity drives motion, mood tints color/glow. Default neutral
  // (pass-through), so with no mood tag the avatar looks exactly as before.
  const mood = new MoodController();

  // Optional "Jarvis only" takeover; assigned below once host elements are known.
  // The onStateChange closure captures it by reference, so state updates routed
  // here reach it once it exists (the controller never fires during construction).
  let takeover: TakeoverHandle | null = null;

  const controller = new AvatarController({
    avatar,
    onStateChange: (state) => {
      safeSetText(statusLabel, state);
      takeover?.setState(state);
    },
    moodProvider: mood,
  });
  avatar.beforeRender = (time) => controller.tick(time);
  avatar.start();

  // The overlay is a full-window dominant layer; keep the canvas sized to it.
  const view = doc.defaultView ?? window;
  const resizeToHost = (): void =>
    avatar.resize(
      overlay.clientWidth || view.innerWidth || 1,
      overlay.clientHeight || view.innerHeight || 1,
    );
  resizeToHost();
  view.addEventListener('resize', resizeToHost);
  const resizeObserver =
    typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resizeToHost()) : null;
  resizeObserver?.observe(overlay);

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

  // Server-audio TTS: on Windows the native speechSynthesis engine is silent
  // (SAPI audio never reaches the output device), so we play a server-rendered
  // WAV through Web Audio instead, and drive the Speaking animation from the
  // real audio amplitude. Falls back to the native engine when the endpoint is
  // unavailable (e.g. macOS), so other hosts are unaffected.
  const mediaTts = new MediaTts({ onSpeakingStart, onSpeakingEnd, onBoundary });

  const speech = new SpeechReactor({
    onSpeakingStart,
    onSpeakingEnd,
    onBoundary,
    // Primary mood-strip point: the spoken text is where Claude reliably emits
    // the tag. Strip it before TTS speaks it, and apply the mood.
    transformText: (text) => {
      const parsed = parseMoodMarker(text);
      if (parsed.mood) {
        mood.setMood(parsed.mood);
      }
      return parsed.stripped;
    },
    mediaSpeak: (text) => mediaTts.speak(text),
  });
  speech.attach();

  // Resume the audio context on the first user gesture so the browser autoplay
  // policy allows server-audio playback. Cheap and idempotent; kept live so a
  // later suspend (tab backgrounding) is recovered on the next interaction.
  const unlockAudio = (): void => mediaTts.unlock();
  doc.addEventListener('pointerdown', unlockAudio, true);

  // Secondary mood-strip point: a backstop on the rendered transcript so a
  // marker is never left visible if it bypasses the speak path.
  const messages = doc.getElementById('conversationMessages');
  const transcript = messages
    ? new TranscriptMoodObserver({ root: messages, onMood: (m) => mood.setMood(m) })
    : null;
  transcript?.start();

  const mic = new MicAnalyser({
    onLevel: (level) => controller.setMicLevel(level),
    onBands: (bands) => controller.setMicBands(bands),
  });

  const onRecognitionStart = (): void => {
    signals.micActive = true;
    signals.pendingResponse = false;
    void mic.start();
    sync();
  };
  const onRecognitionEnd = (): void => {
    signals.micActive = false;
    // User finished talking; Claude is now thinking until speech starts.
    signals.pendingResponse = true;
    mic.stop();
    sync();
  };

  const win = (doc.defaultView ?? window) as unknown as SpeechWindow;
  const unpatch = patchSpeechRecognition(win, onRecognitionStart, onRecognitionEnd);

  // Fallback: observe the mic button toggling its active/listening state.
  const micBtn = doc.getElementById('micBtn');
  const micObserver = micBtn
    ? observeAttribute(micBtn, () => {
        const active = isMicButtonActive(micBtn);
        if (active !== signals.micActive) {
          if (active) {
            onRecognitionStart();
          } else {
            onRecognitionEnd();
          }
        }
      })
    : null;

  // "Jarvis only" view: hide the host chrome, show the head full-screen with a
  // reply caption and a tap-to-talk control proxying the real mic button.
  if (options.takeover) {
    takeover = enableTakeover({ doc, micButton: micBtn, messagesRoot: messages });
    takeover.setState(controller.current);
  }

  return {
    avatar,
    controller,
    dispose: () => {
      speech.detach();
      mediaTts.dispose();
      doc.removeEventListener('pointerdown', unlockAudio, true);
      mic.stop();
      unpatch();
      micObserver?.disconnect();
      takeover?.dispose();
      transcript?.dispose();
      view.removeEventListener('resize', resizeToHost);
      resizeObserver?.disconnect();
      avatar.dispose();
      overlay.remove();
    },
  };
}

export function isMicButtonActive(button: HTMLElement): boolean {
  const cls = button.className.toLowerCase();
  return (
    button.getAttribute('aria-pressed') === 'true' ||
    cls.includes('listening') ||
    cls.includes('recording') ||
    cls.includes('active')
  );
}

function observeAttribute(target: HTMLElement, onChange: () => void): MutationObserver {
  const observer = new MutationObserver(onChange);
  observer.observe(target, { attributes: true, attributeFilter: ['class', 'aria-pressed'] });
  return observer;
}
