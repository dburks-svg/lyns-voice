import { describe, it, expect, vi } from 'vitest';
import { LibraryPanel, shortCommand } from '../src/app/library/LibraryPanel';

// The hook rows show names, not local paths (paths leak usernames on screen and
// add nothing: the name identifies the hook; the full command lives in the hover).
describe('shortCommand', () => {
  it('reduces path tokens to basenames and keeps args', () => {
    expect(shortCommand('bun C:/Users/someone/.claude/hooks/notify.ts --quiet')).toBe(
      'bun notify.ts --quiet',
    );
    expect(shortCommand('C:\\tools\\lint.cmd')).toBe('lint.cmd');
    expect(shortCommand('/usr/local/bin/format --check')).toBe('format --check');
  });

  it('passes plain commands through', () => {
    expect(shortCommand('npm test')).toBe('npm test');
    expect(shortCommand('echo done')).toBe('echo done');
  });
});

function mount(opts?: Partial<ConstructorParameters<typeof LibraryPanel>[0]>) {
  const onToggle = vi.fn();
  const onToggleHook = vi.fn();
  const panel = new LibraryPanel({
    x: 10,
    y: 10,
    servers: ['wisdom', 'github'],
    disabled: new Set<string>(),
    onToggle,
    hooks: [],
    disabledHooks: new Set<string>(),
    onToggleHook,
    onFocus: () => {},
    onClose: () => {},
    ...opts,
  });
  document.body.appendChild(panel.el);
  return { panel, onToggle, onToggleHook };
}

describe('LibraryPanel', () => {
  it('renders one checked row per registered MCP server', () => {
    const { panel } = mount();
    const rows = panel.el.querySelectorAll('.library-row');
    expect(rows.length).toBe(2);
    const names = [...panel.el.querySelectorAll('.library-name')].map((n) => n.textContent);
    expect(names).toEqual(['wisdom', 'github']);
    for (const box of panel.el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
      expect(box.checked).toBe(true); // everything enabled by default
    }
    panel.destroy();
  });

  it('unchecks rows for disabled servers and reports toggles', () => {
    const { panel, onToggle } = mount({ disabled: new Set(['github']) });
    const boxes = panel.el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(boxes[0].checked).toBe(true); // wisdom
    expect(boxes[1].checked).toBe(false); // github (disabled)
    boxes[0].checked = false;
    boxes[0].dispatchEvent(new Event('change'));
    expect(onToggle).toHaveBeenCalledWith('wisdom', false);
    panel.destroy();
  });

  it('shows the empty hint when nothing is registered', () => {
    const { panel } = mount({ servers: [] });
    expect(panel.el.querySelector('.library-empty')?.textContent).toContain('no MCP servers');
    panel.destroy();
  });

  it('lists hooks with scope/event context and reports hook toggles by id', () => {
    const { panel, onToggleHook } = mount({
      servers: [],
      hooks: [
        { scope: 'user', event: 'PreToolUse', matcher: 'Bash', command: 'lint.cmd', id: 'aaa' },
        { scope: 'project', event: 'SessionStart', matcher: '', command: 'hello.cmd', id: 'bbb' },
      ],
      disabledHooks: new Set(['bbb']),
    });
    const rows = panel.el.querySelectorAll('.library-hook-rows .library-row');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('PreToolUse [Bash] lint.cmd (user)');
    expect(rows[1].textContent).toContain('SessionStart hello.cmd (project)');
    const boxes = panel.el.querySelectorAll<HTMLInputElement>(
      '.library-hook-rows input[type="checkbox"]',
    );
    expect(boxes[0].checked).toBe(true);
    expect(boxes[1].checked).toBe(false); // disabled by id
    boxes[0].checked = false;
    boxes[0].dispatchEvent(new Event('change'));
    expect(onToggleHook).toHaveBeenCalledWith('aaa', false);
    panel.destroy();
  });

  it('renders a server name as text, never markup', () => {
    const { panel } = mount({ servers: ['<img src=x onerror=alert(1)>'] });
    expect(panel.el.querySelector('img')).toBeNull();
    expect(panel.el.querySelector('.library-name')?.textContent).toContain('<img');
    panel.destroy();
  });
});
