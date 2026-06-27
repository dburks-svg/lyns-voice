import { describe, it, expect, vi } from 'vitest';
import {
  toArrayBuffer,
  tauriTtsFetch,
  splitForSpeech,
  createWatchdog,
  attachTauri,
  type InvokeFn,
  type ListenFn,
  type AvatarLike,
} from '../src/integration/tauriAdapter';

describe('toArrayBuffer', () => {
  it('returns an ArrayBuffer unchanged', () => {
    const buf = new Uint8Array([1, 2, 3]).buffer;
    expect(toArrayBuffer(buf)).toBe(buf);
  });

  it('copies a typed-array view into a fresh ArrayBuffer', () => {
    const src = new Uint8Array([9, 8, 7, 6]);
    const out = toArrayBuffer(src.subarray(1, 3)); // offset view -> [8, 7]
    expect(out).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(new Uint8Array(out))).toEqual([8, 7]);
  });

  it('converts a plain number array', () => {
    const out = toArrayBuffer([10, 20, 30]);
    expect(Array.from(new Uint8Array(out))).toEqual([10, 20, 30]);
  });

  it('returns an empty buffer for unrecognized input', () => {
    expect(toArrayBuffer(null).byteLength).toBe(0);
    expect(toArrayBuffer(undefined).byteLength).toBe(0);
    expect(toArrayBuffer('nope').byteLength).toBe(0);
  });
});

