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

test('rapid presses debounce into a single speak (no same-tick cancel storm)', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __speaks: number }).__speaks = 0;
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        speak(u: SpeechSynthesisUtterance) {
          (window as unknown as { __speaks: number }).__speaks += 1;
          setTimeout(() => u.dispatchEvent(new Event('start')), 10);
          setTimeout(() => u.dispatchEvent(new Event('end')), 900); // long enough to observe
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
  // Click synchronously many times in one tick (the debounce window).
  await page.evaluate(() => {
    const b = document.getElementById('speak-test');
    for (let i = 0; i < 6; i += 1) {
      b?.click();
    }
  });
  await expect(page.locator('#status')).toContainText('speaking', { timeout: 2000 });
  const speaks = await page.evaluate(() => (window as unknown as { __speaks: number }).__speaks);
  expect(speaks).toBe(1); // six presses coalesced into one utterance
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
