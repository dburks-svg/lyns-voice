import { describe, it, expect, vi } from 'vitest';
import { SessionManager, type SessionManagerDeps } from '../src/app/session/SessionManager';

function setup(dir = 'C:/proj') {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const handlers: Record<string, (p: unknown) => void> = {};
  const onDone = vi.fn();
  const onUsage = vi.fn();
  const onCountChange = vi.fn();
  const layer = document.createElement('div');
  document.body.appendChild(layer);

  const deps: SessionManagerDeps = {
    invoke: (async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      return cmd === 'claude_start' ? 'claude-9' : undefined;
    }) as SessionManagerDeps['invoke'],
    listen: (async (event: string, handler: (p: unknown) => void) => {
      handlers[event] = handler;
      return () => {
        delete handlers[event];
      };
    }) as unknown as SessionManagerDeps['listen'],
    layer,
    defaults: () => ({ dir, model: 'opus', effort: 'high' }),
    onDone,
    onUsage,
    onCountChange,
  };
  return { mgr: new SessionManager(deps), calls, handlers, onDone, onUsage, onCountChange, layer };
}

describe('SessionManager (background multi-session)', () => {
  it('spawns with dir/model/effort and subscribes to the session events', async () => {
    const { mgr, calls, handlers, layer } = setup();
    const id = await mgr.spawn();
    expect(id).toBe('claude-9');
    expect(calls).toContainEqual({
      cmd: 'claude_start',
      args: { dir: 'C:/proj', model: 'opus', effort: 'high' },
    });
    expect(typeof handlers['claude://claude-9/stream']).toBe('function');
    expect(typeof handlers['claude://claude-9/turn-end']).toBe('function');
    expect(layer.querySelector('.session-window')).not.toBeNull();
    expect(mgr.count).toBe(1);
    mgr.closeAll();
  });

  it('refuses to spawn without a project dir', async () => {
    const { mgr } = setup(''); // empty (falsy) dir, without triggering the default param
    expect(await mgr.spawn()).toBeNull();
    expect(mgr.count).toBe(0);
  });

  it('routes typed input to claude_submit with the session id', async () => {
    const { mgr, calls, layer } = setup();
    await mgr.spawn();
    const input = layer.querySelector<HTMLTextAreaElement>('.session-input')!;
    input.value = 'do the thing';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(calls).toContainEqual({ cmd: 'claude_submit', args: { id: 'claude-9', text: 'do the thing' } });
    mgr.closeAll();
  });

  it('announces a finished turn via onDone', async () => {
    const { mgr, handlers, onDone } = setup();
    await mgr.spawn();
    handlers['claude://claude-9/turn-end']({ text: 'done', is_error: false });
    expect(onDone).toHaveBeenCalledWith('Session A', false);
    mgr.closeAll();
  });

  it('spawns with a conductor-supplied dir and submits the opening task', async () => {
    const { mgr, calls } = setup();
    const id = await mgr.spawn({ name: 'frontend', dir: 'C:/web', task: 'build it' });
    expect(id).toBe('claude-9');
    expect(calls).toContainEqual({ cmd: 'claude_start', args: { dir: 'C:/web', model: 'opus', effort: 'high' } });
    expect(calls).toContainEqual({ cmd: 'claude_submit', args: { id: 'claude-9', text: 'build it' } });
    mgr.closeAll();
  });

  it('tell() relays a message to the worker by name (case-insensitive)', async () => {
    const { mgr, calls } = setup();
    await mgr.spawn({ name: 'backend', dir: 'C:/api', task: 'serve' });
    expect(mgr.tell('Backend', 'add rate limiting')).toBe(true);
    expect(calls).toContainEqual({ cmd: 'claude_submit', args: { id: 'claude-9', text: 'add rate limiting' } });
    mgr.closeAll();
  });

  it('tell() returns false for an unknown worker', async () => {
    const { mgr } = setup();
    await mgr.spawn({ name: 'backend', dir: 'C:/api', task: 'serve' });
    expect(mgr.tell('frontend', 'hi')).toBe(false);
    mgr.closeAll();
  });

  it('forwards worker usage and count changes for the fleet meter', async () => {
    const { mgr, handlers, onUsage, onCountChange } = setup();
    await mgr.spawn();
    expect(onCountChange).toHaveBeenLastCalledWith(1);
    handlers['claude://claude-9/usage']({ cost_usd: 0.42 });
    expect(onUsage).toHaveBeenCalledWith({ cost_usd: 0.42 });
    mgr.close('claude-9');
    expect(onCountChange).toHaveBeenLastCalledWith(0);
  });

  it('close stops the session by id and tears down its panel', async () => {
    const { mgr, calls, layer } = setup();
    await mgr.spawn();
    mgr.close('claude-9');
    expect(calls).toContainEqual({ cmd: 'claude_stop', args: { id: 'claude-9' } });
    expect(layer.querySelector('.session-window')).toBeNull();
    expect(mgr.count).toBe(0);
  });

  it('closes a worker whose child died (ready active:false)', async () => {
    const { mgr, handlers, layer, onCountChange } = setup();
    await mgr.spawn();
    expect(mgr.count).toBe(1);
    // A stray active:true must NOT close it.
    handlers['claude://claude-9/ready']({ active: true });
    expect(mgr.count).toBe(1);
    // The child exits -> the panel is torn down and the fleet count decremented.
    handlers['claude://claude-9/ready']({ active: false });
    expect(mgr.count).toBe(0);
    expect(layer.querySelector('.session-window')).toBeNull();
    expect(onCountChange).toHaveBeenLastCalledWith(0);
  });
});
