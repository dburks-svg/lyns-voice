import { describe, it, expect, vi, afterEach } from 'vitest';
import { MediaTts, type AudioContextLike } from '../src/audio/MediaTts';

interface FakeSource {
  buffer: AudioBuffer | null;
  onended: (() => void) | null;
  connect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

function makeCtx(opts: { state?: string; sample?: number } = {}) {
  const sample = opts.sample ?? 128; // 128 = silence
  const source: FakeSource = {
    buffer: null,
    onended: null,
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
  const analyser = {
    fftSize: 256,
    getByteTimeDomainData: vi.fn((arr: Uint8Array) => arr.fill(sample)),
    connect: vi.fn(),
  };
  const ctx = {
    state: opts.state ?? 'running',
    destination: {},
    resume: vi.fn().mockResolvedValue(undefined),
    decodeAudioData: vi.fn().mockResolvedValue({} as AudioBuffer),
    createBufferSource: vi.fn(() => source),
    createAnalyser: vi.fn(() => analyser),
  } as unknown as AudioContextLike & { resume: ReturnType<typeof vi.fn> };
  return { ctx, source, analyser };
}

function okFetch(bytes = 16) {
  return vi.fn().mockResolvedValue({
    ok: true,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(bytes)),
  });
}

describe('MediaTts', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches, decodes, plays, and reports start then end', async () => {
    const { ctx, source } = makeCtx();
    const fetchImpl = okFetch();
    const onSpeakingStart = vi.fn();
    const onSpeakingEnd = vi.fn();
    const mt = new MediaTts({
      fetchImpl,
      audioContextFactory: () => ctx,
      onSpeakingStart,
      onSpeakingEnd,
    });

    const handled = await mt.speak('hello world');
    expect(handled).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/tts-wav',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ text: 'hello world' }) }),
    );
    expect(source.start).toHaveBeenCalledTimes(1);
    expect(onSpeakingStart).toHaveBeenCalledTimes(1);
    expect(mt.isSpeaking).toBe(true);

    source.onended?.();
    expect(onSpeakingEnd).toHaveBeenCalledTimes(1);
    expect(mt.isSpeaking).toBe(false);
  });

  it('treats empty text as handled without fetching', async () => {
    const fetchImpl = okFetch();
    const mt = new MediaTts({ fetchImpl, audioContextFactory: () => makeCtx().ctx });
    expect(await mt.speak('   ')).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('declines (false) on a non-ok response so the caller can fall back', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });
    const { ctx, source } = makeCtx();
    const onSpeakingStart = vi.fn();
    const mt = new MediaTts({ fetchImpl, audioContextFactory: () => ctx, onSpeakingStart });
    expect(await mt.speak('hi')).toBe(false);
    expect(source.start).not.toHaveBeenCalled();
    expect(onSpeakingStart).not.toHaveBeenCalled();
  });

  it('declines (false) when the fetch throws', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network'));
    const mt = new MediaTts({ fetchImpl, audioContextFactory: () => makeCtx().ctx });
    expect(await mt.speak('hi')).toBe(false);
  });

  it('unlock resumes a suspended context', () => {
    const { ctx } = makeCtx({ state: 'suspended' });
    const resume = (ctx as unknown as { resume: ReturnType<typeof vi.fn> }).resume;
    const mt = new MediaTts({ fetchImpl: okFetch(), audioContextFactory: () => ctx });
    mt.unlock();
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('stop cuts off playback and emits a clean end', async () => {
    const { ctx, source } = makeCtx();
    const onSpeakingEnd = vi.fn();
    const mt = new MediaTts({ fetchImpl: okFetch(), audioContextFactory: () => ctx, onSpeakingEnd });
    await mt.speak('hi');
    mt.stop();
    expect(source.stop).toHaveBeenCalledTimes(1);
    expect(onSpeakingEnd).toHaveBeenCalledTimes(1);
    expect(mt.isSpeaking).toBe(false);
  });

  it('drives boundary pulses from real amplitude while loud', async () => {
    vi.useFakeTimers();
    const { ctx } = makeCtx({ sample: 220 }); // loud
    const onBoundary = vi.fn();
    const mt = new MediaTts({
      fetchImpl: okFetch(),
      audioContextFactory: () => ctx,
      onBoundary,
      pollIntervalMs: 10,
      boundaryMinIntervalMs: 0,
      boundaryThreshold: 0.05,
    });
    await mt.speak('loud');
    vi.advanceTimersByTime(35); // ~3 polls
    expect(onBoundary.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('stays quiet (no boundary) while the signal is silent', async () => {
    vi.useFakeTimers();
    const { ctx } = makeCtx({ sample: 128 }); // silence
    const onBoundary = vi.fn();
    const mt = new MediaTts({
      fetchImpl: okFetch(),
      audioContextFactory: () => ctx,
      onBoundary,
      pollIntervalMs: 10,
      boundaryThreshold: 0.05,
    });
    await mt.speak('quiet');
    vi.advanceTimersByTime(50);
    expect(onBoundary).not.toHaveBeenCalled();
  });

  // --- pipelining seam: synthesize (fetch+decode) split from playBuffer ---

  it('synthesize fetches + decodes a buffer WITHOUT starting playback', async () => {
    const { ctx, source } = makeCtx();
    const mt = new MediaTts({ fetchImpl: okFetch(), audioContextFactory: () => ctx });
    const buf = await mt.synthesize('hello');
    expect(buf).not.toBeNull();
    expect(source.start).not.toHaveBeenCalled();
    expect(mt.isSpeaking).toBe(false);
  });

  it('synthesize returns null on empty text (no fetch) and on a failed fetch', async () => {
    const empty = okFetch();
    const mtEmpty = new MediaTts({ fetchImpl: empty, audioContextFactory: () => makeCtx().ctx });
    expect(await mtEmpty.synthesize('   ')).toBeNull();
    expect(empty).not.toHaveBeenCalled();

    const bad = vi.fn().mockResolvedValue({ ok: false, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });
    const mtBad = new MediaTts({ fetchImpl: bad, audioContextFactory: () => makeCtx().ctx });
    expect(await mtBad.synthesize('hi')).toBeNull();
  });

  it('playBuffer plays a prefetched buffer and reports speaking start then end', async () => {
    const { ctx, source } = makeCtx();
    const onSpeakingStart = vi.fn();
    const onSpeakingEnd = vi.fn();
    const mt = new MediaTts({
      fetchImpl: okFetch(),
      audioContextFactory: () => ctx,
      onSpeakingStart,
      onSpeakingEnd,
    });
    const buf = await mt.synthesize('hello');
    expect(buf).not.toBeNull();
    if (!buf) return;
    expect(await mt.playBuffer(buf)).toBe(true);
    expect(source.start).toHaveBeenCalledTimes(1);
    expect(onSpeakingStart).toHaveBeenCalledTimes(1);
    expect(mt.isSpeaking).toBe(true);
    source.onended?.();
    expect(onSpeakingEnd).toHaveBeenCalledTimes(1);
    expect(mt.isSpeaking).toBe(false);
  });
});
