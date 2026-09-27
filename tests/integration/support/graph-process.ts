// Trusted QA orchestration only; candidate code executes through QuickJsCheckRunner.
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { Command } from "@langchain/langgraph";
import { createTaskGraph } from "../../../src/server/tasks/agent-loop.js";
import { createMockCodexPort } from "../../../src/server/codex/mock-port.js";
import { LocalArtifactStore } from "../../../src/server/storage/local-store.js";
import { QuickJsCheckRunner } from "../../../src/server/code-runner/quickjs-runner.js";
import { EventJournal } from "../../../src/server/storage/task-history.js";
import { TaskStateSchema } from "../../../src/server/tasks/types.js";
import { DEFAULT_LIMITS, DEFAULT_MODELS } from "../../../src/server/config.js";
const root = process.argv[2]!;
const mode = process.argv[3]!;
const mock = createMockCodexPort("happy");
const artifacts = new LocalArtifactStore(root);
const graph = createTaskGraph(path.join(root, "checkpoints.sqlite"), {
  ports: {
    artifacts,
    checks: new QuickJsCheckRunner(artifacts),
    events: new EventJournal(root),
    codex: {
      // Записывает попытку на диск перед выполнением управляемого mock-сценария.
      async run(request, hooks) {
        await appendFile(
          path.join(root, "qa-calls.jsonl"),
          JSON.stringify({ role: request.role, attemptId: request.attemptId }) + "\n",
        );
        return mock.run(request, hooks);
      },
    },
  }, // В этом сценарии отмена графа не требуется; сохраняет контракт регистрации.
  registerAbort() {},
  // В этом сценарии нет зарегистрированной отмены; сохраняет контракт очистки.
  clearAbort() {},
  isStopRequested:
    /* Разрешает продолжение графа: этот процесс останавливается внешним сигналом. */ () => false,
});
const config = {
  configurable: { thread_id: "qa-process" },
  durability: "sync" as const,
};
try {
  if (mode === "seed") {
    const now = new Date().toISOString();
    const value = TaskStateSchema.parse({
      schemaVersion: 1,
      executionMode: "mock",
      taskId: "qa-process",
      taskText: "Implement mergeIntervals.",
      models: DEFAULT_MODELS,
      phase: "preparing",
      currentArtifact: null,
      latestReview: null,
      latestChecks: null,
      approval: null,
      limits: DEFAULT_LIMITS,
      usedModelCalls: 0,
      createdVersions: 0,
      activeAttempt: null,
      lastAttempt: null,
      stopReason: null,
      resultPath: null,
      createdAt: now,
      updatedAt: now,
      lastEventSequence: 0,
    });
    const result = await graph.invoke({ value }, config);
    process.send?.({
      phase: result.value.phase,
      hash: result.value.currentArtifact?.manifestHash,
    });
  } else {
    const value = TaskStateSchema.parse((await graph.getState(config)).values.value);
    const artifact = value.currentArtifact!;
    const result = await graph.invoke(
      new Command({
        resume: {
          decisionId: "qa-process-approval",
          decision: "approve",
          versionId: artifact.versionId,
          manifestHash: artifact.manifestHash,
          at: new Date().toISOString(),
        },
      }),
      config,
    );
    process.send?.({
      phase: result.value.phase,
      hash: result.value.currentArtifact?.manifestHash,
    });
  }
} catch (error) {
  process.send?.({ error: String(error) });
}
// Parent owns termination, to make abrupt crash timing explicit.
process.on("message", () => {
  // Обрабатывает сигнал процесса и завершает соответствующее ожидание.
});
