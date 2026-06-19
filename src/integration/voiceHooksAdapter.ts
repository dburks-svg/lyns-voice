import { Avatar } from '../avatar/Avatar';
import { AvatarController, type AvatarState } from '../avatar/AvatarController';
import { MicAnalyser } from '../audio/MicAnalyser';
import { SpeechReactor } from '../audio/SpeechReactor';
import { safeSetText } from './dom';

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

interface RecognitionLike extends EventTarget {
  start?: () => void;
}
type RecognitionCtor = new () => RecognitionLike;
interface SpeechWindow {
  SpeechRecognition?: RecognitionCtor;
  webkitSpeechRecognition?: RecognitionCtor;
}

/**
 * Patch the SpeechRecognition constructor so every recogniser created afterwards
 * reports start/end to us (the most reliable Listening signal). Best-effort:
 * recognisers created before this runs are not observed; the mic-button observer
 * below is the fallback. Returns an unpatch function.
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
  const Original = win[key] as RecognitionCtor;
  const Patched = function PatchedRecognition(): RecognitionLike {
    const instance = new Original();
    instance.addEventListener('start', onStart);
    instance.addEventListener('end', onEnd);
    return instance;
  } as unknown as RecognitionCtor;
  Patched.prototype = Original.prototype;
  win[key] = Patched;
  return () => {
    win[key] = Original;
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
export function attachToVoiceHooks(doc: Document = document): VoiceHooksHandle {
  const overlay = doc.createElement('div');
  overlay.id = 'jarvis-avatar-overlay';
  doc.body.appendChild(overlay);

  const avatar = new Avatar();
  avatar.mount(overlay);

  const signals: VoiceSignals = { micActive: false, speaking: false, pendingResponse: false };
  const statusLabel = doc.getElementById('jarvis-avatar-status');

  const controller = new AvatarController({
    avatar,
    onStateChange: (state) => safeSetText(statusLabel, state),
  });
  avatar.beforeRender = (time) => controller.tick(time);
  avatar.start();

  const sync = (): void => controller.setState(deriveState(signals));

  const speech = new SpeechReactor({
    onSpeakingStart: () => {
      signals.speaking = true;
      signals.pendingResponse = false;
      sync();
    },
    onSpeakingEnd: () => {
      signals.speaking = false;
      sync();
    },
    onBoundary: () => controller.pulse(),
  });
  speech.attach();

  const mic = new MicAnalyser({ onLevel: (level) => controller.setMicLevel(level) });

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

  const unpatch = patchSpeechRecognition(
    window as unknown as SpeechWindow,
    onRecognitionStart,
    onRecognitionEnd,
  );

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

  return {
    avatar,
    controller,
    dispose: () => {
      speech.detach();
      mic.stop();
      unpatch();
      micObserver?.disconnect();
      avatar.dispose();
      overlay.remove();
    },
  };
}

function isMicButtonActive(button: HTMLElement): boolean {
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
