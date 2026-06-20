import { describe, it, expect } from 'vitest';
import { toArrayBuffer, tauriTtsFetch, type InvokeFn } from '../src/integration/tauriAdapter';

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
});
