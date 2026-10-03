import { createServer, type Server } from "node:http";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createHttpApp } from "../../src/server/app.js";
import { CodexConnectionError } from "../../src/server/codex/connection-error.js";
import { createMockCodexPort, type MockScenario } from "../../src/server/codex/mock-port.js";
import { QuickJsCheckRunner } from "../../src/server/code-runner/quickjs-runner.js";
import { DEFAULT_LIMITS } from "../../src/server/config.js";
import { LocalArtifactStore } from "../../src/server/storage/local-store.js";
import { createAppService, type AppService } from "../../src/server/tasks/service.js";
import type { CodexPort } from "../../src/server/tasks/ports.js";
import type { DecisionRequest, TaskSnapshotResponse } from "../../src/shared/api.js";
import { CodexReadinessSchema, type CodexReadiness } from "../../src/shared/connections.js";
import { waitForTask } from "../support/service.js";

const resources: Array<{ root: string; service: AppService; server?: Server }> = [];
const loginMessage = "Вход отсутствует. Выполните codex login и проверьте подключение снова.";

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    if (resource.server?.listening) {
      resource.server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        resource.server!.close((error) => (error ? reject(error) : resolve()));
      });
    }
    await resource.service.close();
    await rm(resource.root, { recursive: true, force: true });
  }
});

// Настоящие сервис, диск, SQLite и QuickJS используют управляемые mock-вход и ответы модели.
async function setup(
  options: {
    loggedIn?: boolean;
    executionMode?: "real" | "mock";
    scenario?: MockScenario;
    runError?: Error;
  } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "kontur-qa-connections-"));
  let loggedIn = options.loggedIn ?? false;
  const mock = createMockCodexPort(options.scenario ?? "happy");
  const mockReadiness = vi.fn(async (): Promise<CodexReadiness> => ({
    executionMode: "real",
    ready: loggedIn,
    checkedAt: new Date().toISOString(),
    checks: [
      { id: "cli", status: "passed", message: "CLI доступен." },
      {
        id: "auth",
        status: loggedIn ? "passed" : "failed",
        message: loggedIn ? "Вход выполнен." : loginMessage,
      },
      { id: "cloud", status: "not_checked", message: "Облачный запрос не выполнялся." },
    ],
  }));
  const mockRun = vi.fn<CodexPort["run"]>(async (request, hooks) => {
    if (options.runError) throw options.runError;
    return mock.run(request, hooks);
  });
  const artifacts = new LocalArtifactStore(root);
  const service = await createAppService({
    dataDir: root,
    executionMode: options.executionMode ?? "real",
    limits: { ...DEFAULT_LIMITS, modelTimeoutMs: options.scenario === "no_response" ? 50 : 10000 },
    ports: {
      artifacts,
      checks: new QuickJsCheckRunner(artifacts),
      codex: { checkReadiness: mockReadiness, run: mockRun },
    },
  });
  const resource: (typeof resources)[number] = { root, service };
  resources.push(resource);
  return {
    root,
    service,
    mockRun,
    mockReadiness,
    setLoggedIn(value: boolean) {
      loggedIn = value;
    },
    // Свободный локальный порт позволяет запускать HTTP-проверки параллельно с другими файлами.
    async http() {
      const server = createServer(createHttpApp(service));
      resource.server = server;
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Не назначен HTTP-порт");
      return `http://127.0.0.1:${address.port}`;
    },
  };
}

function approval(snapshot: TaskSnapshotResponse): DecisionRequest {
  return {
    decisionId: "qa-connection-approval",
    decision: "approve",
    versionId: snapshot.state.currentVersionId!,
    manifestHash: snapshot.state.currentManifestHash!,
  };
}

