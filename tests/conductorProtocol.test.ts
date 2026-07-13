import { describe, it, expect } from 'vitest';
import { parseConductor, isWithinDir } from '../src/integration/conductorProtocol';

describe('parseConductor', () => {
  it('returns text unchanged when there is no marker', () => {
    const r = parseConductor('Just a normal reply.');
    expect(r.stripped).toBe('Just a normal reply.');
    expect(r.directives).toEqual([]);
  });

  it('extracts and strips a spawn directive', () => {
    const r = parseConductor('Spinning that up. <<spawn:frontend|D:\\proj\\web|Build the login form>> Done.');
    expect(r.directives).toEqual([
      { kind: 'spawn', name: 'frontend', dir: 'D:\\proj\\web', task: 'Build the login form' },
    ]);
    expect(r.stripped).not.toContain('<<');
    expect(r.stripped).toContain('Spinning that up.');
    expect(r.stripped).toContain('Done.');
  });

  it('extracts a tell directive', () => {
    const r = parseConductor('<<tell:backend|Also add rate limiting>>');
    expect(r.directives).toEqual([{ kind: 'tell', name: 'backend', message: 'Also add rate limiting' }]);
    expect(r.stripped).toBe('');
  });

  it('extracts a propose directive', () => {
    const r = parseConductor('<<propose:Split into a frontend and a backend session>>');
    expect(r.directives).toEqual([
      { kind: 'propose', summary: 'Split into a frontend and a backend session' },
    ]);
  });

  it('handles several markers in one reply', () => {
    const r = parseConductor('<<spawn:api|/srv/api|serve>> and <<tell:api|use port 8080>>');
    expect(r.directives.map((d) => d.kind)).toEqual(['spawn', 'tell']);
  });

  it('strips an invalid directive but emits nothing', () => {
    // name has an illegal char, and the task is missing
    const r = parseConductor('<<spawn:bad/name|/dir>>');
    expect(r.directives).toEqual([]);
    expect(r.stripped).not.toContain('<<');
  });

  it('leaves a mood marker untouched (stripped later by speak)', () => {
    const r = parseConductor('<<mood:happy>> All good.');
    expect(r.directives).toEqual([]);
    expect(r.stripped).toContain('<<mood:happy>>');
  });

  it('is case-insensitive and tolerant of inner whitespace', () => {
    const r = parseConductor('<< SPAWN : Worker One | /tmp | do it >>');
    expect(r.directives).toEqual([
      { kind: 'spawn', name: 'Worker One', dir: '/tmp', task: 'do it' },
    ]);
  });
});

// The spawn gate's path check (see main.ts): a <<spawn>> inside the primary
// session's project dir keeps the user-chosen blast radius and may run
// unprompted; anything else (other roots, drive changes, .. traversal) must be
// confirmed. Windows semantics: case-insensitive, / and \ interchangeable.
describe('isWithinDir', () => {
  it('accepts the same dir and subdirectories, case/slash-insensitively', () => {
    expect(isWithinDir('D:\\proj', 'D:\\proj')).toBe(true);
    expect(isWithinDir('D:\\proj\\web', 'D:\\proj')).toBe(true);
    expect(isWithinDir('d:/PROJ/web/sub', 'D:\\proj\\')).toBe(true);
  });

  it('rejects siblings, prefixes that are not path boundaries, and other roots', () => {
    expect(isWithinDir('D:\\proj2', 'D:\\proj')).toBe(false); // prefix, not a subdir
    expect(isWithinDir('D:\\other', 'D:\\proj')).toBe(false);
    expect(isWithinDir('C:\\proj', 'D:\\proj')).toBe(false);
  });

  it('rejects .. traversal and empty inputs outright', () => {
    expect(isWithinDir('D:\\proj\\..\\secrets', 'D:\\proj')).toBe(false);
    expect(isWithinDir('D:\\proj\\web\\..', 'D:\\proj')).toBe(false);
    expect(isWithinDir('', 'D:\\proj')).toBe(false);
    expect(isWithinDir('D:\\proj', '')).toBe(false);
  });
});
