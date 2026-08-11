import { defineConfig } from '@playwright/test';

/**
 * L1 browser E2E (#662 slice 2).
 *
 * Runs headless Chrome against a locally-started sc-server in standalone
 * mode (LAN player page on 127.0.0.1:8787). The server + ROM + core are
 * provided by run-l1.sh; this config only controls the browser.
 *
 * Chrome (not Playwright's Chromium) is required: the server encodes H.264
 * and the fixture asserts decoded frames, so the browser must ship the
 * proprietary H.264 decoder. `channel: 'chrome'` uses the system Google
 * Chrome (present on ubuntu-latest runners and dev boxes with Chrome
 * installed). Override with CHANNEL=chromium only if your Chromium build
 * includes H.264.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'results.json' }]],
  use: {
    channel: process.env.L1_CHROME_BIN ? undefined : process.env.CHANNEL || 'chrome',
    headless: true,
    launchOptions: {
      executablePath: process.env.L1_CHROME_BIN || undefined,
      args: [
        '--no-sandbox',
        '--autoplay-policy=no-user-gesture-required',
        '--use-fake-ui-for-media-stream',
      ],
    },
    baseURL: process.env.L1_BASE_URL || 'http://127.0.0.1:8787',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
