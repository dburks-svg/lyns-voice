import { test, expect } from '@playwright/test';

/**
 * End-to-end smoke for the FUI app shell at `/` (the Tauri webview entry). It
 * renders the holographic orb (a real WebGL canvas), the four telemetry panels,
 * and the TAP TO TALK mic, and cycles state through the HUD. No Tauri backend is
 * needed: the adapter's invoke/listen calls reject outside Tauri and are
 * swallowed, and the orb renders without them.
 */
test('renders the WebGL orb, telemetry panels, mic, and cycles state', async ({ page }) => {
  await page.goto('/');

  // The holographic orb is a real, sized WebGL canvas mounted full-window.
  const canvas = page.locator('#avatar-root canvas');
  await expect(canvas).toBeVisible();
  const ready = await page.evaluate(() => {
    const c = document.querySelector('#avatar-root canvas') as HTMLCanvasElement | null;
    if (!c || c.width === 0 || c.height === 0) return false;
    return Boolean(c.getContext('webgl2') ?? c.getContext('webgl'));
  });
  expect(ready).toBe(true);

  // The four floating telemetry panels and the TAP TO TALK mic are present.
  await expect(page.locator('.panel')).toHaveCount(4);
  await expect(page.locator('#mic-fab')).toBeVisible();

  // Cycling a state from the HUD reflects onto body[data-state] (the CSS hook the
  // adapter drives; #status is the app's message/version label, not the state).
  await page.click('button[data-state="thinking"]');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'thinking');

  await page.screenshot({ path: 'test-results/fui-app.png' });
});
