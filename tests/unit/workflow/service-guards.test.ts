import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { LocalArtifactStore } from "../../../src/server/storage/local-store.js";
import { QuickJsCheckRunner } from "../../../src/server/code-runner/quickjs-runner.js";
import { EventJournal } from "../../../src/server/storage/task-history.js";
import { createMockCodexPort } from "../../../src/server/codex/mock-port.js";
import { createTaskGraph } from "../../../src/server/tasks/agent-loop.js";
import { createAppService, type AppService } from "../../../src/server/tasks/service.js";
import { TaskStateSchema } from "../../../src/server/tasks/types.js";
import { type CodexPort } from "../../../src/server/tasks/ports.js";

const roots: string[] = [];
const services: AppService[] = [];
afterEach(async () => {
  // Освобождает процессы и ресурсы сценария, затем удаляет временные данные.

  await Promise.allSettled(
    services
      .splice(0)
      .map(/* Закрывает ресурс перед удалением временных данных. */ (service) => service.close()),
  );
  await Promise.all(
    roots
      .splice(0)
      .map(/* Удаляет временные данные. */ (root) => rm(root, { recursive: true, force: true })),
  );
});

// Создаёт сервис в указанном режиме; по умолчанию ответы модели выдаёт mock-порт.
async function setup(
  mode: "real" | "mock",
  root: string,
  codex: CodexPort = createMockCodexPort("happy"),
) {
  const artifacts = new LocalArtifactStore(root);
  const service = await createAppService({
    dataDir: root,
    executionMode: mode,
    ports: {
      artifacts,
      checks: new QuickJsCheckRunner(artifacts),
      codex: {
        run: (request, hooks) => codex.run(request, hooks),
        // Метка real проверяет несовпадение режимов; вход и ответы здесь явно замоканы.
        checkReadiness: async () => ({
          executionMode: mode,
          ready: true,
          checkedAt: new Date().toISOString(),
          checks: [
            { id: "auth", status: "passed", message: "Mock проверки входа для теста режимов." },
          ],
        }),
      },
    },
  });
  services.push(service);
  return { service, artifacts };
}

// Дожидается паузы перед подтверждением и возвращает полное состояние задачи.
async function paused(
  service: AppService,
  taskId: string,
): Promise<Awaited<ReturnType<AppService["getTask"]>>> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const snapshot = await service.getTask(taskId);
    if (snapshot.task.phase === "awaiting_approval") return snapshot;
    await new Promise(
      /* Выдерживает короткий интервал перед повторной проверкой состояния. */ (resolve) =>
        setTimeout(resolve, 20),
    );
  }
  throw new Error("Task did not reach approval pause");
}

it("сервер в mock-режиме не подтверждает и не запускает сохранённую задачу режима real", async () => {
  const root = await mkdtemp(join(tmpdir(), "loop-mode-"));
  roots.push(root);
  const first = await setup("real", root);
  const created = await first.service.createTask(
    { text: "Implement mergeIntervals." },
    randomUUID(),
  );
  const before = await paused(first.service, created.taskId);
  await first.service.close();
  services.splice(services.indexOf(first.service), 1);
  let mockCalls = 0;
  const mock: CodexPort = {
    // Записывает запрещённый вызов модели и аварийно завершает его для обнаружения нарушения режима.
    async run() {
      mockCalls++;
      throw new Error("wrong mode invoked");
    },
  };
  const second = await setup("mock", root, mock);
  const snapshot = await second.service.getTask(before.task.taskId);

  expect(snapshot.state.executionMode).toBe("real");
  expect(snapshot.actions.canDecide).toBe(false);
  expect(snapshot.task.stopReason).toContain("real");
  await expect(
    second.service.decide(before.task.taskId, {
      decisionId: "wrong-mode",
      decision: "approve",
      versionId: before.state.currentVersionId!,
      manifestHash: before.state.currentManifestHash!,
    }),
  ).rejects.toMatchObject({ code: "mode_mismatch" });
  expect(mockCalls).toBe(0);
});

it("сервер в mock-режиме не запускает ожидающий узел задачи режима real", async () => {
  const root = await mkdtemp(join(tmpdir(), "loop-mode-pending-"));
  roots.push(root);
  const first = await setup("real", root);
  const created = await first.service.createTask(
    { text: "Implement mergeIntervals." },
    randomUUID(),
  );
  const before = await paused(first.service, created.taskId);
  await first.service.close();
  services.splice(services.indexOf(first.service), 1);
  const taskId = before.task.taskId;
  const config = {
    configurable: { thread_id: taskId },
    durability: "sync" as const,
  };
  const graph = createTaskGraph(join(root, "checkpoints.sqlite"), {
    ports: {
      codex: createMockCodexPort("happy"),
      artifacts: first.artifacts,
      checks: new QuickJsCheckRunner(first.artifacts),
      events: new EventJournal(root),
    },
    // В этом сценарии отмена графа не требуется; сохраняет контракт регистрации.
    registerAbort() {},
    // В этом сценарии нет зарегистрированной отмены; сохраняет контракт очистки.
    clearAbort() {},
    isStopRequested: /* Разрешает продолжение графа без запроса остановки. */ () => false,
  });
  const saved = TaskStateSchema.parse((await graph.getState(config)).values.value);
  const pending = TaskStateSchema.parse({
    ...saved,
    phase: "author",
    usedModelCalls: saved.usedModelCalls + 1,
    activeAttempt: {
      attemptId: randomUUID(),
      role: "author",
      modelId: saved.models.author,
      inputVersionId: saved.currentArtifact?.versionId ?? null,
      status: "reserved",
      startedAt: new Date().toISOString(),
      endedAt: null,
      observations: [],
      error: null,
    },
  });
  await graph.updateState(config, { value: pending }, "prepareAuthor");
  let mockCalls = 0;
  const mock: CodexPort = {
    // Записывает запрещённый вызов модели и аварийно завершает его для обнаружения нарушения режима.
    async run() {
      mockCalls++;
      throw new Error("wrong mode invoked");
    },
  };
  const second = await setup("mock", root, mock);
  await new Promise(
    /* Выдерживает короткий интервал перед повторной проверкой состояния. */ (resolve) =>
      setTimeout(resolve, 100),
  );
  const snapshot = await second.service.getTask(taskId);

  expect(snapshot.state.executionMode).toBe("real");
  expect(snapshot.actions.canDecide).toBe(false);
  expect(snapshot.task.stopReason).toContain("real");
  expect(mockCalls).toBe(0);
});

