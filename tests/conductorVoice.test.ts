import { describe, it, expect, vi } from 'vitest';
import {
  createConductorVoice,
  joinNames,
  criticalLine,
  digestLine,
} from '../src/integration/conductorVoice';

function harness(free = true) {
  const spoken: string[] = [];
  let voiceFree = free;
  const cv = createConductorVoice({
    speak: (t) => spoken.push(t),
    voiceFree: () => voiceFree,
    timer: globalThis as unknown as Window,
    digestMs: 1000,
  });
  return { cv, spoken, setFree: (f: boolean) => (voiceFree = f) };
}

describe('joinNames / line builders', () => {
  it('reads naturally for 1, 2, and 3 names', () => {
    expect(joinNames(['A'])).toBe('A');
    expect(joinNames(['A', 'B'])).toBe('A and B');
    expect(joinNames(['A', 'B', 'C'])).toBe('A, B, and C');
  });
  it('mood-tags and pluralizes the lines', () => {
    expect(criticalLine(['Session C'])).toContain('<<mood:concerned>>');
    expect(criticalLine(['A', 'B'])).toContain('hit errors');
    expect(digestLine(['A'])).toContain('is done');
    expect(digestLine(['A', 'B'])).toContain('are done');
  });
});

describe('createConductorVoice', () => {
  it('announces a worker error immediately when the voice is free', () => {
    const { cv, spoken } = harness(true);
    cv.announce('Session C', true);
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toContain('Session C');
    expect(spoken[0]).toContain('hit an error');
  });

  it('holds an error while the voice is busy, then speaks it on flush', () => {
    const { cv, spoken, setFree } = harness(false);
    cv.announce('Session C', true);
    expect(spoken).toHaveLength(0); // voice busy
    setFree(true);
    cv.flush();
    expect(spoken).toHaveLength(1);
  });

  it('batches successes into one digest after the debounce', () => {
    vi.useFakeTimers();
    try {
      const { cv, spoken } = harness(true);
      cv.announce('Session A', false);
      cv.announce('Session B', false);
      expect(spoken).toHaveLength(0); // still debouncing
      vi.advanceTimersByTime(1000);
      expect(spoken).toHaveLength(1);
      expect(spoken[0]).toContain('Session A and Session B');
      expect(spoken[0]).toContain('are done');
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes a critical before a pending digest', () => {
    const { cv, spoken, setFree } = harness(false);
    cv.announce('Session A', false); // digest (voice busy)
    cv.announce('Session C', true); // critical (voice busy)
    setFree(true);
    cv.flush();
    expect(spoken[0]).toContain('Session C'); // critical first
    cv.flush();
    expect(spoken[1]).toContain('Session A'); // digest after
  });
});
