import { describe, it, expect } from 'vitest';
import { parseMoodMarker } from '../src/mood/moodProtocol';
import { lerpHex, lerp, clamp01 } from '../src/mood/colorBlend';
import { MoodController } from '../src/mood/MoodController';
import { MOOD_TABLE } from '../src/mood/moods';
import { AvatarController, type ControllableAvatar } from '../src/avatar/AvatarController';
import type { DeformationParams } from '../src/avatar/deformation';

function fakeAvatar() {
  const params: DeformationParams = { amplitude: -1, frequency: -1, speed: -1 };
  const colors = { rim: -1, core: -1 };
  const glow = { value: -1 };
  const avatar: ControllableAvatar = {
    setParams: (next) => Object.assign(params, next),
    setGlow: (v) => {
      glow.value = v;
    },
    setColors: (rim, core) => {
      colors.rim = rim;
      colors.core = core;
    },
    idleRotationSpeed: 0,
    mesh: { rotation: { x: 0, y: 0, z: 0 }, scale: { set: () => undefined } },
  };
  return { avatar, params, colors, glow };
}

describe('parseMoodMarker', () => {
  it('extracts a leading mood and strips the marker', () => {
    expect(parseMoodMarker('<<mood:happy>> Hello there')).toEqual({
      mood: 'happy',
      stripped: 'Hello there',
    });
  });

  it('passes through text with no marker (fast path)', () => {
    expect(parseMoodMarker('All systems nominal')).toEqual({
      mood: null,
      stripped: 'All systems nominal',
    });
  });

  it('is case-insensitive and whitespace-tolerant', () => {
    expect(parseMoodMarker('<< MOOD : Error >> down').mood).toBe('error');
  });

  it('strips an unknown keyword but yields no mood', () => {
    const parsed = parseMoodMarker('<<mood:banana>> hi');
    expect(parsed.mood).toBeNull();
    expect(parsed.stripped).toBe('hi');
  });

  it('always strips, even mid-sentence, so a leak is silent', () => {
    const parsed = parseMoodMarker('Task done <<mood:happy>> moving on');
    expect(parsed.mood).toBe('happy');
    expect(parsed.stripped).not.toContain('<<');
  });

  it('takes the first valid mood and strips every marker', () => {
    const parsed = parseMoodMarker('<<mood:happy>><<mood:error>> ready');
    expect(parsed.mood).toBe('happy');
    expect(parsed.stripped).toBe('ready');
  });
});

describe('colorBlend', () => {
  it('lerpHex interpolates channel-wise and clamps t', () => {
    expect(lerpHex(0x000000, 0xffffff, 0)).toBe(0x000000);
    expect(lerpHex(0x000000, 0xffffff, 1)).toBe(0xffffff);
    expect(lerpHex(0x000000, 0xffffff, 0.5)).toBe(0x808080);
    expect(lerpHex(0x112233, 0x445566, 2)).toBe(0x445566); // clamped to b
  });

  it('lerp/clamp01 clamp out-of-range inputs', () => {
    expect(lerp(0, 10, 0.5)).toBe(5);
    expect(clamp01(-3)).toBe(0);
    expect(clamp01(NaN)).toBe(0);
  });
});

describe('MoodController', () => {
  it('neutral mood is pass-through (zero regression)', () => {
    const mc = new MoodController();
    mc.tick(0);
    mc.tick(0.5);
    expect(mc.colors(0x112233, 0x445566)).toEqual([0x112233, 0x445566]);
    expect(mc.glow(2.0)).toBeCloseTo(2.0);
  });

  it('eases toward a mood tint and scales glow', () => {
    const mc = new MoodController();
    mc.setMood('error');
    for (let t = 0; t <= 1.2; t += 0.1) {
      mc.tick(Number(t.toFixed(2)));
    }
    const [rim] = mc.colors(0x00f0ff, 0x0077ff);
    expect(rim).not.toBe(0x00f0ff); // tinted toward the error rim
    expect(mc.glow(1.0)).toBeGreaterThan(1.0); // error glowMul > 1
    expect(mc.glow(1.0)).toBeLessThanOrEqual(3.5); // clamped
    expect(mc.mood).toBe('error');
  });

  it('every mood has a complete visual entry', () => {
    for (const visual of Object.values(MOOD_TABLE)) {
      expect(typeof visual.rim).toBe('number');
      expect(typeof visual.glowMul).toBe('number');
      expect(visual.weight).toBeGreaterThanOrEqual(0);
      expect(visual.weight).toBeLessThanOrEqual(1);
    }
  });
});

describe('AvatarController with a mood provider', () => {
  it('a neutral mood leaves idle exactly as today', () => {
    const { avatar, params, colors, glow } = fakeAvatar();
    const controller = new AvatarController({ avatar, moodProvider: new MoodController() });
    controller.tick(0);
    controller.tick(0.5);
    expect(params.amplitude).toBeCloseTo(0.12);
    expect(glow.value).toBeCloseTo(1.0);
    expect(colors.core).toBe(0x0a1530); // idle core unchanged at neutral
  });

  it('a non-neutral mood tints color and lifts glow', () => {
    const { avatar, colors, glow } = fakeAvatar();
    const mood = new MoodController();
    const controller = new AvatarController({ avatar, moodProvider: mood });
    controller.setState('listening');
    mood.setMood('error');
    for (let t = 0; t <= 1.2; t += 0.1) {
      controller.tick(Number(t.toFixed(2)));
    }
    expect(colors.core).not.toBe(0x0077ff); // listening core tinted toward error
    expect(glow.value).toBeGreaterThan(1.2); // base 1.2 lifted by error glowMul
  });
});