it("восстанавливает опубликованный результат после сбоя перед сохранением состояния применения", async () => {
  const root = await mkdtemp(join(tmpdir(), "loop-publish-recover-"));
  roots.push(root);
  const first = await setup("mock", root);
  const created = await first.service.createTask(
    { text: "Implement mergeIntervals." },
    randomUUID(),
  );
  const before = await paused(first.service, created.taskId);
  await first.service.close();
  services.splice(services.indexOf(first.service), 1);
  const taskId = before.task.taskId;
  const config = {
    configurable: { thread_id: taskId },
    durability: "sync" as const,
  };
  const graph = createTaskGraph(join(root, "checkpoints.sqlite"), {
    ports: {
      codex: createMockCodexPort("happy"),
      artifacts: first.artifacts,
      checks: new QuickJsCheckRunner(first.artifacts),
      events: new EventJournal(root),
    },
    // В этом сценарии отмена графа не требуется; сохраняет контракт регистрации.
    registerAbort() {},
    // В этом сценарии нет зарегистрированной отмены; сохраняет контракт очистки.
    clearAbort() {},
    isStopRequested: /* Разрешает продолжение графа без запроса остановки. */ () => false,
  });
  const saved = TaskStateSchema.parse((await graph.getState(config)).values.value);
  const ref = saved.currentArtifact!;
  const approval = {
    decisionId: "approved-before-crash",
    decision: "approve" as const,
    versionId: ref.versionId,
    manifestHash: ref.manifestHash,
    at: new Date().toISOString(),
  };
  const pending = TaskStateSchema.parse({
    ...saved,
    approval,
    phase: "applying",
    usedModelCalls: 3,
    activeAttempt: {
      attemptId: randomUUID(),
      role: "applier",
      modelId: saved.models.applier,
      inputVersionId: ref.versionId,
      status: "reserved",
      startedAt: new Date().toISOString(),
      endedAt: null,
      observations: [],
      error: null,
    },
  });
  await graph.updateState(config, { value: pending }, "prepareApplier");
  await first.artifacts.publishApprovedVersion(ref, approval);
  let replayedCalls = 0;
  const codex: CodexPort = {
    // Фиксирует недопустимый повтор облачного вызова после восстановления.
    async run() {
      replayedCalls++;
      throw new Error("must not call cloud again");
    },
  };
  const second = await setup("mock", root, codex);
  const after = await second.service.getTask(taskId);

  expect(after.task.phase).toBe("completed");
  expect(after.state.usedModelCalls).toBe(3);
  expect(after.state.currentManifestHash).toBe(ref.manifestHash);
  expect(replayedCalls).toBe(0);
});

it("отклоняет целостный манифест результата, не совпадающий с сохранённым состоянием", async () => {
  const root = await mkdtemp(join(tmpdir(), "loop-result-tamper-"));
  roots.push(root);
  const { service } = await setup("mock", root);
  const created = await service.createTask({ text: "Implement mergeIntervals." }, randomUUID());
  const before = await paused(service, created.taskId);
  await service.decide(before.task.taskId, {
    decisionId: "approve",
    decision: "approve",
    versionId: before.state.currentVersionId!,
    manifestHash: before.state.currentManifestHash!,
  });
  let completed = await service.getTask(before.task.taskId);
  for (let attempt = 0; attempt < 100 && completed.task.phase !== "completed"; attempt++) {
    await new Promise(
      /* Выдерживает короткий интервал перед повторной проверкой состояния. */ (resolve) =>
        setTimeout(resolve, 20),
    );
    completed = await service.getTask(before.task.taskId);
  }

  expect(completed.task.phase).toBe("completed");

  const result = join(root, "tasks", before.task.taskId, "result");
  const manifestPath = join(result, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const changed = "export function mergeIntervals() { return []; }";
  await writeFile(join(result, "solution.ts"), changed);
  manifest.files[0].sha256 = createHash("sha256").update(changed).digest("hex");
  manifest.files[0].bytes = Buffer.byteLength(changed);
  const body = {
    taskId: manifest.taskId,
    versionId: manifest.versionId,
    files: manifest.files.map(
      (file: { artifactId: string; path: string; sha256: string; bytes: number }) => ({
        artifactId: file.artifactId,
        path: file.path,
        sha256: file.sha256,
        bytes: file.bytes,
      }),
    ),
  };
  manifest.manifestHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  await writeFile(manifestPath, JSON.stringify(manifest));

  await expect(
    service.getFile(before.task.taskId, completed.files[0]!.artifactId),
  ).rejects.toMatchObject({ code: "artifact_changed" });
});
