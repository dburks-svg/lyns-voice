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
// First sentence: minimal run up to a terminator (with optional closing quote/bracket)
// FOLLOWED BY whitespace; the trailing partial sentence stays buffered.
const SENTENCE = /^([\s\S]*?[.!?]+["')\]]*)(\s+)([\s\S]*)$/;

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
        if (stripLeading() === 'wait') return;
        const m = SENTENCE.exec(buf);
        if (!m) return; // no complete sentence boundary yet
        const candidate = m[1];
        // If the candidate contains an unmatched `<<`, the boundary lives inside an
        // unfinished marker (e.g. a "." in `<<spawn:a.b`): wait for the marker to close.
        const open = candidate.lastIndexOf('<<');
        if (open !== -1 && candidate.indexOf('>>', open) === -1) return;
        buf = m[3];
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
      // Drop any dangling incomplete marker so half a `<<...` is never spoken.
      const open = rest.lastIndexOf('<<');
      if (open !== -1 && rest.indexOf('>>', open) === -1) rest = rest.slice(0, open);
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
