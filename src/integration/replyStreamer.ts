/**
 * Phase B: turn a stream of assistant text deltas into speakable sentences as they
 * arrive, so Q starts talking ~one sentence in instead of after the whole reply.
 *
 * This is the tricky, pure heart of streaming speech, kept dependency-light and
 * fully unit-tested. It owns three concerns that the one-shot `speak()` path
 * handled trivially on the complete reply but are subtle on a token stream:
 *
 *  1. `<<mood:NAME>>` markers set the orb mood and are never spoken. A leading one
 *     sets the opening mood; further markers anywhere in the reply recolor the orb
 *     as it streams, so a story can shift mood per part.
 *  2. Conductor markers (`<<spawn|tell|propose:...>>`) can appear anywhere; they
 *     are stripped from spoken text. (Dispatching them is still done elsewhere, on
 *     the complete narration/turn-end text, so this module only has to MUTE them.)
 *  3. A marker can be split across deltas (`"<<sp" | "awn:..>>"`): an incomplete
 *     trailing `<<...` is held back until it completes, so half a marker is never
 *     spoken and a sentence boundary inside an unfinished marker never fires.
 *
 * Output is whole sentences (split on `.?!` + whitespace), with the final partial
 * sentence held until `flush()` at turn end. Numbers like `3.14` do not split
 * because the terminator is not followed by whitespace.
 */

import { parseMoodMarker } from '../mood/moodProtocol';
import type { Mood } from '../mood/moods';

export interface ReplyStreamerOptions {
  /** A speakable, marker-free chunk (one sentence, or the flushed tail). */
  onChunk: (text: string) => void;
  /** Fired for each `<<mood:...>>` marker as it streams (leading or mid-reply). */
  onMood?: (mood: Mood) => void;
}

export interface ReplyStreamer {
  /** Feed the next assistant text delta; emits any now-complete sentences. */
  push(delta: string): void;
  /** Turn end: emit any remaining buffered text (marker-stripped). */
  flush(): void;
  /** Whether any chunk has been emitted this turn (drives turn-end de-dup). */
  spoke(): boolean;
  /** Discard all buffered state for a new turn (also call on barge-in). */
  reset(): void;
}

// A complete marker: `<<...>>` (non-greedy to the first `>>`). Bodies never contain `>>`.
const COMPLETE_MARKER = /<<[\s\S]*?>>/g;
// The longest an unmatched `<<` may hold the stream. Real marker bodies are bounded
// (mood names are short; the conductor grammar caps bodies at 512 chars), so once
// this much text follows a `<<` with no `>>` it is prose (`operator <<`, a heredoc),
// not a marker, and the stream must flow again rather than swallow the reply's tail.
const MARKER_HOLD_MAX = 600;
// Cap the unemitted buffer: a pathological stream with no sentence boundary at all
// must not grow (and re-scan) the buffer without bound.
const BUF_MAX = 16_384;
// A dangling `<<name:` tail at flush is a truncated marker (drop it); a dangling
// prose `<<` (C++ stream operators, shifts) is kept, not swallowed.
const MARKER_PREFIX = /^<<[a-z]*\s*(:|$)/i;

const TERMINATORS = '.!?';
const CLOSERS = '"\')]';
const WS = /\s/;

/**
 * First sentence boundary at or after `from`: a run of `.!?` (plus closing
 * quotes/brackets) followed by whitespace. Returns the candidate end (exclusive)
 * and where the remainder starts (past the whitespace). A linear scan on purpose:
 * the previous lazy-regex approach re-ran against the whole buffer on every delta
 * with backtracking, going quadratic (measured ~1.4 s per delta at 32 k chars) on
 * adversarial terminator floods.
 */
function findBoundary(s: string, from: number): { end: number; rest: number } | null {
  for (let i = from; i < s.length; i++) {
    if (!TERMINATORS.includes(s[i])) continue;
    let j = i + 1;
    while (j < s.length && TERMINATORS.includes(s[j])) j++;
    let k = j;
    while (k < s.length && CLOSERS.includes(s[k])) k++;
    if (k < s.length && WS.test(s[k])) {
      let m = k + 1;
      while (m < s.length && WS.test(s[m])) m++;
      return { end: k, rest: m };
    }
    i = k - 1; // no whitespace after the run (e.g. `3.14`): resume right past it
  }
  return null;
}

/** Index of a trailing unmatched `<<` in `s` (no `>>` anywhere after it), or -1. */
function unclosedOpen(s: string): number {
  const open = s.lastIndexOf('<<');
  return open !== -1 && s.indexOf('>>', open) === -1 ? open : -1;
}

/**
 * First boundary that may be emitted: one not inside a marker. A boundary inside a
 * COMPLETE marker is skipped past (the scan resumes after its `>>`); one inside a
 * still-open marker holds the stream (null), unless that "marker" has outgrown any
 * legal body and is therefore prose.
 */
