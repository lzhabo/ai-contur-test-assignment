import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { createAppService, type AppService } from "../../src/server/tasks/service.js";
import { createMockCodexPort } from "../../src/server/codex/mock-port.js";
import { LocalArtifactStore } from "../../src/server/storage/local-store.js";
import { QuickJsCheckRunner } from "../../src/server/code-runner/quickjs-runner.js";
import {
  createStructuredLogger,
  type LogEvent,
  type ObservabilityLogger,
} from "../../src/server/logger.js";
import { TaskStateSchema } from "../../src/server/tasks/types.js";

it("журнал описывает уже сохранённое состояние SQLite без текста задания, кода, ревью и авторизации", async () => {
  // Проверяет сценарий: журнал описывает уже сохранённое состояние SQLite без текста задания, кода, ревью и авторизации.

  const directory = await mkdtemp(path.join(tmpdir(), "loop-qa-checkpoint-log-"));
  const stdout: string[] = [];
  const errors: string[] = [];
  const logs: LogEvent[] = [];
  const persistedAtEmission: boolean[] = [];
  const actualDiffs: boolean[] = [];
  const markers = [
    "QA_PRIVATE_PROMPT_7192",
    "QA_PRIVATE_CODE_6281",
    "QA_PRIVATE_REVIEW_5230",
    "QA_BEARER_AUTH_9374",
  ];
  const logger = await createStructuredLogger(directory, {
    writeStdout: (line) => {
      // Сохраняет stdout для проверки состава диагностических записей.
      stdout.push(line);
    },
    writeError: (line) => {
      // Сохраняет stderr для проверки утечки чувствительных данных.
      errors.push(line);
    },
  });
  const reader = SqliteSaver.fromConnString(path.join(directory, "checkpoints.sqlite"));
  const observed: ObservabilityLogger = {
    // Проверяет доступность сохранённого checkpoint перед записью диагностического события.
    async record(event) {
      if (event.event === "checkpoint_persisted") {
        const tuple = await reader.getTuple({
          configurable: {
            thread_id: event.taskId,
            checkpoint_id: event.checkpointId,
          },
        });
        persistedAtEmission.push(tuple?.checkpoint.id === event.checkpointId);
        const state = tuple?.checkpoint.channel_values.value;
        if (state && event.after) {
          const saved = TaskStateSchema.parse(state);
          actualDiffs.push(
            saved.phase === event.after.phase &&
              saved.usedModelCalls === event.after.usedModelCalls &&
              saved.createdVersions === event.after.createdVersions,
          );
          const prior = event.parentCheckpointId
            ? await reader.getTuple({
                configurable: {
                  thread_id: event.taskId,
                  checkpoint_id: event.parentCheckpointId,
                },
              })
            : undefined;
          if (prior?.checkpoint.channel_values.value && event.before) {
            const previous = TaskStateSchema.parse(prior.checkpoint.channel_values.value);
            actualDiffs.push(
              previous.phase === event.before.phase &&
                previous.usedModelCalls === event.before.usedModelCalls,
            );
          }
          if (event.before && event.changed) {
            const expected = (Object.keys(event.after) as Array<keyof typeof event.after>).filter(
              /* Отбирает записи проверяемого вида. */ (key) =>
                event.before![key] !== event.after![key],
            );
            actualDiffs.push(
              JSON.stringify(expected.sort()) === JSON.stringify([...event.changed].sort()),
            );
          }
        }
      }
      logs.push(structuredClone(event));
      await logger.record(event);
    },
    flush: /* Дожидается записи накопленного журнала. */ () => logger.flush(),
    close: /* Закрывает исходный журнал после проверки. */ () => logger.close(),
  };
  let service: AppService | undefined;
  try {
    const artifacts = new LocalArtifactStore(directory);
    const mock = createMockCodexPort("happy");
    service = await createAppService({
      dataDir: directory,
      executionMode: "mock",
      logger: observed,
      ports: {
        artifacts,
        checks: new QuickJsCheckRunner(artifacts),
        codex: {
          // Передаёт диагностическое событие и продолжает вызов модели, проверяя очистку чувствительных данных.
          async run(request, hooks) {
            await hooks.onObservation({
              at: new Date().toISOString(),
              source: "qa",
              name: "local.test",
              stage: "local_started",
              detail: `Bearer ${markers[3]}`,
            });
            const result = await mock.run(request, hooks);
            if (result.output.kind === "candidate")
              result.output.solutionTs += `\n// ${markers[1]}`;
            if (result.output.kind === "review") result.output.findings = [markers[2]!];
            return result;
          },
        },
      },
    });
    const { taskId } = await service.createTask({
      text: `mergeIntervals ${markers[0]}`,
    });
    const deadline = Date.now() + 10000;
    let paused = false;
    while (Date.now() < deadline) {
      if ((await service.getTask(taskId)).actions.canDecide) {
        paused = true;
        break;
      }
      await new Promise(
        /* Выдерживает короткий интервал перед повторной проверкой состояния. */ (resolve) =>
          setTimeout(resolve, 10),
      );
    }

    expect(paused).toBe(true);

    await service.close();
    service = undefined;
    await observed.flush();

    expect(persistedAtEmission.length).toBeGreaterThan(3);
    expect(persistedAtEmission.every(Boolean)).toBe(true);
    expect(actualDiffs.length).toBeGreaterThan(3);
    expect(actualDiffs.every(Boolean)).toBe(true);
    expect(
      logs.some(
        /* Проверяет наличие состояния, которое допускает или запрещает сценарий. */ (event) =>
          event.event === "checkpoint_persisted" &&
          event.changed?.includes("usedModelCalls") &&
          event.attemptId,
      ),
    ).toBe(true);

    const file = await readFile(path.join(directory, "server-events.jsonl"), "utf8");

    expect(file).toBe(stdout.join(""));
    expect(
      file
        .trim()
        .split("\n")
        .every(
          /* Проверяет требуемое свойство у каждой записи. */ (line) =>
            Boolean(JSON.parse(line).event),
        ),
    ).toBe(true);

    for (const marker of markers) expect(file + errors.join("")).not.toContain(marker);

    expect(file).not.toContain("export function");
    expect(errors).toEqual([]);
    expect(
      logs.some(
        /* Проверяет наличие состояния, которое допускает или запрещает сценарий. */ (event) =>
          event.event === "node_completed" && event.node,
      ),
    ).toBe(true);
  } finally {
    await service?.close();
    await logger.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);
