const { defineConfig, devices } = require('@playwright/test');

const PORT = 4180;

module.exports = defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  // One shared server and database: run the files one after another
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: `http://127.0.0.1:${PORT}/`, locale: 'fa-IR', timezoneId: 'Asia/Tehran', trace: 'retain-on-failure' },
  projects: [
    { name: 'laptop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
    { name: 'phone', use: { ...devices['Pixel 7'], browserName: 'chromium' } }
  ],
  webServer: {
    command: 'node tests/e2e-server.js',
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: { E2E_PORT: String(PORT), TZ: 'Asia/Tehran' }
  }
});
