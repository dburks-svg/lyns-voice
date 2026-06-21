import { describe, it, expect, vi } from 'vitest';
import { showProposeCard } from '../src/app/proposeCard';

describe('showProposeCard', () => {
  it('renders the proposal summary as text (injection-safe)', () => {
    const el = showProposeCard({
      summary: 'Split into a frontend and a backend session',
      onApprove: vi.fn(),
      onDecline: vi.fn(),
    });
    expect(el.textContent).toContain('Split into a frontend and a backend session');
    expect(el.querySelector('script')).toBeNull();
    el.remove();
  });

  it('approve fires onApprove and dismisses the card', () => {
    const onApprove = vi.fn();
    const el = showProposeCard({ summary: 's', onApprove, onDecline: vi.fn() });
    el.querySelector<HTMLButtonElement>('.propose-approve')!.click();
    expect(onApprove).toHaveBeenCalledOnce();
    expect(document.body.contains(el)).toBe(false);
  });

  it('decline fires onDecline and dismisses the card', () => {
    const onDecline = vi.fn();
    const el = showProposeCard({ summary: 's', onApprove: vi.fn(), onDecline });
    el.querySelector<HTMLButtonElement>('.propose-decline')!.click();
    expect(onDecline).toHaveBeenCalledOnce();
    expect(document.body.contains(el)).toBe(false);
  });
});
