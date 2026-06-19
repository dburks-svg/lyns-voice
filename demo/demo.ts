import { Avatar, VERSION } from '../src/index';

/**
 * Standalone demo bootstrap.
 *
 * Phase 2: mount the avatar and run the idle breathing loop in a real browser.
 * Phase 3 wires the control panel to the four-state controller and the real
 * mic/speech reactors.
 */
function bootstrap(): void {
  const root = document.getElementById('avatar-root');
  const status = document.getElementById('status');
  if (!root) {
    return;
  }

  const avatar = new Avatar();
  avatar.mount(root);
  avatar.start();

  window.addEventListener('resize', () => {
    avatar.resize(root.clientWidth, root.clientHeight);
  });

  if (status) {
    status.textContent = `Jarvis Avatar v${VERSION} - idle`;
  }
}

bootstrap();
