import { describe, it, expect, vi, afterEach } from 'vitest';
import * as THREE from 'three';
import { attachToVoiceHooks, isMicButtonActive } from '../src/integration/voiceHooksAdapter';

function mockRendererFactory() {
  return (canvas: HTMLCanvasElement): THREE.WebGLRenderer =>
    ({
      domElement: canvas,
      render: vi.fn(),
      setSize: vi.fn(),
      setPixelRatio: vi.fn(),
      setClearColor: vi.fn(),
      dispose: vi.fn(),
    }) as unknown as THREE.WebGLRenderer;
}

type WinWithRecognition = { webkitSpeechRecognition?: unknown };

describe('isMicButtonActive', () => {
  it('detects active state via aria-pressed or a class hint', () => {
    const button = document.createElement('button');
    expect(isMicButtonActive(button)).toBe(false);
    button.setAttribute('aria-pressed', 'true');
    expect(isMicButtonActive(button)).toBe(true);
    button.removeAttribute('aria-pressed');
    for (const cls of ['mic listening', 'mic recording', 'mic active']) {
      button.className = cls;
      expect(isMicButtonActive(button)).toBe(true);
    }
    button.className = 'mic';
    expect(isMicButtonActive(button)).toBe(false);
  });
});

describe('attachToVoiceHooks', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    delete (window as unknown as WinWithRecognition).webkitSpeechRecognition;
  });

  it('mounts an overlay, maps recognition start/end to states, and tears down on dispose', () => {
    class FakeRecognition extends EventTarget {}
    (window as unknown as WinWithRecognition).webkitSpeechRecognition = FakeRecognition;

    const handle = attachToVoiceHooks(document, { rendererFactory: mockRendererFactory() });

    expect(document.getElementById('jarvis-avatar-overlay')).not.toBeNull();
    expect(handle.controller.current).toBe('idle');

    const Ctor = (window as unknown as WinWithRecognition).webkitSpeechRecognition as new () => EventTarget;
    const recognition = new Ctor();
    recognition.dispatchEvent(new Event('start'));
    expect(handle.controller.current).toBe('listening');
    recognition.dispatchEvent(new Event('end'));
    expect(handle.controller.current).toBe('thinking');

    handle.dispose();
    expect(document.getElementById('jarvis-avatar-overlay')).toBeNull();
    // Constructor restored to the genuine original (no clobber).
    expect((window as unknown as WinWithRecognition).webkitSpeechRecognition).toBe(FakeRecognition);
  });

  it('degrades gracefully when host elements and SpeechRecognition are absent', () => {
    expect(() => {
      const handle = attachToVoiceHooks(document, { rendererFactory: mockRendererFactory() });
      handle.dispose();
    }).not.toThrow();
  });
});
