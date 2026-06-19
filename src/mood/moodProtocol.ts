/**
 * Parsing of the Claude-emitted mood tag.
 *
 * Convention: the assistant prefixes a spoken reply with a tiny machine-readable
 * marker `<<mood:NAME>>` (for example `<<mood:happy>>`). The avatar reads the
 * mood and ALWAYS strips every marker from the text, so a stray or mid-sentence
 * tag is silently removed rather than spoken aloud or shown in the transcript.
 *
 * The matcher is tolerant (case-insensitive, whitespace-flexible, keyword length
 * capped to avoid ReDoS) and never throws. An unknown keyword is stripped but
 * yields no mood (the avatar keeps its current mood).
 */

import { isMood, type Mood } from './moods';

export interface ParsedMood {
  /** The first valid mood found, or null if none. */
  mood: Mood | null;
  /** The input with every mood marker removed (leading whitespace trimmed). */
  stripped: string;
}

// Bounded keyword length (1..24) keeps this linear: no catastrophic backtracking.
const MARKER = /<<\s*mood\s*:\s*([a-z0-9_-]{1,24})\s*>>/gi;

export function parseMoodMarker(text: string): ParsedMood {
  if (!text || text.indexOf('<<') === -1) {
    return { mood: null, stripped: text };
  }
  let mood: Mood | null = null;
  MARKER.lastIndex = 0;
  const stripped = text
    .replace(MARKER, (_match: string, name: string): string => {
      if (mood === null) {
        const lower = name.toLowerCase();
        if (isMood(lower)) {
          mood = lower;
        }
      }
      return '';
    })
    .replace(/^\s+/, '');
  return { mood, stripped };
}
