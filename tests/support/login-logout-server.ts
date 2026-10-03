import { createServer } from "node:http";
import { chmod, copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import express from "express";
import { createHttpApp, closeHttpStreams } from "../../src/server/app.js";
import { installFrontendFallback } from "../../src/server/routes/frontend.js";
import { createAppService } from "../../src/server/tasks/service.js";
import { LocalArtifactStore } from "../../src/server/storage/local-store.js";
import { QuickJsCheckRunner } from "../../src/server/code-runner/quickjs-runner.js";
import { CodexCliPort } from "../../src/server/codex/cli-port.js";

// Настоящий адаптер запускает исполняемый mock; отдельная папка исключает доступ к личным сессиям.
const directory = await mkdtemp(join(tmpdir(), "kontur-auth-e2e-"));
const binary = join(directory, "codex-mock.mjs");
await copyFile(new URL("./login-logout-cli.mock.mjs", import.meta.url), binary);
await chmod(binary, 0o700);
await writeFile(join(directory, "auth-state"), "logged-in");
const dataDir = join(directory, "data");
// Каждый сценарий получает новый сервис, граф и хранилище с настоящим адаптером CLI.
async function createTestService() {
  const artifacts = new LocalArtifactStore(dataDir);
  return createAppService({
    dataDir,
    executionMode: "real",
    ports: {
      artifacts,
      checks: new QuickJsCheckRunner(artifacts),
      codex: new CodexCliPort(binary),
    },
  });
}
let service = await createTestService();
let taskApp = createHttpApp(service);
installFrontendFallback(taskApp, resolve("dist"));
const app = express();

// Управляющие маршруты существуют только в этом тестовом сервере, production их не содержит.
app.post("/__qa/reset", async (_request, response) => {
  closeHttpStreams(taskApp);
  await service.close();
  await rm(dataDir, { recursive: true, force: true });
  await rm(join(directory, "calls.jsonl"), { force: true });
  await rm(join(directory, "review-auth-once"), { force: true });
  await writeFile(join(directory, "auth-state"), "logged-in");
  service = await createTestService();
  taskApp = createHttpApp(service);
  installFrontendFallback(taskApp, resolve("dist"));
  response.sendStatus(204);
});
app.post("/__qa/review-auth-once", async (_request, response) => {
  await writeFile(join(directory, "review-auth-once"), "wait-for-logout");
  response.sendStatus(204);
});
app.post("/__qa/auth/:state", async (request, response) => {
  if (!["logged-in", "logged-out"].includes(request.params.state)) {
    response.sendStatus(400);
    return;
  }
  await writeFile(join(directory, "auth-state"), request.params.state);
  response.sendStatus(204);
});
app.get("/__qa/evidence", async (_request, response) => {
  const readOptional = async (path: string) => {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  const index = await readOptional(join(dataDir, "tasks-index.json"));
  const calls = await readOptional(join(directory, "calls.jsonl"));
  let taskDirectories: string[] = [];
  try {
    taskDirectories = await readdir(join(dataDir, "tasks"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  response.json({
    index: index === null ? null : JSON.parse(index),
    calls:
      calls
        ?.trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)) ?? [],
    taskDirectories,
  });
});
app.use((request, response, next) => taskApp(request, response, next));
const server = createServer(app);
let closing = false;

/** Закрывает настоящий сервис и удаляет только данные этого прогона. */
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  closeHttpStreams(taskApp);
  if (server.listening) {
    const stopped = new Promise<void>((complete, reject) =>
      server.close((error) => (error ? reject(error) : complete())),
    );
    server.closeAllConnections();
    await stopped;
  }
  await service.close();
  await rm(directory, { recursive: true, force: true });
}
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void close().then(
      () => process.exit(0),
      (error) => {
        console.error(error);
        process.exit(1);
      },
    );
  });
}
try {
  await new Promise<void>((complete, reject) => {
    server.once("error", reject);
    server.listen(Number(process.env.QA_AUTH_E2E_PORT ?? 4328), "127.0.0.1", complete);
  });
} catch (error) {
  await close();
  throw error;
}
