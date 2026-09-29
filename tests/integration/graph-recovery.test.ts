import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { Command } from "@langchain/langgraph";
import { createTaskGraph } from "../../src/server/tasks/agent-loop.js";
import { createMockCodexPort } from "../../src/server/codex/mock-port.js";
import { LocalArtifactStore } from "../../src/server/storage/local-store.js";
import { QuickJsCheckRunner } from "../../src/server/code-runner/quickjs-runner.js";
import { EventJournal } from "../../src/server/storage/task-history.js";
import { DEFAULT_LIMITS, DEFAULT_MODELS } from "../../src/server/config.js";
import { TaskStateSchema } from "../../src/server/tasks/types.js";
import { type CodexPort, type CodexRunRequest } from "../../src/server/tasks/ports.js";
const roots: string[] = [];
afterEach(async () => {
  // Освобождает процессы и ресурсы сценария, затем удаляет временные данные.
  await Promise.all(
    roots
      .splice(0)
      .map(/* Удаляет временные данные. */ (root) => rm(root, { recursive: true, force: true })),
  );
});
// Собирает граф с настоящим хранилищем и переданным портом модели для проверки восстановления.
async function setup(codex: CodexPort, limits = DEFAULT_LIMITS) {
  const root = await mkdtemp(path.join(tmpdir(), "kontur-qa-graph-"));
  roots.push(root);
  const artifacts = new LocalArtifactStore(root);
  let stopRequested = false;
  const controllers = new Set<AbortController>();
  const hooks = {
    ports: {
      codex,
      artifacts,
      checks: new QuickJsCheckRunner(artifacts),
      events: new EventJournal(root),
    },
    registerAbort: (_id: string, controller: AbortController) => {
      // Запоминает контроллер текущего вызова для управляемой остановки.
      controllers.add(controller);
    },
    clearAbort: (_id: string, controller: AbortController) => {
      // Убирает контроллер завершённого вызова.
      controllers.delete(controller);
    },
    isStopRequested: /* Сообщает графу, запрошена ли остановка. */ () => stopRequested,
  };
  const graph = /* Открывает граф поверх той же SQLite-базы для проверки восстановления. */ () =>
    createTaskGraph(path.join(root, "checkpoints.sqlite"), hooks);
  const time = new Date().toISOString();
  const state = TaskStateSchema.parse({
    schemaVersion: 1,
    executionMode: "mock",
    taskId: "qa-graph",
    taskText: "Implement mergeIntervals.",
    models: DEFAULT_MODELS,
    phase: "preparing",
    currentArtifact: null,
    latestReview: null,
    latestChecks: null,
    approval: null,
    limits,
    usedModelCalls: 0,
    createdVersions: 0,
    activeAttempt: null,
    lastAttempt: null,
    stopReason: null,
    resultPath: null,
    createdAt: time,
    updatedAt: time,
    lastEventSequence: 0,
  });
  const config = {
    configurable: { thread_id: state.taskId },
    durability: "sync" as const,
    recursionLimit: 100,
  };
  return {
    root,
    graph,
    state,
    config,
    stop: () => {
      // Устанавливает остановку и отменяет все незавершённые вызовы.
      stopRequested = true;
      for (const controller of controllers) controller.abort();
    },
  };
}
// Возвращает mock-порт, который сохраняет каждый запрос перед выдачей ответа сценария.
function tracked(scenario: Parameters<typeof createMockCodexPort>[0]) {
  const calls: CodexRunRequest[] = [];
  const mock = createMockCodexPort(scenario);
  const codex: CodexPort = {
    run: (request, hooks) => {
      // Запоминает запрос и возвращает соответствующий mock-ответ.
      calls.push(request);
      return mock.run(request, hooks);
    },
  };
  return { calls, codex };
}
it("A-04/A-08: граф восстанавливает паузу, а подтверждение вызывает только применяющего агента", async () => {
  const { calls, codex } = tracked("happy");
  const f = await setup(codex);
  const first = await f.graph().invoke({ value: f.state }, f.config);

  expect(first.value.phase).toBe("awaiting_approval");
  expect(calls.map((call) => call.role)).toEqual(["author", "reviewer"]);
  await expect(access(path.join(f.root, "tasks/qa-graph/result"))).rejects.toMatchObject({
    code: "ENOENT",
  });

  const restarted = f.graph();
  const saved = await restarted.getState(f.config);
  const state = TaskStateSchema.parse(saved.values.value);

  expect(state.currentArtifact).toEqual(first.value.currentArtifact);

  const artifact = state.currentArtifact!;
  const result = await restarted.invoke(
    new Command({
      resume: {
        decisionId: "qa-approval",
        decision: "approve",
        versionId: artifact.versionId,
        manifestHash: artifact.manifestHash,
        at: new Date().toISOString(),
      },
    }),
    f.config,
  );

  expect(result.value.phase).toBe("completed");
  expect(calls.map((call) => call.role)).toEqual(["author", "reviewer", "applier"]);
  expect(result.value.usedModelCalls).toBe(3);
}, 15000);

