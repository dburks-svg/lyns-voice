import { test, expect } from '@playwright/test';
import { installTauriMock } from './helpers/tauri-mock';

/**
 * Verifies the app shell bootstraps correctly with a mocked Tauri backend,
 * including the WebGL orb and HUD controls.
 */

test('orb renders with mocked Tauri backend', async ({ page }) => {
  await installTauriMock(page, {
    tts_list_voices: () => [],
  });

  await page.goto('/');

  const canvas = page.locator('#avatar-root canvas');
  await expect(canvas).toBeVisible();
  const hasWebGL = await page.evaluate(() => {
    const c = document.querySelector(
      '#avatar-root canvas',
    ) as HTMLCanvasElement | null;
    if (!c || c.width === 0 || c.height === 0) return false;
    return Boolean(c.getContext('webgl2') ?? c.getContext('webgl'));
  });
  expect(hasWebGL).toBe(true);
});

test('session strip shows telemetry labels', async ({ page }) => {
  await installTauriMock(page, {
    tts_list_voices: () => [],
  });

  await page.goto('/');

  await expect(page.locator('#hud-tokens-in')).toBeVisible();
  await expect(page.locator('#hud-tokens-out')).toBeVisible();
  await expect(page.locator('#hud-cost')).toBeVisible();
  await expect(page.locator('#hud-turns')).toBeVisible();
  await expect(page.locator('#hud-uptime')).toBeVisible();
});
