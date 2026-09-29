import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { afterEach, expect, it } from "vitest";
import { LocalArtifactStore } from "../../../src/server/storage/local-store.js";
import { QuickJsCheckRunner } from "../../../src/server/code-runner/quickjs-runner.js";
import { createMockCodexPort } from "../../../src/server/codex/mock-port.js";
import { createStructuredLogger, type ObservabilityLogger } from "../../../src/server/logger.js";
import { createAppService, type AppService } from "../../../src/server/tasks/service.js";

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

// Создаёт сервис с mock-ответами моделей и переданным журналом технических событий.
async function setup(logger: ObservabilityLogger, root: string) {
  const artifacts = new LocalArtifactStore(root);
  const service = await createAppService({
    dataDir: root,
    executionMode: "mock",
    logger,
    ports: {
      artifacts,
      checks: new QuickJsCheckRunner(artifacts),
      codex: createMockCodexPort("happy"),
    },
  });
  services.push(service);
  return service;
}

it("записывает ограниченный набор изменений после фактического сохранения SQLite", async () => {
  const root = await mkdtemp(join(tmpdir(), "loop-log-"));
  roots.push(root);
  const output: string[] = [];
  const logger = await createStructuredLogger(root, {
    writeStdout: /* Сохраняет вывод журнала для проверки очищенных полей. */ (line) =>
      output.push(line),
  });
  const service = await setup(logger, root);
  const sentinel = "SECRET_TASK_CODE_AUTH_4c013db0";
  const { taskId } = await service.createTask({
    text: `Implement mergeIntervals. ${sentinel}`,
  });
  let snapshot = await service.getTask(taskId);
  for (let count = 0; count < 200 && snapshot.task.phase !== "awaiting_approval"; count++) {
    await new Promise(
      /* Выдерживает короткий интервал перед повторной проверкой состояния. */ (resolve) =>
        setTimeout(resolve, 10),
    );
    snapshot = await service.getTask(taskId);
  }

  expect(snapshot.task.phase).toBe("awaiting_approval");

  await service.close();
  services.splice(services.indexOf(service), 1);
  await logger.flush();
  const file = await readFile(join(root, "server-events.jsonl"), "utf8");

  expect(file).toBe(output.join(""));
  expect(file).not.toContain(sentinel);
  expect(file).not.toContain("solutionTs");
  expect(file).not.toContain("contextText");

  const records = file
    .trim()
    .split("\n")
    .map(
      /* Читает сохранённую строку JSON как запись журнала. */ (line) =>
        JSON.parse(line) as Record<string, unknown>,
    );
  const persisted = records.filter(
    (record) => record.event === "checkpoint_persisted" && record.taskId === taskId,
  );

  expect(persisted.length).toBeGreaterThan(3);
  expect(
    records.some(
      /* Проверяет наличие состояния, которое допускает или запрещает сценарий. */ (record) =>
        record.event === "node_completed" && record.taskId === taskId,
    ),
  ).toBe(true);
  expect(
    records.some(
      /* Проверяет наличие состояния, которое допускает или запрещает сценарий. */ (record) =>
        record.event === "node_paused" && record.node === "waitApproval",
    ),
  ).toBe(true);
  expect(
    records.some(
      /* Проверяет наличие состояния, которое допускает или запрещает сценарий. */ (record) =>
        record.event === "node_completed" && record.node === "waitApproval",
    ),
  ).toBe(false);
  expect(
    persisted.some(
      /* Проверяет наличие состояния, которое допускает или запрещает сценарий. */ (record) =>
        (record.changed as string[]).includes("usedModelCalls") &&
        (record.after as { usedModelCalls: number }).usedModelCalls === 1,
    ),
  ).toBe(true);

  const saver = SqliteSaver.fromConnString(join(root, "checkpoints.sqlite"));
  const tuple = await saver.getTuple({ configurable: { thread_id: taskId } });
  const saved = tuple?.checkpoint.channel_values.value as {
    phase: string;
    usedModelCalls: number;
  };

  expect(saved.phase).toBe("awaiting_approval");

  const last = persisted.at(-1)!;

  expect(last.checkpointId).toBe(tuple?.checkpoint.id);
  expect((last.after as { phase: string }).phase).toBe(saved.phase);
  expect((last.after as { usedModelCalls: number }).usedModelCalls).toBe(saved.usedModelCalls);

  await logger.close();
});