describe('tauriTtsFetch', () => {
  it('invokes tts_synthesize with the body text and returns the WAV bytes', async () => {
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    const invoke = (async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      return new Uint8Array([1, 2, 3]).buffer;
    }) as InvokeFn;

    const fetchImpl = tauriTtsFetch(invoke);
    const res = await fetchImpl('/api/tts-wav', {
      method: 'POST',
      body: JSON.stringify({ text: 'hello' }),
    });

    expect(calls).toEqual([{ cmd: 'tts_synthesize', args: { text: 'hello' } }]);
    expect(res.ok).toBe(true);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });

  it('reports not-ok when invoke rejects (caller falls back)', async () => {
    const invoke = (async () => {
      throw new Error('backend down');
    }) as InvokeFn;

    const res = await tauriTtsFetch(invoke)('/api/tts-wav', {
      method: 'POST',
      body: JSON.stringify({ text: 'hi' }),
    });

    expect(res.ok).toBe(false);
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  it('passes empty text when the body is missing or malformed', async () => {
    const seen: string[] = [];
    const invoke = (async (_cmd: string, args?: Record<string, unknown>) => {
      seen.push((args?.text as string) ?? '<undefined>');
      return new ArrayBuffer(0);
    }) as InvokeFn;
    const fetchImpl = tauriTtsFetch(invoke);

    await fetchImpl('/api/tts-wav', { method: 'POST' });
    await fetchImpl('/api/tts-wav', { method: 'POST', body: '{not json' });

    expect(seen).toEqual(['', '']);
  });

  it('forwards rate/pitch/voice/engine from the settings getter', async () => {
    const calls: Array<Record<string, unknown> | undefined> = [];
    const invoke = (async (_cmd: string, args?: Record<string, unknown>) => {
      calls.push(args);
      return new ArrayBuffer(0);
    }) as InvokeFn;
    const fetchImpl = tauriTtsFetch(invoke, () => ({ rate: 3, pitch: -2, voice: 'af_heart', engine: 'kokoro' }));
    await fetchImpl('/api/tts-wav', { method: 'POST', body: JSON.stringify({ text: 'hi' }) });
    expect(calls[0]).toEqual({ text: 'hi', rate: 3, pitch: -2, voice: 'af_heart', engine: 'kokoro' });
  });
});

describe('splitForSpeech', () => {
  it('returns nothing for empty/whitespace input', () => {
    expect(splitForSpeech('')).toEqual([]);
    expect(splitForSpeech('   \n ')).toEqual([]);
  });

  it('keeps a short reply as a single chunk', () => {
    expect(splitForSpeech('All systems nominal.')).toEqual(['All systems nominal.']);
  });

  it('splits on sentence boundaries', () => {
    expect(splitForSpeech('Done. It compiled! Ship it?')).toEqual([
      'Done.',
      'It compiled!',
      'Ship it?',
    ]);
  });

  it('hard-wraps an over-long sentence under the cap, losing no words', () => {
    const long = Array.from({ length: 50 }, (_, i) => `word${i}`).join(' '); // one "sentence"
    const chunks = splitForSpeech(long, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(40);
    }
    expect(chunks.join(' ').split(/\s+/)).toEqual(long.split(' '));
  });
});

describe('createWatchdog', () => {
  it('fires onTimeout after the delay when armed', () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const wd = createWatchdog(globalThis as unknown as Window, 1000, onTimeout);
      wd.arm();
      vi.advanceTimersByTime(999);
      expect(onTimeout).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onTimeout).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fire after clear()', () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const wd = createWatchdog(globalThis as unknown as Window, 1000, onTimeout);
      wd.arm();
      wd.clear();
      vi.advanceTimersByTime(5000);
      expect(onTimeout).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('arming while already armed does not restart the countdown', () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const wd = createWatchdog(globalThis as unknown as Window, 1000, onTimeout);
      wd.arm();
      vi.advanceTimersByTime(600);
      wd.arm(); // no-op: must NOT push the deadline out
      vi.advanceTimersByTime(400);
      expect(onTimeout).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-arms after firing', () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const wd = createWatchdog(globalThis as unknown as Window, 1000, onTimeout);
      wd.arm();
      vi.advanceTimersByTime(1000);
      wd.arm();
      vi.advanceTimersByTime(1000);
      expect(onTimeout).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fires the progress tick repeatedly while armed, then stops on clear', () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const onTick = vi.fn();
      const wd = createWatchdog(globalThis as unknown as Window, 1000, onTimeout, {
        everyMs: 300,
        onTick,
      });
      wd.arm();
      vi.advanceTimersByTime(900); // ticks at 300/600/900
      expect(onTick).toHaveBeenCalledTimes(3);
      expect(onTimeout).not.toHaveBeenCalled();
      wd.clear();
      vi.advanceTimersByTime(1000);
      expect(onTick).toHaveBeenCalledTimes(3); // no further ticks after clear
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops ticking once the final timeout fires', () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const onTick = vi.fn();
      const wd = createWatchdog(globalThis as unknown as Window, 1000, onTimeout, {
        everyMs: 300,
        onTick,
      });
      wd.arm();
      vi.advanceTimersByTime(1000); // timeout at 1000; ticks at 300/600/900
      expect(onTimeout).toHaveBeenCalledTimes(1);
      const atTimeout = onTick.mock.calls.length;
      vi.advanceTimersByTime(2000);
      expect(onTick.mock.calls.length).toBe(atTimeout); // pending tick was cancelled
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves a function deadline at arm() time (the ultracode longer-budget path)', () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      let ms = 1000;
      const wd = createWatchdog(globalThis as unknown as Window, () => ms, onTimeout);
      wd.arm();
      vi.advanceTimersByTime(1000);
      expect(onTimeout).toHaveBeenCalledTimes(1); // first arm resolved to 1000

      ms = 5000; // the source (e.g. switching to ultracode) changed before the next turn
      wd.arm();
      vi.advanceTimersByTime(1000);
      expect(onTimeout).toHaveBeenCalledTimes(1); // still pending under the re-resolved 5000 budget
      vi.advanceTimersByTime(4000);
      expect(onTimeout).toHaveBeenCalledTimes(2); // fired at 5000
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('attachTauri (Claude session binding)', () => {
  function setup(extra?: Partial<Parameters<typeof attachTauri>[0]>) {
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    const invoke = (async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (cmd === 'claude_start') return 'claude-1';
      if (cmd === 'tts_synthesize') throw new Error('no audio in test'); // keep AudioContext out
      return undefined;
    }) as InvokeFn;

    const handlers: Record<string, (p: unknown) => void> = {};
    const listen = (async (event: string, handler: (p: unknown) => void) => {
      handlers[event] = handler; // registered synchronously
      return () => {
        delete handlers[event];
      };
    }) as unknown as ListenFn;

    const avatarFactory = (): AvatarLike => ({
      setParams() {},
      setGlow() {},
      setColors() {},
      idleRotationSpeed: 0,
      mesh: { rotation: { x: 0, y: 0, z: 0 }, scale: { set() {} } },
      reducedMotion: false,
      beforeRender: null,
      mount() {},
      start() {},
      resize() {},
      dispose() {},
    });

    const root = document.createElement('div');
    document.body.appendChild(root);
    const handle = attachTauri({ root, view: window, invoke, listen, avatarFactory, ...extra });
    return { handle, calls, handlers };
  }

  const state = (): string | undefined => document.body.dataset.state;

  it('subscribes per session and routes a thinking event to the Thinking state', async () => {
    const { handle, handlers } = setup();
    await handle.startClaude('C:/proj');
    expect(handlers['claude://claude-1/thinking']).toBeTypeOf('function');
    handlers['claude://claude-1/thinking']({ active: true });
    expect(state()).toBe('thinking');
    handlers['claude://claude-1/thinking']({ active: false });
    expect(state()).toBe('idle');
    handle.dispose();
  });

  it('submits an utterance to claude_submit with the session id', async () => {
    const { handle, handlers, calls } = setup();
    await handle.startClaude('C:/proj');
    handlers['stt://final']({ text: 'refactor the parser' });
    expect(calls).toContainEqual({
      cmd: 'claude_submit',
      args: { id: 'claude-1', text: 'refactor the parser' },
    });
    handle.dispose();
  });

  it('cancelClaude cancels the in-flight turn by id and returns to idle', async () => {
    const { handle, handlers, calls } = setup();
    await handle.startClaude('C:/proj');
    handlers['claude://claude-1/thinking']({ active: true });
    expect(state()).toBe('thinking');
    handle.cancelClaude();
    expect(calls).toContainEqual({ cmd: 'claude_cancel', args: { id: 'claude-1' } });
    expect(state()).toBe('idle');
    handle.dispose();
  });

  it('stopClaude stops the session by id and disconnects', async () => {
    const { handle, calls } = setup();
    await handle.startClaude('C:/proj');
    expect(handle.isClaudeConnected()).toBe(true);
    handle.stopClaude();
    expect(calls).toContainEqual({ cmd: 'claude_stop', args: { id: 'claude-1' } });
    expect(handle.isClaudeConnected()).toBe(false);
    handle.dispose();
  });

  it('routes conductor markers in a primary turn-end to the spawn/tell callbacks', async () => {
    const onConductorSpawn = vi.fn();
    const onConductorTell = vi.fn();
    const { handle, handlers } = setup({ onConductorSpawn, onConductorTell });
    await handle.startClaude('C:/proj');
    handlers['claude://claude-1/turn-end']({
      text: 'On it. <<spawn:frontend|C:/web|build the form>> <<tell:backend|add tests>>',
      is_error: false,
    });
    expect(onConductorSpawn).toHaveBeenCalledWith({ name: 'frontend', dir: 'C:/web', task: 'build the form' });
    expect(onConductorTell).toHaveBeenCalledWith({ name: 'backend', message: 'add tests' });
    handle.dispose();
  });

  it('dispatches a marker seen in the live stream once, not again at turn-end', async () => {
    const onConductorSpawn = vi.fn();
    const { handle, handlers } = setup({ onConductorSpawn });
    await handle.startClaude('C:/proj');
    const marker = 'Spinning up. <<spawn:frontend|C:/web|build the form>>';
    handlers['claude://claude-1/stream']({ kind: 'narration', text: marker });
    handlers['claude://claude-1/turn-end']({ text: marker, is_error: false });
    expect(onConductorSpawn).toHaveBeenCalledTimes(1);
    expect(onConductorSpawn).toHaveBeenCalledWith({ name: 'frontend', dir: 'C:/web', task: 'build the form' });
    handle.dispose();
  });

  it('passes per-session model and effort to claude_start, and marks it the conductor', async () => {
    const { handle, calls } = setup();
    await handle.startClaude('C:/proj', 'opus', 'high');
    expect(calls).toContainEqual({
      cmd: 'claude_start',
      args: { conductor: true, dir: 'C:/proj', model: 'opus', effort: 'high' },
    });
    handle.dispose();
  });

  it('interrupt() cancels an in-flight thinking turn and returns true (barge-in)', async () => {
    const { handle, handlers, calls } = setup();
    await handle.startClaude('C:/proj');
    handlers['claude://claude-1/thinking']({ active: true });
    expect(state()).toBe('thinking');
    expect(handle.interrupt()).toBe(true);
    expect(calls).toContainEqual({ cmd: 'claude_cancel', args: { id: 'claude-1' } });
    expect(state()).toBe('idle');
    handle.dispose();
  });

  it('interrupt() is a no-op (returns false) when nothing is in flight', async () => {
    const { handle, calls } = setup();
    await handle.startClaude('C:/proj');
    expect(handle.interrupt()).toBe(false);
    expect(calls.some((c) => c.cmd === 'claude_cancel')).toBe(false);
    handle.dispose();
  });
});
