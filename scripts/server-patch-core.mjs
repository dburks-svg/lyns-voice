/**
 * Pure, side-effect-free helpers for patching the Jarvis `POST /api/tts-wav`
 * route into an `mcp-voice-hooks` `dist/unified-server.js`.
 *
 * Why this exists: on Windows the browser speech engine never reaches the
 * speakers (Windows SAPI audio routing is broken on the host), so the avatar
 * plays server-synthesized WAV audio through Web Audio instead. That requires a
 * server route the stock `mcp-voice-hooks` build does not ship. Hand-editing the
 * installed file is wiped on every package update; this module folds the route
 * into the idempotent, reversible injector so it survives updates (re-run
 * `npm run inject` after an update and the route comes back).
 *
 * These string transforms are kept free of filesystem access so they can be
 * unit-tested deterministically; `inject.mjs` wraps them with the file IO.
 */

export const SERVER_MARKER_BEGIN = '// AVATAR:SERVER:BEGIN (jarvis-avatar tts-wav)';
export const SERVER_MARKER_END = '// AVATAR:SERVER:END (jarvis-avatar tts-wav)';

/**
 * The injected route, fully self-contained: every dependency (os, fs, path,
 * child_process, util, crypto) is dynamically imported inside the handler so the
 * block does not rely on outer-scope symbols (`promisify`, `randomUUID`,
 * `debugLog`, ...) that a future `mcp-voice-hooks` build could rename or drop.
 * The only host couplings left are the express `app` and its JSON body
 * middleware, both registered long before our `app.listen(` anchor.
 *
 * Synthesizes `text` to a WAV via Windows `System.Speech` (PowerShell) and
 * returns `audio/wav`. Text crosses the shell as base64 so no user content is
 * ever interpolated into the PowerShell command.
 * @type {string}
 */
const ROUTE_BODY = [
  'app.post("/api/tts-wav", async (req, res) => {',
  '  const { text, rate = 0 } = req.body || {};',
  '  if (!text || !String(text).trim()) {',
  '    res.status(400).json({ error: "Text is required" });',
  '    return;',
  '  }',
  '  try {',
  '    const os = await import("os");',
  '    const fs = await import("fs/promises");',
  '    const nodePath = await import("path");',
  '    const { execFile } = await import("child_process");',
  '    const { promisify: promisify2 } = await import("util");',
  '    const { randomUUID: randomUUID2 } = await import("crypto");',
  '    const execFileAsync = promisify2(execFile);',
  '    const b64 = Buffer.from(String(text), "utf8").toString("base64");',
  '    const safeRate = Math.max(-10, Math.min(10, parseInt(rate, 10) || 0));',
  '    const wavPath = nodePath.join(os.tmpdir(), `vh-tts-${randomUUID2()}.wav`);',
  "    const psWavPath = wavPath.replace(/'/g, \"''\");",
  '    const script = [',
  '      "Add-Type -AssemblyName System.Speech;",',
  "      \"$t=[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('\" + b64 + \"'));\",",
  '      "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;",',
  "      \"$s.SetOutputToWaveFile('\" + psWavPath + \"');\",",
  '      "$s.Rate=" + safeRate + ";",',
  '      "$s.Speak($t);",',
  '      "$s.Dispose();"',
  '    ].join(" ");',
  '    await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });',
  '    const buf = await fs.readFile(wavPath);',
  '    res.setHeader("Content-Type", "audio/wav");',
  '    res.setHeader("Cache-Control", "no-store");',
  '    res.send(buf);',
  '    fs.unlink(wavPath).catch(() => {});',
  '  } catch (error) {',
  '    res.status(500).json({',
  '      error: "Failed to synthesize speech",',
  '      details: error instanceof Error ? error.message : String(error)',
  '    });',
  '  }',
  '});',
].join('\n');

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches an existing marked server block, including a trailing newline. */
const SERVER_BLOCK_REGION = new RegExp(
  `${escapeRegExp(SERVER_MARKER_BEGIN)}[\\s\\S]*?${escapeRegExp(SERVER_MARKER_END)}\\n?`,
);

/** Anchor: the express server's listen call. We insert just before it. */
const LISTEN_ANCHOR = /^[ \t]*app\.listen\(/m;

/**
 * The full marked block inserted before `app.listen(`.
 * @returns {string}
 */
export function buildServerBlock() {
  return [SERVER_MARKER_BEGIN, ROUTE_BODY, SERVER_MARKER_END].join('\n');
}

/**
 * Whether the marked tts-wav block is already present.
 * @param {string} js
 * @returns {boolean}
 */
export function isServerPatched(js) {
  return js.includes(SERVER_MARKER_BEGIN) && js.includes(SERVER_MARKER_END);
}

/**
 * Heuristic sentinel: does this file look like the `mcp-voice-hooks` server?
 * Requires an express app plus its listen call so we never patch an unrelated
 * file.
 * @param {string} js
 * @returns {boolean}
 */
export function looksLikeVoiceHooksServer(js) {
  return /\bexpress\(\)/.test(js) && LISTEN_ANCHOR.test(js) && /app\.use\(/.test(js);
}

/**
 * Remove the marked block. Returns the source unchanged when not patched.
 * @param {string} js
 * @returns {string}
 */
export function unpatchServer(js) {
  if (!isServerPatched(js)) {
    return js;
  }
  return js.replace(SERVER_BLOCK_REGION, '');
}

/**
 * Insert the tts-wav route immediately before the first `app.listen(`.
 *
 * Idempotent by construction: any pre-existing marked block is stripped first,
 * then a fresh block is inserted, so running twice yields identical output. Also
 * strips a legacy unmarked route (an earlier hand-applied patch) so the
 * transition from the manual patch does not leave two `/api/tts-wav` handlers.
 * @param {string} js
 * @returns {string}
 */
export function patchServer(js) {
  let stripped = unpatchServer(js);
  stripped = stripLegacyUnmarkedRoute(stripped);
  if (!LISTEN_ANCHOR.test(stripped)) {
    throw new Error('Target server has no app.listen( call; refusing to patch.');
  }
  const block = buildServerBlock();
  return stripped.replace(LISTEN_ANCHOR, (match) => `${block}\n${match}`);
}

/**
 * Best-effort removal of an earlier hand-applied, marker-less `/api/tts-wav`
 * route so re-injection over a manually-patched file does not duplicate it.
 * Matches `app.post("/api/tts-wav", ...)` up to its closing `});`.
 * @param {string} js
 * @returns {string}
 */
export function stripLegacyUnmarkedRoute(js) {
  const legacy = /[ \t]*app\.post\(\s*["']\/api\/tts-wav["'][\s\S]*?\n\}\);\n?/;
  return js.replace(legacy, '');
}
