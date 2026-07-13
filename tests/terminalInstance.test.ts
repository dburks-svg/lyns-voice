import { describe, it, expect } from 'vitest';
import { base64ToBytes } from '../src/app/terminal/TerminalInstance';

// The Rust side (terminal.rs) batches raw PTY bytes and emits them base64-encoded
// (STANDARD alphabet, padded); this must round-trip them bit-exactly, including
// ANSI escapes and bytes above 0x7f (box-drawing, UTF-8 continuation bytes).
describe('base64ToBytes', () => {
  it('round-trips shell output bytes', () => {
    const bytes = [72, 101, 108, 108, 111, 13, 10, 27, 91, 51, 49, 109]; // Hello\r\n ESC[31m
    const b64 = btoa(String.fromCharCode(...bytes));
    expect(Array.from(base64ToBytes(b64))).toEqual(bytes);
  });

  it('round-trips binary bytes above 0x7f', () => {
    const bytes = [0, 127, 128, 200, 255];
    const b64 = btoa(String.fromCharCode(...bytes));
    expect(Array.from(base64ToBytes(b64))).toEqual(bytes);
  });

  it('returns an empty array for an empty payload', () => {
    expect(base64ToBytes('').length).toBe(0);
  });
});