it("A-03/A-04: отсутствие ответа сохраняет бюджет, новый вызов требует явного повтора", async () => {
  const { calls, codex } = tracked("no_response");
  const f = await setup(codex, {
    ...DEFAULT_LIMITS,
    modelTimeoutMs: 30,
    modelWarningMs: 10,
  });
  const first = await f.graph().invoke({ value: f.state }, f.config);

  expect(first.value.phase).toBe("unknown_outcome");
  expect(calls).toHaveLength(1);

  const restarted = f.graph();
  const saved = TaskStateSchema.parse((await restarted.getState(f.config)).values.value);

  expect(saved.usedModelCalls).toBe(1);
  expect(saved.lastAttempt?.status).toBe("unknown");
  expect(calls).toHaveLength(1);

  const retry = await restarted.invoke(
    new Command({ resume: { mode: "retry_unknown" } }),
    f.config,
  );

  expect(retry.value.phase).toBe("unknown_outcome");
  expect(retry.value.usedModelCalls).toBe(2);
  expect(calls).toHaveLength(2);
}, 10000);

it("A-02: бесконечные замечания останавливаются по общим лимитам", async () => {
  const { calls, codex } = tracked("review_loop");
  const f = await setup(codex, { ...DEFAULT_LIMITS, maxModelCalls: 3 });
  const result = await f.graph().invoke({ value: f.state }, f.config);

  expect(result.value.phase).toBe("stopped");
  expect(calls).toHaveLength(3);
  expect(result.value.usedModelCalls).toBe(3);
  expect(result.value.stopReason).toBeTruthy();

  const saved = TaskStateSchema.parse((await f.graph().getState(f.config)).values.value);

  expect(saved.usedModelCalls).toBe(3);
  expect(saved.resultPath).toBeNull();
}, 15000);

it("A-08: одобрение ревьюера не разрешает подтверждать некомпилируемый код", async () => {
  const mock = createMockCodexPort("happy");
  const codex: CodexPort = {
    // Подменяет код кандидата версией с ошибкой компиляции при сохранении остальных ответов.
    async run(request, hooks) {
      const result = await mock.run(request, hooks);
      if (result.output.kind === "candidate")
        result.output = {
          ...result.output,
          solutionTs: 'export function mergeIntervals(): number[][] { return "wrong"; }',
        };
      return result;
    },
  };
  const f = await setup(codex, { ...DEFAULT_LIMITS, maxVersions: 1 });
  const result = await f.graph().invoke({ value: f.state }, f.config);

  expect(result.value.latestChecks?.compilation.status).toBe("failed");
  expect(result.value.phase).not.toBe("awaiting_approval");
  expect(result.value.phase).not.toBe("completed");
  expect(result.value.resultPath).toBeNull();
}, 10000);

it("A-08: остановка во время вызова отклоняет запоздалый успешный ответ", async () => {
  const mock = createMockCodexPort("happy");
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    // Сохраняет сигнал о входе в проверяемый участок обработки.
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    // Сохраняет сигнал, которым тест разрешит продолжить обработку.
    release = resolve;
  });
  const codex: CodexPort = {
    // Удерживает ответ модели до сигнала теста, имитируя поздний ответ после остановки.
    async run(request, hooks) {
      entered();
      await gate;
      return mock.run(request, {
        ...hooks,
        signal: new AbortController().signal,
      });
    },
  };
  const f = await setup(codex);
  const running = f.graph().invoke({ value: f.state }, f.config);
  await started;
  f.stop();
  release();
  const result = await running;

  expect(result.value.phase).toBe("stopped");
  expect(result.value.createdVersions).toBe(0);
  expect(result.value.resultPath).toBeNull();
  await expect(access(path.join(f.root, "tasks/qa-graph/result"))).rejects.toMatchObject({
    code: "ENOENT",
  });
}, 10000);

it("A-04: архив сверх лимита запроса не отправляется как контекст продолжения", async () => {
  const { calls, codex } = tracked("review_once");
  const f = await setup(codex);
  const sentinel = "QA_ARCHIVE_ONLY_7f51ce40_DO_NOT_INCLUDE_IN_NEXT_INPUT";
  const archive = sentinel + " obsolete message".repeat(13000);
  await new EventJournal(f.root).append({
    taskId: f.state.taskId,
    eventId: "qa-old-archive",
    at: new Date().toISOString(),
    type: "message",
    from: "author",
    to: "reviewer",
    attemptId: "old-attempt",
    text: archive,
    artifactVersionId: null,
    source: "qa",
  });

  expect(Buffer.byteLength(archive)).toBeGreaterThan(DEFAULT_LIMITS.maxContextBytes);

  const result = await f.graph().invoke({ value: f.state }, f.config);

  expect(result.value.phase).toBe("awaiting_approval");
  expect(calls.map((call) => call.role)).toEqual(["author", "reviewer", "author", "reviewer"]);

  for (const call of calls) {
    expect(call.contextText).not.toContain(sentinel);
    expect(Buffer.byteLength(call.contextText)).toBeLessThanOrEqual(DEFAULT_LIMITS.maxContextBytes);
    expect(call.contextText).toContain(f.state.taskText);
  }

  expect(calls[2]!.contextText).toContain("changes_requested");
}, 15000);
