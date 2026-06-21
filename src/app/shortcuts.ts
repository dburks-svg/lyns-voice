export interface ShortcutActions {
  toggleTerminal: () => void;
  toggleDiffs: () => void;
  toggleSession: () => void;
  toggleSettings: () => void;
  toggleMic: () => void;
  toggleMini: () => void;
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

export function attachShortcuts(actions: ShortcutActions): () => void {
  const ac = new AbortController();

  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (isTextFocused()) return;

    if (e.altKey && e.key === 't') {
      e.preventDefault();
      actions.toggleTerminal();
      return;
    }
    if (e.altKey && e.key === 'd') {
      e.preventDefault();
      actions.toggleDiffs();
      return;
    }
    if (e.altKey && e.key === 'j') {
      e.preventDefault();
      actions.toggleSession();
      return;
    }
    if (e.altKey && e.key === 's') {
      e.preventDefault();
      actions.toggleSettings();
      return;
    }
    if (e.altKey && e.key === 'm') {
      e.preventDefault();
      actions.toggleMini();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      actions.closeFocused();
      return;
    }
    if (e.key === ' ' && !e.altKey && !e.ctrlKey && !e.metaKey && !e.repeat) {
      e.preventDefault();
      actions.toggleMic();
      return;
    }
  }, { signal: ac.signal });

  return () => ac.abort();
}
