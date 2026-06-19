import { defineConfig } from 'vitest/config';

/**
 * Unit-test runner config. Uses happy-dom so DOM/Web APIs (canvas element,
 * SpeechSynthesisUtterance shims, AnalyserNode mocks) are available without a
 * real browser. WebGL is not provided by happy-dom, so renderer-dependent code
 * is exercised through mocks; pure logic (noise, deformation, state machine,
 * injector) is tested directly.
 */
export default defineConfig({
  test: {
    environment: 'happy-dom',
    globals: true,
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'scripts/**/*.mjs'],
    },
  },
});
