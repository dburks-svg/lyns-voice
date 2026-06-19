import { test, expect } from '@playwright/test';

/**
 * The demo Speak button must drive the speaking state. We test both paths with a
 * fake speechSynthesis installed before the page loads (headless browsers often
 * have no TTS voice, exactly the situation the visual fallback exists for):
 *   1. when the engine fires start/boundary/end -> the SpeechReactor drives it;
 *   2. when the engine is silent -> the demo's visual fallback drives it.
 */

test('speak drives the speaking state when the engine fires events', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        speak(u: SpeechSynthesisUtterance) {
          setTimeout(() => u.dispatchEvent(new Event('start')), 10);
          setTimeout(() => {
            const e = new Event('boundary') as Event & { name?: string };
            e.name = 'word';
            u.dispatchEvent(e);
          }, 40);
          setTimeout(() => u.dispatchEvent(new Event('end')), 200);
        },
        cancel() {},
        pause() {},
        resume() {},
        getVoices: () => [],
      },
    });
  });

  await page.goto('/demo/');
  await page.waitForTimeout(1200);
  await page.click('#speak-test');
  await expect(page.locator('#status')).toContainText('speaking', { timeout: 2000 });
  await expect(page.locator('#status')).toContainText('idle', { timeout: 2000 });
});

test('speak still animates via the visual fallback when the engine is silent', async ({ page }) => {
  await page.addInitScript(() => {
    // A speechSynthesis that accepts speak() but never fires any event.
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: { speak() {}, cancel() {}, pause() {}, resume() {}, getVoices: () => [] },
    });
  });

  await page.goto('/demo/');
  await page.waitForTimeout(1200);
  await page.click('#speak-test');
  // No engine events fire, so the demo's ~350ms fallback drives the animation.
  await expect(page.locator('#status')).toContainText('speaking', { timeout: 2000 });
});
