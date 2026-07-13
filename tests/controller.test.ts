import { describe, it, expect, vi } from 'vitest';
import { AvatarController, type ControllableAvatar } from '../src/avatar/AvatarController';
import type { DeformationParams } from '../src/avatar/deformation';

function fakeAvatar() {
  const params: DeformationParams = { amplitude: -1, frequency: -1, speed: -1 };
  const scale = { x: 1, y: 1, z: 1 };
  const colors = { rim: -1, core: -1 };
  const state = { glow: -1 };
  const avatar: ControllableAvatar = {
    setParams: (next) => Object.assign(params, next),
    setGlow: (value) => {
      state.glow = value;
    },
    setColors: (rim, core) => {
      colors.rim = rim;
      colors.core = core;
    },
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
  return { avatar, params, scale, colors, state };
}

describe('AvatarController', () => {
  it('starts idle and reports state changes once', () => {
    const { avatar } = fakeAvatar();
    const onStateChange = vi.fn();
    const controller = new AvatarController({ avatar, onStateChange });

    expect(controller.current).toBe('idle');
    controller.setState('listening');
    controller.setState('listening'); // no-op, same state
    expect(controller.current).toBe('listening');
    expect(onStateChange).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenCalledWith('listening');
  });

  it('idle: baseline params, glow, slow rotation, no compression', () => {
    const { avatar, params, scale, state } = fakeAvatar();
    const controller = new AvatarController({ avatar });
    controller.tick(0);
    expect(params.amplitude).toBeCloseTo(0.12);
    expect(state.glow).toBeCloseTo(1.0);
    expect(avatar.idleRotationSpeed).toBeCloseTo(0.15);
    expect(scale).toEqual({ x: 1, y: 1, z: 1 });
  });

  it('listening: mic level raises amplitude/glow and compresses vertically', () => {
    const { avatar, params, scale, state } = fakeAvatar();
    const controller = new AvatarController({ avatar });
    controller.setState('listening');
    controller.setMicLevel(1);
    controller.tick(0);
    expect(params.amplitude).toBeGreaterThan(0.4);
    expect(state.glow).toBeGreaterThan(1.5);
    expect(scale.y).toBeLessThan(1); // vertical compression

    controller.setMicLevel(0);
    controller.tick(0.016);
    expect(scale.y).toBeCloseTo(1);
  });

  it('thinking: fast rotation and animated orbital tilt', () => {
    const { avatar } = fakeAvatar();
    const controller = new AvatarController({ avatar });
    controller.setState('thinking');
    controller.tick(1.0);
    expect(avatar.idleRotationSpeed).toBeCloseTo(0.6);
    expect(Math.abs(avatar.mesh.rotation.x)).toBeGreaterThan(0); // orbital wobble
  });

  it('speaking: a word impulse spikes amplitude/glow, then decays over time', () => {
    const { avatar, params, state } = fakeAvatar();
    const controller = new AvatarController({ avatar });
    controller.setState('speaking');
    controller.pulse(1);

    controller.tick(0);
    const spikedAmplitude = params.amplitude;
    const spikedGlow = state.glow;
    expect(spikedAmplitude).toBeGreaterThan(0.6);
    expect(spikedGlow).toBeGreaterThan(2.5);

    controller.tick(1.0); // 1s later: impulse fully decayed
    expect(params.amplitude).toBeLessThan(spikedAmplitude);
    expect(params.amplitude).toBeCloseTo(0.12, 2);
    expect(state.glow).toBeCloseTo(1.8, 2);
  });

  it('clears the speaking impulse when leaving the speaking state', () => {
    const { avatar, params } = fakeAvatar();
    const controller = new AvatarController({ avatar });
    controller.setState('speaking');
    controller.pulse(1);
    controller.setState('idle');
    controller.setState('speaking');
    controller.tick(0);
    expect(params.amplitude).toBeCloseTo(0.12); // impulse was reset
  });

  it('clamps out-of-range mic levels', () => {
    const { avatar, scale } = fakeAvatar();
    const controller = new AvatarController({ avatar });
    controller.setState('listening');
    controller.setMicLevel(5); // clamped to 1
    controller.tick(0);
    expect(scale.y).toBeGreaterThanOrEqual(0);
    controller.setMicLevel(Number.NaN); // treated as 0
    controller.tick(0.016);
    expect(scale.y).toBeCloseTo(1);
  });

  it('idle shifts to a dark navy/slate spectrum; active states brighten (spec section 4)', () => {
    const { avatar, colors } = fakeAvatar();
    const controller = new AvatarController({ avatar });

    controller.tick(0); // idle
    const idleCore = colors.core;

    controller.setState('listening');
    controller.tick(0.016);
    const listeningCore = colors.core;

    const luminance = (hex: number): number =>
      0.299 * ((hex >> 16) & 255) + 0.587 * ((hex >> 8) & 255) + 0.114 * (hex & 255);
    // Idle core is visibly darker (navy/slate) than the neon listening core.
    expect(luminance(idleCore)).toBeLessThan(luminance(listeningCore));
    expect(idleCore).toBe(0x0a1530);
    expect(listeningCore).toBe(0x0077ff);
  });

  it('speaking impulse saturates at 1 and ignores NaN pulses', () => {
    const { avatar, params } = fakeAvatar();
    const controller = new AvatarController({ avatar });
    controller.setState('speaking');

    controller.pulse(1);
    controller.pulse(1); // accumulation clamped to 1
    controller.tick(0);
    const saturated = params.amplitude;
    expect(saturated).toBeCloseTo(0.12 + 0.6); // single-spike maximum, not doubled

    controller.pulse(Number.NaN); // ignored
    controller.tick(0);
    expect(params.amplitude).toBeLessThanOrEqual(saturated);
  });
});
