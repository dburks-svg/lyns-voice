import { VERSION } from '../src/index';

/**
 * Standalone demo bootstrap.
 *
 * Phase 1: confirm the scaffold loads and the source bundle is reachable.
 * Phase 2 mounts the avatar; Phase 3 wires the control panel to the four-state
 * controller and real mic/speech reactors.
 */
function bootstrap(): void {
  const status = document.getElementById('status');
  if (status) {
    status.textContent = `Jarvis Avatar v${VERSION} — Phase 1 scaffold ready`;
  }
}

bootstrap();
