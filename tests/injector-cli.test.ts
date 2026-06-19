// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { parseArgs } from '../scripts/inject.mjs';

const FIXTURE = readFileSync(
  join(process.cwd(), 'tests', 'fixtures', 'voice-hooks-index.html'),
  'utf8',
);
const INJECT = join(process.cwd(), 'scripts', 'inject.mjs');

function tryRun(args: string[]): { ok: boolean } {
  try {
    execFileSync(process.execPath, [INJECT, ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

describe('parseArgs', () => {
  it('parses boolean flags and both --path spellings', () => {
    expect(parseArgs(['--revert'])).toMatchObject({ revert: true });
    expect(parseArgs(['--force', '--dry-run'])).toMatchObject({ force: true, dryRun: true });
    expect(parseArgs(['--path', 'a/index.html'])).toMatchObject({ path: 'a/index.html' });
    expect(parseArgs(['--path=b/index.html'])).toMatchObject({ path: 'b/index.html' });
    expect(parseArgs(['-h'])).toMatchObject({ help: true });
  });
});

describe('inject.mjs CLI', () => {
  let dir: string;
  let index: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jarvis-cli-'));
    index = join(dir, 'index.html');
    writeFileSync(index, FIXTURE, 'utf8');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('backs up a pre-existing host asset, injects idempotently, and reverts fully', () => {
    const original = readFileSync(index, 'utf8');
    const hostThree = join(dir, 'three.min.js');
    writeFileSync(hostThree, 'HOST THREE', 'utf8'); // shares a name with an injected asset

    expect(tryRun(['--path', index]).ok).toBe(true);
    expect(readFileSync(index, 'utf8')).toContain('AVATAR:BEGIN');
    // Host asset preserved before being overwritten with the vendored copy.
    expect(existsSync(`${hostThree}.avatar-backup`)).toBe(true);
    expect(readFileSync(`${hostThree}.avatar-backup`, 'utf8')).toBe('HOST THREE');
    expect(readFileSync(hostThree, 'utf8')).not.toBe('HOST THREE');

    expect(tryRun(['--path', index]).ok).toBe(true); // idempotent
    expect(readFileSync(index, 'utf8').match(/AVATAR:BEGIN/g)).toHaveLength(1);

    expect(tryRun(['--revert', '--path', index]).ok).toBe(true);
    expect(readFileSync(index, 'utf8')).toBe(original);
    expect(readFileSync(hostThree, 'utf8')).toBe('HOST THREE'); // restored
    expect(existsSync(`${hostThree}.avatar-backup`)).toBe(false);
  });

  it('removes avatar-owned assets it added on revert', () => {
    const three = join(dir, 'three.min.js');
    expect(existsSync(three)).toBe(false);
    expect(tryRun(['--path', index]).ok).toBe(true);
    expect(existsSync(three)).toBe(true); // we added it
    expect(tryRun(['--revert', '--path', index]).ok).toBe(true);
    expect(existsSync(three)).toBe(false); // and removed it
  });

  it('refuses a non-voice-hooks page without --force', () => {
    writeFileSync(index, '<html><body><h1>not voice hooks</h1></body></html>', 'utf8');
    expect(tryRun(['--path', index]).ok).toBe(false);
    expect(readFileSync(index, 'utf8')).not.toContain('AVATAR:BEGIN');
  });

  it('rejects a symlinked target (skipped where symlinks need privileges)', () => {
    const real = join(dir, 'real-index.html');
    writeFileSync(real, FIXTURE, 'utf8');
    rmSync(index, { force: true });
    try {
      symlinkSync(real, index);
    } catch {
      return; // environment cannot create symlinks (e.g. unprivileged Windows)
    }
    expect(tryRun(['--path', index]).ok).toBe(false);
    // The real target behind the symlink was not modified.
    expect(readFileSync(real, 'utf8')).not.toContain('AVATAR:BEGIN');
  });
});
