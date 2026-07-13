/**
 * DOM wrapper for a floating terminal window with tabbed sessions. Each panel
 * can hold multiple terminal tabs; clicking a tab switches the visible session.
 * A "+" button spawns a new tab in the same window. Closing the last tab
 * destroys the panel.
 */
import { attachDragResize } from './dragResize';

export interface TerminalPanelOptions {
  panelId: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  onCloseTab: (termId: string) => void;
  onAddTab: (panelId: string) => void;
  onFocus: (panelId: string) => void;
}

const RESIZE_DIRS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;

export class TerminalPanel {
  readonly el: HTMLElement;
  private tabList: HTMLElement;
  private contentArea: HTMLElement;
  private tabs = new Map<string, { tabEl: HTMLElement; bodyEl: HTMLElement }>();
  private activeTabId: string | null = null;
  private cleanup: (() => void) | null = null;

  constructor(private opts: TerminalPanelOptions) {
    this.el = document.createElement('div');
    this.el.className = 'terminal-window';
    this.el.style.left = `${opts.x}px`;
    this.el.style.top = `${opts.y}px`;
    this.el.style.width = `${opts.width ?? 520}px`;
    this.el.style.height = `${opts.height ?? 340}px`;

    this.el.innerHTML = `
      <div class="terminal-tabs">
        <span class="led"></span><span class="led"></span><span class="led"></span>
        <div class="tab-list"></div>
        <button class="tab-add" aria-label="New tab">+</button>
      </div>
      <div class="terminal-content"></div>
      ${RESIZE_DIRS.map((d) => `<div class="resize-handle rh-${d}" data-dir="${d}"></div>`).join('')}
    `;

    this.tabList = this.el.querySelector('.tab-list')!;
    this.contentArea = this.el.querySelector('.terminal-content')!;

    this.el.addEventListener('pointerdown', () => opts.onFocus(opts.panelId));

    this.el.querySelector('.tab-add')!.addEventListener('click', (e) => {
      e.stopPropagation();
      opts.onAddTab(opts.panelId);
    });

    const tabBar = this.el.querySelector<HTMLElement>('.terminal-tabs')!;
    this.cleanup = attachDragResize({
      el: this.el,
      dragHandle: tabBar,
      onMoveStart: () => opts.onFocus(opts.panelId),
    });
  }

  addTab(id: string, title: string): HTMLElement {
    const tabEl = document.createElement('button');
    tabEl.className = 'tab';
    tabEl.dataset.termId = id;
    tabEl.innerHTML =
      `<span class="tab-title">${escapeText(title)}</span>` +
      `<span class="tab-close" aria-label="Close tab">×</span>`;

    tabEl.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('.tab-close')) {
        e.stopPropagation();
        this.opts.onCloseTab(id);
      } else {
        this.setActiveTab(id);
      }
    });

    const bodyEl = document.createElement('div');
    bodyEl.className = 'terminal-body';
    bodyEl.style.display = 'none';

    this.tabList.appendChild(tabEl);
    this.contentArea.appendChild(bodyEl);
    this.tabs.set(id, { tabEl, bodyEl });

    this.setActiveTab(id);
    return bodyEl;
  }

  removeTab(id: string): boolean {
    const tab = this.tabs.get(id);
    if (!tab) return true;
    tab.tabEl.remove();
    tab.bodyEl.remove();
    this.tabs.delete(id);

    if (this.activeTabId === id) {
      const remaining = [...this.tabs.keys()];
      if (remaining.length > 0) {
        this.setActiveTab(remaining[remaining.length - 1]);
      } else {
        this.activeTabId = null;
        return false;
      }
    }
    return true;
  }

  setActiveTab(id: string): void {
    for (const [tabId, { tabEl, bodyEl }] of this.tabs) {
      const active = tabId === id;
      tabEl.classList.toggle('active', active);
      bodyEl.style.display = active ? '' : 'none';
    }
    this.activeTabId = id;
  }

  getActiveTabId(): string | null {
    return this.activeTabId;
  }

  get tabCount(): number {
    return this.tabs.size;
  }

  destroy(): void {
    this.cleanup?.();
    this.el.remove();
  }
}

function escapeText(s: string): string {
  const d = document.createElement('span');
  d.textContent = s;
  return d.innerHTML;
}