it("сохраняет состояние при отказе записи журнала", async () => {
  const root = await mkdtemp(join(tmpdir(), "loop-log-fail-"));
  roots.push(root);
  const logger = await createStructuredLogger(root, {
    writeStdout: () => {
      // Имитирует отказ вывода журнала с чувствительным текстом ошибки.
      throw new Error("sink secret");
    },
  });
  const service = await setup(logger, root);
  const { taskId } = await service.createTask({
    text: "Implement mergeIntervals.",
  });
  const saver = SqliteSaver.fromConnString(join(root, "checkpoints.sqlite"));

  expect(
    (await saver.getTuple({ configurable: { thread_id: taskId } }))?.checkpoint.id,
  ).toBeTruthy();

  await service.close();
  services.splice(services.indexOf(service), 1);
  await logger.close();
  const file = await readFile(join(root, "server-events.jsonl"), "utf8");

  expect(file).toContain("checkpoint_persisted");
  expect(file).not.toContain("sink secret");
});

it("доводит задачу до паузы, даже если журнал отклоняет каждую запись", async () => {
  const root = await mkdtemp(join(tmpdir(), "loop-log-reject-"));
  roots.push(root);
  const rejecting: ObservabilityLogger = {
    // Имитирует отказ журнала, чтобы проверить сохранение задачи при ошибке диагностики.
    async record() {
      throw new Error("secret logger failure");
    },
    // Имитирует отказ журнала, чтобы проверить сохранение задачи при ошибке диагностики.
    async flush() {
      throw new Error("secret logger failure");
    },
    // Имитирует отказ журнала, чтобы проверить сохранение задачи при ошибке диагностики.
    async close() {
      throw new Error("secret logger failure");
    },
  };
  const service = await setup(rejecting, root);
  const { taskId } = await service.createTask(
    { text: "Implement mergeIntervals." },
    "logger-reject-key",
  );
  let snapshot = await service.getTask(taskId);
  for (let count = 0; count < 200 && snapshot.task.phase !== "awaiting_approval"; count++) {
    await new Promise(
      /* Выдерживает короткий интервал перед повторной проверкой состояния. */ (resolve) =>
        setTimeout(resolve, 10),
    );
    snapshot = await service.getTask(taskId);
  }

  expect(snapshot.task.phase).toBe("awaiting_approval");
  expect(
    (await service.createTask({ text: "Implement mergeIntervals." }, "logger-reject-key")).taskId,
  ).toBe(taskId);
});

it("ротирует JSONL ограниченного размера без изменения состояния задачи", async () => {
  const root = await mkdtemp(join(tmpdir(), "loop-log-rotate-"));
  roots.push(root);
  const logger = await createStructuredLogger(root, {
    maxBytes: 4096,
    writeStdout: /* Отключает stdout: этот сценарий проверяет файлы ротации. */ () => undefined,
  });
  for (let index = 0; index < 100; index++)
    await logger.record({ event: "rotation_probe", taskId: `task-${index}` });
  await logger.close();

  expect((await stat(join(root, "server-events.jsonl"))).size).toBeLessThanOrEqual(4096);
  expect((await stat(join(root, "server-events.jsonl.1"))).size).toBeGreaterThan(0);

  const lines = (await readFile(join(root, "server-events.jsonl"), "utf8")).trim().split("\n");

  expect(
    lines.every(
      /* Проверяет требуемое свойство у каждой записи. */ (line) =>
        JSON.parse(line).event === "rotation_probe",
    ),
  ).toBe(true);
});
