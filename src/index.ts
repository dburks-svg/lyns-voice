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
export { extractHeadGeometry, normalizeHeadGeometry, loadHeadGeometry } from './avatar/gltf';
export type { GLTFLoaderLike, GLTFLoaderFactory, GLTFResultLike, LoadHeadOptions } from './avatar/gltf';
export { perlin3 } from './avatar/noise';
export { MicAnalyser, computeLevel } from './audio/MicAnalyser';
export type { MicAnalyserOptions, GetUserMedia } from './audio/MicAnalyser';
export { computeBands } from './audio/bands';
export { SpeechReactor } from './audio/SpeechReactor';
export type { SpeechReactorOptions } from './audio/SpeechReactor';
export { attachToVoiceHooks, deriveState } from './integration/voiceHooksAdapter';
export type { VoiceSignals, VoiceHooksHandle } from './integration/voiceHooksAdapter';
export { safeSetText, prefersReducedMotion } from './integration/dom';
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
export { MoodController } from './mood/MoodController';
export type { MoodLayer } from './mood/MoodController';
export { parseMoodMarker } from './mood/moodProtocol';
export type { ParsedMood } from './mood/moodProtocol';
export { MOODS, MOOD_TABLE, isMood } from './mood/moods';
export type { Mood, MoodVisual } from './mood/moods';
export { lerpHex, lerp, clamp01 } from './mood/colorBlend';
export { TranscriptMoodObserver } from './integration/transcriptMoodObserver';
export type { TranscriptMoodObserverOptions } from './integration/transcriptMoodObserver';
