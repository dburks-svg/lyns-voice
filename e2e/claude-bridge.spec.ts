import { test, expect, type Page } from '@playwright/test';
import {
  installTauriMock,
  emitTauriEvent,
  getInvokeCalls,
} from './helpers/tauri-mock';

/**
 * Claude bridge integration with a mocked Tauri backend. Tests the connect
 * flow and verifies that turn-end events surface in the caption (mood-stripped).
 */

/** Open the settings drawer and wait for the observable open state (the drawer
 *  animates via CSS, so the un-hidden attribute is the ready signal). */
async function openSettings(page: Page): Promise<void> {
  await page.click('#settings-btn');
  await expect(page.locator('#settings-drawer')).not.toHaveAttribute('hidden', '');
}

/** Connect to a project dir and wait until the mock actually received claude_start. */
async function connectClaude(page: Page, dir: string): Promise<void> {
  await page.locator('#claude-dir').fill(dir);
  await page.click('#claude-btn');
  await expect
    .poll(async () => (await getInvokeCalls(page)).map((c) => c.cmd))
    .toContain('claude_start');
}

test('connect button calls claude_start and updates UI', async ({ page }) => {
  await installTauriMock(page, {
    claude_start: () => null,
    tts_list_voices: () => [],
  });

  await page.goto('/');
  await openSettings(page);
  await connectClaude(page, '/test/project');

  const calls = await getInvokeCalls(page);
  const startCall = calls.find((c) => c.cmd === 'claude_start');
  expect(startCall).toBeTruthy();
  expect((startCall?.args as Record<string, unknown>)?.dir).toBe(
    '/test/project',
  );
});

test('claude://ready event updates the caption', async ({ page }) => {
  await installTauriMock(page, {
    claude_start: () => 'claude-1',
    tts_list_voices: () => [],
  });

  await page.goto('/');
  await openSettings(page);
  await connectClaude(page, '/test/project');

  await emitTauriEvent(page, 'claude://claude-1/ready', {
    active: true,
    cwd: '/test/project',
  });

  const caption = page.locator('#caption');
  await expect(caption).toContainText('Claude connected');
});

test('claude://turn-end with mood tag strips the marker from caption', async ({
  page,
}) => {
  await installTauriMock(page, {
    claude_start: () => 'claude-1',
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
  await openSettings(page);
  await connectClaude(page, '/test/project');

  await emitTauriEvent(page, 'claude://claude-1/turn-end', {
    text: '<<mood:happy>>Hello from Claude!',
    is_error: false,
  });

  const caption = page.locator('#caption');
  await expect(caption).toContainText('Hello from Claude!');
  await expect(caption).not.toContainText('<<mood');
});
