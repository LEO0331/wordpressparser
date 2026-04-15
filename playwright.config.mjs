import { defineConfig } from "@playwright/test";

const port = Number(process.env.E2E_PORT || 4173);

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  outputDir: "output/playwright",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    headless: true
  },
  webServer: {
    command: `PORT=${port} node server.js`,
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000
  }
});
