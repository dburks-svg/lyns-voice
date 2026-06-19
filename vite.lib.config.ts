import { defineConfig } from 'vite';

/**
 * Builds the injectable global bundle `dist/avatar.js` consumed by the
 * `mcp-voice-hooks` page.
 *
 * `three` is kept external and bound to the global `THREE` that the vendored
 * `vendor/three.min.js` installs before this script runs. This keeps the bundle
 * small and mirrors the host page's non-module script environment.
 */
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: true,
    lib: {
      entry: 'src/bundle.ts',
      name: 'JarvisAvatar',
      formats: ['iife'],
      fileName: () => 'avatar.js',
    },
    rollupOptions: {
      external: ['three'],
      output: {
        globals: { three: 'THREE' },
        extend: true,
      },
    },
  },
});
