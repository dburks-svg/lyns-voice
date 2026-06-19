/**
 * Secondary mood-strip point: watches the host transcript (`#conversationMessages`)
 * and removes any `<<mood:NAME>>` marker that appears in rendered assistant text,
 * emitting the mood. The PRIMARY strip happens in the SpeechReactor (the spoken
 * `speak` text), which is where the user's Claude session reliably emits the tag;
 * this observer is a best-effort backstop so a marker is never left visible.
 *
 * Security: only ever reads/writes text node data (never innerHTML), so it cannot
 * introduce markup. Rewriting is idempotent (re-parsing stripped text finds no
 * marker), so the self-triggered characterData mutation terminates immediately.
 */

import { parseMoodMarker } from '../mood/moodProtocol';
import type { Mood } from '../mood/moods';

export interface TranscriptMoodObserverOptions {
  /** The transcript container to watch (e.g. #conversationMessages). */
  root: Node;
  /** Called with each parsed mood. */
  onMood: (mood: Mood) => void;
}

const TEXT_NODE = 3;

export class TranscriptMoodObserver {
  private readonly root: Node;
  private readonly onMood: (mood: Mood) => void;
  private observer: MutationObserver | null = null;

  constructor(options: TranscriptMoodObserverOptions) {
    this.root = options.root;
    this.onMood = options.onMood;
  }

  start(): void {
    if (this.observer) {
      return;
    }
    // Strip anything already present, then watch for new/streamed text.
    this.processNode(this.root);
    this.observer = new MutationObserver((records) => this.handle(records));
    this.observer.observe(this.root, { childList: true, subtree: true, characterData: true });
  }

  dispose(): void {
    this.observer?.disconnect();
    this.observer = null;
  }

  private handle(records: MutationRecord[]): void {
    for (const record of records) {
      if (record.type === 'characterData') {
        this.processNode(record.target);
      } else {
        record.addedNodes.forEach((node) => this.processNode(node));
      }
    }
  }

  private processNode(node: Node): void {
    if (node.nodeType === TEXT_NODE) {
      this.processText(node as Text);
      return;
    }
    node.childNodes.forEach((child) => this.processNode(child));
  }

  private processText(text: Text): void {
    const data = text.data;
    if (!data || data.indexOf('<<') === -1) {
      return;
    }
    const parsed = parseMoodMarker(data);
    if (parsed.stripped !== data) {
      text.data = parsed.stripped;
    }
    if (parsed.mood) {
      this.onMood(parsed.mood);
    }
  }
}
