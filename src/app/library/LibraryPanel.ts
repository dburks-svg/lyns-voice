/**
 * The Library: the user's Claude Code world as Q sees it - their user-scope MCP
 * servers (`~/.claude.json`) and their hooks (user/project/local settings files),
 * each toggleable with a click. Everything is ENABLED by default - the terminal
 * configuration is the consent boundary, and Q is an orchestrator of that world,
 * not a gate - so a toggle here is an off switch, persisted and applied to
 * sessions started afterwards.
 *
 * Reuses the diff viewer's floating-window chrome (`diff-window` classes: glass,
 * notch, drag/resize handles); library.css adds only the row styles. All user
 * data (names, matchers, commands) is rendered with textContent (never innerHTML).
 */
import { attachDragResize } from '../terminal/dragResize';

/** One configured hook, flattened by the Rust side (library_list_hooks). */
export interface HookEntry {
  scope: string;
  event: string;
  matcher: string;
  command: string;
  id: string;
}

export interface LibraryPanelOptions {
  x: number;
  y: number;
  width?: number;
  height?: number;
  /** Registered user-scope MCP server names (from the `library_list_mcp` command). */
  servers: string[];
  /** Names currently disabled (persisted in settings by the host). */
  disabled: ReadonlySet<string>;
  onToggle: (name: string, enabled: boolean) => void;
  /** Configured hooks (from the `library_list_hooks` command). */
  hooks: HookEntry[];
  /** Hook ids currently disabled (persisted in settings by the host). */
  disabledHooks: ReadonlySet<string>;
  onToggleHook: (id: string, enabled: boolean) => void;
  onFocus: () => void;
  onClose: () => void;
}

const RESIZE_DIRS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;

/**
 * A hook command shortened for display: every path-looking token is reduced to
 * its basename ("bun C:/Users/you/.claude/hooks/notify.ts --quiet" -> "bun
 * notify.ts --quiet"). The name is what identifies a hook; the full command
 * stays in the row's hover title, and the disable id still hashes the full
 * command on the Rust side. Exported for tests.
 */
export function shortCommand(command: string): string {
  return command
    .split(/\s+/)
    .map((token) => {
      const cut = Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\'));
      return cut >= 0 ? token.slice(cut + 1) : token;
    })
    .filter((t) => t.length > 0)
    .join(' ');
}

export class LibraryPanel {
  readonly el: HTMLElement;
  private cleanup: (() => void) | null = null;

  constructor(opts: LibraryPanelOptions) {
    this.el = document.createElement('div');
    this.el.className = 'diff-window library-window';
    this.el.style.left = `${opts.x}px`;
    this.el.style.top = `${opts.y}px`;
    this.el.style.width = `${opts.width ?? 420}px`;
    this.el.style.height = `${opts.height ?? 360}px`;

    this.el.innerHTML = `
      <div class="diff-titlebar">
        <span class="led"></span><span class="led"></span><span class="led"></span>
        <span class="diff-title">Library</span>
        <button class="diff-close" aria-label="Close library">×</button>
      </div>
      <div class="library-body">
        <div class="library-section-title">MCP servers</div>
        <div class="library-rows"></div>
        <div class="library-section-title library-hooks-title">Hooks</div>
        <div class="library-hook-rows"></div>
        <div class="library-note">from your Claude Code configuration - changes apply to new sessions</div>
      </div>
      ${RESIZE_DIRS.map((d) => `<div class="resize-handle rh-${d}" data-dir="${d}"></div>`).join('')}
    `;

    const rows = this.el.querySelector<HTMLElement>('.library-rows')!;
    if (opts.servers.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'library-empty';
      empty.textContent = 'no MCP servers registered (add them with `claude mcp add`)';
      rows.appendChild(empty);
    }
    for (const name of opts.servers) {
      const row = document.createElement('label');
      row.className = 'library-row';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !opts.disabled.has(name);
      box.addEventListener('change', () => opts.onToggle(name, box.checked));
      const label = document.createElement('span');
      label.className = 'library-name';
      label.textContent = name; // user data: textContent only
      row.append(box, label);
      rows.appendChild(row);
    }

    const hookRows = this.el.querySelector<HTMLElement>('.library-hook-rows')!;
    if (opts.hooks.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'library-empty';
      empty.textContent = 'no hooks configured';
      hookRows.appendChild(empty);
    }
    for (const hook of opts.hooks) {
      const row = document.createElement('label');
      row.className = 'library-row';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !opts.disabledHooks.has(hook.id);
      box.addEventListener('change', () => opts.onToggleHook(hook.id, box.checked));
      const label = document.createElement('span');
      label.className = 'library-name';
      // e.g. "PreToolUse [Bash|Edit] lint.cmd (user)" - all textContent, truncated by
      // CSS; paths shortened to basenames (the name identifies the hook, and full
      // local paths do not belong on screen). Hover shows the complete command.
      const matcher = hook.matcher ? ` [${hook.matcher}]` : '';
      label.textContent = `${hook.event}${matcher} ${shortCommand(hook.command)} (${hook.scope})`;
      label.title = hook.command;
      row.append(box, label);
      hookRows.appendChild(row);
    }

    this.el.addEventListener('pointerdown', () => opts.onFocus());
    this.el.querySelector('.diff-close')!.addEventListener('click', (e) => {
      e.stopPropagation();
      opts.onClose();
    });

    const titlebar = this.el.querySelector<HTMLElement>('.diff-titlebar')!;
    this.cleanup = attachDragResize({
      el: this.el,
      dragHandle: titlebar,
      onMoveStart: () => opts.onFocus(),
    });
  }

  destroy(): void {
    this.cleanup?.();
    this.cleanup = null;
    this.el.remove();
  }
}
