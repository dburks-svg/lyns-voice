/**
 * DOM wrapper for a single floating terminal window. Matches the FUI aesthetic:
 * glass background, notched corners, neon cyan border, LED header, close button.
 */
import { attachDragResize } from './dragResize';

export interface TerminalPanelOptions {
  id: string;
  title?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  onClose: (id: string) => void;
  onFocus: (id: string) => void;
}

const RESIZE_DIRS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;

export class TerminalPanel {
  readonly el: HTMLElement;
  private cleanup: (() => void) | null = null;

  constructor(opts: TerminalPanelOptions) {
    this.el = document.createElement('div');
    this.el.className = 'terminal-window';
    this.el.style.left = `${opts.x}px`;
    this.el.style.top = `${opts.y}px`;
    this.el.style.width = `${opts.width ?? 520}px`;
    this.el.style.height = `${opts.height ?? 340}px`;

    this.el.innerHTML = `
      <div class="terminal-head">
        <span class="led"></span><span class="led"></span><span class="led"></span>
        <span class="panel-title">${escapeText(opts.title ?? opts.id)}</span>
        <button class="terminal-close" aria-label="Close terminal">×</button>
      </div>
      <div class="terminal-body"></div>
      ${RESIZE_DIRS.map((d) => `<div class="resize-handle rh-${d}" data-dir="${d}"></div>`).join('')}
    `;

    this.el.addEventListener('pointerdown', () => opts.onFocus(opts.id));

    const closeBtn = this.el.querySelector('.terminal-close')!;
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      opts.onClose(opts.id);
    });

    const head = this.el.querySelector<HTMLElement>('.terminal-head')!;
    this.cleanup = attachDragResize({
      el: this.el,
      dragHandle: head,
      onMoveStart: () => opts.onFocus(opts.id),
    });
  }

  getBody(): HTMLElement {
    return this.el.querySelector('.terminal-body')!;
  }

  setTitle(title: string): void {
    const t = this.el.querySelector('.panel-title');
    if (t) t.textContent = title;
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
