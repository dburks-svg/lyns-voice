/**
 * Friendly display labels for Kokoro voice ids. The ids encode accent + gender in a
 * two-letter prefix (`a`=American, `b`=British; `f`=female, `m`=male) plus a name,
 * e.g. `bf_emma` -> "Emma (UK, female)". Deriving the label (rather than a hand-kept
 * map) means new voices in the Rust VOICES list get a sensible label for free; an
 * unrecognized id falls back to the raw id.
 */
export function voiceLabel(id: string): string {
  const m = /^([ab])([fm])_(.+)$/.exec(id);
  if (!m) return id;
  const accent = m[1] === 'a' ? 'US' : 'UK';
  const gender = m[2] === 'f' ? 'female' : 'male';
  const name = m[3].charAt(0).toUpperCase() + m[3].slice(1);
  return `${name} (${accent}, ${gender})`;
}
