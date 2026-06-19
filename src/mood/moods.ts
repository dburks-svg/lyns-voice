/**
 * Mood vocabulary and the visual mapping for each mood.
 *
 * Mood is layered on top of the four activity states (idle/listening/thinking/
 * speaking): the activity state owns MOTION (amplitude, rotation, scale), and
 * the mood owns a COLOR TINT and a glow adjustment. `neutral` has weight 0, so a
 * neutral mood leaves the avatar exactly as it was before moods existed (this is
 * the zero-regression default).
 */

export type Mood = 'neutral' | 'focused' | 'happy' | 'concerned' | 'error' | 'curious';

export const MOODS: readonly Mood[] = [
  'neutral',
  'focused',
  'happy',
  'concerned',
  'error',
  'curious',
];

export interface MoodVisual {
  /** Rim tint (hex). */
  rim: number;
  /** Core tint (hex). */
  core: number;
  /** Multiplier applied to the activity glow. */
  glowMul: number;
  /** Amplitude of a small glow shimmer (0 = steady). */
  flutter: number;
  /** How strongly the mood tint overrides the activity color (0..1). */
  weight: number;
}

export const MOOD_TABLE: Record<Mood, MoodVisual> = {
  // weight 0 => pass-through: neutral equals the pre-mood look exactly.
  neutral: { rim: 0x00f0ff, core: 0x0077ff, glowMul: 1.0, flutter: 0.0, weight: 0.0 },
  focused: { rim: 0x2a7bff, core: 0x0a2a66, glowMul: 1.05, flutter: 0.0, weight: 0.45 },
  happy: { rim: 0x46ffd0, core: 0x0a9d7a, glowMul: 1.2, flutter: 0.0, weight: 0.6 },
  curious: { rim: 0x9a6bff, core: 0x3a1f8f, glowMul: 1.1, flutter: 0.1, weight: 0.55 },
  concerned: { rim: 0xffc24d, core: 0x8a5a10, glowMul: 1.1, flutter: 0.15, weight: 0.6 },
  error: { rim: 0xff4d5e, core: 0x7a1020, glowMul: 1.25, flutter: 0.35, weight: 0.7 },
};

export function isMood(value: string): value is Mood {
  return (MOODS as readonly string[]).includes(value);
}
