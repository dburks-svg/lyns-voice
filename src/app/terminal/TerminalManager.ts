/**
 * Manages the collection of floating terminal windows. Owns the terminal-layer
 * DOM element, handles spawn/close/z-index ordering, and positions new windows
 * away from the orb center.
 */
import { TerminalPanel } from './TerminalPanel';
import { TerminalInstance } from './TerminalInstance';

interface TauriApi {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  listen: (event: string, handler: (e: { payload: unknown }) => void) => Promise<() => void>;
}

interface TerminalEntry {
  panel: TerminalPanel;
  instance: TerminalInstance;
}

export class TerminalManager {
  private terminals = new Map<string, TerminalEntry>();
  private layer: HTMLElement;
  private topZ = 10;
  private cascadeIndex = 0;

  constructor(
    layerEl: HTMLElement,
    private tauri: TauriApi,
  ) {
    this.layer = layerEl;
  }

  async spawn(cwd?: string): Promise<string | null> {
    try {
      const id = (await this.tauri.invoke('terminal_spawn', { cwd })) as string;
      const pos = this.nextPosition();

      const panel = new TerminalPanel({
        id,
        title: cwd ? shortenPath(cwd) : 'terminal',
        x: pos.x,
        y: pos.y,
        onClose: (tid) => this.close(tid),
        onFocus: (tid) => this.bringToFront(tid),
      });

      this.layer.appendChild(panel.el);

      const instance = new TerminalInstance(id, panel.getBody(), this.tauri, cwd);
      this.terminals.set(id, { panel, instance });
      this.bringToFront(id);
      instance.focus();

      return id;
    } catch (e) {
      console.error('terminal spawn failed:', e);
      return null;
    }
  }

  close(id: string): void {
    const entry = this.terminals.get(id);
    if (!entry) return;
    entry.instance.destroy();
    entry.panel.destroy();
    this.terminals.delete(id);
    this.tauri.invoke('terminal_kill', { id }).catch(() => {});
  }

  closeAll(): void {
    for (const id of [...this.terminals.keys()]) {
      this.close(id);
    }
  }

  bringToFront(id: string): void {
    const entry = this.terminals.get(id);
    if (!entry) return;
    this.topZ += 1;
    entry.panel.el.style.zIndex = `${this.topZ}`;
    entry.instance.focus();
  }

  get count(): number {
    return this.terminals.size;
  }

  private nextPosition(): { x: number; y: number } {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 60;
    const cascade = 30;

    // Avoid the center 40% (the orb zone). Place in top-left quadrant,
    // cascading each new window.
    const baseX = margin + (this.cascadeIndex * cascade) % (vw * 0.25);
    const baseY = margin + 40 + (this.cascadeIndex * cascade) % (vh * 0.25);
    this.cascadeIndex++;

    return { x: baseX, y: baseY };
  }
}

function shortenPath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length <= 2) return parts.join('/');
  return '.../' + parts.slice(-2).join('/');
}
