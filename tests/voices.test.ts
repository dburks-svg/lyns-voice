import { describe, it, expect } from 'vitest';
import { voiceLabel } from '../src/integration/voices';

describe('voiceLabel', () => {
  it('derives accent + gender + capitalized name from the id', () => {
    expect(voiceLabel('bf_emma')).toBe('Emma (UK, female)');
    expect(voiceLabel('af_heart')).toBe('Heart (US, female)');
    expect(voiceLabel('am_michael')).toBe('Michael (US, male)');
    expect(voiceLabel('bm_george')).toBe('George (UK, male)');
  });

  it('falls back to the raw id for anything unrecognized', () => {
    expect(voiceLabel('Microsoft David')).toBe('Microsoft David');
    expect(voiceLabel('')).toBe('');
    expect(voiceLabel('xf_name')).toBe('xf_name'); // unknown accent prefix
  });
});
