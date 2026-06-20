#!/usr/bin/env node
/**
 * CLI: inject (or revert) the Jarvis avatar into an `mcp-voice-hooks`
 * `public/index.html`.
 *
 * Usage:
 *   node scripts/inject.mjs [--path <index.html|dir>] [--force] [--dry-run]
 *   node scripts/inject.mjs --revert [--path <index.html|dir>]
 *
 * Target discovery when `--path` is omitted:
 *   1. $MCP_VOICE_HOOKS_DIR/public/index.html (or .../index.html)
 *   2. <npm global node_modules>/mcp-voice-hooks/public/index.html (best-effort)
 *
 * Safety: validates the path, verifies the page looks like mcp-voice-hooks
 * (unless --force), backs up the pristine original once, and is idempotent.
 */

import { readFile, writeFile, copyFile, stat, lstat, access, rm } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  ASSET_FILES,
  assertSafeTargetPath,
  injectIntoHtml,
  isInjected,
  looksLikeVoiceHooksIndex,
  revertHtml,
} from './injector-core.mjs';
import {
  looksLikeVoiceHooksServer,
  patchServer,
  unpatchServer,
} from './server-patch-core.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const BACKUP_SUFFIX = '.avatar-backup';
const SERVER_BACKUP_SUFFIX = '.avatar-server-backup';
/** Server file location relative to the target `public/` dir. */
const SERVER_REL_FROM_PUBLIC = ['..', 'dist', 'unified-server.js'];

/** Asset filename -> source path within this repo. */
const ASSET_SOURCES = {
  'three.min.js': path.join(REPO_ROOT, 'vendor', 'three.min.js'),
  'GLTFLoader.js': path.join(REPO_ROOT, 'vendor', 'GLTFLoader.js'),
  'avatar.js': path.join(REPO_ROOT, 'dist', 'avatar.js'),
  'avatar.css': path.join(REPO_ROOT, 'dist', 'avatar.css'),
  'head.glb': path.join(REPO_ROOT, 'vendor', 'head.glb'),
};

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const args = { path: undefined, revert: false, force: false, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--revert') args.revert = true;
    else if (a === '--force') args.force = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--path') {
      args.path = argv[i + 1];
      i += 1;
    } else if (a.startsWith('--path=')) {
      args.path = a.slice('--path='.length);
    }
  }
  return args;
}

/**
 * @param {string} p
 * @returns {Promise<boolean>}
 */
