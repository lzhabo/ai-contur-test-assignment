import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { LocalArtifactStore } from "../../../src/server/artifacts/local-store.js";
import { QuickJsCheckRunner } from "../../../src/server/checks/quickjs-runner.js";
import { createHttpApp } from "../../../src/server/http/app.js";
import { acquireDataLock } from "../../../src/server/storage/data-lock.js";
import { createMockCodexPort } from "../../../src/server/codex/mock-port.js";
import { createAppService, type AppService } from "../../../src/server/workflow/service.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([promise, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`Timed out after ${ms} ms`)), ms))]);
}

async function paused(service: AppService): Promise<{ taskId: string; cursor: number }> {
  const { taskId } = await service.createTask({ text: "Implement mergeIntervals." });
  for (let index = 0; index < 100; index++) {
    const snapshot = await service.getTask(taskId);
    if (snapshot.task.phase === "awaiting_approval") return { taskId, cursor: snapshot.lastEventSequence };
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Task did not reach approval pause");
}

it("opens an idle SSE immediately and closes it with the server, releasing the data lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "loop-sse-close-")); roots.push(root);
  const artifacts = new LocalArtifactStore(root);
  const service = await createAppService({ dataDir: root, executionMode: "mock", ports: { artifacts, checks: new QuickJsCheckRunner(artifacts), codex: createMockCodexPort("happy") } });
  const server = createHttpServer(createHttpApp(service));
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (server.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    await service.close();
  };
  try {
    const { taskId, cursor } = await paused(service);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No HTTP port");
    const response = await within(fetch(`http://127.0.0.1:${address.port}/api/tasks/${taskId}/events?after=${cursor}`), 1_000);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = await within(reader.read(), 1_000);
    expect(new TextDecoder().decode(first.value)).toContain(": connected\n\n");
    await within(close(), 2_000);
    const lock = await within(acquireDataLock(root), 1_000);
    await lock.release();
    await reader.cancel().catch(() => undefined);
  } finally {
    await close();
  }
}, 10_000);

it("SIGTERM closes a real server with idle SSE and releases its data lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "loop-sse-signal-")); roots.push(root);
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("No TCP port");
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const port = address.port;
  const child = spawn(process.execPath, ["--import", "tsx", "src/server/main/index.ts"], {
    cwd: process.cwd(), env: { ...process.env, APP_PORT: String(port), APP_DATA_DIR: root, APP_CODEX_MODE: "mock" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stderr.on("data", chunk => { logs += String(chunk); });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  try {
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let index = 0; index < 100; index++) {
      try { ready = (await fetch(`${base}/api/health`)).ok; if (ready) break; }
      catch { /* process may still be starting */ }
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    expect(ready, logs).toBe(true);
    const created = await fetch(`${base}/api/tasks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "Implement mergeIntervals." }) });
    expect(created.status).toBe(202);
    const { taskId } = await created.json() as { taskId: string };
    let cursor = 0;
    for (let index = 0; index < 100; index++) {
      const state = await (await fetch(`${base}/api/tasks/${taskId}`)).json() as { task: { phase: string }; lastEventSequence: number };
      if (state.task.phase === "awaiting_approval") { cursor = state.lastEventSequence; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(cursor).toBeGreaterThan(0);
    const stream = await within(fetch(`${base}/api/tasks/${taskId}/events?after=${cursor}`), 1_000);
    const reader = stream.body!.getReader();
    expect(new TextDecoder().decode((await within(reader.read(), 1_000)).value)).toContain(": connected\n\n");
    child.kill("SIGTERM");
    expect(await within(exit, 2_000)).toEqual({ code: 0, signal: null });
    const lock = await within(acquireDataLock(root), 1_000);
    await lock.release();
    await reader.cancel().catch(() => undefined);
  } finally {
    child.kill("SIGKILL");
    await exit;
  }
}, 15_000);

it("releases the data lock when the HTTP port is already occupied", async () => {
  const root = await mkdtemp(join(tmpdir(), "loop-listen-fail-")); roots.push(root);
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("No TCP port");
  const child = spawn(process.execPath, ["--import", "tsx", "src/server/main/index.ts"], {
    cwd: process.cwd(), env: { ...process.env, APP_PORT: String(address.port), APP_DATA_DIR: root, APP_CODEX_MODE: "mock" }, stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    const exit = await within(new Promise<number | null>(resolve => child.once("exit", code => resolve(code))), 5_000);
    expect(exit).not.toBe(0);
    const lock = await within(acquireDataLock(root), 1_000);
    await lock.release();
  } finally {
    child.kill("SIGKILL");
    await new Promise<void>(resolve => socket.close(() => resolve()));
  }
}, 10_000);
