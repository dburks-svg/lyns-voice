/**
 * IIFE bundle entry (built to `dist/avatar.js`).
 *
 * Re-exports the public API as the global `JarvisAvatar` and auto-attaches the
 * avatar to an mcp-voice-hooks page once the DOM is ready. The demo imports
 * `./index` directly, so this auto-init runs only inside the injected host
 * bundle, never in the demo.
 */
import * as THREE from 'three';
import { attachToVoiceHooks } from './integration/voiceHooksAdapter';
import { DEFAULT_CONFIG } from './config/config';
import type { AvatarOptions } from './avatar/Avatar';
import type { GLTFLoaderLike } from './avatar/gltf';

export * from './index';

function isVoiceHooksHost(): boolean {
  return Boolean(
    document.getElementById('micBtn') || document.getElementById('conversationMessages'),
  );
}

/**
 * Host avatar options: the head skin plus the GLTF loader vendored as a global
 * (`THREE.GLTFLoader` from `vendor/GLTFLoader.js`). If that script is not present
 * the loader is omitted and the avatar gracefully shows the orb.
 */
function hostAvatarOptions(): AvatarOptions {
  const options: AvatarOptions = { skin: DEFAULT_CONFIG.skin, headUrl: DEFAULT_CONFIG.headUrl };
  const loaderCtor = (THREE as unknown as { GLTFLoader?: new () => GLTFLoaderLike }).GLTFLoader;
  if (typeof loaderCtor === 'function') {
    options.gltfLoaderFactory = (): GLTFLoaderLike => new loaderCtor();
  }
  return options;
}

function autoAttach(): void {
  if (isVoiceHooksHost()) {
    attachToVoiceHooks(document, hostAvatarOptions());
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoAttach, { once: true });
  } else {
    autoAttach();
  }
}
