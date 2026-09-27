import { defineConfig } from '@playwright/test';

// Перед запуском сценариев запустите изолированный сервер с mock-ответами моделей на порту 4318.
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
