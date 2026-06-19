/**
 * "Jarvis only" takeover: turns the injected mcp-voice-hooks page into a
 * full-screen avatar view. The glowing head (rendered by #jarvis-avatar-overlay)
 * becomes the whole UI; the host's Messenger chrome is hidden, the latest
 * assistant reply is shown as a large readable caption, and a single
 * tap-to-talk control proxies the host mic button.
 *
 * Design notes:
 * - The host chrome is HIDDEN with CSS, never removed, so the existing observers
 *   (#micBtn, #conversationMessages) and the host's own logic keep working. The
 *   mic is driven via the real button's programmatic click(), reusing all of the
 *   host's recognition / auto-send behaviour.
 * - A persistent mode toggle (top-right) flips takeover on/off and remembers the
 *   choice, so the user is never trapped in either view.
 *
 * Security: caption text comes from the host transcript and is written with
 * `textContent` only (via safeSetText), never innerHTML, so a reply can never
 * inject markup. The mic icon is built with createElementNS from a constant.
 */

import type { AvatarState } from '../avatar/AvatarController';
import { parseMoodMarker } from '../mood/moodProtocol';
import { safeSetText } from './dom';
import type { StorageLike } from '../config/store';

const BODY_CLASS = 'jarvis-takeover';
const SETTINGS_OPEN_CLASS = 'jarvis-settings-open';
const STORAGE_KEY = 'jarvisTakeover';

/** Human label shown under the talk control for each avatar state. */
const STATE_LABELS: Record<AvatarState, string> = {
  idle: 'Tap to talk',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
};

export interface TakeoverOptions {
  doc?: Document;
  /** Host mic button to proxy (e.g. #micBtn). Null degrades to a no-op control. */
  micButton?: HTMLElement | null;
  /** Transcript root to source captions from (e.g. #conversationMessages). */
  messagesRoot?: HTMLElement | null;
  /** Storage for the on/off preference. Defaults to localStorage when available. */
  storage?: StorageLike | null;
}

export interface TakeoverHandle {
  /** Reflect the avatar state on the talk control + status label. */
  setState(state: AvatarState): void;
  /** Whether the takeover view is currently active. */
  active(): boolean;
  dispose(): void;
}

function defaultStorage(): StorageLike | null {
  try {
    const ls = (globalThis as { localStorage?: StorageLike }).localStorage;
    return ls ?? null;
  } catch {
    return null;
  }
}

/** Default ON: the injected host is "Jarvis only" unless the user opted out. */
function readPref(storage: StorageLike | null): boolean {
  if (!storage) {
    return true;
  }
  try {
    return storage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

function writePref(storage: StorageLike | null, active: boolean): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(STORAGE_KEY, active ? 'on' : 'off');
  } catch {
    /* persistence is best-effort; ignore quota/security errors */
  }
}

/** The last assistant reply text in the transcript, mood-stripped. '' if none. */
export function latestAssistantText(root: ParentNode | null): string {
  if (!root) {
    return '';
  }
  const bubbles = root.querySelectorAll('.message-bubble.assistant');
  const last = bubbles[bubbles.length - 1] as HTMLElement | undefined;
  if (!last) {
    return '';
  }
  const textEl = (last.querySelector('.message-text') as HTMLElement | null) ?? last;
  const raw = textEl.textContent ?? '';
  return parseMoodMarker(raw).stripped.trim();
}

/** Build the microphone glyph as an inline SVG (constant markup, no host text). */
function makeMicIcon(doc: Document): SVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = doc.createElementNS(NS, 'path');
  path.setAttribute(
    'd',
    'M12 1C10.34 1 9 2.34 9 4V12C9 13.66 10.34 15 12 15C13.66 15 15 13.66 15 12V4C15 2.34 13.66 1 12 1ZM19 12C19 15.53 16.39 18.44 13 18.93V22H11V18.93C7.61 18.44 5 15.53 5 12H7C7 14.76 9.24 17 12 17C14.76 17 17 14.76 17 12H19Z',
  );
  svg.appendChild(path);
  return svg;
}

