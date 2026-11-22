// Browser tests. Uses a locally installed Chromium when CHROME_PATH is set
// (CI images without Playwright-managed browsers); otherwise Playwright's own.
import { defineConfig } from '@playwright/test';
const executablePath = process.env.CHROME_PATH || undefined;
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: /.*\.spec\.mjs/,
  timeout: 60_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 2,
  reporter: [['list']],
  use: { browserName: 'chromium', launchOptions: { executablePath }, viewport: { width: 1280, height: 900 }, acceptDownloads: true, locale: 'en-IN', timezoneId: 'Asia/Kolkata' },
});
