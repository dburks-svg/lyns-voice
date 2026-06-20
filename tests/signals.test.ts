import { describe, it, expect } from 'vitest';
import { deriveState } from '../src/integration/signals';
import { safeSetText } from '../src/integration/dom';

describe('deriveState', () => {
  it('prioritises speaking > listening > thinking > idle', () => {
    expect(deriveState({ speaking: true, micActive: true, pendingResponse: true })).toBe('speaking');
    expect(deriveState({ speaking: false, micActive: true, pendingResponse: true })).toBe(
      'listening',
    );
    expect(deriveState({ speaking: false, micActive: false, pendingResponse: true })).toBe(
      'thinking',
    );
    expect(deriveState({ speaking: false, micActive: false, pendingResponse: false })).toBe('idle');
  });
});

describe('safeSetText', () => {
  it('writes textContent and never parses markup (XSS-safe)', () => {
    const element = document.createElement('div');
    safeSetText(element, '<img src=x onerror=alert(1)>');
    expect(element.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(element.querySelector('img')).toBeNull();
    expect(element.children.length).toBe(0);
  });

  it('is a no-op for a null element', () => {
    expect(() => safeSetText(null, 'whatever')).not.toThrow();
  });
});
