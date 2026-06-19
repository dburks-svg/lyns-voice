import { describe, it, expect, vi, afterEach } from 'vitest';
import { enableTakeover, latestAssistantText } from '../src/integration/takeover';
import type { StorageLike } from '../src/config/store';

type FakeStorage = StorageLike & { map: Record<string, string> };

function fakeStorage(initial: Record<string, string> = {}): FakeStorage {
  const map: Record<string, string> = { ...initial };
  return {
    map,
    getItem: (k) => (k in map ? map[k] : null),
    setItem: (k, v) => {
      map[k] = v;
    },
  };
}

function addBubble(root: HTMLElement, role: 'assistant' | 'user', text: string): void {
  const bubble = document.createElement('div');
  bubble.className = `message-bubble ${role}`;
  const t = document.createElement('div');
  t.className = 'message-text';
  t.textContent = text;
  bubble.appendChild(t);
  root.appendChild(bubble);
}

describe('latestAssistantText', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('returns empty for a null or empty root', () => {
    expect(latestAssistantText(null)).toBe('');
    expect(latestAssistantText(document.createElement('div'))).toBe('');
  });

  it('returns the last assistant message, ignoring user bubbles', () => {
    const root = document.createElement('div');
    addBubble(root, 'assistant', 'first');
    addBubble(root, 'user', 'a user line');
    addBubble(root, 'assistant', 'second');
    expect(latestAssistantText(root)).toBe('second');
  });

  it('strips a mood marker from the caption text', () => {
    const root = document.createElement('div');
    addBubble(root, 'assistant', '<<mood:happy>> all green');
    expect(latestAssistantText(root)).toBe('all green');
  });
});

describe('enableTakeover', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    document.body.className = '';
  });

  it('adds the body class and builds the caption, talk, label, gear, and toggle', () => {
    const handle = enableTakeover({ storage: fakeStorage() });
    expect(document.body.classList.contains('jarvis-takeover')).toBe(true);
    expect(document.getElementById('jarvis-caption')).not.toBeNull();
    expect(document.getElementById('jarvis-talk')).not.toBeNull();
    expect(document.getElementById('jarvis-talk-label')).not.toBeNull();
    expect(document.getElementById('jarvis-controls')).not.toBeNull();
    expect(document.getElementById('jarvis-gear')).not.toBeNull();
    expect(document.getElementById('jarvis-mode-toggle')).not.toBeNull();
    handle.dispose();
  });

  it('gear toggles the floating settings panel open and closed', () => {
    const handle = enableTakeover({ storage: fakeStorage() });
    const gear = document.getElementById('jarvis-gear') as HTMLButtonElement;
    expect(document.body.classList.contains('jarvis-settings-open')).toBe(false);
    gear.click();
    expect(document.body.classList.contains('jarvis-settings-open')).toBe(true);
    expect(gear.getAttribute('aria-expanded')).toBe('true');
    gear.click();
    expect(document.body.classList.contains('jarvis-settings-open')).toBe(false);
    expect(gear.getAttribute('aria-expanded')).toBe('false');
    handle.dispose();
  });

  it('switching to classic mode also closes the settings panel', () => {
    const handle = enableTakeover({ storage: fakeStorage() });
    (document.getElementById('jarvis-gear') as HTMLButtonElement).click();
    expect(document.body.classList.contains('jarvis-settings-open')).toBe(true);
    (document.getElementById('jarvis-mode-toggle') as HTMLButtonElement).click();
    expect(document.body.classList.contains('jarvis-takeover')).toBe(false);
    expect(document.body.classList.contains('jarvis-settings-open')).toBe(false);
    handle.dispose();
  });

  it('proxies the talk control to the host mic button', () => {
    const mic = document.createElement('button');
    const click = vi.spyOn(mic, 'click');
    const handle = enableTakeover({ micButton: mic, storage: fakeStorage() });
    (document.getElementById('jarvis-talk') as HTMLButtonElement).click();
    expect(click).toHaveBeenCalledTimes(1);
    handle.dispose();
  });

  it('reflects avatar state on the control and label', () => {
    const handle = enableTakeover({ storage: fakeStorage() });
    handle.setState('listening');
    const talk = document.getElementById('jarvis-talk') as HTMLButtonElement;
    const label = document.getElementById('jarvis-talk-label') as HTMLElement;
    expect(talk.dataset.state).toBe('listening');
    expect(label.textContent).toBe('Listening');
    handle.dispose();
  });

  it('shows the latest reply as a caption', () => {
    const root = document.createElement('div');
    root.id = 'conversationMessages';
    document.body.appendChild(root);
    addBubble(root, 'assistant', 'hello there');
    const handle = enableTakeover({ messagesRoot: root, storage: fakeStorage() });
    const caption = document.getElementById('jarvis-caption') as HTMLElement;
    expect(caption.textContent).toBe('hello there');
    expect(caption.classList.contains('show')).toBe(true);
    handle.dispose();
  });

  it('starts in classic mode when the preference is off, then toggles and persists', () => {
    const storage = fakeStorage({ jarvisTakeover: 'off' });
    const handle = enableTakeover({ storage });
    expect(document.body.classList.contains('jarvis-takeover')).toBe(false);
    expect(handle.active()).toBe(false);
    (document.getElementById('jarvis-mode-toggle') as HTMLButtonElement).click();
    expect(document.body.classList.contains('jarvis-takeover')).toBe(true);
    expect(storage.map.jarvisTakeover).toBe('on');
    handle.dispose();
  });

  it('dispose removes all elements and the body classes', () => {
    const handle = enableTakeover({ storage: fakeStorage() });
    (document.getElementById('jarvis-gear') as HTMLButtonElement).click();
    handle.dispose();
    expect(document.getElementById('jarvis-talk')).toBeNull();
    expect(document.getElementById('jarvis-caption')).toBeNull();
    expect(document.getElementById('jarvis-controls')).toBeNull();
    expect(document.getElementById('jarvis-gear')).toBeNull();
    expect(document.getElementById('jarvis-mode-toggle')).toBeNull();
    expect(document.body.classList.contains('jarvis-takeover')).toBe(false);
    expect(document.body.classList.contains('jarvis-settings-open')).toBe(false);
  });
});