function emittableBoundary(s: string): { end: number; rest: number } | null {
  let from = 0;
  for (;;) {
    const b = findBoundary(s, from);
    if (!b) return null;
    const open = s.lastIndexOf('<<', b.end - 1);
    if (open === -1) return b; // no marker near the boundary
    const close = s.indexOf('>>', open);
    if (close === -1) {
      // Boundary inside an unfinished marker (e.g. the `.` in `<<spawn:a. b`).
      return s.length - open <= MARKER_HOLD_MAX ? null : b;
    }
    if (close > b.end) {
      from = close + 2; // the boundary was inside a complete marker; look past it
      continue;
    }
    return b; // the marker closed before the boundary: a clean boundary
  }
}

export function createReplyStreamer(opts: ReplyStreamerOptions): ReplyStreamer {
  let buf = '';
  let didSpeak = false;

  // Apply a marker's mood the instant it is consumed (leading OR mid-reply), so a
  // reply that shifts mood per part recolors the orb each time, not just once at the
  // start. Non-mood markers (conductor spawn/tell/propose) yield no mood and are
  // ignored here; they are still stripped from spoken text.
  function applyMood(marker: string): void {
    const { mood } = parseMoodMarker(marker);
    if (mood) opts.onMood?.(mood);
  }

  // Consume leading whitespace + any COMPLETE leading markers from `buf`, applying
  // each mood marker as it goes. Returns 'wait' if the head is an INCOMPLETE marker
  // (`<<` with no `>>` yet), meaning we must not touch the buffer until more text
  // arrives.
  function stripLeading(): 'ok' | 'wait' {
    for (;;) {
      const lead = buf.replace(/^\s+/, '');
      const leadingSpace = buf.length - lead.length;
      if (!lead.startsWith('<<')) return 'ok';
      const close = lead.indexOf('>>');
      if (close === -1) return 'wait'; // incomplete leading marker; hold
      const marker = lead.slice(0, close + 2);
      applyMood(marker);
      buf = buf.slice(leadingSpace + marker.length); // drop space + marker, loop
    }
  }

  function emit(sentence: string): void {
    // A mood marker embedded in this sentence (a mid-sentence shift) recolors the orb
    // before every marker is stripped from the spoken text.
    const markers = sentence.match(COMPLETE_MARKER);
    if (markers) for (const mk of markers) applyMood(mk);
    const clean = sentence.replace(COMPLETE_MARKER, '').trim();
    if (clean) {
      didSpeak = true;
      opts.onChunk(clean);
    }
  }

  return {
    push(delta: string): void {
      if (!delta) return;
      buf += delta;
      for (;;) {
        if (stripLeading() === 'wait') {
          // A leading `<<` with no `>>` yet: hold for it to complete, unless it has
          // outgrown any legal marker body; then it is prose and flows on below.
          const open = unclosedOpen(buf);
          if (open === -1 || buf.length - open <= MARKER_HOLD_MAX) return;
        }
        const b = emittableBoundary(buf);
        if (!b) {
          // Nothing emittable. Bound the buffer so a boundary-less flood cannot grow
          // (and re-scan) it forever; a genuinely-held partial marker stays buffered.
          if (buf.length > BUF_MAX) {
            const open = unclosedOpen(buf);
            const cut = open !== -1 && buf.length - open <= MARKER_HOLD_MAX ? open : buf.length;
            emit(buf.slice(0, cut));
            buf = buf.slice(cut);
          }
          return;
        }
        const candidate = buf.slice(0, b.end);
        buf = buf.slice(b.rest);
        emit(candidate);
      }
    },

    flush(): void {
      stripLeading(); // apply a leading/trailing mood marker + strip leading markers
      // A mood marker buffered in a terminator-less tail (no sentence boundary to
      // emit it through) still recolors the orb before it is stripped below.
      const markers = buf.match(COMPLETE_MARKER);
      if (markers) for (const mk of markers) applyMood(mk);
      let rest = buf.replace(COMPLETE_MARKER, '');
      // Drop a dangling truncated marker (`<<tel`, `<<spawn:...`) so half a marker is
      // never spoken; a dangling prose `<<` (C++ operators) is kept, not swallowed.
      const open = unclosedOpen(rest);
      if (open !== -1 && MARKER_PREFIX.test(rest.slice(open))) rest = rest.slice(0, open);
      const clean = rest.trim();
      if (clean) {
        didSpeak = true;
        opts.onChunk(clean);
      }
      buf = '';
    },

    spoke(): boolean {
      return didSpeak;
    },

    reset(): void {
      buf = '';
      didSpeak = false;
    },
  };
}
