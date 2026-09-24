import { defineConfig } from '@playwright/test';

// Start an isolated fake-cloud backend on 4318 before running this suite.
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  workers: 1,
  timeout: 45_000,
  outputDir: '/tmp/two-model-loop-qa-playwright',
  use: {
    baseURL: process.env.QA_BASE_URL ?? 'http://127.0.0.1:4318',
    channel: 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
