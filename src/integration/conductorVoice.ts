/**
 * The conductor's single voice across the fleet. Worker sessions report a finished
 * turn here, and this decides WHEN and HOW Q says it, without ever cutting the user
 * off mid-word:
 *  - a worker ERROR is critical: announced as soon as the voice is free (at the next
 *    pause), ahead of any digest;
 *  - a worker SUCCESS is non-critical: batched into one digest line and flushed after
 *    a short debounce, once the voice is free.
 *
 * Announcements are spoken through the host's existing speak() (mood parse + chunking),
 * so there is no second TTS path. Pure but for the injected timer + speak; unit-tested.
 */

export interface ConductorVoice {
  /** A worker session finished a turn (`isError` => critical). */
  announce(name: string, isError: boolean): void;
  /** Speak a queued announcement now if one is pending; call when the voice frees. */
  flush(): void;
}

export interface ConductorVoiceDeps {
  speak: (text: string) => void;
  /** True when no reply/announcement currently occupies the single voice channel. */
  voiceFree: () => boolean;
  timer: Pick<Window, 'setTimeout' | 'clearTimeout'>;
  /** Debounce before flushing a success digest, so near-simultaneous finishes batch. */
  digestMs?: number;
}

/** Join names into readable prose: "A", "A and B", "A, B, and C". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

/** Courteous critical announcement (a worker errored). Mood-tagged for the orb. */
export function criticalLine(names: string[]): string {
  const verb = names.length > 1 ? 'hit errors' : 'hit an error';
  return `<<mood:concerned>> Excuse me Sir, ${joinNames(names)} ${verb}.`;
}

/** Batched success digest (workers finished). Mood-tagged for the orb. */
export function digestLine(names: string[]): string {
  const verb = names.length > 1 ? 'are done' : 'is done';
  return `<<mood:happy>> ${joinNames(names)} ${verb}.`;
}

export function createConductorVoice(deps: ConductorVoiceDeps): ConductorVoice {
  const critical: string[] = [];
  const digest: string[] = [];
  let digestTimer: ReturnType<Window['setTimeout']> | null = null;
  const digestMs = deps.digestMs ?? 1500;

  function flush(): void {
    if (!deps.voiceFree()) return; // voice busy; retry when it frees (e.g. onSpeakingEnd)
    if (critical.length > 0) {
      deps.speak(criticalLine(critical.splice(0)));
      return; // one announcement per flush; the rest follow on the next free moment
    }
    if (digest.length > 0) {
      deps.speak(digestLine(digest.splice(0)));
    }
  }

  function announce(name: string, isError: boolean): void {
    if (isError) {
      critical.push(name);
      flush(); // criticals try immediately (still gated on voiceFree)
    } else {
      digest.push(name);
      if (digestTimer !== null) deps.timer.clearTimeout(digestTimer);
      digestTimer = deps.timer.setTimeout(() => {
        digestTimer = null;
        flush();
      }, digestMs);
    }
  }

  return { announce, flush };
}
