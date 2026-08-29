export interface ShortcutActions {
  toggleTerminal: () => void;
  toggleDiffs: () => void;
  toggleSession: () => void;
  toggleSettings: () => void;
  toggleMic: () => void;
  toggleMini: () => void;
  newSession: () => void;
  closeFocused: () => void;
}

function isTextFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  if (el.closest('.terminal-body')) return true;
  return false;
}

/** The action a keydown maps to, or undefined for a key we do not own. */
function pickAction(e: KeyboardEvent, actions: ShortcutActions): (() => void) | undefined {
  if (e.altKey) {
    const alt: Record<string, (() => void) | undefined> = {
      t: actions.toggleTerminal,
      d: actions.toggleDiffs,
      j: actions.toggleSession,
      n: actions.newSession,
      s: actions.toggleSettings,
      m: actions.toggleMini,
    };
    const hit = alt[e.key];
    if (hit) return hit;
  }
  if (e.key === 'Escape') return actions.closeFocused;
  if (e.key === ' ' && !e.altKey && !e.ctrlKey && !e.metaKey && !e.repeat) {
    return actions.toggleMic;
  }
  return undefined;
}

export function attachShortcuts(actions: ShortcutActions): () => void {
  const ac = new AbortController();

  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (isTextFocused()) return;
    const action = pickAction(e, actions);
    if (action) {
      e.preventDefault();
      action();
    }
  }, { signal: ac.signal });

  return () => ac.abort();
}
