import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  Avatar,
  AvatarController,
  DEFAULT_CONFIG,
  VERSION,
  prefersReducedMotion,
  type AvatarState,
} from '../index';
import headUrl from '../../vendor/head.glb?url';

/**
 * Jarvis desktop app entry (Phase 0 scaffold).
 *
 * Mounts the avatar full-window in the native Tauri webview and runs the
 * controller-driven loop. A temporary debug cluster cycles the four states
 * until the STT / TTS / Claude adapters drive them (Phases 1-3). The avatar
 * rendering, state machine, and config are reused verbatim from the library;
 * only the host shell is new.
 */
function bootstrap(): void {
  const root = document.getElementById('avatar-root');
  if (!root) {
    return;
  }

  const avatar = new Avatar({
    skin: DEFAULT_CONFIG.skin,
    headUrl,
    gltfLoaderFactory: () => new GLTFLoader(),
  });
  avatar.reducedMotion = prefersReducedMotion(window);
  avatar.mount(root);

  const controller = new AvatarController({ avatar });
  avatar.beforeRender = (time) => controller.tick(time);
  avatar.start();

  // The stage IS the window in the desktop app, so size the canvas to it.
  const fit = (): void => avatar.resize(window.innerWidth, window.innerHeight);
  fit();
  window.addEventListener('resize', fit);

  for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-state]')) {
    button.addEventListener('click', () => {
      const next = button.dataset.state as AvatarState | undefined;
      if (next) {
        controller.setState(next);
      }
    });
  }

  const label = document.getElementById('status');
  if (label) {
    label.textContent = `Jarvis v${VERSION}`;
  }
}

bootstrap();
