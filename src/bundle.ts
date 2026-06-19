/**
 * IIFE bundle entry (built to `dist/avatar.js`).
 *
 * Re-exports the public API as the global `JarvisAvatar` and auto-attaches the
 * avatar to an mcp-voice-hooks page once the DOM is ready. The demo imports
 * `./index` directly, so this auto-init runs only inside the injected host
 * bundle, never in the demo.
 */
import { attachToVoiceHooks } from './integration/voiceHooksAdapter';

export * from './index';

function isVoiceHooksHost(): boolean {
  return Boolean(
    document.getElementById('micBtn') || document.getElementById('conversationMessages'),
  );
}

function autoAttach(): void {
  if (isVoiceHooksHost()) {
    attachToVoiceHooks();
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoAttach, { once: true });
  } else {
    autoAttach();
  }
}
