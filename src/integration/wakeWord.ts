/**
 * The wake word, built on the existing Whisper STT - no extra model.
 *
 * The product is LYNS Voice; the one you speak with is Oracle, the same entity
 * you consult in the LYNS IDE (lyns.dev). Two forms wake her:
 *
 *   vocative:  "Oracle, <command>"      (also a bare "Oracle" to arm)
 *   greeting:  "hey oracle, <command>"  (also hi/hay/heya)
 *
 * The vocative form REQUIRES punctuation (or end of utterance) right after the
 * name: vocative prosody makes whisper write "Oracle, run the tests." with the
 * comma, while ambient mentions ("the oracle database is down") either are not
 * leading or run straight into the next word, and stay asleep. "Oracle" is a
 * common word whisper transcribes reliably - no homophone family needed.
 *
 * A wake with a command runs it in one breath; a bare wake arms the mic so the
 * NEXT utterance is the command (the "Oracle." -> "Yes?" -> "run the tests"
 * flow). The command text is returned verbatim (Whisper's casing/punctuation
 * preserved) so it reaches Claude unmangled.
 */

export interface WakeResult {
  /** The wake phrase was present at the start of the utterance. */
  woke: boolean;
  /** Text after the wake phrase (empty = a bare wake: wake + arm, no command yet). */
  command: string;
}

const NAME = String.raw`oracle`;

// "hey"/"hay"/"heya"/"hi" + the name at a word boundary, then the rest verbatim.
const GREETING_WAKE = new RegExp(
  String.raw`^\s*(?:hey|hay|heya|hi)[\s,]+${NAME}\b[\s,.!?:;-]*(.*)$`,
  'is',
);
// Leading vocative: the name, then REQUIRED punctuation (or end of utterance).
// "Oracle, lights." wakes; "oracle databases are complicated" does not.
const VOCATIVE_WAKE = new RegExp(String.raw`^\s*${NAME}\s*(?:$|[,.!?:;-]+\s*(.*)$)`, 'is');

/** Detect a leading wake phrase and split off the command after it. */
export function matchWake(transcript: string): WakeResult {
  const text = (transcript ?? '').trim();
  const m = GREETING_WAKE.exec(text) ?? VOCATIVE_WAKE.exec(text);
  if (!m) return { woke: false, command: '' };
  return { woke: true, command: (m[1] ?? '').trim() };
}
