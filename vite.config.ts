import { defineConfig } from 'vite';

/**
 * Dev server + demo build.
 *
 * The standalone demo (`demo/index.html`) imports the avatar source directly
 * through Vite for fast iteration. The production/injected artifact is built
 * separately by `vite.lib.config.ts` as a global IIFE.
 *
 * Bound to localhost only (no `0.0.0.0`) so the dev server is never exposed on
 * the LAN.
 */
export default defineConfig({
  root: '.',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
    // Auto-open is intentionally off: the e2e runner starts this server
    // headlessly, and the demo browser is opened explicitly when desired.
    open: false,
  },
  build: {
    outDir: 'dist-demo',
    emptyOutDir: true,
  },
});
