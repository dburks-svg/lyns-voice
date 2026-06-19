import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG, cloneConfig } from '../src/config/config';
import {
  loadConfig,
  saveConfig,
  sanitizeConfig,
  STORAGE_KEY,
  type StorageLike,
} from '../src/config/store';

/** In-memory storage so persistence tests are deterministic. */
function fakeStorage(seed?: Record<string, string>): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
  };
}

describe('DEFAULT_CONFIG', () => {
  it('reproduces the historical hard-coded values exactly (zero-regression)', () => {
    expect(DEFAULT_CONFIG.skin).toBe('orb');
    expect(DEFAULT_CONFIG.mesh).toEqual({ radius: 1.2, detail: 3 });
    expect(DEFAULT_CONFIG.idle).toEqual({ amplitude: 0.12, frequency: 1.1, speed: 0.5 });
    expect(DEFAULT_CONFIG.rotation).toEqual({
      idle: 0.15,
      listening: 0.1,
      thinking: 0.6,
      speaking: 0.2,
    });
    expect(DEFAULT_CONFIG.timing).toEqual({ impulseDecaySeconds: 0.32, thinkingPulseRate: 7.5 });
    expect(DEFAULT_CONFIG.palette.idleCore).toBe(0x0a1530);
    expect(DEFAULT_CONFIG.palette.listeningCore).toBe(0x0077ff);
    expect(DEFAULT_CONFIG.palette.neonRim).toBe(0x00f0ff);
    expect(DEFAULT_CONFIG.glowMode).toBe('fresnel');
    expect(DEFAULT_CONFIG.features.bloom).toBe(false);
    expect(DEFAULT_CONFIG.moodSource).toBe('tag');
    expect(DEFAULT_CONFIG.apiKeyPresent).toBe(false);
  });

  it('cloneConfig is a deep copy (mutating the clone does not touch defaults)', () => {
    const clone = cloneConfig(DEFAULT_CONFIG);
    clone.palette.idleCore = 0x123456;
    clone.mesh.radius = 99;
    expect(DEFAULT_CONFIG.palette.idleCore).toBe(0x0a1530);
    expect(DEFAULT_CONFIG.mesh.radius).toBe(1.2);
  });
});

describe('loadConfig', () => {
  it('returns defaults when storage is empty or absent', () => {
    expect(loadConfig(fakeStorage())).toEqual(DEFAULT_CONFIG);
    expect(loadConfig(null)).toEqual(DEFAULT_CONFIG);
  });

  it('returns defaults on malformed JSON', () => {
    expect(loadConfig(fakeStorage({ [STORAGE_KEY]: '{not json' }))).toEqual(DEFAULT_CONFIG);
  });

  it('applies valid overrides and ignores invalid enum values', () => {
    const store = fakeStorage({
      [STORAGE_KEY]: JSON.stringify({ skin: 'head', glowMode: 'banana', moodSource: 'api' }),
    });
    const cfg = loadConfig(store);
    expect(cfg.skin).toBe('head'); // valid enum applied
    expect(cfg.glowMode).toBe('fresnel'); // invalid -> default
    expect(cfg.moodSource).toBe('api');
  });

  it('never surfaces a stored API key; only the presence flag is honored', () => {
    const store = fakeStorage({
      [STORAGE_KEY]: JSON.stringify({ apiKey: 'sk-secret-123', apiKeyPresent: true }),
    });
    const cfg = loadConfig(store) as unknown as Record<string, unknown>;
    expect(cfg.apiKeyPresent).toBe(true);
    expect('apiKey' in cfg).toBe(false);
    expect(JSON.stringify(cfg)).not.toContain('sk-secret-123');
  });

  it('clamps amplitudeScale to a sane range', () => {
    expect(loadConfig(fakeStorage({ [STORAGE_KEY]: JSON.stringify({ amplitudeScale: 999 }) }))
      .amplitudeScale).toBe(DEFAULT_CONFIG.amplitudeScale);
    expect(loadConfig(fakeStorage({ [STORAGE_KEY]: JSON.stringify({ amplitudeScale: 0.5 }) }))
      .amplitudeScale).toBe(0.5);
  });
});

describe('saveConfig', () => {
  it('persists only the safe subset and round-trips', () => {
    const store = fakeStorage();
    saveConfig({ skin: 'head', features: { bloom: true, shaderWarp: false } }, store);
    const reloaded = loadConfig(store);
    expect(reloaded.skin).toBe('head');
    expect(reloaded.features.bloom).toBe(true);
    // Numeric internals are never persisted, so they stay at defaults.
    const stored = JSON.parse(store.data.get(STORAGE_KEY) as string);
    expect('palette' in stored).toBe(false);
    expect('mesh' in stored).toBe(false);
  });

  it('sanitizes a hostile blob (drops API key, rejects bad skin)', () => {
    const merged = sanitizeConfig({ apiKey: 'leak', skin: 'wormhole' });
    expect(merged.skin).toBe('orb');
    expect(JSON.stringify(merged)).not.toContain('leak');
  });
});
