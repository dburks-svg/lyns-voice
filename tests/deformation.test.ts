import { describe, it, expect } from 'vitest';
import { displacement, type DeformationParams } from '../src/avatar/deformation';

const PARAMS: DeformationParams = { amplitude: 0.5, frequency: 1.2, speed: 0.8 };

describe('displacement', () => {
  it('returns exactly 0 when amplitude is 0 (true idle freeze)', () => {
    expect(displacement(1, 2, 3, 0.5, { amplitude: 0, frequency: 1, speed: 1 })).toBe(0);
  });

  it('is bounded by |amplitude|', () => {
    for (let x = -3; x <= 3; x += 0.7) {
      for (let t = 0; t < 5; t += 0.5) {
        const d = displacement(x, x * 0.5, -x, t, PARAMS);
        expect(Math.abs(d)).toBeLessThanOrEqual(PARAMS.amplitude + 1e-9);
      }
    }
  });

  it('is deterministic', () => {
    expect(displacement(1, 1, 1, 2, PARAMS)).toBe(displacement(1, 1, 1, 2, PARAMS));
  });

  it('produces nonzero displacement somewhere in the field', () => {
    let nonzero = false;
    for (let x = -2; x <= 2; x += 0.3) {
      if (Math.abs(displacement(x, 0.1, 0.2, 1.0, PARAMS)) > 1e-6) {
        nonzero = true;
        break;
      }
    }
    expect(nonzero).toBe(true);
  });

  it('evolves over time (animation is alive)', () => {
    const a = displacement(0.5, 0.5, 0.5, 0.0, PARAMS);
    const b = displacement(0.5, 0.5, 0.5, 2.0, PARAMS);
    expect(a).not.toBe(b);
  });
});
