import { describe, it, expect } from 'vitest';
import { computeBands } from '../src/audio/bands';
import { AvatarController, type ControllableAvatar } from '../src/avatar/AvatarController';
import type { DeformationParams } from '../src/avatar/deformation';

function fakeAvatar() {
  const params: DeformationParams = { amplitude: -1, frequency: -1, speed: -1 };
  const scale = { x: 1, y: 1, z: 1 };
  const glow = { value: -1 };
  const avatar: ControllableAvatar = {
    setParams: (next) => Object.assign(params, next),
    setGlow: (v) => {
      glow.value = v;
    },
    setColors: () => undefined,
    idleRotationSpeed: 0,
    mesh: {
      rotation: { x: 0, y: 0, z: 0 },
      scale: {
        set: (x, y, z) => {
          scale.x = x;
          scale.y = y;
          scale.z = z;
        },
      },
    },
  };
  return { avatar, params, scale, glow };
}

describe('computeBands', () => {
  it('returns an empty array for zero bands or empty data', () => {
    expect(computeBands(new Uint8Array([1, 2, 3]), 0)).toHaveLength(0);
    expect(Array.from(computeBands(new Uint8Array(0), 4))).toEqual([0, 0, 0, 0]);
  });

  it('normalizes a full buffer to ~1 across all bands', () => {
    const full = new Uint8Array(64).fill(255);
    const bands = computeBands(full, 4);
    expect(bands).toHaveLength(4);
    for (const v of bands) {
      expect(v).toBeCloseTo(1, 5);
    }
  });

  it('puts low-frequency energy in the low bands (log spacing)', () => {
    const data = new Uint8Array(64);
    for (let i = 0; i < 8; i += 1) {
      data[i] = 255; // energy only in the lowest bins
    }
    const bands = computeBands(data, 4);
    expect(bands[0]).toBeGreaterThan(bands[3]);
    expect(bands[3]).toBeCloseTo(0, 5);
  });
});

describe('AvatarController.setMicBands', () => {
  it('treble adds glow and frequency detail beyond the level-only reaction', () => {
    const a = fakeAvatar();
    const ca = new AvatarController({ avatar: a.avatar });
    ca.setState('listening');
    ca.setMicLevel(0.5); // no bands -> level-only baseline
    ca.tick(0);
    const baselineGlow = a.glow.value;

    const b = fakeAvatar();
    const cb = new AvatarController({ avatar: b.avatar });
    cb.setState('listening');
    cb.setMicBands(new Float32Array([0.5, 0.2, 0.2, 1.0])); // bass 0.5, treble 1.0
    cb.tick(0);

    expect(b.glow.value).toBeGreaterThan(baselineGlow); // treble lifts glow
    expect(b.params.frequency).toBeGreaterThan(1.4); // treble adds ripple detail
    expect(b.scale.y).toBeCloseTo(1 - 0.5 * 0.35); // bass still drives compression
  });

  it('no-bands listening is byte-identical to the original level-only formula', () => {
    const { avatar, params, scale, glow } = fakeAvatar();
    const c = new AvatarController({ avatar });
    c.setState('listening');
    c.setMicLevel(1); // no bands set
    c.tick(0);
    expect(params.amplitude).toBeCloseTo(0.55); // 0.05 + 1 * 0.5
    expect(params.frequency).toBeCloseTo(1.4); // unchanged (treble = 0)
    expect(glow.value).toBeCloseTo(2.0); // 1.2 + 1 * 0.8
    expect(scale.y).toBeCloseTo(0.65); // 1 - 1 * 0.35
  });

  it('clears bands when leaving the listening state', () => {
    const { avatar, params } = fakeAvatar();
    const controller = new AvatarController({ avatar });
    controller.setState('listening');
    controller.setMicBands(new Float32Array([1, 1, 1, 1]));
    controller.setState('idle'); // should drop stale bands
    controller.setState('listening');
    controller.setMicLevel(0); // no fresh bands
    controller.tick(0);
    expect(params.amplitude).toBeCloseTo(0.05); // level-only baseline (bass = 0)
  });
});
