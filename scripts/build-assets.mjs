#!/usr/bin/env node
/**
 * Emits the non-JS injectable assets into dist/ after the library build.
 *
 * Currently copies the shared stylesheet (demo/avatar.css) to dist/avatar.css so
 * the injector can ship it alongside dist/avatar.js. Without this, the injected
 * mcp-voice-hooks page would link a missing avatar.css and the host overlay
 * (#jarvis-avatar-overlay) would be unstyled.
 */

import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SOURCE = path.join(REPO_ROOT, 'demo', 'avatar.css');
const DEST_DIR = path.join(REPO_ROOT, 'dist');
const DEST = path.join(DEST_DIR, 'avatar.css');

async function main() {
  await mkdir(DEST_DIR, { recursive: true });
  await copyFile(SOURCE, DEST);
  console.log('[assets] copied', path.relative(REPO_ROOT, SOURCE), '->', path.relative(REPO_ROOT, DEST));
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[assets] error:', err);
    process.exit(1);
  });
