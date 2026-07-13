import { describe, it, expect } from 'vitest';
import { effortLevelsForModel, clampEffortToModel } from '../src/app/settings';

describe('effortLevelsForModel', () => {
  it('offers ultracode plus xhigh/max only for Opus', () => {
    const opus = effortLevelsForModel('opus');
    expect(opus).toContain('ultracode');
    expect(opus).toContain('xhigh');
    expect(opus).toContain('max');
  });

  it('drops xhigh and ultracode for Sonnet but keeps max', () => {
    const sonnet = effortLevelsForModel('sonnet');
    expect(sonnet).toContain('max');
    expect(sonnet).not.toContain('xhigh');
    expect(sonnet).not.toContain('ultracode');
  });

  it('offers no effort levels for Haiku (the effort param is unsupported there)', () => {
    expect(effortLevelsForModel('haiku')).toEqual([]);
  });

  it('falls back to a safe subset for the default and any unknown model', () => {
    expect(effortLevelsForModel('')).toEqual(['low', 'medium', 'high']);
    expect(effortLevelsForModel('claude-opus-4-8')).toEqual(['low', 'medium', 'high']);
  });
});

describe('clampEffortToModel', () => {
  it('keeps an effort the model actually offers', () => {
    expect(clampEffortToModel('opus', 'ultracode')).toBe('ultracode');
    expect(clampEffortToModel('opus', 'xhigh')).toBe('xhigh');
    expect(clampEffortToModel('sonnet', 'high')).toBe('high');
  });

  it('self-heals a stale combo to the default effort', () => {
    expect(clampEffortToModel('sonnet', 'xhigh')).toBe(''); // Sonnet has no xhigh
    expect(clampEffortToModel('sonnet', 'ultracode')).toBe(''); // ultracode is Opus-only
    expect(clampEffortToModel('haiku', 'high')).toBe(''); // Haiku has no effort levels
  });

  it('leaves the default effort untouched for every model', () => {
    expect(clampEffortToModel('opus', '')).toBe('');
    expect(clampEffortToModel('sonnet', '')).toBe('');
    expect(clampEffortToModel('haiku', '')).toBe('');
  });
});
