import { test, expect } from '@playwright/test';
import { installTauriMock, getInvokeCalls } from './helpers/tauri-mock';

/**
 * Terminal panel lifecycle with a mocked Tauri backend. The terminal manager
 * requires `__TAURI_INTERNALS__` to be present (main.ts gates on it), so we
 * install the mock before navigation.
 */

test('clicking "+ terminal" spawns a terminal panel', async ({ page }) => {
  await installTauriMock(page, {
    terminal_spawn: () => 'term-1',
  });
  await page.goto('/');
  // Bootstrap is done when the version label lands in #status (wired last).
  await expect(page.locator('#status')).toContainText('LYNS Voice v');

  await page.click('#terminal-btn');

  const panel = page.locator('#terminal-layer .terminal-window');
  await expect(panel.first()).toBeVisible({ timeout: 3000 });

  const calls = await getInvokeCalls(page);
  const spawnCall = calls.find((c) => c.cmd === 'terminal_spawn');
  expect(spawnCall).toBeTruthy();
});

test('terminal panel has a tab bar for drag', async ({ page }) => {
  await installTauriMock(page, {
    terminal_spawn: () => 'term-1',
  });
  await page.goto('/');
  await expect(page.locator('#status')).toContainText('LYNS Voice v');

  await page.click('#terminal-btn');
  const tabBar = page.locator('#terminal-layer .terminal-window .terminal-tabs');
  await expect(tabBar.first()).toBeVisible({ timeout: 3000 });
});
