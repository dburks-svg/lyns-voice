/**
 * Manages floating terminal windows with tabbed sessions. Each panel can hold
 * multiple terminal tabs. The "+" button on a panel spawns a new tab in the
 * same window; the HUD "+ terminal" button creates a new window.
 */
import { TerminalPanel } from './TerminalPanel';
import { TerminalInstance } from './TerminalInstance';

interface TauriApi {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  listen: (event: string, handler: (e: { payload: unknown }) => void) => Promise<() => void>;
}

interface PanelEntry {
  panel: TerminalPanel;
  instances: Map<string, TerminalInstance>;
}

let nextPanelId = 1;

export class TerminalManager {
  private panels = new Map<string, PanelEntry>();
  private termToPanel = new Map<string, string>();
  private layer: HTMLElement;
  private topZ = 10;
  private cascadeIndex = 0;
  private defaultCwd: (() => string | undefined) | undefined;

  constructor(
    layerEl: HTMLElement,
    private tauri: TauriApi,
    cwdFn?: () => string | undefined,
  ) {
    this.layer = layerEl;
    this.defaultCwd = cwdFn;
  }

  async spawn(cwd?: string, panelId?: string): Promise<string | null> {
    try {
      const id = (await this.tauri.invoke('terminal_spawn', { cwd })) as string;

      let entry = panelId ? this.panels.get(panelId) : undefined;
      if (!entry) {
        const pid = `panel-${nextPanelId++}`;
        const pos = this.nextPosition();
        const panel = new TerminalPanel({
          panelId: pid,
          x: pos.x,
          y: pos.y,
          onCloseTab: (termId) => this.closeTab(termId),
          onAddTab: (p) => {
            const dir = this.defaultCwd?.();
            void this.spawn(dir, p);
          },
          onFocus: (p) => this.bringToFront(p),
        });
        entry = { panel, instances: new Map() };
        this.panels.set(pid, entry);
        this.layer.appendChild(panel.el);
        panelId = pid;
      }

      const title = cwd ? shortenPath(cwd) : 'shell';
      const bodyEl = entry.panel.addTab(id, title);
      const instance = new TerminalInstance(id, bodyEl, this.tauri);
      entry.instances.set(id, instance);
      this.termToPanel.set(id, panelId!);

      this.bringToFront(panelId!);
      instance.focus();
      return id;
    } catch (e) {
      console.error('terminal spawn failed:', e);
      return null;
    }
  }

  closeTab(termId: string): void {
    const panelId = this.termToPanel.get(termId);
    if (!panelId) return;
    const entry = this.panels.get(panelId);
    if (!entry) return;

    const instance = entry.instances.get(termId);
    if (instance) instance.destroy();
    entry.instances.delete(termId);
    this.termToPanel.delete(termId);
    this.tauri.invoke('terminal_kill', { id: termId }).catch(() => {});

    const hasMore = entry.panel.removeTab(termId);
    if (!hasMore) {
      entry.panel.destroy();
      this.panels.delete(panelId);
    }
  }

  closeAll(): void {
    for (const [, entry] of this.panels) {
      for (const [termId, instance] of entry.instances) {
        instance.destroy();
        this.tauri.invoke('terminal_kill', { id: termId }).catch(() => {});
      }
      entry.panel.destroy();
    }
    this.panels.clear();
    this.termToPanel.clear();
  }

  bringToFront(panelId: string): void {
    const entry = this.panels.get(panelId);
    if (!entry) return;
    this.topZ += 1;
    entry.panel.el.style.zIndex = `${this.topZ}`;
    const activeId = entry.panel.getActiveTabId();
    if (activeId) {
      entry.instances.get(activeId)?.focus();
    }
  }

  private nextPosition(): { x: number; y: number } {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 60;
    const cascade = 30;

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
