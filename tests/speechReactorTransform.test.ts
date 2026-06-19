import { describe, it, expect, vi } from 'vitest';
import { SpeechReactor } from '../src/audio/SpeechReactor';

/** Minimal fake utterance/synthesis so the patched speak path can be exercised. */
function fakeUtterance(text: string): SpeechSynthesisUtterance {
  return { text, addEventListener: vi.fn() } as unknown as SpeechSynthesisUtterance;
}

function fakeSynthesis() {
  const speak = vi.fn();
  const synthesis = { speak } as unknown as SpeechSynthesis;
  return { synthesis, speak };
}

describe('SpeechReactor transformText', () => {
  it('rewrites utterance text before speaking', () => {
    const { synthesis, speak } = fakeSynthesis();
    const reactor = new SpeechReactor({
      synthesis,
      transformText: (text) => text.replace('<<mood:happy>> ', ''),
    });
    reactor.attach();

    const utterance = fakeUtterance('<<mood:happy>> Hello sir');
    synthesis.speak(utterance);

    expect(utterance.text).toBe('Hello sir'); // marker stripped before speaking
    expect(speak).toHaveBeenCalledTimes(1);
    reactor.detach();
  });

  it('leaves text byte-identical when no transform is given', () => {
    const { synthesis, speak } = fakeSynthesis();
    const reactor = new SpeechReactor({ synthesis });
    reactor.attach();

    const utterance = fakeUtterance('Unchanged text');
    synthesis.speak(utterance);

    expect(utterance.text).toBe('Unchanged text');
    expect(speak).toHaveBeenCalledTimes(1);
    reactor.detach();
  });

  it('never blocks speech if the transform throws', () => {
    const { synthesis, speak } = fakeSynthesis();
    const reactor = new SpeechReactor({
      synthesis,
      transformText: () => {
        throw new Error('bad transform');
      },
    });
    reactor.attach();

    const utterance = fakeUtterance('Still speaks');
    synthesis.speak(utterance);

    expect(utterance.text).toBe('Still speaks'); // unchanged
    expect(speak).toHaveBeenCalledTimes(1); // still spoken
    reactor.detach();
  });
});
