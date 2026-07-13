import { describe, it, expect, vi } from 'vitest';
import { SttCapture } from '../src/audio/SttCapture';

describe('SttCapture', () => {
  it('dedupes concurrent start() calls into one getUserMedia', () => {
    // getUserMedia stays pending so both start() calls overlap in the in-flight window.
    const getUserMedia = vi.fn(() => new Promise<MediaStream>(() => {}));
    const cap = new SttCapture({ onFrame: () => {}, getUserMedia });

    const p1 = cap.start();
    const p2 = cap.start();

    // A second start before the first resolves must NOT open a second mic stream,
    // and both callers share the one in-flight attempt.
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(p2).toBe(p1);
    expect(cap.isActive).toBe(false); // still resolving (getUserMedia pending)
  });

  it('reports a permission denial as a failed start', async () => {
    const getUserMedia = vi.fn(() => Promise.reject(new Error('denied')));
    const cap = new SttCapture({ onFrame: () => {}, getUserMedia });

    await expect(cap.start()).resolves.toBe(false);
    expect(cap.isActive).toBe(false);
    // After a failed attempt the in-flight guard is cleared, so a retry starts fresh.
    await cap.start();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });
});
