import { describe, it, expect } from 'vitest';
import { matchHeyQ } from '../src/integration/wakeWord';

describe('matchHeyQ', () => {
  it('matches "hey Q <command>" and returns the command verbatim', () => {
    const r = matchHeyQ("Hey Q, what's the version?");
    expect(r.woke).toBe(true);
    expect(r.command).toBe("what's the version?"); // apostrophe + punctuation preserved
  });

  it('matches common Whisper renderings of "Q"', () => {
    expect(matchHeyQ('hey cue open the file').command).toBe('open the file');
    expect(matchHeyQ('Hey queue, run the tests').command).toBe('run the tests');
    expect(matchHeyQ('hay kew status').woke).toBe(true);
  });

  it('treats a bare "hey Q" as wake-and-arm (empty command)', () => {
    expect(matchHeyQ('Hey Q.')).toEqual({ woke: true, command: '' });
    expect(matchHeyQ('hey, cue!')).toEqual({ woke: true, command: '' });
  });

  it('does not wake without the phrase', () => {
    expect(matchHeyQ("what's the version").woke).toBe(false);
    expect(matchHeyQ('hey you, do this').woke).toBe(false); // "you" is not a Q homophone
    expect(matchHeyQ('').woke).toBe(false);
  });

  it('does not false-trigger on words that merely start with the letters', () => {
    expect(matchHeyQ('Hey Quincy, are you there').woke).toBe(false);
    expect(matchHeyQ('heyday is here').woke).toBe(false);
  });

  it('is case-insensitive and tolerates leading whitespace', () => {
    expect(matchHeyQ('   HEY Q DEPLOY now').command).toBe('DEPLOY now');
  });
});
