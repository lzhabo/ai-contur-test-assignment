import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

const port = process.env.QA_AUTH_E2E_PORT ?? "4328";
const baseURL = `http://127.0.0.1:${port}`;

// Отдельное расширение исключает этот mock CLI из обычного и настоящего модельного E2E.
export default defineConfig({
  testDir: ".",
  testMatch: "login-logout.pw.ts",
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  outputDir: "/tmp/kontur-auth-playwright",
  webServer: {
    command: "npm run build && node --import tsx tests/support/login-logout-server.ts",
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    url: `${baseURL}/api/health`,
    timeout: 60_000,
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    stdout: "pipe",
    stderr: "pipe",
  },
  use: { baseURL, channel: "chrome", trace: "retain-on-failure", screenshot: "only-on-failure" },
});
