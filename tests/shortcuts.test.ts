import { describe, it, expect, vi } from 'vitest';
import { attachShortcuts, type ShortcutActions } from '../src/app/shortcuts';

function makeActions(): ShortcutActions {
  return {
    toggleTerminal: vi.fn(),
    toggleDiffs: vi.fn(),
    toggleSettings: vi.fn(),
    toggleMic: vi.fn(),
    closeFocused: vi.fn(),
  };
}

function fire(key: string, opts: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts });
  document.dispatchEvent(e);
  return e;
}

describe('attachShortcuts', () => {
  it('dispatches Alt+T to toggleTerminal', () => {
    const a = makeActions();
    const cleanup = attachShortcuts(a);
    fire('t', { altKey: true });
    expect(a.toggleTerminal).toHaveBeenCalledOnce();
    cleanup();
  });

  it('dispatches Alt+D to toggleDiffs', () => {
    const a = makeActions();
    const cleanup = attachShortcuts(a);
    fire('d', { altKey: true });
    expect(a.toggleDiffs).toHaveBeenCalledOnce();
    cleanup();
  });

  it('dispatches Alt+S to toggleSettings', () => {
    const a = makeActions();
    const cleanup = attachShortcuts(a);
    fire('s', { altKey: true });
    expect(a.toggleSettings).toHaveBeenCalledOnce();
    cleanup();
  });

  it('dispatches Escape to closeFocused', () => {
    const a = makeActions();
    const cleanup = attachShortcuts(a);
    fire('Escape');
    expect(a.closeFocused).toHaveBeenCalledOnce();
    cleanup();
  });

  it('dispatches Space to toggleMic', () => {
    const a = makeActions();
    const cleanup = attachShortcuts(a);
    fire(' ');
    expect(a.toggleMic).toHaveBeenCalledOnce();
    cleanup();
  });

  it('suppresses Space when modifier keys are held', () => {
    const a = makeActions();
    const cleanup = attachShortcuts(a);
    fire(' ', { ctrlKey: true });
    fire(' ', { altKey: true });
    fire(' ', { metaKey: true });
    expect(a.toggleMic).not.toHaveBeenCalled();
    cleanup();
  });

  it('suppresses shortcuts when an input is focused', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const a = makeActions();
    const cleanup = attachShortcuts(a);
    fire('t', { altKey: true });
    fire(' ');
    expect(a.toggleTerminal).not.toHaveBeenCalled();
    expect(a.toggleMic).not.toHaveBeenCalled();
    cleanup();
    document.body.removeChild(input);
  });

  it('cleans up on teardown', () => {
    const a = makeActions();
    const cleanup = attachShortcuts(a);
    cleanup();
    fire('t', { altKey: true });
    expect(a.toggleTerminal).not.toHaveBeenCalled();
  });
});
