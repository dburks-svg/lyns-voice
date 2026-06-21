import { describe, it, expect, vi } from 'vitest';
import { SessionPanel } from '../src/app/session/SessionPanel';

function make() {
  const onSubmit = vi.fn();
  const panel = new SessionPanel({ x: 0, y: 0, onSubmit, onFocus: vi.fn(), onClose: vi.fn() });
  document.body.appendChild(panel.el);
  return { panel, onSubmit };
}

describe('SessionPanel', () => {
  it('renders stream lines with a kind class and stays XSS-safe (textContent)', () => {
    const { panel } = make();
    panel.addLine('narration', 'Reading the parser...');
    panel.addLine('action', 'Read src/a.ts');
    const lines = panel.el.querySelectorAll('.session-stream .s-line');
    expect(lines.length).toBe(2);
    expect(lines[0].classList.contains('s-narration')).toBe(true);
    expect(lines[1].classList.contains('s-action')).toBe(true);

    // Streamed model/tool text is rendered as text, never parsed as markup.
    panel.addLine('output', '<img src=x onerror=alert(1)>');
    const last = panel.el.querySelectorAll('.s-line')[2];
    expect(last.querySelector('img')).toBeNull();
    expect(last.textContent).toContain('<img');
    panel.destroy();
  });

  it('submits on Enter and clears the field', () => {
    const { panel, onSubmit } = make();
    const input = panel.el.querySelector<HTMLTextAreaElement>('.session-input')!;
    input.value = '  refactor the parser  ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(onSubmit).toHaveBeenCalledWith('refactor the parser');
    expect(input.value).toBe('');
    panel.destroy();
  });

  it('Shift+Enter does not submit (newline for multi-line compose)', () => {
    const { panel, onSubmit } = make();
    const input = panel.el.querySelector<HTMLTextAreaElement>('.session-input')!;
    input.value = 'line one';
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }),
    );
    expect(onSubmit).not.toHaveBeenCalled();
    panel.destroy();
  });

  it('ignores an empty Enter', () => {
    const { panel, onSubmit } = make();
    const input = panel.el.querySelector<HTMLTextAreaElement>('.session-input')!;
    input.value = '   ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(onSubmit).not.toHaveBeenCalled();
    panel.destroy();
  });

  it('appendToInput stages a file reference for attach', () => {
    const { panel } = make();
    const input = panel.el.querySelector<HTMLTextAreaElement>('.session-input')!;
    panel.appendToInput('see C:/x/plan.md');
    expect(input.value).toContain('plan.md');
    panel.destroy();
  });

  it('caps retained lines so the DOM cannot grow unbounded', () => {
    const { panel } = make();
    for (let i = 0; i < 520; i += 1) panel.addLine('narration', `line ${i}`);
    expect(panel.el.querySelectorAll('.s-line').length).toBeLessThanOrEqual(500);
    panel.destroy();
  });
});
