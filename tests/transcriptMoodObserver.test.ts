import { describe, it, expect, vi } from 'vitest';
import { TranscriptMoodObserver } from '../src/integration/transcriptMoodObserver';
import type { Mood } from '../src/mood/moods';

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('TranscriptMoodObserver', () => {
  it('strips a marker already present and emits the mood on start', () => {
    const root = document.createElement('div');
    const msg = document.createElement('div');
    msg.textContent = '<<mood:happy>> Online and ready';
    root.appendChild(msg);

    const moods: Mood[] = [];
    const observer = new TranscriptMoodObserver({ root, onMood: (m) => moods.push(m) });
    observer.start();

    expect(msg.textContent).toBe('Online and ready');
    expect(moods).toEqual(['happy']);
    observer.dispose();
  });

  it('rewrites only text (no markup injection) and is XSS-safe', () => {
    const root = document.createElement('div');
    const msg = document.createElement('div');
    msg.textContent = '<<mood:error>><img src=x onerror=boom>';
    root.appendChild(msg);

    const moods: Mood[] = [];
    const observer = new TranscriptMoodObserver({ root, onMood: (m) => moods.push(m) });
    observer.start();

    expect(moods).toEqual(['error']);
    // The marker is gone; the rest stays literal text, never a real element.
    expect(msg.textContent).toBe('<img src=x onerror=boom>');
    expect(msg.querySelector('img')).toBeNull();
    observer.dispose();
  });

  it('strips markers in messages added after start', async () => {
    const root = document.createElement('div');
    const onMood = vi.fn();
    const observer = new TranscriptMoodObserver({ root, onMood });
    observer.start();

    const msg = document.createElement('div');
    msg.textContent = '<<mood:curious>> Investigating';
    root.appendChild(msg);

    await flush();
    expect(onMood).toHaveBeenCalledWith('curious');
    expect(msg.textContent).toBe('Investigating');
    observer.dispose();
  });

  it('emits the mood exactly once and converges (self-mutation is idempotent)', async () => {
    const root = document.createElement('div');
    const onMood = vi.fn();
    const observer = new TranscriptMoodObserver({ root, onMood });
    observer.start();

    const msg = document.createElement('div');
    msg.textContent = '<<mood:happy>> hi';
    root.appendChild(msg);

    await flush();
    await flush(); // let the self-triggered characterData mutation settle

    expect(onMood).toHaveBeenCalledTimes(1); // the rewrite does not re-emit
    expect(msg.textContent).toBe('hi');
    observer.dispose();
  });

  it('stops processing after dispose', async () => {
    const root = document.createElement('div');
    const onMood = vi.fn();
    const observer = new TranscriptMoodObserver({ root, onMood });
    observer.start();
    observer.dispose();

    const msg = document.createElement('div');
    msg.textContent = '<<mood:happy>> later';
    root.appendChild(msg);

    await flush();
    expect(onMood).not.toHaveBeenCalled();
    expect(msg.textContent).toBe('<<mood:happy>> later');
  });
});
