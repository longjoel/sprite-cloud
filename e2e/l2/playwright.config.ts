import { defineConfig } from "@playwright/test";

// L2 drives the full gateway journey: sc-web (Next.js, port 3000) + a
// paired sc-server (port 8787). Chrome (H.264) is required — see L1.
export default defineConfig({
  testDir: "./tests",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    // GitHub runners ship Google Chrome (H.264-capable). Local override:
    //   L2_CHROME_BIN=/snap/bin/chromium
    channel: process.env.CHANNEL || "chrome",
    launchOptions: {
      executablePath: process.env.L2_CHROME_BIN || undefined,
      args: [
        "--no-sandbox",
        "--autoplay-policy=no-user-gesture-required",
        "--use-fake-ui-for-media-stream",
      ],
    },
    baseURL: process.env.GATEWAY_URL || "http://127.0.0.1:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
