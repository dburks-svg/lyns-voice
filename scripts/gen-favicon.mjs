#!/usr/bin/env node
/**
 * Generate `assets/favicon.ico`: a small neon-blue glowing orb that matches the
 * avatar theme, so the browser's automatic `/favicon.ico` request stops 404ing.
 *
 * First-party asset (no third-party license). Committed binary; this script only
 * documents how it was produced and lets us regenerate it deterministically.
 *
 * Output is a multi-size 32-bit BGRA ICO (16x16 and 32x32) with a soft alpha
 * edge and a correct AND mask, valid for every browser and Windows shell.
 *
 * Usage: node scripts/gen-favicon.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT_DIR = path.join(REPO_ROOT, 'assets');

// Neon blue-cyan, matching the avatar's glow.
const COLOR = { r: 80, g: 200, b: 255 };

/**
 * Build one ICO image record (BITMAPINFOHEADER + bottom-up BGRA XOR + AND mask).
 * @param {number} n edge length in pixels
 * @returns {Buffer}
 */
function makeImage(n) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(n, 4); // biWidth
  header.writeInt32LE(n * 2, 8); // biHeight (XOR + AND)
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  // remaining fields (compression, sizes, palette) stay zero

  const xor = Buffer.alloc(n * n * 4);
  const andRowBytes = ((n + 31) >> 5) << 2; // 1bpp rows padded to 32-bit
  const and = Buffer.alloc(andRowBytes * n);

  const c = (n - 1) / 2;
  const rCore = n * 0.36;
  const rEdge = n * 0.48;

  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      const dx = x - c;
      const dy = y - c;
      const dist = Math.sqrt(dx * dx + dy * dy);
      let a;
      if (dist <= rCore) a = 255;
      else if (dist >= rEdge) a = 0;
      else a = Math.round(255 * (1 - (dist - rCore) / (rEdge - rCore)));

      const row = n - 1 - y; // ICO pixel rows are bottom-up
      const off = (row * n + x) * 4;
      xor[off + 0] = COLOR.b;
      xor[off + 1] = COLOR.g;
      xor[off + 2] = COLOR.r;
      xor[off + 3] = a;
      if (a === 0) {
        // AND mask bit set => pixel is transparent (belt-and-suspenders with alpha)
        and[row * andRowBytes + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }
  return Buffer.concat([header, xor, and]);
}

const sizes = [16, 32];
const images = sizes.map(makeImage);
const count = sizes.length;

const dir = Buffer.alloc(6 + 16 * count);
dir.writeUInt16LE(0, 0); // reserved
dir.writeUInt16LE(1, 2); // type: icon
dir.writeUInt16LE(count, 4);

let offset = 6 + 16 * count;
for (let i = 0; i < count; i += 1) {
  const n = sizes[i];
  const img = images[i];
  const e = 6 + 16 * i;
  dir.writeUInt8(n, e + 0); // width (0 would mean 256)
  dir.writeUInt8(n, e + 1); // height
  dir.writeUInt8(0, e + 2); // palette size
  dir.writeUInt8(0, e + 3); // reserved
  dir.writeUInt16LE(1, e + 4); // planes
  dir.writeUInt16LE(32, e + 6); // bit count
  dir.writeUInt32LE(img.length, e + 8); // bytes in resource
  dir.writeUInt32LE(offset, e + 12); // offset from file start
  offset += img.length;
}

const ico = Buffer.concat([dir, ...images]);
mkdirSync(OUT_DIR, { recursive: true });
const outPath = path.join(OUT_DIR, 'favicon.ico');
writeFileSync(outPath, ico);
console.log(`[favicon] wrote ${outPath} (${ico.length} bytes, sizes: ${sizes.join(', ')})`);
