import { attachDragResize } from '../terminal/dragResize';

export interface DiffEntry {
  tool: string;
  filePath: string;
  oldString?: string;
  newString?: string;
  content?: string;
}

export interface DiffPanelOptions {
  x: number;
  y: number;
  width?: number;
  height?: number;
  onFocus: () => void;
  onClose: () => void;
}

const RESIZE_DIRS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;

export class DiffPanel {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private cleanup: (() => void) | null = null;

  constructor(opts: DiffPanelOptions) {
    this.el = document.createElement('div');
    this.el.className = 'diff-window';
    this.el.style.left = `${opts.x}px`;
    this.el.style.top = `${opts.y}px`;
    this.el.style.width = `${opts.width ?? 600}px`;
    this.el.style.height = `${opts.height ?? 420}px`;

    this.el.innerHTML = `
      <div class="diff-titlebar">
        <span class="led"></span><span class="led"></span><span class="led"></span>
        <span class="diff-title">Diffs</span>
        <button class="diff-clear" aria-label="Clear diffs">clear</button>
        <button class="diff-close" aria-label="Close diff viewer">×</button>
      </div>
      <div class="diff-body"></div>
      ${RESIZE_DIRS.map((d) => `<div class="resize-handle rh-${d}" data-dir="${d}"></div>`).join('')}
    `;

    this.body = this.el.querySelector('.diff-body')!;

    this.el.addEventListener('pointerdown', () => opts.onFocus());
    this.el.querySelector('.diff-close')!.addEventListener('click', (e) => {
      e.stopPropagation();
      opts.onClose();
    });
    this.el.querySelector('.diff-clear')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.clear();
    });

    const titlebar = this.el.querySelector<HTMLElement>('.diff-titlebar')!;
    this.cleanup = attachDragResize({
      el: this.el,
      dragHandle: titlebar,
      onMoveStart: () => opts.onFocus(),
    });
  }

  addDiff(entry: DiffEntry): void {
    const section = document.createElement('div');
    section.className = 'diff-section';

    const header = document.createElement('div');
    header.className = 'diff-file-header';
    header.textContent = `${entry.tool} ${entry.filePath}`;
    section.appendChild(header);

    if (entry.tool === 'Write' && entry.content) {
      const block = document.createElement('pre');
      block.className = 'diff-block';
      for (const line of entry.content.split('\n')) {
        const row = document.createElement('div');
        row.className = 'diff-line diff-add';
        row.textContent = `+ ${line}`;
        block.appendChild(row);
      }
      section.appendChild(block);
    } else if (entry.oldString != null || entry.newString != null) {
      const block = document.createElement('pre');
      block.className = 'diff-block';
      if (entry.oldString) {
        for (const line of entry.oldString.split('\n')) {
          const row = document.createElement('div');
          row.className = 'diff-line diff-del';
          row.textContent = `- ${line}`;
          block.appendChild(row);
        }
      }
      if (entry.newString) {
        for (const line of entry.newString.split('\n')) {
          const row = document.createElement('div');
          row.className = 'diff-line diff-add';
          row.textContent = `+ ${line}`;
          block.appendChild(row);
        }
      }
      section.appendChild(block);
    }

    this.body.appendChild(section);
    this.body.scrollTop = this.body.scrollHeight;

    const title = this.el.querySelector('.diff-title');
    const count = this.body.querySelectorAll('.diff-section').length;
    if (title) title.textContent = `Diffs (${count})`;
  }

  clear(): void {
    this.body.innerHTML = '';
    const title = this.el.querySelector('.diff-title');
    if (title) title.textContent = 'Diffs';
  }

  destroy(): void {
    this.cleanup?.();
    this.el.remove();
  }
}
