import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import {
  ASSET_FILES,
  MARKER_BEGIN,
  MARKER_END,
  assertSafeTargetPath,
  buildInjectionBlock,
  injectIntoHtml,
  isInjected,
  looksLikeVoiceHooksIndex,
  revertHtml,
} from '../scripts/injector-core.mjs';

const FIXTURE = readFileSync(
  join(process.cwd(), 'tests', 'fixtures', 'voice-hooks-index.html'),
  'utf8',
);

describe('buildInjectionBlock', () => {
  it('wraps script/style references between the markers in dependency order', () => {
    const block = buildInjectionBlock();
    expect(block.startsWith(MARKER_BEGIN)).toBe(true);
    expect(block.endsWith(MARKER_END)).toBe(true);
    for (const asset of ['three.min.js', 'GLTFLoader.js', 'avatar.css', 'avatar.js']) {
      expect(block).toContain(asset);
    }
    // THREE global, then the loader that augments it, then the bundle.
    expect(block.indexOf('three.min.js')).toBeLessThan(block.indexOf('GLTFLoader.js'));
    expect(block.indexOf('GLTFLoader.js')).toBeLessThan(block.indexOf('avatar.js'));
  });

  it('copies head.glb but never tags it (it is a runtime fetch)', () => {
    expect(ASSET_FILES).toContain('head.glb');
    expect(buildInjectionBlock()).not.toContain('head.glb');
  });
});

describe('injectIntoHtml', () => {
  it('inserts the block immediately before </body>', () => {
    const out = injectIntoHtml(FIXTURE);
    expect(isInjected(out)).toBe(true);
    const blockIndex = out.indexOf(MARKER_BEGIN);
    const bodyIndex = out.indexOf('</body>');
    expect(blockIndex).toBeGreaterThan(-1);
    expect(blockIndex).toBeLessThan(bodyIndex);
  });

  it('is idempotent: injecting twice yields byte-identical output', () => {
    const once = injectIntoHtml(FIXTURE);
    const twice = injectIntoHtml(once);
    expect(twice).toBe(once);
    // exactly one marker pair, never duplicated
    expect(twice.match(new RegExp(MARKER_BEGIN.replace(/[()]/g, '\\$&'), 'g'))).toHaveLength(1);
  });

  it('throws when there is no </body> to anchor to', () => {
    expect(() => injectIntoHtml('<html><head></head></html>')).toThrow(/<\/body>/);
  });
});

describe('revertHtml', () => {
  it('round-trips: inject then revert restores the original exactly', () => {
    const injected = injectIntoHtml(FIXTURE);
    expect(injected).not.toBe(FIXTURE);
    expect(revertHtml(injected)).toBe(FIXTURE);
  });

  it('is a no-op when no avatar block is present', () => {
    expect(revertHtml(FIXTURE)).toBe(FIXTURE);
  });
});

describe('looksLikeVoiceHooksIndex', () => {
  it('accepts the mcp-voice-hooks fixture', () => {
    expect(looksLikeVoiceHooksIndex(FIXTURE)).toBe(true);
  });

  it('rejects an unrelated page', () => {
    expect(looksLikeVoiceHooksIndex('<html><body><h1>hello</h1></body></html>')).toBe(false);
  });

  it('requires both the client script and a known DOM anchor', () => {
    expect(looksLikeVoiceHooksIndex('<script src="app.js"></script>')).toBe(false);
    expect(looksLikeVoiceHooksIndex('<button id="micBtn"></button>')).toBe(false);
  });
});

describe('assertSafeTargetPath', () => {
  it('returns the absolute path for an index.html target', () => {
    const resolved = assertSafeTargetPath('some/dir/index.html');
    expect(resolved.toLowerCase().endsWith('index.html')).toBe(true);
  });

  it('rejects a non-index target', () => {
    expect(() => assertSafeTargetPath('some/dir/app.js')).toThrow(/non-index/);
  });

  it('rejects empty input and null bytes', () => {
    expect(() => assertSafeTargetPath('')).toThrow();
    expect(() => assertSafeTargetPath('index.html\0.png')).toThrow(/null byte/);
  });
});

describe('filesystem round-trip', () => {
  let dir: string;
  let indexPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jarvis-inject-'));
    indexPath = join(dir, 'index.html');
    writeFileSync(indexPath, FIXTURE, 'utf8');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('injects, stays idempotent on a second pass, then reverts to the original on disk', () => {
    const original = readFileSync(indexPath, 'utf8');

    writeFileSync(indexPath, injectIntoHtml(readFileSync(indexPath, 'utf8')), 'utf8');
    const afterFirst = readFileSync(indexPath, 'utf8');
    expect(isInjected(afterFirst)).toBe(true);

    writeFileSync(indexPath, injectIntoHtml(readFileSync(indexPath, 'utf8')), 'utf8');
    const afterSecond = readFileSync(indexPath, 'utf8');
    expect(afterSecond).toBe(afterFirst);

    writeFileSync(indexPath, revertHtml(readFileSync(indexPath, 'utf8')), 'utf8');
    expect(readFileSync(indexPath, 'utf8')).toBe(original);
  });
});
