/**
 * Wraps a single xterm.js Terminal wired to a Tauri-spawned shell session.
 *
 * Without a PTY the shell has no prompt and no echo, so this class provides
 * local echo, line buffering, and a synthetic prompt. Keystrokes are collected
 * locally; on Enter the complete line is sent to the Rust backend which pipes
 * it to cmd.exe. Output comes back via Tauri events.
 */
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface TauriEvent<T> {
  payload: T;
}

type UnlistenFn = () => void;

interface TauriApi {
  listen: (event: string, handler: (e: TauriEvent<unknown>) => void) => Promise<UnlistenFn>;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

const PROMPT = '\x1b[36m>\x1b[0m ';

export class TerminalInstance {
  readonly term: Terminal;
  private fitAddon: FitAddon;
  private unlisteners: UnlistenFn[] = [];
  private resizeObserver: ResizeObserver | null = null;
  private destroyed = false;
  private lineBuffer = '';
  private promptWritten = false;
  private promptTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly id: string,
    container: HTMLElement,
    private tauri: TauriApi,
    cwd?: string,
  ) {
    this.term = new Terminal({
      fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.3,
      cursorBlink: true,
      cursorStyle: 'bar',
      theme: {
        background: '#05070b',
        foreground: '#aee7ff',
        cursor: '#00f0ff',
        selectionBackground: 'rgba(0, 240, 255, 0.18)',
        black: '#0a0e14',
        red: '#ff5a7a',
        green: '#4dffc3',
        yellow: '#ffe06b',
        blue: '#00a0ff',
        magenta: '#c89aff',
        cyan: '#00f0ff',
        white: '#cfe9f5',
        brightBlack: '#4a5568',
        brightRed: '#ff8aa0',
        brightGreen: '#7fffdb',
        brightYellow: '#fff0a0',
        brightBlue: '#33c4ff',
        brightMagenta: '#dab8ff',
        brightCyan: '#66f5ff',
        brightWhite: '#eafaff',
      },
      scrollback: 5000,
    });

    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.open(container);

    requestAnimationFrame(() => {
      if (!this.destroyed) this.fitAddon.fit();
    });

    this.term.write(`\x1b[90m[${cwd ?? 'shell'}]\x1b[0m\r\n`);
    this.writePrompt();

    this.term.onData((data: string) => this.handleInput(data));

    this.wireEvents();

    this.resizeObserver = new ResizeObserver(() => {
      if (!this.destroyed) this.fitAddon.fit();
    });
    this.resizeObserver.observe(container);
  }

  private handleInput(data: string): void {
    for (const ch of data) {
      if (ch === '\r') {
        this.term.write('\r\n');
        const line = this.lineBuffer;
        this.lineBuffer = '';
        this.promptWritten = false;
        if (line.length > 0) {
          this.tauri
            .invoke('terminal_write', { id: this.id, data: line + '\r\n' })
            .catch(() => {
              this.term.write('\x1b[31m[send failed]\x1b[0m\r\n');
              this.writePrompt();
            });
        } else {
          this.writePrompt();
        }
      } else if (ch === '\x7f' || ch === '\b') {
        if (this.lineBuffer.length > 0) {
          this.lineBuffer = this.lineBuffer.slice(0, -1);
          this.term.write('\b \b');
        }
      } else if (ch === '\x03') {
        this.lineBuffer = '';
        this.term.write('^C\r\n');
        this.writePrompt();
      } else if (ch >= ' ') {
        this.lineBuffer += ch;
        this.term.write(ch);
      }
    }
  }

  private writePrompt(): void {
    if (!this.promptWritten) {
      this.term.write(PROMPT);
      this.promptWritten = true;
    }
  }

  private schedulePrompt(): void {
    if (this.promptTimer) clearTimeout(this.promptTimer);
    this.promptTimer = setTimeout(() => {
      this.promptWritten = false;
      this.writePrompt();
    }, 150);
  }

  private async wireEvents(): Promise<void> {
    const onOutput = await this.tauri.listen(
      `terminal://${this.id}/output`,
      (e: TauriEvent<unknown>) => {
        const payload = e.payload as { data?: string };
        if (payload.data != null) {
          this.term.write(payload.data + '\r\n');
        }
        this.schedulePrompt();
      },
    );
    this.unlisteners.push(onOutput);

    const onExit = await this.tauri.listen(
      `terminal://${this.id}/exit`,
      () => {
        this.term.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n');
      },
    );
    this.unlisteners.push(onExit);
  }

  focus(): void {
    this.term.focus();
  }

  destroy(): void {
    this.destroyed = true;
    this.resizeObserver?.disconnect();
    this.unlisteners.forEach((fn) => fn());
    this.term.dispose();
  }
}
