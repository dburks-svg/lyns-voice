/**
 * Public API barrel (no side effects). The demo imports this directly; the
 * injected host bundle (`bundle.ts`) re-exports it as the global `JarvisAvatar`
 * and adds auto-attach.
 */

// Keep in sync with package.json "version"; tests/version.test.ts enforces it.
export const VERSION = '0.4.0';

export { Avatar, IDLE_PARAMS } from './avatar/Avatar';
export type { AvatarOptions, RendererFactory } from './avatar/Avatar';
export { AvatarController } from './avatar/AvatarController';
export type {
  AvatarState,
  ControllableAvatar,
  AvatarControllerOptions,
} from './avatar/AvatarController';
export { displacement } from './avatar/deformation';
export type { DeformationParams } from './avatar/deformation';
export { perlin3 } from './avatar/noise';
export { MicAnalyser, computeLevel } from './audio/MicAnalyser';
export type { MicAnalyserOptions, GetUserMedia } from './audio/MicAnalyser';
export { SpeechReactor } from './audio/SpeechReactor';
export type { SpeechReactorOptions } from './audio/SpeechReactor';
export { attachToVoiceHooks, deriveState } from './integration/voiceHooksAdapter';
export type { VoiceSignals, VoiceHooksHandle } from './integration/voiceHooksAdapter';
export { safeSetText } from './integration/dom';
export { DEFAULT_CONFIG, cloneConfig } from './config/config';
export type {
  AvatarConfig,
  Skin,
  GlowMode,
  MoodSource,
  PaletteConfig,
  FeatureFlags,
} from './config/config';
export { loadConfig, saveConfig, sanitizeConfig, STORAGE_KEY } from './config/store';
export type { StorageLike } from './config/store';
