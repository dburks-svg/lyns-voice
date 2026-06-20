/**
 * Pure, side-effect-free helpers for injecting the Jarvis avatar assets into an
 * `mcp-voice-hooks` `public/index.html`.
 *
 * These string transforms are kept free of filesystem access so they can be
 * unit-tested deterministically; `inject.mjs` wraps them with the actual file
 * IO (discovery, backup, copy, write).
 */

import path from 'node:path';

export const MARKER_BEGIN = '<!-- AVATAR:BEGIN (jarvis-avatar) -->';
export const MARKER_END = '<!-- AVATAR:END (jarvis-avatar) -->';

/**
 * Asset files copied next to the target `index.html`. The script/style assets
 * are also referenced by the injected markup (see buildInjectionBlock); `head.glb`
 * is fetched at runtime by the bundle, and `favicon.ico` is requested
 * automatically by the browser and served by the host's `express.static`, so
 * both are copied but never tagged. Script load order matters: the vendored
 * global `THREE` loads first, then GLTFLoader (which augments `THREE`), then the
 * avatar bundle that consumes both.
 * @type {readonly string[]}
 */
export const ASSET_FILES = Object.freeze([
  'three.min.js',
  'GLTFLoader.js',
  'avatar.css',
  'avatar.js',
  'head.glb',
  'favicon.ico',
]);

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches an existing avatar block, including leading indent and trailing newline. */
const BLOCK_REGION = new RegExp(
  `[ \\t]*${escapeRegExp(MARKER_BEGIN)}[\\s\\S]*?${escapeRegExp(MARKER_END)}[ \\t]*\\n?`,
);

/**
 * Build the marked HTML block injected before `</body>`.
 * @returns {string}
 */
export function buildInjectionBlock() {
  return [
    MARKER_BEGIN,
    '    <link rel="stylesheet" href="avatar.css" />',
    '    <script src="three.min.js"></script>',
    '    <script src="GLTFLoader.js"></script>',
    '    <script src="avatar.js"></script>',
    MARKER_END,
  ].join('\n');
}

/**
 * Whether the avatar block is already present in the HTML.
 * @param {string} html
 * @returns {boolean}
 */
export function isInjected(html) {
  return html.includes(MARKER_BEGIN) && html.includes(MARKER_END);
}

/**
 * Heuristic sentinel: does this HTML look like the `mcp-voice-hooks` UI? Requires
 * the `app.js` client plus one known DOM anchor so we never patch an unrelated
 * page.
 * @param {string} html
 * @returns {boolean}
 */
export function looksLikeVoiceHooksIndex(html) {
  const hasClient = /\bapp\.js\b/.test(html);
  const hasAnchor =
    /id=["']micBtn["']/.test(html) ||
    /id=["']conversationMessages["']/.test(html) ||
    /MessengerClient/.test(html);
  return hasClient && hasAnchor;
}

/**
 * Remove the avatar block. Returns the HTML unchanged when not injected.
 * @param {string} html
 * @returns {string}
 */
export function revertHtml(html) {
  if (!isInjected(html)) {
    return html;
  }
  return html.replace(BLOCK_REGION, '');
}

/**
 * Insert the avatar block immediately before the closing `</body>` tag.
 *
 * Idempotent by construction: any pre-existing block is stripped first, then a
 * fresh block is inserted, so running twice yields byte-identical output.
 * @param {string} html
 * @returns {string}
 */
export function injectIntoHtml(html) {
  const stripped = revertHtml(html);
  const closingBody = /([ \t]*)<\/body>/i;
  if (!closingBody.test(stripped)) {
    throw new Error('Target HTML has no </body> tag; refusing to inject.');
  }
  const block = buildInjectionBlock();
  return stripped.replace(closingBody, (_match, indent) => `${block}\n${indent}</body>`);
}

/**
 * Validate that a path is a plausible, safe injection target. Guards against
 * null-byte tricks and non-`index.html` targets before any file is written.
 * @param {string} targetPath
 * @returns {string} the normalized absolute path
 */
export function assertSafeTargetPath(targetPath) {
  if (typeof targetPath !== 'string' || targetPath.length === 0) {
    throw new Error('Target path must be a non-empty string.');
  }
  if (targetPath.includes('\0')) {
    throw new Error('Target path contains a null byte.');
  }
  const resolved = path.resolve(targetPath);
  if (path.basename(resolved).toLowerCase() !== 'index.html') {
    throw new Error(`Refusing to operate on non-index file: ${resolved}`);
  }
  return resolved;
}
