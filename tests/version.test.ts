import { describe, it, expect } from 'vitest';
import pkg from '../package.json';
import { VERSION } from '../src/index';

describe('VERSION', () => {
  it('matches package.json version (single source of truth)', () => {
    expect(VERSION).toBe(pkg.version);
  });
});
