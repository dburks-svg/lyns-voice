/**
 * The conductor's orchestration markers. The primary (voice) session is told, via its
 * system prompt, that it can spawn and steer worker sessions by emitting markers in its
 * reply, exactly like the `<<mood:...>>` convention:
 *
 *   <<spawn:NAME|DIR|TASK>>   spawn a worker named NAME in directory DIR with an initial TASK
 *   <<tell:NAME|MESSAGE>>     send a follow-up MESSAGE to the worker named NAME
 *   <<propose:SUMMARY>>       propose splitting work into parallel sessions (asks first)
 *
 * Markers are ALWAYS stripped before anything is spoken or shown (like mood), and the body
 * is a bounded negated class so the regex stays linear (no catastrophic backtracking). Only
 * the primary session is given the vocabulary, so only it emits markers; this parser mirrors
 * `mood/moodProtocol.ts` and leaves mood markers untouched (they are stripped later in speak()).
 */

export type ConductorDirective =
  | { kind: 'spawn'; name: string; dir: string; task: string }
  | { kind: 'tell'; name: string; message: string }
  | { kind: 'propose'; summary: string };

export interface ParsedConductor {
  stripped: string;
  directives: ConductorDirective[];
}

// Bounded body (no `>`, max 512) keeps the match linear. The kind is one of the three verbs.
const MARKER = /<<\s*(spawn|tell|propose)\s*:([^>]{0,512})>>/gi;
// A session name: 1..40 of letters/digits/space/underscore/hyphen.
const NAME = /^[a-z0-9 _-]{1,40}$/i;

export function parseConductor(text: string): ParsedConductor {
  if (!text || text.indexOf('<<') === -1) {
    return { stripped: text, directives: [] };
  }
  const directives: ConductorDirective[] = [];
  MARKER.lastIndex = 0;
  const stripped = text
    .replace(MARKER, (_match: string, kind: string, body: string): string => {
      const directive = toDirective(kind.toLowerCase(), body);
      if (directive) directives.push(directive);
      return ''; // always strip, valid directive or not
    })
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return { stripped, directives };
}

function toDirective(kind: string, body: string): ConductorDirective | null {
  const parts = body.split('|').map((s) => s.trim());
  if (kind === 'spawn') {
    const [name, dir, ...rest] = parts;
    const task = rest.join(' | ').trim();
    if (name && NAME.test(name) && dir && task) {
      return { kind: 'spawn', name, dir, task };
    }
    return null;
  }
  if (kind === 'tell') {
    const [name, ...rest] = parts;
    const message = rest.join(' | ').trim();
    if (name && NAME.test(name) && message) {
      return { kind: 'tell', name, message };
    }
    return null;
  }
  // propose: the whole body is a human-readable summary.
  const summary = body.trim();
  return summary ? { kind: 'propose', summary } : null;
}
