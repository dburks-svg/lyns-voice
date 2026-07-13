/**
 * Wraps a single xterm.js Terminal wired to a REAL ConPTY shell (the user's
 * escape-hatch terminal). Raw mode: keystrokes go straight to the PTY via
 * `terminal_write`, the shell echoes them and renders its own prompt + ANSI, and
 * output bytes arrive on `terminal://{id}/output`. Resizes are forwarded to the
 * PTY (`terminal_resize`) so the shell reflows. No faked prompt or local echo.
 */
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { detectGpu } from '../../avatar/gpu';

/** Decode the base64 the Rust side emits back into raw PTY bytes. */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

interface TauriEvent<T> {
  payload: T;
}

type UnlistenFn = () => void;

interface TauriApi {
  listen: (event: string, handler: (e: TauriEvent<unknown>) => void) => Promise<UnlistenFn>;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

export class TerminalInstance {
  readonly term: Terminal;
  private fitAddon: FitAddon;
  private unlisteners: UnlistenFn[] = [];
  private resizeObserver: ResizeObserver | null = null;
  private destroyed = false;

  constructor(
    readonly id: string,
    container: HTMLElement,
    private tauri: TauriApi,
  ) {
    this.term = new Terminal({
      fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
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

    // GPU-render the terminal where a real GPU exists: the DOM renderer relayouts
    // per write and dominates fast-scroll cost. Software WebGL (SwiftShader/WARP)
    // would burn CPU instead, so those machines keep the DOM renderer (same probe
    // the orb's lite mode uses). On context loss xterm falls back to the DOM
    // renderer once the addon is disposed.
    if (!detectGpu().software) {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        this.term.loadAddon(webgl);
      } catch (e) {
        console.warn('[terminal] WebGL renderer unavailable, using the DOM renderer', e);
      }
    }

    requestAnimationFrame(() => {
      if (this.destroyed) return;
      this.fitAddon.fit();
      this.sendResize();
    });

    // Raw keystrokes straight to the PTY; the shell echoes them back as output.
    this.term.onData((data: string) => {
      void this.tauri.invoke('terminal_write', { id: this.id, data }).catch(() => undefined);
    });

    void this.wireEvents();

    this.resizeObserver = new ResizeObserver(() => {
      if (this.destroyed) return;
      this.fitAddon.fit();
      this.sendResize();
    });
    this.resizeObserver.observe(container);
  }

  private sendResize(): void {
    void this.tauri
      .invoke('terminal_resize', { id: this.id, cols: this.term.cols, rows: this.term.rows })
      .catch(() => undefined);
  }

  private async wireEvents(): Promise<void> {
    const onOutput = await this.tauri.listen(
      `terminal://${this.id}/output`,
      (e: TauriEvent<unknown>) => {
        // Batched raw PTY bytes, base64-encoded on the Rust side (see terminal.rs).
        const payload = e.payload as { data?: string };
        if (payload.data) this.term.write(base64ToBytes(payload.data));
      },
    );
    this.unlisteners.push(onOutput);

    const onExit = await this.tauri.listen(`terminal://${this.id}/exit`, () => {
      this.term.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n');
    });
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
