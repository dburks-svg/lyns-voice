import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end smoke config (Phase 4).
 *
 * Boots the Vite dev server and drives the standalone demo in headless
 * Chromium to assert the canvas/WebGL context initialises and the four avatar
 * states transition. Chromium is installed on demand via `npm run e2e:install`.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5173/demo/',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
