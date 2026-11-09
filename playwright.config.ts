import { defineConfig } from "@playwright/test";

const PORT = 3100;

// End-to-end tests start the real server (which also serves the built client) and
// drive real browsers. Locally the installed Chrome is used so that nothing has to
// be downloaded; in CI `playwright install chromium` provides the browser.
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    ...(process.env.CI ? {} : { channel: "chrome" }),
  },
  webServer: {
    command: "npm run build && npm start",
    url: `http://127.0.0.1:${PORT}/health`,
    env: { PORT: String(PORT), HOST: "127.0.0.1" },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
