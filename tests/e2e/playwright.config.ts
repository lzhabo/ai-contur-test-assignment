import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

const real = process.env.QA_REAL_CODEX === "1";
const port = process.env.QA_E2E_PORT ?? "4318";
const baseURL = `http://127.0.0.1:${port}`;

// Самостоятельно собирает фронтенд и запускает изолированный сервер; чужой процесс не переиспользуется.
export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  workers: 1,
  timeout: real ? 300_000 : 45_000,
  expect: { timeout: real ? 180_000 : 10_000 },
  outputDir: "/tmp/two-model-loop-qa-playwright",
  webServer: {
    command: "npm run build && node --import tsx tests/support/e2e-server.ts",
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    url: `${baseURL}/api/health`,
    timeout: 60_000,
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    stdout: "pipe",
    stderr: "pipe",
  },
  use: {
    baseURL,
    channel: "chrome",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