async function exists(p) {
  try {
    await access(p, FS.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} p
 * @returns {Promise<boolean>}
 */
async function isSymlink(p) {
  try {
    const info = await lstat(p);
    return info.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Reject symlinked targets so injection cannot be redirected to clobber an
 * arbitrary file via a symlink named index.html.
 * @param {string} p
 */
async function assertNotSymlink(p) {
  if (await isSymlink(p)) {
    throw new Error(`Refusing to operate on a symlink: ${p}`);
  }
}

/**
 * Copy avatar assets next to the page, backing up any pre-existing host file of
 * the same name exactly once so injection stays reversible. Symlinked
 * destinations are skipped (never followed).
 * @param {string} publicDir
 */
async function copyAssets(publicDir) {
  for (const name of ASSET_FILES) {
    const src = ASSET_SOURCES[name];
    const dest = path.join(publicDir, name);
    if (!src || !(await exists(src))) {
      console.warn(`[avatar] asset not found, skipped: ${name} (build it with "npm run build:lib")`);
      continue;
    }
    if (await isSymlink(dest)) {
      console.warn(`[avatar] destination is a symlink, skipped: ${name}`);
      continue;
    }
    const backup = dest + BACKUP_SUFFIX;
    if ((await exists(dest)) && !(await exists(backup))) {
      await copyFile(dest, backup);
    }
    await copyFile(src, dest);
  }
}

/**
 * Reverse copyAssets: restore any backed-up host asset, otherwise remove the
 * avatar-owned file we added.
 * @param {string} publicDir
 */
async function restoreAssets(publicDir) {
  for (const name of ASSET_FILES) {
    const dest = path.join(publicDir, name);
    const backup = dest + BACKUP_SUFFIX;
    if (await isSymlink(dest)) {
      continue;
    }
    if (await exists(backup)) {
      await copyFile(backup, dest);
      await rm(backup, { force: true });
    } else if (await exists(dest)) {
      await rm(dest, { force: true });
    }
  }
}

/**
 * Patch the `/api/tts-wav` route into the `mcp-voice-hooks` server that sits
 * alongside the injected `public/` dir, so server-synthesized TTS works on
 * Windows. Backs up the pristine server once, is idempotent, and is skipped
 * (with a warning, never a hard failure) when the server file is missing,
 * symlinked, or does not look like an mcp-voice-hooks server.
 * @param {string} publicDir
 */
async function patchServerFile(publicDir) {
  const serverPath = path.join(publicDir, ...SERVER_REL_FROM_PUBLIC);
  if (!(await exists(serverPath))) {
    console.warn(`[avatar] server not found, skipped tts-wav route: ${serverPath}`);
    return;
  }
  if (await isSymlink(serverPath)) {
    console.warn('[avatar] server is a symlink, skipped tts-wav route.');
    return;
  }
  const original = await readFile(serverPath, 'utf8');
  if (!looksLikeVoiceHooksServer(original)) {
    console.warn('[avatar] server does not look like mcp-voice-hooks, skipped tts-wav route.');
    return;
  }
  const backup = serverPath + SERVER_BACKUP_SUFFIX;
  if (!(await exists(backup))) {
    // Only the pristine (unpatched) server is a valid backup; never snapshot an
    // already-patched file.
    await writeFile(backup, unpatchServer(original), 'utf8');
  }
  await writeFile(serverPath, patchServer(original), 'utf8');
  console.log('[avatar] Patched tts-wav route into', serverPath);
}

/**
 * Reverse patchServerFile: restore the pristine server backup if present,
 * otherwise strip our marked block. Removes the backup on success.
 * @param {string} publicDir
 */
async function restoreServerFile(publicDir) {
  const serverPath = path.join(publicDir, ...SERVER_REL_FROM_PUBLIC);
  if (!(await exists(serverPath)) || (await isSymlink(serverPath))) {
    return;
  }
  const backup = serverPath + SERVER_BACKUP_SUFFIX;
  if (await exists(backup)) {
    await copyFile(backup, serverPath);
    await rm(backup, { force: true });
  } else {
    await writeFile(serverPath, unpatchServer(await readFile(serverPath, 'utf8')), 'utf8');
  }
  console.log('[avatar] Removed tts-wav route from', serverPath);
}

/**
 * @param {string | undefined} explicit
 * @returns {Promise<string | undefined>}
 */
async function resolveTarget(explicit) {
  /** @type {string[]} */
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.MCP_VOICE_HOOKS_DIR) {
    candidates.push(path.join(process.env.MCP_VOICE_HOOKS_DIR, 'public', 'index.html'));
    candidates.push(path.join(process.env.MCP_VOICE_HOOKS_DIR, 'index.html'));
  }
  if (process.env.APPDATA) {
    candidates.push(
      path.join(process.env.APPDATA, 'npm', 'node_modules', 'mcp-voice-hooks', 'public', 'index.html'),
    );
  }

  for (const candidate of candidates) {
    let resolved = candidate;
    try {
      const info = await stat(candidate);
      if (info.isDirectory()) {
        const pub = path.join(candidate, 'public', 'index.html');
        resolved = (await exists(pub)) ? pub : path.join(candidate, 'index.html');
      }
    } catch {
      // candidate does not exist yet; fall through to the existence check below
    }
    if (await exists(resolved)) return resolved;
  }
  return undefined;
}

function printHelp() {
  console.log(
    [
      'Jarvis avatar injector',
      '',
      'Inject:  node scripts/inject.mjs [--path <index.html|dir>] [--force] [--dry-run]',
      'Revert:  node scripts/inject.mjs --revert [--path <index.html|dir>]',
      '',
      'Env: MCP_VOICE_HOOKS_DIR points at an installed mcp-voice-hooks directory.',
    ].join('\n'),
  );
}

/**
 * @returns {Promise<number>} process exit code
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }

  const target = await resolveTarget(args.path);
  if (!target) {
    console.error('[avatar] Could not locate an mcp-voice-hooks index.html.');
    console.error('[avatar] Pass --path <path-to-index.html> or set MCP_VOICE_HOOKS_DIR.');
    return 2;
  }

  const safeTarget = assertSafeTargetPath(target);
  await assertNotSymlink(safeTarget);
  const publicDir = path.dirname(safeTarget);
  // Also reject a symlinked containing directory so assets cannot be redirected
  // (lstat on index.html alone resolves the parent through a symlink).
  await assertNotSymlink(publicDir);
  const backupPath = safeTarget + BACKUP_SUFFIX;
  const original = await readFile(safeTarget, 'utf8');

  if (args.revert) {
    const restored = (await exists(backupPath)) ? await readFile(backupPath, 'utf8') : revertHtml(original);
    if (args.dryRun) {
      console.log('[avatar] (dry-run) would revert', safeTarget);
      return 0;
    }
    await writeFile(safeTarget, restored, 'utf8');
    await rm(backupPath, { force: true });
    await restoreAssets(publicDir);
    await restoreServerFile(publicDir);
    console.log('[avatar] Reverted', safeTarget);
    return 0;
  }

  if (!args.force && !looksLikeVoiceHooksIndex(original)) {
    console.error('[avatar] Target does not look like an mcp-voice-hooks page. Use --force to override.');
    return 2;
  }

  const next = injectIntoHtml(original);
  if (args.dryRun) {
    console.log('[avatar] (dry-run) would inject into', safeTarget, isInjected(original) ? '(refresh)' : '(new)');
    return 0;
  }

  if (!(await exists(backupPath))) {
    await writeFile(backupPath, original, 'utf8');
  }
  await writeFile(safeTarget, next, 'utf8');
  await copyAssets(publicDir);
  await patchServerFile(publicDir);
  console.log('[avatar] Injected avatar into', safeTarget);
  return 0;
}

const invokedDirectly = path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('[avatar] error:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