/**
 * Mount the Jarvis-only takeover onto the live host page. Idempotent per call:
 * each call appends its own controls; dispose() removes them and the body class.
 */
export function enableTakeover(options: TakeoverOptions = {}): TakeoverHandle {
  const doc = options.doc ?? document;
  const body = doc.body;
  const micButton = options.micButton ?? null;
  const messagesRoot = options.messagesRoot ?? null;
  const storage = options.storage === undefined ? defaultStorage() : options.storage;

  // Caption: latest reply, large + readable (also lets you READ replies when
  // TTS audio is off).
  const caption = doc.createElement('p');
  caption.id = 'jarvis-caption';
  caption.setAttribute('role', 'status');
  caption.setAttribute('aria-live', 'polite');

  // Talk control: proxies the host mic button.
  const talk = doc.createElement('button');
  talk.id = 'jarvis-talk';
  talk.type = 'button';
  talk.setAttribute('aria-label', STATE_LABELS.idle);
  talk.dataset.state = 'idle';
  talk.appendChild(makeMicIcon(doc));

  const label = doc.createElement('span');
  label.id = 'jarvis-talk-label';
  label.textContent = STATE_LABELS.idle;

  // Mode toggle: always visible (both modes) so the user is never trapped.
  const toggle = doc.createElement('button');
  toggle.id = 'jarvis-mode-toggle';
  toggle.type = 'button';

  // Gear: opens the host Voice Settings as a floating panel WITHOUT leaving the
  // avatar view (otherwise the settings stay buried in the hidden host chrome).
  const gear = doc.createElement('button');
  gear.id = 'jarvis-gear';
  gear.type = 'button';
  gear.textContent = '⚙'; // gear glyph
  gear.setAttribute('aria-label', 'Voice settings');
  gear.setAttribute('aria-expanded', 'false');

  // Top-right control cluster holding the gear + mode toggle.
  const controls = doc.createElement('div');
  controls.id = 'jarvis-controls';
  controls.appendChild(gear);
  controls.appendChild(toggle);

  let active = readPref(storage);

  const applyMode = (next: boolean): void => {
    active = next;
    body.classList.toggle(BODY_CLASS, next);
    if (!next) {
      // Leaving the avatar view: close the floating settings panel too.
      body.classList.remove(SETTINGS_OPEN_CLASS);
      gear.setAttribute('aria-expanded', 'false');
    }
    toggle.textContent = next ? 'Classic UI' : 'Jarvis mode';
    toggle.setAttribute('aria-pressed', String(next));
  };

  const onTalk = (): void => {
    micButton?.click();
  };
  const onToggle = (): void => {
    applyMode(!active);
    writePref(storage, active);
  };
  const onGear = (): void => {
    const open = body.classList.toggle(SETTINGS_OPEN_CLASS);
    gear.setAttribute('aria-expanded', String(open));
  };

  talk.addEventListener('click', onTalk);
  toggle.addEventListener('click', onToggle);
  gear.addEventListener('click', onGear);

  body.appendChild(caption);
  body.appendChild(talk);
  body.appendChild(label);
  body.appendChild(controls);

  const refreshCaption = (): void => {
    const text = latestAssistantText(messagesRoot);
    safeSetText(caption, text);
    caption.classList.toggle('show', text.length > 0);
  };

  let observer: MutationObserver | null = null;
  if (messagesRoot && typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(() => refreshCaption());
    observer.observe(messagesRoot, { childList: true, subtree: true, characterData: true });
  }

  applyMode(active);
  refreshCaption();

  return {
    setState(state: AvatarState): void {
      talk.dataset.state = state;
      talk.setAttribute('aria-label', STATE_LABELS[state]);
      safeSetText(label, STATE_LABELS[state]);
    },
    active(): boolean {
      return active;
    },
    dispose(): void {
      observer?.disconnect();
      talk.removeEventListener('click', onTalk);
      toggle.removeEventListener('click', onToggle);
      gear.removeEventListener('click', onGear);
      body.classList.remove(BODY_CLASS);
      body.classList.remove(SETTINGS_OPEN_CLASS);
      caption.remove();
      talk.remove();
      label.remove();
      controls.remove();
    },
  };
}
