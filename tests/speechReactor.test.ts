import { describe, it, expect, vi, afterEach } from 'vitest';
import { SpeechReactor } from '../src/audio/SpeechReactor';

function fakeUtterance(): SpeechSynthesisUtterance {
  return new EventTarget() as unknown as SpeechSynthesisUtterance;
}

function boundaryEvent(name: string): Event {
  const event = new Event('boundary');
  Object.assign(event, { name });
  return event;
}

describe('SpeechReactor', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('wraps speak, reports start/word-boundary/end, and still calls the original speak', () => {
    const speak = vi.fn();
    const synthesis = { speak } as unknown as SpeechSynthesis;
    const onSpeakingStart = vi.fn();
    const onSpeakingEnd = vi.fn();
    const onBoundary = vi.fn();
    const reactor = new SpeechReactor({ synthesis, onSpeakingStart, onSpeakingEnd, onBoundary });
    reactor.attach();

    const utterance = fakeUtterance();
    synthesis.speak(utterance);
    expect(speak).toHaveBeenCalledWith(utterance);

    utterance.dispatchEvent(new Event('start'));
    expect(onSpeakingStart).toHaveBeenCalledTimes(1);
    expect(reactor.isSpeaking).toBe(true);

    utterance.dispatchEvent(boundaryEvent('word'));
    expect(onBoundary).toHaveBeenCalledTimes(1);
    utterance.dispatchEvent(boundaryEvent('sentence'));
    expect(onBoundary).toHaveBeenCalledTimes(1); // non-word boundaries ignored

    utterance.dispatchEvent(new Event('end'));
    expect(onSpeakingEnd).toHaveBeenCalledTimes(1);
    expect(reactor.isSpeaking).toBe(false);
  });

  it('emits a synthetic envelope when no native boundaries arrive, then yields to native ones', () => {
    vi.useFakeTimers();
    const synthesis = { speak: vi.fn() } as unknown as SpeechSynthesis;
    const onBoundary = vi.fn();
    const reactor = new SpeechReactor({ synthesis, onBoundary, syntheticIntervalMs: 100 });
    reactor.attach();

    const utterance = fakeUtterance();
    synthesis.speak(utterance);
    utterance.dispatchEvent(new Event('start'));

    vi.advanceTimersByTime(100);
    expect(onBoundary).toHaveBeenCalledTimes(1); // synthetic impulse

    utterance.dispatchEvent(boundaryEvent('word')); // a real boundary arrives
    expect(onBoundary).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(300);
    expect(onBoundary).toHaveBeenCalledTimes(2); // synthetic suppressed once native seen
  });

  it('detach restores the original speak so new utterances are not bound', () => {
    const synthesis = { speak: vi.fn() } as unknown as SpeechSynthesis;
    const onSpeakingStart = vi.fn();
    const reactor = new SpeechReactor({ synthesis, onSpeakingStart });
    reactor.attach();
    reactor.detach();

    const utterance = fakeUtterance();
    synthesis.speak(utterance);
    utterance.dispatchEvent(new Event('start'));
    expect(onSpeakingStart).not.toHaveBeenCalled();
  });
});
