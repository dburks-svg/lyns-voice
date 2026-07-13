import { defineConfig } from 'vite';

/**
 * Dev server + build for the Q desktop app (Tauri webview) and the
 * standalone demo.
 *
 * The app entry is the root `index.html`; the host-free demo stays at
 * `/demo/`. Both import the avatar source directly through Vite, with npm
 * `three` as a normal ESM dependency. Bound to localhost only.
 *
 * `strictPort` is required so Tauri's `devUrl` (http://localhost:5173) never
 * drifts out from under the desktop shell. `clearScreen: false` keeps Tauri's
 * compile logs visible.
 */
export default defineConfig({
  root: '.',
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    open: false,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'esnext',
    rollupOptions: {
      input: {
        main: 'index.html',
        demo: 'demo/index.html',
      },
    },
  },
});
