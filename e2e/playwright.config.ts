import { defineConfig } from '@playwright/test';

/* One Mochi app for the whole run; scenarios reset its storage and run in order. */
export default defineConfig({
  testDir: '.',
  testMatch: '*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { outputFolder: '../out/e2e-report', open: 'never' }]],
  outputDir: '../out/e2e-results',
});
