#!/usr/bin/env node
/**
 * Vendors the Three.js runtime assets from the installed `three` package into
 * `vendor/`:
 *   - `three.min.js`   the UMD build that installs the global `THREE`
 *   - `GLTFLoader.js`  the classic example loader that augments `THREE` with
 *                      `THREE.GLTFLoader` (used to load the head GLB)
 *
 * Run after `npm install` or when bumping the pinned three version. Vendoring
 * keeps the runtime fully local (no CDN dependency), satisfying AVATAR_SPEC's
 * "100% local" requirement and removing a supply-chain/runtime fetch.
 *
 * Note: the head model itself (`vendor/head.glb`) is a committed static asset,
 * not derived from node_modules; see vendor/NOTICE.md.
 */

import { copyFile, mkdir, access } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const VENDOR = path.join(REPO_ROOT, 'vendor');
const TM = path.join(REPO_ROOT, 'node_modules', 'three');

/** Each asset: candidate source paths (first that exists wins) and a destination. */
const ASSETS = [
  {
    label: 'three.min.js',
    candidates: [path.join(TM, 'build', 'three.min.js'), path.join(TM, 'build', 'three.js')],
    dest: path.join(VENDOR, 'three.min.js'),
  },
  {
    label: 'GLTFLoader.js',
    candidates: [path.join(TM, 'examples', 'js', 'loaders', 'GLTFLoader.js')],
    dest: path.join(VENDOR, 'GLTFLoader.js'),
  },
];

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
  await mkdir(VENDOR, { recursive: true });
  for (const asset of ASSETS) {
    let copied = false;
    for (const src of asset.candidates) {
      if (await exists(src)) {
        await copyFile(src, asset.dest);
        console.log('[vendor] copied', path.relative(REPO_ROOT, src), '->', path.relative(REPO_ROOT, asset.dest));
        copied = true;
        break;
      }
    }
    if (!copied) {
      console.error('[vendor] Could not find a source for', asset.label, 'under node_modules/three.');
      console.error('[vendor] Run "npm install" first (expects three@0.128.0).');
      return 1;
    }
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[vendor] error:', err);
    process.exit(1);
  });
