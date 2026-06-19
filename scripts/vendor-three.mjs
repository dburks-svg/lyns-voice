#!/usr/bin/env node
/**
 * Copies the Three.js UMD build (installs the global `THREE`) from the installed
 * `three` package into `vendor/three.min.js`.
 *
 * Run after `npm install` or when bumping the pinned three version. Vendoring
 * keeps the runtime fully local (no CDN dependency), satisfying AVATAR_SPEC's
 * "100% local" requirement and removing a supply-chain/runtime fetch.
 */

import { copyFile, mkdir, access } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const CANDIDATES = [
  path.join(REPO_ROOT, 'node_modules', 'three', 'build', 'three.min.js'),
  path.join(REPO_ROOT, 'node_modules', 'three', 'build', 'three.js'),
];
const DEST = path.join(REPO_ROOT, 'vendor', 'three.min.js');

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

async function main() {
  await mkdir(path.dirname(DEST), { recursive: true });
  for (const src of CANDIDATES) {
    if (await exists(src)) {
      await copyFile(src, DEST);
      console.log('[vendor] copied', path.relative(REPO_ROOT, src), '->', path.relative(REPO_ROOT, DEST));
      return 0;
    }
  }
  console.error('[vendor] Could not find a three build under node_modules/three/build.');
  console.error('[vendor] Run "npm install" first (expects three@0.128.0).');
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[vendor] error:', err);
    process.exit(1);
  });
