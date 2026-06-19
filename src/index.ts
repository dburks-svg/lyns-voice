/**
 * Public entry point for the Jarvis avatar bundle.
 *
 * This module is built two ways:
 *  - as an IIFE global (`window.JarvisAvatar`) via `vite.lib.config.ts`, loaded by the
 *    injected `mcp-voice-hooks` page after the vendored global `THREE`; and
 *  - imported directly (ESM) by the standalone demo during development.
 *
 * Concrete avatar/controller/audio exports are added in later phases.
 */

export const VERSION = '0.1.0';
