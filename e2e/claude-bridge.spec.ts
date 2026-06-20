import { test, expect } from '@playwright/test';
import {
  installTauriMock,
  emitTauriEvent,
  getInvokeCalls,
} from './helpers/tauri-mock';

/**
 * Claude bridge integration with a mocked Tauri backend. Tests the connect
 * flow and verifies that turn-end events surface in the caption (mood-stripped).
 */

test('connect button calls claude_start and updates UI', async ({ page }) => {
  await installTauriMock(page, {
    claude_start: () => null,
    tts_list_voices: () => [],
  });

  await page.goto('/');
  await page.click('#settings-btn');
  await page.waitForTimeout(300);

  const dirInput = page.locator('#claude-dir');
  await dirInput.fill('/test/project');

  const connectBtn = page.locator('#claude-btn');
  await connectBtn.click();
  await page.waitForTimeout(800);

  const calls = await getInvokeCalls(page);
  const startCall = calls.find((c) => c.cmd === 'claude_start');
  expect(startCall).toBeTruthy();
  expect((startCall?.args as Record<string, unknown>)?.dir).toBe(
    '/test/project',
  );
});

test('claude://ready event updates the caption', async ({ page }) => {
  await installTauriMock(page, {
    claude_start: () => null,
    tts_list_voices: () => [],
  });

  await page.goto('/');
  await page.click('#settings-btn');
  await page.waitForTimeout(300);

  const dirInput = page.locator('#claude-dir');
  await dirInput.fill('/test/project');
  await page.click('#claude-btn');
  await page.waitForTimeout(800);

  await emitTauriEvent(page, 'claude://ready', {
    active: true,
    cwd: '/test/project',
  });
  await page.waitForTimeout(200);

  const caption = page.locator('#caption');
  await expect(caption).toContainText('Claude connected');
});

test('claude://turn-end with mood tag strips the marker from caption', async ({
  page,
}) => {
  await installTauriMock(page, {
    claude_start: () => null,
    tts_synthesize: () => [],
    tts_list_voices: () => [],
  });

  await page.addInitScript(() => {
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        speak() {},
        cancel() {},
        pause() {},
        resume() {},
        getVoices: () => [],
      },
    });
  });

  await page.goto('/');
  await page.click('#settings-btn');
  await page.waitForTimeout(300);

  const dirInput = page.locator('#claude-dir');
  await dirInput.fill('/test/project');
  await page.click('#claude-btn');
  await page.waitForTimeout(800);

  await emitTauriEvent(page, 'claude://turn-end', {
    text: '<<mood:happy>>Hello from Claude!',
    is_error: false,
  });
  await page.waitForTimeout(500);

  const caption = page.locator('#caption');
  const text = await caption.textContent();
  expect(text).toContain('Hello from Claude!');
  expect(text).not.toContain('<<mood');
});
