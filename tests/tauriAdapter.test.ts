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
import type { MediaTtsOptions, MediaTtsLike } from '../src/audio/MediaTts';

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
      stop() {},
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

  // The Library's MCP toggles: names disabled there must reach claude_start (the
  // Rust side then allowlists every registered server EXCEPT these).
  it('passes Library-disabled MCP servers to claude_start', async () => {
    const { handle, calls } = setup({ mcpDisabled: () => ['github'] });
    await handle.startClaude('C:/proj');
    const start = calls.find((c) => c.cmd === 'claude_start');
    expect(start?.args?.disabledMcp).toEqual(['github']);
    handle.dispose();
  });

  it('omits the disabledMcp arg when nothing is disabled', async () => {
    const { handle, calls } = setup();
    await handle.startClaude('C:/proj');
    const start = calls.find((c) => c.cmd === 'claude_start');
    expect(start?.args).not.toHaveProperty('disabledMcp');
    expect(start?.args).not.toHaveProperty('disabledHooks');
    handle.dispose();
  });

  // Live-test report: the last reply's caption persisted after disconnect (nothing
  // clears it but the next reply). Disconnecting must return the stage to quiet.
  it('clears the caption on disconnect', async () => {
    const caption = document.createElement('div');
    const { handle, handlers } = setup({ caption });
    await handle.startClaude('C:/proj');
    handlers['claude://claude-1/turn-end']({ text: 'All done.', is_error: false });
    expect(caption.textContent).toBe('All done.');
    handle.stopClaude();
    expect(caption.textContent).toBe('');
    handle.dispose();
  });

  it('passes Library-disabled hook ids to claude_start', async () => {
    const { handle, calls } = setup({ hooksDisabled: () => ['aaa', 'bbb'] });
    await handle.startClaude('C:/proj');
    const start = calls.find((c) => c.cmd === 'claude_start');
    expect(start?.args?.disabledHooks).toEqual(['aaa', 'bbb']);
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

  // Regression: streaming fires pumpSpeech once per sentence, so sentences 2+ arrive
  // during sentence 1's synthesis (before isSpeaking flips on). Without the `pumping`
  // guard they started parallel syntheses, got shifted out of the queue, then dropped
  // once playback began - so Q stopped after the first sentence. All must play in order.
  it('plays every streamed sentence in order when they arrive during synthesis', async () => {
    vi.useFakeTimers();
    try {
      const played: string[] = [];
      // A fake MediaTts whose synth resolves on a microtask and whose playback ends on
      // a 0ms timer - enough to recreate the synth->play race deterministically.
      const fakeFactory = (opts: MediaTtsOptions): MediaTtsLike => {
        let speaking = false;
        return {
          get isSpeaking() {
            return speaking;
          },
          synthesize: (text: string) =>
            Promise.resolve(text.trim() ? ({ __text: text } as unknown as AudioBuffer) : null),
          playBuffer: (buf: AudioBuffer) => {
            speaking = true;
            opts.onSpeakingStart?.();
            played.push((buf as unknown as { __text: string }).__text.trim());
            setTimeout(() => {
              speaking = false;
              opts.onSpeakingEnd?.();
            }, 0);
            return Promise.resolve(true);
          },
          stop: () => {
            speaking = false;
          },
          unlock: () => {},
          dispose: () => {},
        };
      };

      const { handle, handlers } = setup({ mediaTtsFactory: fakeFactory });
      await handle.startClaude('C:/proj');
      // One delta carrying three sentences: the streamer emits all three synchronously,
      // firing pumpSpeech three times within the first synth window.
      handlers['claude://claude-1/delta']({ text: 'First sentence. Second sentence. Third sentence. ' });
      await vi.runAllTimersAsync();

      expect(played).toEqual(['First sentence.', 'Second sentence.', 'Third sentence.']);
      handle.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  // A fake MediaTts whose playback starts on the synth microtask and never ends on
  // its own, so tests can hold the app in the Speaking state deterministically.
  function speakingFactory(): { factory: (opts: MediaTtsOptions) => MediaTtsLike } {
    return {
      factory: (opts: MediaTtsOptions): MediaTtsLike => {
        let speaking = false;
        return {
          get isSpeaking() {
            return speaking;
          },
          synthesize: (text: string) =>
            Promise.resolve(text.trim() ? ({ __text: text } as unknown as AudioBuffer) : null),
          playBuffer: () => {
            speaking = true;
            opts.onSpeakingStart?.();
            return Promise.resolve(true);
          },
          stop: () => {
            speaking = false;
          },
          unlock: () => {},
          dispose: () => {},
        };
      },
    };
  }
  const flushMicrotasks = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  // Regression (audit): the barge-in path ran cancelClaude(); submitToClaude() back to
  // back, but the Rust cancel is a kill+RELAUNCH: during the relaunch window the
  // session is absent and the submit was silently dropped. The submit must wait for
  // the cancel invoke to resolve.
  it('voice barge-in submits only after claude_cancel resolves (no dropped command)', async () => {
    const order: string[] = [];
    let releaseCancel!: () => void;
    const invoke = (async (cmd: string) => {
      order.push(cmd);
      if (cmd === 'claude_start') return 'claude-1';
      if (cmd === 'tts_synthesize') throw new Error('no audio in test');
      if (cmd === 'claude_cancel') {
        return new Promise<void>((resolve) => {
          releaseCancel = resolve; // the kill + process-respawn window, held open
        });
      }
      return undefined;
    }) as InvokeFn;
    const { handle, handlers } = setup({ invoke, bargeIn: () => true });
    await handle.startClaude('C:/proj');
    handlers['claude://claude-1/thinking']({ active: true }); // a turn is generating
    handlers['stt://final']({ text: 'stop, do this instead' }); // barge-in
    await flushMicrotasks();
    expect(order).toContain('claude_cancel');
    expect(order).not.toContain('claude_submit'); // must not race the relaunch window
    releaseCancel();
    await flushMicrotasks();
    expect(order.indexOf('claude_submit')).toBeGreaterThan(order.indexOf('claude_cancel'));
    handle.dispose();
  });

  // Regression (audit): barge-in while Q was merely reading a COMPLETED reply killed
  // and relaunched the session, wiping the conversation context for nothing. A
  // speech-only interrupt suffices there.
  it('barge-in while only reading a finished reply keeps the session (no cancel)', async () => {
    const { factory } = speakingFactory();
    const { handle, handlers, calls } = setup({ mediaTtsFactory: factory, bargeIn: () => true });
    await handle.startClaude('C:/proj');
    handlers['claude://claude-1/thinking']({ active: true });
    handlers['claude://claude-1/delta']({ text: 'Here is the answer. ' });
    await flushMicrotasks(); // playback starts; pendingResponse cleared
    handlers['claude://claude-1/turn-end']({ text: 'Here is the answer.', is_error: false });
    expect(state()).toBe('speaking');
    handlers['stt://final']({ text: 'wait, change of plan' });
    expect(calls.some((c) => c.cmd === 'claude_cancel')).toBe(false);
    expect(calls).toContainEqual({
      cmd: 'claude_submit',
      args: { id: 'claude-1', text: 'wait, change of plan' },
    });
    handle.dispose();
  });

  // Regression (audit): on a single-sentence streamed reply, turn-end's settle check
  // saw an empty queue while the tail sentence was still mid-synthesis and dropped
  // Thinking, flashing idle (and reopening the input guard) before Speaking began.
  it('keeps Thinking through the turn-end -> speech gap on a single-sentence streamed reply', async () => {
    const fakeFactory = (opts: MediaTtsOptions): MediaTtsLike => ({
      get isSpeaking() {
        return false; // playback has not started yet
      },
      synthesize: () => new Promise<AudioBuffer | null>(() => undefined), // never resolves
      playBuffer: () => {
        opts.onSpeakingStart?.();
        return Promise.resolve(true);
      },
      stop: () => {},
      unlock: () => {},
      dispose: () => {},
    });
    const { handle, handlers } = setup({ mediaTtsFactory: fakeFactory });
    await handle.startClaude('C:/proj');
    handlers['claude://claude-1/thinking']({ active: true });
    handlers['claude://claude-1/delta']({ text: 'Only one sentence with no trailing space.' });
    handlers['claude://claude-1/turn-end']({
      text: 'Only one sentence with no trailing space.',
      is_error: false,
    });
    expect(state()).toBe('thinking'); // NOT idle: the tail sentence is mid-synthesis
    handle.dispose();
  });

  // Regression (audit): Escape during a streamed reply that was still generating only
  // stopped playback; the child kept generating and its remaining deltas were spoken
  // into the NEXT turn. Interrupt must cancel the generation too.
  it('interrupt() during a still-generating streamed reply cancels the turn', async () => {
    const { factory } = speakingFactory();
    const { handle, handlers, calls } = setup({ mediaTtsFactory: factory });
    await handle.startClaude('C:/proj');
    handlers['claude://claude-1/thinking']({ active: true });
    handlers['claude://claude-1/delta']({ text: 'First sentence spoken early. ' });
    await flushMicrotasks(); // speaking now, but no turn-end yet
    expect(handle.interrupt()).toBe(true);
    expect(calls).toContainEqual({ cmd: 'claude_cancel', args: { id: 'claude-1' } });
    handle.dispose();
  });

  // The audit's top clunkiness finding: stt://listening{active:false} (the VAD closing
  // an utterance) was emitted by Rust but never consumed, so the UI sat unchanged
  // through the whole transcription. It must acknowledge immediately.
  it('acknowledges end-of-speech with a Transcribing caption, replaced by the transcript', async () => {
    const caption = document.createElement('div');
    const { handle, handlers } = setup({ caption });
    handlers['stt://listening']({ active: false }); // worker start chatter: no utterance yet
    expect(caption.textContent ?? '').toBe('');
    handlers['stt://listening']({ active: true }); // speech opened
    handlers['stt://listening']({ active: false }); // utterance closed -> whisper running
    expect(caption.textContent).toBe('Transcribing…');
    handlers['stt://final']({ text: 'run the tests' });
    expect(caption.textContent).toBe('run the tests');
    handle.dispose();
  });

  // Live-test regression: a noise blip / silence yields an EMPTY transcription; Rust
  // now emits an empty stt://final for it, and the UI must blank the "Transcribing"
  // acknowledgment instead of leaving it on screen indefinitely.
  it('clears the Transcribing caption when the transcription comes back empty', async () => {
    const caption = document.createElement('div');
    const { handle, handlers } = setup({ caption });
    handlers['stt://listening']({ active: true });
    handlers['stt://listening']({ active: false });
    expect(caption.textContent).toBe('Transcribing…');
    handlers['stt://final']({ text: '' });
    expect(caption.textContent).toBe('');
    handle.dispose();
  });

  // Live-test regression: with overlapping utterances (B closes while A still
  // decodes), A's EMPTY final must not blank the "Transcribing" acknowledgment
  // that now belongs to B - the caption flickered set/blank/set. Blank only when
  // no decode is still in flight.
  it('keeps the Transcribing caption while a newer utterance is still decoding', () => {
    const caption = document.createElement('div');
    const { handle, handlers } = setup({ caption });
    // Utterance A closes, then B opens and closes: two decodes in flight.
    handlers['stt://listening']({ active: true });
    handlers['stt://listening']({ active: false });
    handlers['stt://listening']({ active: true });
    handlers['stt://listening']({ active: false });
    expect(caption.textContent).toBe('Transcribing…');
    handlers['stt://final']({ text: '' }); // A: prefiltered ambient - B still decoding
    expect(caption.textContent).toBe('Transcribing…');
    handlers['stt://final']({ text: '' }); // B: nothing usable either - now blank
    expect(caption.textContent).toBe('');
    handle.dispose();
  });

  // Wake-word prefilter (de-clunk round 2): the adapter syncs the gate (wake mode
  // on AND Q not armed) to Rust via stt_set_wake_gate so stt.rs can skip the full
  // whisper decode on ambient speech. The gate must open on speech onset, close
  // while a bare "hey Q" has Q armed (the follow-up command needs a full decode),
  // and reopen when the arm window expires unused.
  it('syncs the wake gate to Rust across arm and disarm transitions', () => {
    vi.useFakeTimers();
    try {
      const { handle, handlers, calls } = setup({ wakeWordEnabled: () => true });
      const gate = (): unknown[] =>
        calls.filter((c) => c.cmd === 'stt_set_wake_gate').map((c) => c.args?.active);
      handlers['stt://listening']({ active: true });
      expect(gate()).toEqual([true]);
      // A bare "Oracle" arms the mic: the gate closes.
      handlers['stt://listening']({ active: false });
      handlers['stt://final']({ text: 'Oracle.' });
      expect(gate()).toEqual([true, false]);
      // The arm window expires unused: the gate reopens.
      vi.advanceTimersByTime(8000);
      expect(gate()).toEqual([true, false, true]);
      handle.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends the wake gate once (deduped) and inactive when wake mode is off', () => {
    const { handle, handlers, calls } = setup(); // no wakeWordEnabled option
    handlers['stt://listening']({ active: true });
    handlers['stt://listening']({ active: false });
    handlers['stt://listening']({ active: true });
    const gate = calls.filter((c) => c.cmd === 'stt_set_wake_gate').map((c) => c.args?.active);
    expect(gate).toEqual([false]);
    handle.dispose();
  });

  // Live-test regression: one-chunk-ahead prefetch stalled at paragraph seams (a
  // short closing sentence finished playing before the long next-paragraph opener
  // finished synthesizing). The pipeline must keep several chunks synthesizing
  // ahead of playback, in order, without over-eagerly draining the whole queue.
  it('synthesizes multiple chunks ahead while the first is still playing', async () => {
    const synths: string[] = [];
    const holdingFactory = (opts: MediaTtsOptions): MediaTtsLike => {
      let speaking = false; // flips true at first playback and NEVER ends
      return {
        get isSpeaking() {
          return speaking;
        },
        synthesize: (text: string) => {
          synths.push(text);
          return Promise.resolve({ __text: text, duration: 1 } as unknown as AudioBuffer);
        },
        playBuffer: () => {
          speaking = true;
          opts.onSpeakingStart?.();
          return Promise.resolve(true);
        },
        stop: () => {},
        unlock: () => {},
        dispose: () => {},
      };
    };
    const { handle } = setup({ mediaTtsFactory: holdingFactory });
    await handle.speak('One. Two. Three. Four. Five. Six.');
    await new Promise((r) => setTimeout(r, 0)); // let the chained synths settle
    // Head (playing) + a full 3-deep pipeline = 4 synthesized; the rest stay queued.
    expect(synths).toEqual(['One.', 'Two.', 'Three.', 'Four.']);
    handle.dispose();
  });

  // Live-test regression: Kokoro's model window is 510 phoneme tokens (~400 chars);
  // chunks sized for SAPI (4500 chars) were silently truncated by the engine, so a
  // document read "cut out" past ~400 chars of every chunk. Kokoro chunks must stay
  // small; SAPI keeps its big cap.
  it('splits speech into Kokoro-sized chunks for the kokoro engine only', async () => {
    const synths: string[] = [];
    const recordingFactory = (opts: MediaTtsOptions): MediaTtsLike => ({
      get isSpeaking() {
        return false;
      },
      synthesize: (text: string) => {
        synths.push(text);
        return new Promise<AudioBuffer | null>(() => undefined); // hold: counting only
      },
      playBuffer: () => {
        opts.onSpeakingStart?.();
        return Promise.resolve(true);
      },
      stop: () => {},
      unlock: () => {},
      dispose: () => {},
    });
    const oneLongSentence = `${'word '.repeat(150)}end.`; // ~750 chars, no inner boundary
    {
      const { handle } = setup({
        mediaTtsFactory: recordingFactory,
        ttsSettings: () => ({ rate: 0, pitch: 0, voice: '', engine: 'kokoro' }),
      });
      await handle.speak(oneLongSentence);
      expect(synths.length).toBeGreaterThan(0);
      expect(synths[0].length).toBeLessThanOrEqual(330); // Kokoro-sized head chunk
      handle.dispose();
    }
    synths.length = 0;
    {
      const { handle } = setup({
        mediaTtsFactory: recordingFactory,
        ttsSettings: () => ({ rate: 0, pitch: 0, voice: '', engine: 'sapi' }),
      });
      await handle.speak(oneLongSentence);
      expect(synths[0].length).toBeGreaterThan(330); // SAPI keeps the whole sentence
      handle.dispose();
    }
  });

  // Regression (audit): a pending auto-reconnect timer survived a manual reconnect and
  // later fired startClaude, silently tearing down the fresh session (context loss).
  it('a manual reconnect supersedes the pending auto-reconnect timer', async () => {
    vi.useFakeTimers();
    try {
      const { handle, handlers, calls } = setup();
      await handle.startClaude('C:/proj');
      handlers['claude://claude-1/ready']({ active: false, cwd: '' }); // drop -> schedules retry
      await handle.startClaude('C:/proj'); // the user reconnects first
      const startsBefore = calls.filter((c) => c.cmd === 'claude_start').length;
      await vi.advanceTimersByTimeAsync(120_000);
      const startsAfter = calls.filter((c) => c.cmd === 'claude_start').length;
      expect(startsAfter).toBe(startsBefore); // the stale timer must not start (= replace) a session
      handle.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('attachTauri (visibility pauses the orb)', () => {
  function recordingAvatar(): AvatarLike & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      setParams() {},
      setGlow() {},
      setColors() {},
      idleRotationSpeed: 0,
      mesh: { rotation: { x: 0, y: 0, z: 0 }, scale: { set() {} } },
      reducedMotion: false,
      beforeRender: null,
      mount() {},
      start() {
        calls.push('start');
      },
      stop() {
        calls.push('stop');
      },
      resize() {},
      dispose() {},
    };
  }

  function setHidden(value: boolean): void {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
    document.dispatchEvent(new Event('visibilitychange'));
  }

  it('stops the render loop when hidden and restarts it when visible again', () => {
    const avatar = recordingAvatar();
    const invoke = (async (cmd: string) => {
      if (cmd === 'tts_synthesize') throw new Error('no audio in test');
      return undefined;
    }) as InvokeFn;
    const listen = (async () => () => {}) as unknown as ListenFn;

    const root = document.createElement('div');
    document.body.appendChild(root);
    setHidden(false); // start visible
    const handle = attachTauri({ root, view: window, invoke, listen, avatarFactory: () => avatar });

    // attachTauri starts the loop once on mount.
    expect(avatar.calls).toEqual(['start']);

    setHidden(true);
    expect(avatar.calls).toEqual(['start', 'stop']); // minimized -> paused

    setHidden(false);
    expect(avatar.calls).toEqual(['start', 'stop', 'start']); // restored -> resumed

    handle.dispose();
    setHidden(false); // reset for other tests
  });
});
