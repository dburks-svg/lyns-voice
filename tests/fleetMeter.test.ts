import { describe, it, expect } from 'vitest';
import { createFleetMeter } from '../src/integration/fleetMeter';

function els() {
  return { container: document.createElement('span'), value: document.createElement('span') };
}

describe('createFleetMeter', () => {
  it('stays hidden until at least two sessions are live', () => {
    const { container, value } = els();
    const m = createFleetMeter(container, value);
    m.setActive(1);
    expect(container.style.display).toBe('none');
    m.setActive(2);
    expect(container.style.display).toBe('');
  });

  it('accumulates cost across sessions and shows the count', () => {
    const { container, value } = els();
    const m = createFleetMeter(container, value);
    m.setActive(2);
    m.addCost(0.5);
    m.addCost(0.25);
    expect(value.textContent).toContain('$0.7500');
    expect(value.textContent).toContain('· 2');
  });

  it('formats costs over a dollar with two decimals', () => {
    const { container, value } = els();
    const m = createFleetMeter(container, value);
    m.setActive(3);
    m.addCost(2.5);
    expect(value.textContent).toContain('$2.50');
    expect(value.textContent).toContain('· 3');
  });

  it('ignores negative cost deltas', () => {
    const { container, value } = els();
    const m = createFleetMeter(container, value);
    m.setActive(2);
    m.addCost(-5);
    expect(value.textContent).toContain('$0.0000');
  });
});
