/**
 * Public entry point for the Jarvis avatar bundle.
 *
 * Built two ways:
 *  - IIFE global (`window.JarvisAvatar`) via `vite.lib.config.ts`, loaded by the
 *    injected `mcp-voice-hooks` page after the vendored global `THREE`; and
 *  - imported directly (ESM) by the standalone demo during development.
 */

export const VERSION = '0.2.0';

export { Avatar, IDLE_PARAMS } from './avatar/Avatar';
export type { AvatarOptions, RendererFactory } from './avatar/Avatar';
export { displacement } from './avatar/deformation';
export type { DeformationParams } from './avatar/deformation';
export { perlin3 } from './avatar/noise';
