import { test, expect } from '@playwright/test';

/**
 * Settings drawer and theme switching. These controls are pure DOM + localStorage
 * and do not require a Tauri backend, so no IPC mock is needed.
 *
 * The drawer uses a CSS transition (opacity 0 -> 1) with `display: block` even
 * when `hidden`, so we assert on the attribute rather than Playwright visibility.
 */

test('settings drawer toggles open and closed', async ({ page }) => {
  await page.goto('/');
  const drawer = page.locator('#settings-drawer');
  await expect(drawer).toHaveAttribute('hidden', '');

  await page.click('#settings-btn');
  await expect(drawer).not.toHaveAttribute('hidden', '');

  await page.click('#settings-btn');
  await expect(drawer).toHaveAttribute('hidden', '');
});

test('theme buttons switch the active class', async ({ page }) => {
  await page.goto('/');
  await page.click('#settings-btn');
  await page.waitForTimeout(300);

  for (const theme of ['cyan', 'aurora', 'ember'] as const) {
    await page.click(`.theme-btn[data-theme="${theme}"]`);
    const active = page.locator('.theme-btn.active');
    await expect(active).toHaveAttribute('data-theme', theme);
  }
});

test('theme choice persists across reload', async ({ page }) => {
  await page.goto('/');
  await page.click('#settings-btn');
  await page.waitForTimeout(300);
  await page.click('.theme-btn[data-theme="ember"]');

  await page.reload();
  await page.click('#settings-btn');
  await page.waitForTimeout(300);
  const active = page.locator('.theme-btn.active');
  await expect(active).toHaveAttribute('data-theme', 'ember');
});

test('TTS rate slider updates its displayed value', async ({ page }) => {
  await page.goto('/');
  await page.click('#settings-btn');
  await page.waitForTimeout(300);

  const slider = page.locator('#set-rate');
  const val = page.locator('#set-rate-val');

  await slider.fill('5');
  await slider.dispatchEvent('input');
  await expect(val).toHaveText('5');
});