it("HTTP показывает отсутствие входа и отклоняет создание до записи задачи или вызова модели", async () => {
  const f = await setup();
  const base = await f.http();

  const status = await fetch(`${base}/api/connections`);
  const readiness = CodexReadinessSchema.parse(await status.json());
  const created = await fetch(`${base}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "mergeIntervals" }),
  });

  expect(status.status).toBe(200);
  expect(readiness).toMatchObject({ executionMode: "real", ready: false });
  expect(readiness.checks).toContainEqual({ id: "auth", status: "failed", message: loginMessage });
  expect(created.status).toBe(503);
  expect(await created.json()).toEqual({ code: "codex_not_ready", message: loginMessage });
  expect((await f.service.listTasks()).tasks).toEqual([]);
  const taskDirectories = await readdir(path.join(f.root, "tasks")).catch((error: unknown) => {
    expect(error).toMatchObject({ code: "ENOENT" });
    return [];
  });
  expect(taskDirectories).toEqual([]);
  expect(f.mockRun).not.toHaveBeenCalled();
});

it("после входа повторная проверка разрешает создать задачу с тем же ключом отклонённого запроса", async () => {
  const f = await setup();

  await expect(
    f.service.createTask({ text: "mergeIntervals" }, "login-retry"),
  ).rejects.toMatchObject({ code: "codex_not_ready" });
  f.setLoggedIn(true);
  const status = await f.service.getConnections();
  const created = await f.service.createTask({ text: "mergeIntervals" }, "login-retry");
  const paused = await waitForTask(f.service, created.taskId, (value) => value.actions.canDecide);

  expect(status.ready).toBe(true);
  expect((await f.service.listTasks()).tasks).toHaveLength(1);
  expect(paused.state.usedModelCalls).toBe(2);
  expect(f.mockRun.mock.calls.map(([request]) => request.role)).toEqual(["author", "reviewer"]);
}, 15000);

it("выход после успешной проверки блокирует новое создание, сохраняя историю и идемпотентный ответ", async () => {
  const f = await setup({ loggedIn: true });
  const created = await f.service.createTask({ text: "mergeIntervals" }, "existing-task");
  await waitForTask(f.service, created.taskId, (value) => value.actions.canDecide);
  await f.service.stop(created.taskId);
  const previous = await f.service.getTask(created.taskId);
  expect((await f.service.getConnections()).ready).toBe(true);

  f.setLoggedIn(false);
  await expect(f.service.createTask({ text: "catify" }, "after-logout")).rejects.toMatchObject({
    code: "codex_not_ready",
  });
  const repeated = await f.service.createTask({ text: "mergeIntervals" }, "existing-task");
  const restored = await f.service.getTask(created.taskId);

  expect(repeated).toEqual(created);
  expect((await f.service.listTasks()).tasks).toHaveLength(1);
  expect(restored.events).toEqual(previous.events);
  expect(restored.state.usedModelCalls).toBe(2);
  expect(f.mockRun).toHaveBeenCalledTimes(2);
}, 15000);

it("потеря входа перед подтверждением не записывает решение и не запускает применяющего агента", async () => {
  const f = await setup({ loggedIn: true });
  const { taskId } = await f.service.createTask({ text: "mergeIntervals" });
  const paused = await waitForTask(f.service, taskId, (value) => value.actions.canDecide);
  const decision = approval(paused);

  f.setLoggedIn(false);
  await expect(f.service.decide(taskId, decision)).rejects.toMatchObject({
    code: "codex_not_ready",
  });
  const blocked = await f.service.getTask(taskId);

  expect(blocked.task.phase).toBe("awaiting_approval");
  expect(blocked.events).toEqual(paused.events);
  expect(blocked.state.usedModelCalls).toBe(2);
  expect(blocked.state.resultPath).toBeNull();
  expect(f.mockRun).toHaveBeenCalledTimes(2);

  f.setLoggedIn(true);
  await f.service.decide(taskId, decision);
  const completed = await waitForTask(
    f.service,
    taskId,
    (value) => value.task.phase === "completed",
  );

  expect(completed.events.filter((event) => event.type === "decision_recorded")).toHaveLength(1);
  expect(f.mockRun.mock.calls.map(([request]) => request.role)).toEqual([
    "author",
    "reviewer",
    "applier",
  ]);
}, 15000);

it("неверное подтверждение отклоняется до проверки подключения, а отказ остаётся доступен без входа", async () => {
  const f = await setup({ loggedIn: true });
  const { taskId } = await f.service.createTask({ text: "mergeIntervals" });
  const paused = await waitForTask(f.service, taskId, (value) => value.actions.canDecide);
  const checksBefore = f.mockReadiness.mock.calls.length;

  f.setLoggedIn(false);
  await expect(
    f.service.decide(taskId, { ...approval(paused), manifestHash: "0".repeat(64) }),
  ).rejects.toMatchObject({ code: "stale_version" });
  await f.service.decide(taskId, { ...approval(paused), decision: "reject" });
  const stopped = await waitForTask(f.service, taskId, (value) => value.task.phase === "stopped");

  expect(f.mockReadiness).toHaveBeenCalledTimes(checksBefore);
  expect(stopped.state.resultPath).toBeNull();
  expect(f.mockRun).toHaveBeenCalledTimes(2);
}, 15000);

it("повтор неизвестного исхода без входа не расходует ещё одну попытку и не меняет историю", async () => {
  const f = await setup({ loggedIn: true, scenario: "no_response" });
  const { taskId } = await f.service.createTask({ text: "mergeIntervals" });
  const unknown = await waitForTask(
    f.service,
    taskId,
    (value) => value.task.phase === "unknown_outcome",
  );

  f.setLoggedIn(false);
  await expect(f.service.resume(taskId, { mode: "retry_unknown" })).rejects.toMatchObject({
    code: "codex_not_ready",
  });
  const blocked = await f.service.getTask(taskId);

  expect(blocked.task.phase).toBe("unknown_outcome");
  expect(blocked.state.usedModelCalls).toBe(1);
  expect(blocked.events).toEqual(unknown.events);
  expect(f.mockRun).toHaveBeenCalledTimes(1);
});

it("известная ошибка входа во время вызова сохраняет паузу для продолжения после входа", async () => {
  const f = await setup({
    loggedIn: true,
    runError: new CodexConnectionError("auth_required", loginMessage),
  });

  const { taskId } = await f.service.createTask({ text: "mergeIntervals" });
  const failed = await waitForTask(
    f.service,
    taskId,
    (value) => value.state.usedModelCalls === 1 && value.state.activeAttempt === null,
  );

  expect(failed.task.stopReason).toBe(loginMessage);
  expect(failed.task.phase).toBe("awaiting_auth");
  expect(failed.actions.canResume).toBe(true);
  expect(failed.actions.resumeRequiresExplicitRetry).toBe(false);
  expect(failed.state.usedModelCalls).toBe(1);
  expect(failed.events.some((event) => event.type === "phase_changed")).toBe(true);
  expect(failed.events.some((event) => event.type === "unknown_outcome")).toBe(false);
  expect(f.mockRun).toHaveBeenCalledTimes(1);
});

it("режим mock обходит проверку настоящего входа и сообщает, что облако не проверялось", async () => {
  const f = await setup({ executionMode: "mock" });

  const readiness = await f.service.getConnections();
  const { taskId } = await f.service.createTask({ text: "mergeIntervals" });
  await waitForTask(f.service, taskId, (value) => value.actions.canDecide);

  expect(readiness).toMatchObject({ executionMode: "mock", ready: true });
  expect(readiness.checks).toContainEqual(
    expect.objectContaining({ id: "cloud", status: "not_checked" }),
  );
  expect(f.mockReadiness).not.toHaveBeenCalled();
  expect(f.mockRun).toHaveBeenCalledTimes(2);
}, 15000);
