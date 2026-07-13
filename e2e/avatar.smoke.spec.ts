import { test, expect } from '@playwright/test';

/**
 * End-to-end smoke: the demo must render a real WebGL canvas and transition
 * through all four avatar states without page errors. Screenshots of each state
 * are saved under test-results/ for visual inspection.
 */
test('renders a WebGL canvas and cycles through all four states', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/demo/');

  const canvas = page.locator('#avatar-root canvas');
  await expect(canvas).toBeVisible();

  // The canvas has real dimensions and a live WebGL context.
  const ready = await page.evaluate(() => {
    const c = document.querySelector('#avatar-root canvas') as HTMLCanvasElement | null;
    if (!c || c.width === 0 || c.height === 0) {
      return false;
    }
    return Boolean(c.getContext('webgl2') ?? c.getContext('webgl'));
  });
  expect(ready).toBe(true);

  for (const state of ['listening', 'thinking', 'speaking', 'idle'] as const) {
    await page.click(`button[data-state="${state}"]`);
    await expect(page.locator('#status')).toContainText(state);
    await page.screenshot({ path: `test-results/state-${state}.png` });
  }

  expect(pageErrors).toEqual([]);
});
