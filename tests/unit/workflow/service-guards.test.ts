import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { LocalArtifactStore } from "../../../src/server/artifacts/local-store.js";
import { QuickJsCheckRunner } from "../../../src/server/checks/quickjs-runner.js";
import { EventJournal } from "../../../src/server/events/journal.js";
import { createFakeCodexPort } from "../../../src/server/workflow/fake-codex.js";
import { createTaskGraph } from "../../../src/server/workflow/graph.js";
import { createAppService, type AppService } from "../../../src/server/workflow/service.js";
import { TaskStateSchema, type CodexPort } from "../../../src/shared/index.js";

const roots: string[] = [];
const services: AppService[] = [];
afterEach(async () => {
  await Promise.allSettled(services.splice(0).map(service => service.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function setup(mode: "real" | "fake", root: string, codex: CodexPort = createFakeCodexPort("happy")) {
  const artifacts = new LocalArtifactStore(root);
  const service = await createAppService({ dataDir: root, executionMode: mode, ports: { artifacts, checks: new QuickJsCheckRunner(artifacts), codex } });
  services.push(service);
  return { service, artifacts };
}

async function paused(service: AppService): Promise<Awaited<ReturnType<AppService["getTask"]>>> {
  const { taskId } = await service.createTask({ text: "Implement mergeIntervals." }, randomUUID());
  for (let attempt = 0; attempt < 100; attempt++) {
    const snapshot = await service.getTask(taskId);
    if (snapshot.task.phase === "awaiting_approval") return snapshot;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Task did not reach approval pause");
}

it("does not let a fake server approve or auto-run a saved real task", async () => {
  const root = await mkdtemp(join(tmpdir(), "loop-mode-")); roots.push(root);
  const first = await setup("real", root);
  const before = await paused(first.service);
  await first.service.close(); services.splice(services.indexOf(first.service), 1);
  let fakeCalls = 0;
  const fake: CodexPort = { async run() { fakeCalls++; throw new Error("wrong mode invoked"); } };
  const second = await setup("fake", root, fake);
  const snapshot = await second.service.getTask(before.task.taskId);
  expect(snapshot.state.executionMode).toBe("real");
  expect(snapshot.actions.canDecide).toBe(false);
  expect(snapshot.task.stopReason).toContain("real");
  await expect(second.service.decide(before.task.taskId, {
    decisionId: "wrong-mode", decision: "approve", versionId: before.state.currentVersionId!, manifestHash: before.state.currentManifestHash!,
  })).rejects.toMatchObject({ statusCode: 409, code: "mode_mismatch" });
  expect(fakeCalls).toBe(0);
});

it("does not auto-run a pending real model node under a fake server", async () => {
  const root = await mkdtemp(join(tmpdir(), "loop-mode-pending-")); roots.push(root);
  const first = await setup("real", root);
  const before = await paused(first.service);
  await first.service.close(); services.splice(services.indexOf(first.service), 1);
  const taskId = before.task.taskId;
  const config = { configurable: { thread_id: taskId }, durability: "sync" as const };
  const graph = createTaskGraph(join(root, "checkpoints.sqlite"), {
    ports: { codex: createFakeCodexPort("happy"), artifacts: first.artifacts, checks: new QuickJsCheckRunner(first.artifacts), events: new EventJournal(root) },
    registerAbort() {}, clearAbort() {}, isStopRequested: () => false,
  });
  const saved = TaskStateSchema.parse((await graph.getState(config)).values.value);
  const pending = TaskStateSchema.parse({ ...saved, phase: "author", usedModelCalls: saved.usedModelCalls + 1, activeAttempt: {
    attemptId: randomUUID(), role: "author", modelId: saved.models.author, inputVersionId: saved.currentArtifact?.versionId ?? null,
    status: "reserved", startedAt: new Date().toISOString(), endedAt: null, observations: [], error: null,
  } });
  await graph.updateState(config, { value: pending }, "prepareAuthor");
  let fakeCalls = 0;
  const fake: CodexPort = { async run() { fakeCalls++; throw new Error("wrong mode invoked"); } };
  const second = await setup("fake", root, fake);
  await new Promise(resolve => setTimeout(resolve, 100));
  const snapshot = await second.service.getTask(taskId);
  expect(snapshot.state.executionMode).toBe("real");
  expect(snapshot.actions.canDecide).toBe(false);
  expect(snapshot.task.stopReason).toContain("real");
  expect(fakeCalls).toBe(0);
});

it("reconciles a complete published result after a crash before the applier checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "loop-publish-recover-")); roots.push(root);
  const first = await setup("fake", root);
  const before = await paused(first.service);
  await first.service.close(); services.splice(services.indexOf(first.service), 1);
  const taskId = before.task.taskId;
  const config = { configurable: { thread_id: taskId }, durability: "sync" as const };
  const graph = createTaskGraph(join(root, "checkpoints.sqlite"), {
    ports: { codex: createFakeCodexPort("happy"), artifacts: first.artifacts, checks: new QuickJsCheckRunner(first.artifacts), events: new EventJournal(root) },
    registerAbort() {}, clearAbort() {}, isStopRequested: () => false,
  });
  const saved = TaskStateSchema.parse((await graph.getState(config)).values.value);
  const ref = saved.currentArtifact!;
  const approval = { decisionId: "approved-before-crash", decision: "approve" as const, versionId: ref.versionId, manifestHash: ref.manifestHash, at: new Date().toISOString() };
  const pending = TaskStateSchema.parse({ ...saved, approval, phase: "applying", usedModelCalls: 3, activeAttempt: {
    attemptId: randomUUID(), role: "applier", modelId: saved.models.applier, inputVersionId: ref.versionId, status: "reserved", startedAt: new Date().toISOString(), endedAt: null, observations: [], error: null,
  } });
  await graph.updateState(config, { value: pending }, "prepareApplier");
  await first.artifacts.publishApprovedVersion(ref, approval);
  let replayedCalls = 0;
  const codex: CodexPort = { async run() { replayedCalls++; throw new Error("must not call cloud again"); } };
  const second = await setup("fake", root, codex);
  const after = await second.service.getTask(taskId);
  expect(after.task.phase).toBe("completed");
  expect(after.state.usedModelCalls).toBe(3);
  expect(after.state.currentManifestHash).toBe(ref.manifestHash);
  expect(replayedCalls).toBe(0);
});

it("rejects a self-consistent result manifest that differs from the checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "loop-result-tamper-")); roots.push(root);
  const { service } = await setup("fake", root);
  const before = await paused(service);
  await service.decide(before.task.taskId, { decisionId: "approve", decision: "approve", versionId: before.state.currentVersionId!, manifestHash: before.state.currentManifestHash! });
  let completed = await service.getTask(before.task.taskId);
  for (let attempt = 0; attempt < 100 && completed.task.phase !== "completed"; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20));
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
  const body = { taskId: manifest.taskId, versionId: manifest.versionId, files: manifest.files.map((file: { artifactId: string; path: string; sha256: string; bytes: number }) => ({ artifactId: file.artifactId, path: file.path, sha256: file.sha256, bytes: file.bytes })) };
  manifest.manifestHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  await writeFile(manifestPath, JSON.stringify(manifest));
  await expect(service.getFile(before.task.taskId, completed.files[0]!.artifactId)).rejects.toMatchObject({ statusCode: 409, code: "artifact_changed" });
});
