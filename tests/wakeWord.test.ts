import { describe, it, expect } from 'vitest';
import { matchWake } from '../src/integration/wakeWord';

describe('matchWake', () => {
  it('wakes on the vocative: "Oracle, <command>"', () => {
    expect(matchWake('Oracle, run the tests.')).toEqual({
      woke: true,
      command: 'run the tests.',
    });
    expect(matchWake('oracle: open the diff')).toEqual({
      woke: true,
      command: 'open the diff',
    });
  });

  it('treats a bare "Oracle" as wake-and-arm (empty command)', () => {
    expect(matchWake('Oracle.')).toEqual({ woke: true, command: '' });
    expect(matchWake('Oracle')).toEqual({ woke: true, command: '' });
  });

  it('wakes on the greeting form: "hey oracle <command>"', () => {
    const r = matchWake("Hey Oracle, what's the version?");
    expect(r.woke).toBe(true);
    expect(r.command).toBe("what's the version?"); // apostrophe + punctuation preserved
    expect(matchWake('hi oracle').woke).toBe(true);
    expect(matchWake('heya oracle run the tests').command).toBe('run the tests');
  });

  it('stays asleep for ambient mentions without vocative position + punctuation', () => {
    expect(matchWake('oracle databases are complicated').woke).toBe(false);
    expect(matchWake('the oracle answered wrong').woke).toBe(false);
    expect(matchWake('oracles are everywhere').woke).toBe(false); // word boundary
    expect(matchWake('ask the oracle, then decide').woke).toBe(false); // not leading
  });

  it('ignores speech without any wake phrase', () => {
    expect(matchWake('The build finished ten minutes ago').woke).toBe(false);
    expect(matchWake('Hey mate, are you there').woke).toBe(false);
    expect(matchWake('hey, um, never mind').woke).toBe(false);
    expect(matchWake('').woke).toBe(false);
  });
});
