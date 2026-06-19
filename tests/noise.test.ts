import { describe, it, expect } from 'vitest';
import { perlin3 } from '../src/avatar/noise';

describe('perlin3', () => {
  it('is deterministic for identical inputs', () => {
    expect(perlin3(1.5, -2.3, 0.7)).toBe(perlin3(1.5, -2.3, 0.7));
  });

  it('returns ~0 at integer lattice points', () => {
    const points: ReadonlyArray<readonly [number, number, number]> = [
      [0, 0, 0],
      [1, 2, 3],
      [-4, 5, -6],
    ];
    for (const [x, y, z] of points) {
      expect(Math.abs(perlin3(x, y, z))).toBeLessThan(1e-9);
    }
  });

  it('stays within [-1, 1] across a sampled grid', () => {
    for (let x = -5; x <= 5; x += 0.5) {
      for (let y = -5; y <= 5; y += 0.5) {
        for (let z = -3; z <= 3; z += 0.5) {
          const n = perlin3(x, y, z);
          expect(n).toBeGreaterThanOrEqual(-1);
          expect(n).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('is continuous: a small input change yields a small output change', () => {
    const base = perlin3(0.2, 0.4, 0.6);
    const near = perlin3(0.2001, 0.4, 0.6);
    expect(Math.abs(near - base)).toBeLessThan(0.01);
  });
});
