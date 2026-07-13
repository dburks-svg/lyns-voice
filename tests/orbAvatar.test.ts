import { describe, it, expect } from 'vitest';
import {
  activityFromSpeed,
  paletteFromColors,
  themeToPalette,
  OrbAvatar,
} from '../src/avatar/OrbAvatar';
import { THEME_PALETTES } from '../src/config/config';

describe('activityFromSpeed (controller speed -> orb state bridge)', () => {
  it('maps each per-state speed to its activity', () => {
    expect(activityFromSpeed(0.5)).toBe('idle'); // ORB idle speed
    expect(activityFromSpeed(0.9)).toBe('listening'); // listening speed
    expect(activityFromSpeed(1.2)).toBe('speaking'); // speaking speed
    expect(activityFromSpeed(2.5)).toBe('thinking'); // thinking speed
  });

  it('places the thresholds between the state speeds', () => {
    expect(activityFromSpeed(0.69)).toBe('idle');
    expect(activityFromSpeed(0.7)).toBe('listening');
    expect(activityFromSpeed(1.04)).toBe('listening');
    expect(activityFromSpeed(1.05)).toBe('speaking');
    expect(activityFromSpeed(1.59)).toBe('speaking');
    expect(activityFromSpeed(1.6)).toBe('thinking');
  });
});

describe('paletteFromColors', () => {
  it('keeps rim as primary and core as secondary, brightening the hot center', () => {
    const rim = 0x66ccff;
    const core = 0x223344;
    const p = paletteFromColors(rim, core);
    expect(p.primary).toBe(rim);
    expect(p.secondary).toBe(core);
    expect(p.core).not.toBe(rim); // hot center is lightened toward white
    expect(p.core).toBeGreaterThan(0);
    expect(p.core).toBeLessThanOrEqual(0xffffff);
    expect(p.fallback.startsWith('radial-gradient')).toBe(true);
  });
});

describe('themeToPalette', () => {
  it('bridges a theme PaletteConfig via its idle colors', () => {
    const cyan = THEME_PALETTES.cyan;
    const p = themeToPalette(cyan);
    expect(p.primary).toBe(cyan.idleRim);
    expect(p.secondary).toBe(cyan.idleCore);
  });
});

describe('OrbAvatar (ControllableAvatar surface, no WebGL)', () => {
  it('records the controller scalars without mounting the renderer', () => {
    const orb = new OrbAvatar();
    orb.setParams({ speed: 2.5, amplitude: 0.4 });
    expect(orb.params.speed).toBe(2.5);
    expect(orb.params.amplitude).toBe(0.4);
    orb.mesh.scale.set(2, 3, 4);
    expect(orb.mesh.scale.x).toBe(2);
    expect(() => orb.setGlow(0.7)).not.toThrow(); // no-op by design
  });
});
