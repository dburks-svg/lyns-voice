/**
 * Background multi-session: spawn and manage several Claude Code sessions in
 * parallel, each in its own SessionPanel. The backend already keys sessions by id
 * (claude://{id}/*), so this is purely additive - it does NOT touch the primary,
 * voice-driven session (the orb/mic/TTS). Background sessions are watched and typed
 * into via their panels, and announce (a callback) when a turn ends.
 *
 * Deliberately out of scope here (a collaborative, hands-on build): switching the
 * single voice channel between sessions, and Q auto-spawning sessions via tools.
 *
 * Deps are injected so the manager is unit-testable without Tauri.
 */
import { SessionPanel } from './SessionPanel';

export interface SessionManagerDeps {
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  /** Subscribe to a namespaced event; resolves to an unlisten fn. */
  listen: <T>(event: string, handler: (payload: T) => void) => Promise<() => void>;
  /** Where the floating session panels mount. */
  layer: HTMLElement;
  /** Defaults for a new session (project dir + optional model/effort). */
  defaults: () => { dir?: string; model?: string; effort?: string };
  /** Courteous notice when a background session finishes a turn. */
  onDone?: (name: string, isError: boolean) => void;
}

interface ManagedSession {
  panel: SessionPanel;
  unlisteners: Array<() => void>;
  name: string;
}

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private counter = 0;
  private zTop = 12;

  constructor(private deps: SessionManagerDeps) {}

  get count(): number {
    return this.sessions.size;
  }

  /** Spawn a new background session. Returns its id, or null if no project dir is set. */
  async spawn(): Promise<string | null> {
    const d = this.deps.defaults();
    if (!d.dir) return null;
    const args: Record<string, unknown> = { dir: d.dir };
    if (d.model) args.model = d.model;
    if (d.effort) args.effort = d.effort;

    let id: string;
    try {
      id = await this.deps.invoke<string>('claude_start', args);
    } catch {
      return null;
    }

    const name = `Session ${String.fromCharCode(65 + (this.counter % 26))}`;
    this.counter += 1;
    const offset = 100 + (this.sessions.size * 28) % 220;
    const panel = new SessionPanel({
      x: offset,
      y: offset,
      title: name,
      onSubmit: (text) => {
        panel.addLine('user', text);
        void this.deps.invoke('claude_submit', { id, text }).catch(() => undefined);
      },
      onFocus: () => {
        this.zTop += 1;
        panel.el.style.zIndex = String(this.zTop);
      },
      onClose: () => this.close(id),
    });
    this.deps.layer.appendChild(panel.el);

    const unlisteners: Array<() => void> = [];
    const wire = <T>(kind: string, handler: (p: T) => void): void => {
      void this.deps.listen<T>(`claude://${id}/${kind}`, handler).then((un) => unlisteners.push(un));
    };
    wire<{ kind: string; text: string }>('stream', (p) => panel.addLine(p.kind, p.text));
    wire<{ name: string; target: string }>('activity', (p) =>
      panel.addLine('action', p.target ? `${p.name}  ${p.target}` : p.name),
    );
    wire<{ text: string; is_error: boolean }>('turn-end', (p) => {
      const text = (p.text ?? '').trim();
      if (text) panel.addLine(p.is_error ? 'output' : 'narration', text);
      this.deps.onDone?.(name, p.is_error);
    });

    this.sessions.set(id, { panel, unlisteners, name });
    return id;
  }

  close(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    for (const un of s.unlisteners) un();
    s.panel.destroy();
    this.sessions.delete(id);
    void this.deps.invoke('claude_stop', { id }).catch(() => undefined);
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }
}
