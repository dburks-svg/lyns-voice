/**
 * A floating panel that shows ONE Claude session as a terminal: the live stream
 * (assistant narration, the tools it runs, and command output) scrolling by, plus
 * a text input so the session can be driven by keyboard as a co-equal to voice.
 *
 * Modeled on DiffPanel (single body + titlebar + drag/resize). All rendered text
 * uses `textContent`, never innerHTML, so streamed model/tool text cannot inject
 * markup. The panel is dumb: it renders what it is handed and reports input via
 * callbacks; the adapter owns the session and the submit path.
 */
import { attachDragResize } from '../terminal/dragResize';

export interface SessionPanelOptions {
  x: number;
  y: number;
  width?: number;
  height?: number;
  title?: string;
  /** Typed input submitted (Enter). */
  onSubmit: (text: string) => void;
  onFocus: () => void;
  onClose: () => void;
}

const RESIZE_DIRS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;
/** Cap retained stream lines so a long session cannot grow the DOM unbounded. */
const MAX_LINES = 500;

export class SessionPanel {
  readonly el: HTMLElement;
  private streamBody: HTMLElement;
  private input: HTMLInputElement;
  private cleanup: (() => void) | null = null;

  constructor(opts: SessionPanelOptions) {
    this.el = document.createElement('div');
    this.el.className = 'session-window';
    this.el.style.left = `${opts.x}px`;
    this.el.style.top = `${opts.y}px`;
    this.el.style.width = `${opts.width ?? 560}px`;
    this.el.style.height = `${opts.height ?? 420}px`;

    this.el.innerHTML = `
      <div class="session-titlebar">
        <span class="led"></span><span class="led"></span><span class="led"></span>
        <span class="session-title"></span>
        <button class="session-close" aria-label="Close session view">×</button>
      </div>
      <div class="session-stream"></div>
      <form class="session-inputbar">
        <input class="session-input" type="text" autocomplete="off" spellcheck="false"
               placeholder="Type to Q  (Enter to send)" aria-label="Message to Q" />
      </form>
      ${RESIZE_DIRS.map((d) => `<div class="resize-handle rh-${d}" data-dir="${d}"></div>`).join('')}
    `;

    this.streamBody = this.el.querySelector('.session-stream')!;
    this.input = this.el.querySelector('.session-input')!;
    this.el.querySelector('.session-title')!.textContent = opts.title ?? 'Session';

    this.el.addEventListener('pointerdown', () => opts.onFocus());
    this.el.querySelector('.session-close')!.addEventListener('click', (e) => {
      e.stopPropagation();
      opts.onClose();
    });

    const form = this.el.querySelector<HTMLFormElement>('.session-inputbar')!;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = this.input.value.trim();
      if (text) {
        opts.onSubmit(text);
        this.input.value = '';
      }
    });

    const titlebar = this.el.querySelector<HTMLElement>('.session-titlebar')!;
    this.cleanup = attachDragResize({
      el: this.el,
      dragHandle: titlebar,
      onMoveStart: () => opts.onFocus(),
    });
  }

  /** Append a stream line. `kind` is narration | action | output | user (styled in CSS). */
  addLine(kind: string, text: string): void {
    const body = this.streamBody;
    // Keep following the tail only if the user was already near the bottom, so
    // scrolling up to read does not get yanked back down by new output.
    const nearBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 24;
    const line = document.createElement('div');
    line.className = `s-line s-${kind}`;
    line.textContent = text;
    body.appendChild(line);
    while (body.childElementCount > MAX_LINES && body.firstElementChild) {
      body.removeChild(body.firstElementChild);
    }
    if (nearBottom) body.scrollTop = body.scrollHeight;
  }

  destroy(): void {
    this.cleanup?.();
    this.el.remove();
  }
}
