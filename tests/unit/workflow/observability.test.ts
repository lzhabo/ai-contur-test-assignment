import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { afterEach, expect, it } from "vitest";
import { LocalArtifactStore } from "../../../src/server/artifacts/local-store.js";
import { QuickJsCheckRunner } from "../../../src/server/checks/quickjs-runner.js";
import { createFakeCodexPort } from "../../../src/server/codex/fake-port.js";
import { createStructuredLogger, type ObservabilityLogger } from "../../../src/server/observability/logger.js";
import { createAppService, type AppService } from "../../../src/server/workflow/service.js";

const roots: string[] = [];
const services: AppService[] = [];
afterEach(async () => {
  await Promise.allSettled(services.splice(0).map(service => service.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function setup(logger: ObservabilityLogger, root: string) {
  const artifacts = new LocalArtifactStore(root);
  const service = await createAppService({ dataDir: root, executionMode: "fake", logger,
    ports: { artifacts, checks: new QuickJsCheckRunner(artifacts), codex: createFakeCodexPort("happy") } });
  services.push(service);
  return service;
}

it("records bounded before/after changes only after real SqliteSaver checkpoints persist", async () => {
  const root = await mkdtemp(join(tmpdir(), "loop-log-")); roots.push(root);
  const output: string[] = [];
  const logger = await createStructuredLogger(root, { writeStdout: line => output.push(line) });
  const service = await setup(logger, root);
  const sentinel = "SECRET_TASK_CODE_AUTH_4c013db0";
  const { taskId } = await service.createTask({ text: `Implement mergeIntervals. ${sentinel}` });
  let snapshot = await service.getTask(taskId);
  for (let count = 0; count < 200 && snapshot.task.phase !== "awaiting_approval"; count++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    snapshot = await service.getTask(taskId);
  }
  expect(snapshot.task.phase).toBe("awaiting_approval");
  await service.close(); services.splice(services.indexOf(service), 1);
  await logger.flush();
  const file = await readFile(join(root, "server-events.jsonl"), "utf8");
  expect(file).toBe(output.join(""));
  expect(file).not.toContain(sentinel);
  expect(file).not.toContain("solutionTs");
  expect(file).not.toContain("contextText");
  const records = file.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  const persisted = records.filter(record => record.event === "checkpoint_persisted" && record.taskId === taskId);
  expect(persisted.length).toBeGreaterThan(3);
  expect(records.some(record => record.event === "node_completed" && record.taskId === taskId)).toBe(true);
  expect(records.some(record => record.event === "node_paused" && record.node === "waitApproval")).toBe(true);
  expect(records.some(record => record.event === "node_completed" && record.node === "waitApproval")).toBe(false);
  expect(persisted.some(record => (record.changed as string[]).includes("usedModelCalls") && (record.after as { usedModelCalls: number }).usedModelCalls === 1)).toBe(true);
  const saver = SqliteSaver.fromConnString(join(root, "checkpoints.sqlite"));
  const tuple = await saver.getTuple({ configurable: { thread_id: taskId } });
  const saved = tuple?.checkpoint.channel_values.value as { phase: string; usedModelCalls: number };
  expect(saved.phase).toBe("awaiting_approval");
  const last = persisted.at(-1)!;
  expect(last.checkpointId).toBe(tuple?.checkpoint.id);
  expect((last.after as { phase: string }).phase).toBe(saved.phase);
  expect((last.after as { usedModelCalls: number }).usedModelCalls).toBe(saved.usedModelCalls);
  await logger.close();
});

it("keeps checkpoint durability when a logging sink fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "loop-log-fail-")); roots.push(root);
  const logger = await createStructuredLogger(root, { writeStdout: () => { throw new Error("sink secret"); } });
  const service = await setup(logger, root);
  const { taskId } = await service.createTask({ text: "Implement mergeIntervals." });
  const saver = SqliteSaver.fromConnString(join(root, "checkpoints.sqlite"));
  expect((await saver.getTuple({ configurable: { thread_id: taskId } }))?.checkpoint.id).toBeTruthy();
  await service.close(); services.splice(services.indexOf(service), 1);
  await logger.close();
  const file = await readFile(join(root, "server-events.jsonl"), "utf8");
  expect(file).toContain("checkpoint_persisted");
  expect(file).not.toContain("sink secret");
});

it("does not strand a task when an injected logger rejects every record", async () => {
  const root = await mkdtemp(join(tmpdir(), "loop-log-reject-")); roots.push(root);
  const rejecting: ObservabilityLogger = {
    async record() { throw new Error("secret logger failure"); },
    async flush() { throw new Error("secret logger failure"); },
    async close() { throw new Error("secret logger failure"); },
  };
  const service = await setup(rejecting, root);
  const { taskId } = await service.createTask({ text: "Implement mergeIntervals." }, "logger-reject-key");
  let snapshot = await service.getTask(taskId);
  for (let count = 0; count < 200 && snapshot.task.phase !== "awaiting_approval"; count++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    snapshot = await service.getTask(taskId);
  }
  expect(snapshot.task.phase).toBe("awaiting_approval");
  expect((await service.createTask({ text: "Implement mergeIntervals." }, "logger-reject-key")).taskId).toBe(taskId);
});

it("rotates a bounded JSONL file without changing workflow state", async () => {
  const root = await mkdtemp(join(tmpdir(), "loop-log-rotate-")); roots.push(root);
  const logger = await createStructuredLogger(root, { maxBytes: 4096, writeStdout: () => undefined });
  for (let index = 0; index < 100; index++) await logger.record({ event: "rotation_probe", taskId: `task-${index}` });
  await logger.close();
  expect((await stat(join(root, "server-events.jsonl"))).size).toBeLessThanOrEqual(4096);
  expect((await stat(join(root, "server-events.jsonl.1"))).size).toBeGreaterThan(0);
  const lines = (await readFile(join(root, "server-events.jsonl"), "utf8")).trim().split("\n");
  expect(lines.every(line => JSON.parse(line).event === "rotation_probe")).toBe(true);
});
