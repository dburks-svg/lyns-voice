import { describe, it, expect, vi } from 'vitest';
import { MicAnalyser, computeLevel } from '../src/audio/MicAnalyser';

function makeMocks(level = 128) {
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const getUserMedia = vi.fn(async () => stream);
  const close = vi.fn();
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const analyser = {
    fftSize: 0,
    frequencyBinCount: 4,
    getByteFrequencyData: (buf: Uint8Array) => buf.fill(level),
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const context = {
    state: 'running' as AudioContextState,
    createMediaStreamSource: () => source,
    createAnalyser: () => analyser,
    close,
  };
  const audioContextFactory = (): AudioContext => context as unknown as AudioContext;
  return { getUserMedia, audioContextFactory, track, close };
}

describe('computeLevel', () => {
  it('is 0 for an empty buffer', () => {
    expect(computeLevel(new Uint8Array(0))).toBe(0);
  });
  it('is 1 for a full buffer', () => {
    expect(computeLevel(new Uint8Array([255, 255, 255, 255]))).toBeCloseTo(1);
  });
  it('is the normalised mean', () => {
    expect(computeLevel(new Uint8Array([0, 255, 0, 255]))).toBeCloseTo(0.5, 2);
  });
});

describe('MicAnalyser', () => {
  it('starts, samples a normalised level, and stops releasing the mic', async () => {
    const mocks = makeMocks(128);
    const levels: number[] = [];
    const mic = new MicAnalyser({
      onLevel: (level) => levels.push(level),
      getUserMedia: mocks.getUserMedia,
      audioContextFactory: mocks.audioContextFactory,
    });

    const ok = await mic.start();
    expect(ok).toBe(true);
    expect(mic.isActive).toBe(true);
    expect(mic.sample()).toBeCloseTo(128 / 255, 3);
    expect(levels.length).toBeGreaterThan(0);

    mic.stop();
    expect(mic.isActive).toBe(false);
    expect(mocks.track.stop).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(levels[levels.length - 1]).toBe(0);
  });

  it('returns false and emits 0 when permission is denied', async () => {
    const denied = vi.fn(async () => {
      throw new Error('NotAllowedError');
    });
    const levels: number[] = [];
    const mic = new MicAnalyser({ onLevel: (level) => levels.push(level), getUserMedia: denied });

    const ok = await mic.start();
    expect(ok).toBe(false);
    expect(mic.isActive).toBe(false);
    expect(levels).toContain(0);
  });
});
