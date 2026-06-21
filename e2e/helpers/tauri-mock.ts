import { type Page } from '@playwright/test';

/**
 * Install a mock `__TAURI_INTERNALS__` on the page before navigation.
 * This intercepts all Tauri IPC calls (invoke + event listen) so the app
 * shell at `/` can bootstrap without a real Tauri backend.
 *
 * Must be called BEFORE `page.goto('/')`.
 */
/**
 * Seed settings so the first-run onboarding overlay never intercepts test clicks.
 * Merges into any existing settings (runs on every navigation, so it must not clobber
 * values a test persisted before a reload, e.g. the chosen theme).
 */
export async function seedOnboarded(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      const KEY = 'q-app-settings';
      const cur = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
      cur.onboarded = true;
      localStorage.setItem(KEY, JSON.stringify(cur));
    } catch {
      /* localStorage unavailable; ignore */
    }
  });
}

export async function installTauriMock(
  page: Page,
  invokeHandlers?: Record<string, (args: Record<string, unknown>) => unknown>,
): Promise<void> {
  const handlersJson = JSON.stringify(
    Object.fromEntries(
      Object.entries(invokeHandlers ?? {}).map(([k, v]) => [k, v.toString()]),
    ),
  );

  await seedOnboarded(page);
  await page.addInitScript((serialized: string) => {
    const handlers: Record<string, (a: Record<string, unknown>) => unknown> = {};
    for (const [cmd, fnStr] of Object.entries(
      JSON.parse(serialized) as Record<string, string>,
    )) {
      handlers[cmd] = new Function('return (' + fnStr + ')')() as (
        a: Record<string, unknown>,
      ) => unknown;
    }

    let nextId = 1;
    const callbacks: Record<number, (payload: unknown) => void> = {};
    const eventListeners: Record<string, number[]> = {};
    const invokeCalls: Array<{ cmd: string; args: unknown }> = [];

    const tauriInternals = {
      invoke(cmd: string, args?: Record<string, unknown>) {
        invokeCalls.push({ cmd, args });

        if (cmd === 'plugin:event|listen') {
          const event = (args as Record<string, unknown>)?.event as string;
          const handler = (args as Record<string, unknown>)?.handler as number;
          if (!eventListeners[event]) eventListeners[event] = [];
          eventListeners[event].push(handler);
          return Promise.resolve(nextId++);
        }
        if (cmd === 'plugin:event|unlisten') {
          return Promise.resolve();
        }

        if (handlers[cmd]) {
          try {
            return Promise.resolve(handlers[cmd](args ?? {}));
          } catch (e) {
            return Promise.reject(e);
          }
        }
        return Promise.resolve(null);
      },

      transformCallback(fn: (payload: unknown) => void, _once?: boolean) {
        const id = nextId++;
        callbacks[id] = fn;
        return id;
      },

      convertFileSrc(path: string) {
        return path;
      },

      metadata: {
        currentWindow: { label: 'main' },
        currentWebview: { label: 'main' },
      },
    };

    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ =
      tauriInternals;

    (window as unknown as Record<string, unknown>).__TAURI_TEST__ = {
      invokeCalls,
      emit(event: string, payload: unknown) {
        for (const cbId of eventListeners[event] ?? []) {
          callbacks[cbId]?.({ event, id: cbId, payload });
        }
      },
    };
  }, handlersJson);
}

/**
 * Fire a synthetic Tauri event from the test side.
 * The app's registered `listen` handlers for that event will be called.
 */
export async function emitTauriEvent(
  page: Page,
  event: string,
  payload: unknown,
): Promise<void> {
  await page.evaluate(
    ({ event: e, payload: p }) => {
      const test = (window as unknown as Record<string, unknown>)
        .__TAURI_TEST__ as {
        emit: (event: string, payload: unknown) => void;
      };
      test.emit(e, p);
    },
    { event, payload },
  );
}

/** Return all recorded invoke calls from the mock. */
export async function getInvokeCalls(
  page: Page,
): Promise<Array<{ cmd: string; args: unknown }>> {
  return page.evaluate(() => {
    const test = (window as unknown as Record<string, unknown>)
      .__TAURI_TEST__ as {
      invokeCalls: Array<{ cmd: string; args: unknown }>;
    };
    return test.invokeCalls;
  });
}
