/**
 * Background multi-session: spawn and manage several Claude Code sessions in
 * parallel, each in its own SessionPanel. The backend already keys sessions by id
 * (claude://{id}/*), so this is purely additive - it does NOT touch the primary,
 * voice-driven session (the orb/mic/TTS). Background sessions are watched and typed
 * into via their panels, and announce (a callback) when a turn ends.
 *
 * The conductor (the primary voice session) can also spawn and steer workers itself via
 * markers in its reply (`spawn`/`tell`), wired through `onConductorSpawn`/`onConductorTell`.
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
  /** Forward each worker session's per-turn usage (cost) for the fleet meter. */
  onUsage?: (usage: { cost_usd: number }) => void;
  /** Live worker count changed (spawn/close), for the fleet meter. */
  onCountChange?: (count: number) => void;
}

interface ManagedSession {
  id: string;
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

  /**
   * Spawn a worker session. With no opts it uses the UI defaults + an auto-name (the Alt+N
   * path); the conductor passes a name/dir/task (the `<<spawn:...>>` path). Returns the id,
   * or null if no project dir is available.
   */
  async spawn(opts?: {
    name?: string;
    dir?: string;
    model?: string;
    effort?: string;
    task?: string;
  }): Promise<string | null> {
    const d = this.deps.defaults();
    const dir = opts?.dir?.trim() || d.dir;
    if (!dir) return null;
    const args: Record<string, unknown> = { dir };
    const model = opts?.model ?? d.model;
    const effort = opts?.effort ?? d.effort;
    if (model) args.model = model;
    if (effort) args.effort = effort;

    let id: string;
    try {
      id = await this.deps.invoke<string>('claude_start', args);
    } catch {
      return null;
    }

    const name = opts?.name?.trim() || `Session ${String.fromCharCode(65 + (this.counter % 26))}`;
    this.counter += 1;
    // Cascade new windows far enough that each is clearly its own panel, not stacked on
    // the last (the conductor can open several at once).
    const offset = 80 + ((this.sessions.size * 44) % 308);
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
    wire<{ cost_usd: number }>('usage', (p) => this.deps.onUsage?.(p));

    this.sessions.set(id, { id, panel, unlisteners, name });
    this.deps.onCountChange?.(this.sessions.size);

    // The conductor can hand a worker its opening task at spawn (claude_start resolves only
    // once the child's stdin is ready, so this submit lands).
    if (opts?.task) {
      panel.addLine('user', opts.task);
      void this.deps.invoke('claude_submit', { id, text: opts.task }).catch(() => undefined);
    }
    return id;
  }

  /** Relay a message to the worker with the given name (case-insensitive). Returns found. */
  tell(name: string, message: string): boolean {
    const target = name.trim().toLowerCase();
    for (const [id, s] of this.sessions) {
      if (s.name.toLowerCase() === target) {
        s.panel.addLine('user', message);
        void this.deps.invoke('claude_submit', { id, text: message }).catch(() => undefined);
        return true;
      }
    }
    return false;
  }

  close(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    for (const un of s.unlisteners) un();
    s.panel.destroy();
    this.sessions.delete(id);
    this.deps.onCountChange?.(this.sessions.size);
    void this.deps.invoke('claude_stop', { id }).catch(() => undefined);
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }
}
