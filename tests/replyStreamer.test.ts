import { describe, it, expect } from 'vitest';
import { createReplyStreamer } from '../src/integration/replyStreamer';

function collect() {
  const chunks: string[] = [];
  const moods: string[] = [];
  const s = createReplyStreamer({
    onChunk: (t) => chunks.push(t),
    onMood: (m) => moods.push(m),
  });
  return { s, chunks, moods };
}

describe('createReplyStreamer', () => {
  it('emits complete sentences as they arrive and holds the partial tail', () => {
    const { s, chunks } = collect();
    s.push('Hello there. How are ');
    expect(chunks).toEqual(['Hello there.']);
    s.push('you today? Bye');
    expect(chunks).toEqual(['Hello there.', 'How are you today?']);
    s.flush();
    expect(chunks).toEqual(['Hello there.', 'How are you today?', 'Bye']);
  });

  it('reassembles a sentence split across many deltas', () => {
    const { s, chunks } = collect();
    for (const d of ['The ', 'quick ', 'brown ', 'fox.', ' Next. ']) s.push(d);
    expect(chunks).toEqual(['The quick brown fox.', 'Next.']);
  });

  it('resolves a leading mood marker and never speaks it', () => {
    const { s, chunks, moods } = collect();
    s.push('<<mood:happy>> All systems nominal. ');
    expect(moods).toEqual(['happy']);
    expect(chunks).toEqual(['All systems nominal.']);
    s.push('Second line. ');
    expect(moods).toEqual(['happy']); // no further marker => no further mood
  });

  it('applies mood markers that appear later in the reply, not just the leading one', () => {
    const { s, chunks, moods } = collect();
    s.push('<<mood:happy>> Once upon a time. ');
    expect(moods).toEqual(['happy']);
    s.push('<<mood:curious>> The puppy wondered. ');
    expect(moods).toEqual(['happy', 'curious']);
    s.push('<<mood:concerned>> Dark clouds gathered. ');
    expect(moods).toEqual(['happy', 'curious', 'concerned']);
    expect(chunks).toEqual(['Once upon a time.', 'The puppy wondered.', 'Dark clouds gathered.']);
    expect(chunks.join(' ')).not.toContain('<<');
  });

  it('applies a mood marker embedded mid-sentence and strips it from speech', () => {
    const { s, chunks, moods } = collect();
    s.push('The hero smiled <<mood:happy>> with joy. ');
    expect(moods).toEqual(['happy']);
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe('The hero smiled with joy.');
    expect(chunks.join(' ')).not.toContain('<<');
  });

  it('applies a trailing mood marker in a terminator-less tail at flush', () => {
    const { s, chunks, moods } = collect();
    s.push('No period here <<mood:error>>');
    s.flush();
    expect(moods).toEqual(['error']);
    expect(chunks).toEqual(['No period here']);
  });

  it('cycles moods through a reply that opens with text and puts each marker on its own line', () => {
    const { s, chunks, moods } = collect();
    // Mirrors the "cycle through all moods" reply: a lead-in sentence with no marker,
    // then each <<mood:NAME>> on its own line followed by a newline.
    s.push('Watch the indicator as I run through them.\n\n');
    s.push('<<mood:neutral>>\nNeutral baseline.\n\n');
    s.push('<<mood:focused>>\nFocused now.\n\n');
    s.push('<<mood:curious>>\nCurious now.\n\n');
    s.push('<<mood:concerned>>\nConcerned now.\n\n');
    s.push('<<mood:error>>\nError now.\n\n');
    s.push('<<mood:happy>>\nHappy now. ');
    s.flush();
    expect(moods).toEqual(['neutral', 'focused', 'curious', 'concerned', 'error', 'happy']);
    expect(chunks.join(' ')).not.toContain('<<');
  });

  it('holds a mood marker that is split across deltas (never speaks a half marker)', () => {
    const { s, chunks, moods } = collect();
    s.push('<<mo');
    s.push('od:foc');
    expect(chunks).toEqual([]);
    expect(moods).toEqual([]);
    s.push('used>> Working on it. ');
    expect(moods).toEqual(['focused']);
    expect(chunks).toEqual(['Working on it.']);
  });

  it('strips conductor markers that appear mid-text', () => {
    const { s, chunks } = collect();
    s.push('Spinning up <<spawn:web|C:/p|build>> now. Done.');
    s.flush();
    // marker removed; surrounding text preserved (collapsed whitespace is fine)
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe('Spinning up now. Done.');
    expect(chunks.join(' ')).not.toContain('<<');
  });

  it('does NOT emit when a sentence terminator falls inside an incomplete marker', () => {
    const { s, chunks } = collect();
    s.push('Working <<spawn:a.b'); // the "." is inside an unfinished marker
    expect(chunks).toEqual([]); // must wait, not speak "Working <<spawn:a.b"
    s.push('|C:/p|task>> ok. ');
    expect(chunks.join(' ')).not.toContain('<<');
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe('Working ok.');
  });

  it('does not split on a decimal point (no following whitespace)', () => {
    const { s, chunks } = collect();
    s.push('Pi is 3.14 today. ');
    expect(chunks).toEqual(['Pi is 3.14 today.']);
  });

  it('flush emits the remaining tail and drops a dangling incomplete marker', () => {
    const { s, chunks } = collect();
    s.push('All set <<tel');
    s.flush();
    expect(chunks).toEqual(['All set']);
    expect(chunks.join('')).not.toContain('<<');
  });

  it('speaks normally when there is no mood marker (onMood never fires)', () => {
    const { s, chunks, moods } = collect();
    s.push('Just text here. ');
    expect(moods).toEqual([]);
    expect(chunks).toEqual(['Just text here.']);
  });

  it('tracks spoke() and reset() clears state', () => {
    const { s } = collect();
    expect(s.spoke()).toBe(false);
    s.push('One. ');
    expect(s.spoke()).toBe(true);
    s.reset();
    expect(s.spoke()).toBe(false);
    const after: string[] = [];
    const s2 = createReplyStreamer({ onChunk: (t) => after.push(t) });
    s2.push('<<mood:error>>');
    s2.reset();
    s2.push('Fresh start. ');
    expect(after).toEqual(['Fresh start.']);
  });

  it('multiple sentences in one delta all emit in order', () => {
    const { s, chunks } = collect();
    s.push('A. B! C? D');
    expect(chunks).toEqual(['A.', 'B!', 'C?']);
    s.flush();
    expect(chunks).toEqual(['A.', 'B!', 'C?', 'D']);
  });

  it('ignores empty deltas', () => {
    const { s, chunks } = collect();
    s.push('');
    s.push('Hi. ');
    expect(chunks).toEqual(['Hi.']);
  });

  // Regression (audit): a literal `<<` in prose (C++ stream operators, shifts) held
  // the buffer forever, silently swallowing everything after it from speech.
  it('does not swallow the reply tail after a literal << in prose (flush keeps it)', () => {
    const { s, chunks } = collect();
    s.push('The C++ stream operator << writes output. Also fix the loop. ');
    s.flush();
    const spoken = chunks.join(' ').replace(/\s+/g, ' ');
    expect(spoken).toContain('Also fix the loop.');
    expect(spoken).toContain('operator <<');
  });

  it('releases an oversized unmatched << as prose instead of stalling the stream', () => {
    const { s, chunks } = collect();
    s.push('see operator << ');
    s.push(`${'x'.repeat(700)}. Then more. `); // far past any legal marker body
    expect(chunks.length).toBeGreaterThan(0); // emitted mid-stream, not held to flush
    expect(chunks.join(' ')).toContain('Then more.');
  });

  it('still drops a dangling truncated marker (<<spawn:...) at flush', () => {
    const { s, chunks } = collect();
    s.push('Done. <<spawn:web|C:/x|build the');
    s.flush();
    expect(chunks).toEqual(['Done.']);
  });

  it('emits a sentence whose boundary sits past a complete marker containing ". "', () => {
    const { s, chunks } = collect();
    s.push('Working <<spawn:a. b|C:/p|task>> ok. Next');
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe('Working ok.');
    expect(chunks.join(' ')).not.toContain('<<');
  });

  // Regression (audit): the old lazy-regex sentence matcher re-scanned the whole
  // buffer per delta with backtracking - quadratic on terminator floods (measured
  // ~1.4 s PER DELTA at 32 k chars), freezing the UI thread. The linear scanner must
  // stay fast and the buffer must stay bounded.
  it('survives a terminator flood without hanging and keeps the buffer bounded', () => {
    const { s, chunks } = collect();
    for (let i = 0; i < 40; i++) s.push('.'.repeat(1000)); // 40 k terminators, no whitespace
    s.push(' The end. ');
    expect(chunks.length).toBeGreaterThan(0); // the buffer cap force-emitted
    expect(chunks.join(' ')).toContain('The end.');
  });
});
