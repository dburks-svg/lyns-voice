import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DEFAULT_CONFIG, VERSION, type AvatarState } from '../index';
import { attachTauri } from '../integration/tauriAdapter';
import headUrl from '../../vendor/head.glb?url';

/**
 * Jarvis desktop app entry.
 *
 * Mounts the avatar full-window in the native Tauri webview through
 * `attachTauri`, which owns the voice-signal seam and the TTS path. A temporary
 * debug cluster cycles the four states and drives a manual "speak" until the
 * STT (Phase 2) and Claude bridge (Phase 3) adapters take over. The avatar
 * rendering, state machine, mood, and TTS are reused verbatim; only the shell is
 * new.
 */
function bootstrap(): void {
  const root = document.getElementById('avatar-root');
  if (!root) {
    return;
  }
  const label = document.getElementById('status');

  const handle = attachTauri({
    root,
    caption: document.getElementById('caption'),
    avatarOptions: {
      skin: DEFAULT_CONFIG.skin,
      headUrl,
      gltfLoaderFactory: () => new GLTFLoader(),
    },
  });

  for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-state]')) {
    button.addEventListener('click', () => {
      const next = button.dataset.state as AvatarState | undefined;
      if (next) {
        handle.setState(next);
      }
    });
  }

  // Phase 1 manual TTS trigger: speak the typed line through native SAPI. Try a
  // mood tag (e.g. "<<mood:happy>> hello") to confirm it tints and is never heard
  // or shown. The Claude bridge drives this same path in Phase 3.
  const speakInput = document.getElementById('speak-input') as HTMLInputElement | null;
  const speakButton = document.getElementById('speak-btn');
  const doSpeak = (): void => {
    const text = speakInput?.value.trim();
    if (!text) {
      return;
    }
    void handle.speak(text).then((ok) => {
      if (!ok && label) {
        label.textContent = 'voice unavailable (TTS failed)';
      }
    });
  };
  speakButton?.addEventListener('click', doSpeak);
  speakInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      doSpeak();
    }
  });

  // Phase 2: tap-to-talk. Mic capture + local Whisper STT auto-finalize on a
  // pause; the recognized text appears in the caption. (Phase 3 sends it to Claude.)
  const micButton = document.getElementById('mic-btn');
  micButton?.addEventListener('click', () => {
    if (handle.isListening()) {
      handle.stopListening();
      micButton.textContent = 'talk';
      micButton.classList.remove('active');
      return;
    }
    void handle.startListening().then((ok) => {
      if (ok) {
        micButton.textContent = 'stop';
        micButton.classList.add('active');
      } else if (label) {
        label.textContent = 'mic permission denied';
      }
    });
  });

  if (label) {
    label.textContent = `Jarvis v${VERSION}`;
  }
}

bootstrap();
