/**
 * Phase C: a "hey Q" wake word built on the existing Whisper STT - no extra model.
 *
 * When wake mode is on, Q listens continuously and every finalized utterance is
 * checked here; only utterances that begin with the wake phrase act on Q, so a
 * room full of talk never turns every sentence into a command. "Q" is a single
 * letter Whisper renders several ways (Q, cue, queue, kew), so the match is
 * tolerant of those homophones and of leading punctuation.
 *
 * "hey Q <command>" runs the command in one breath; a bare "hey Q" wakes Q and
 * arms it so the NEXT utterance is taken as the command (the "Hey Q." -> "Yes?"
 * -> "what's the version" flow). The command text is returned verbatim (Whisper's
 * casing/punctuation preserved) so it reaches Claude unmangled.
 */

export interface WakeResult {
  /** The wake phrase was present at the start of the utterance. */
  woke: boolean;
  /** Text after the wake phrase (empty = bare "hey Q": wake + arm, no command yet). */
  command: string;
}

// "hey"/"hay"/"heya"/"hi" + a Q homophone at a word boundary, then the rest (kept
// verbatim). Case-insensitive; tolerates commas/periods between the words.
const HEY_Q = /^\s*(?:hey|hay|heya|hi)[\s,]+(?:q|cue|queue|kew)\b[\s,.!?:;-]*(.*)$/is;

/** Detect a leading "hey Q" wake phrase and split off the command after it. */
export function matchHeyQ(transcript: string): WakeResult {
  const m = HEY_Q.exec((transcript ?? '').trim());
  if (!m) return { woke: false, command: '' };
  return { woke: true, command: m[1].trim() };
}
