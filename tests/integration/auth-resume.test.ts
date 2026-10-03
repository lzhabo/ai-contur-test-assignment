import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CodexConnectionError } from "../../src/server/codex/connection-error.js";
import { createMockCodexPort } from "../../src/server/codex/mock-port.js";
import { QuickJsCheckRunner } from "../../src/server/code-runner/quickjs-runner.js";
import { DEFAULT_LIMITS } from "../../src/server/config.js";
import { LocalArtifactStore } from "../../src/server/storage/local-store.js";
import { EventJournal } from "../../src/server/storage/task-history.js";
import { createTaskGraph } from "../../src/server/tasks/agent-loop.js";
import { createAppService, type AppService } from "../../src/server/tasks/service.js";
import type { CodexPort } from "../../src/server/tasks/ports.js";
import { TaskStateSchema } from "../../src/server/tasks/types.js";
import type { AgentRole, TaskSnapshotResponse } from "../../src/shared/api.js";
import { waitForTask } from "../support/service.js";

const resources: Array<{ root: string; service: AppService }> = [];
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.service.close();
    await rm(resource.root, { recursive: true, force: true });
  }
});

// SQLite, артефакты и проверки настоящие; вход и облачные ответы управляются mock-портом.
async function setup(failedRole: AgentRole, maxModelCalls = DEFAULT_LIMITS.maxModelCalls) {
  const root = await mkdtemp(join(tmpdir(), "kontur-auth-resume-"));
  const artifacts = new LocalArtifactStore(root);
  const mock = createMockCodexPort("happy");
  let loggedIn = true;
  let failNext = true;
  const mockRun = vi.fn<CodexPort["run"]>(async (request, hooks) => {
    if (failNext && request.role === failedRole) {
      failNext = false;
      loggedIn = false;
      throw new CodexConnectionError("auth_required");
    }
    return mock.run(request, hooks);
  });
  const options = {
    dataDir: root,
    executionMode: "real" as const,
    limits: { ...DEFAULT_LIMITS, maxModelCalls },
    ports: {
      artifacts,
      checks: new QuickJsCheckRunner(artifacts),
      codex: {
        run: mockRun,
        checkReadiness: async () => ({
          executionMode: "real" as const,
          ready: loggedIn,
          checkedAt: new Date().toISOString(),
          checks: [
            {
              id: "auth" as const,
              status: loggedIn ? ("passed" as const) : ("failed" as const),
              message: "mock login status",
            },
          ],
        }),
      },
    },
  };
  const resource = { root, service: await createAppService(options) };
  resources.push(resource);
  return {
    get service() {
      return resource.service;
    },
    root,
    mockRun,
    login() {
      loggedIn = true;
    },
    async restart() {
      await resource.service.close();
      resource.service = await createAppService(options);
    },
    // Воссоздаёт checkpoint прежней версии приложения, не обращаясь к настоящим credentials.
    async checkpointBeforePause(taskId: string, legacyReason?: string) {
      await resource.service.close();
      const graph = createTaskGraph(join(root, "checkpoints.sqlite"), {
        ports: { ...options.ports, events: new EventJournal(root) },
        registerAbort() {},
        clearAbort() {},
        isStopRequested: () => false,
      });
      const config = { configurable: { thread_id: taskId }, durability: "sync" as const };
      const state = TaskStateSchema.parse((await graph.getState(config)).values.value);
      await graph.updateState(
        config,
        {
          value: {
            ...state,
            phase: legacyReason ? "error" : state.phase,
            stopReason: legacyReason ?? state.stopReason,
            lastAttempt: legacyReason
              ? { ...state.lastAttempt!, error: legacyReason }
              : state.lastAttempt,
          },
        },
        failedRole === "author"
          ? "callAuthor"
          : failedRole === "reviewer"
            ? "callReviewer"
            : "callApplier",
      );
      resource.service = await createAppService(options);
    },
  };
}

function approve(service: AppService, snapshot: TaskSnapshotResponse) {
  return service.decide(snapshot.task.taskId, {
    decisionId: "auth-resume-approval",
    decision: "approve",
    versionId: snapshot.state.currentVersionId!,
    manifestHash: snapshot.state.currentManifestHash!,
  });
}

it.each<AgentRole>(["author", "reviewer", "applier"])(
  "после отказа входа у %s продолжает только сохранённую роль и завершает ту же задачу",
  async (role) => {
    const f = await setup(role);
    const { taskId } = await f.service.createTask({ text: "mergeIntervals" });
    if (role === "applier")
      await approve(f.service, await waitForTask(f.service, taskId, (s) => s.actions.canDecide));
    const paused = await waitForTask(f.service, taskId, (s) => s.task.phase === "awaiting_auth");
    const callsBefore = f.mockRun.mock.calls.length;
    await f.restart();

    const restored = await f.service.getTask(taskId);
    expect(restored.state).toEqual(paused.state);
    expect(restored.files).toEqual(paused.files);
    expect(restored.actions).toMatchObject({
      canStop: true,
      canResume: true,
      resumeRequiresExplicitRetry: false,
    });
    expect(f.mockRun).toHaveBeenCalledTimes(callsBefore);
    await expect(f.service.createTask({ text: "second" })).rejects.toMatchObject({
      code: "active_task",
    });
    await expect(f.service.resume(taskId, { mode: "continue" })).rejects.toMatchObject({
      code: "codex_not_ready",
    });
    expect((await f.service.getTask(taskId)).state.usedModelCalls).toBe(
      paused.state.usedModelCalls,
    );

    f.login();
    await f.service.getConnections();
    expect(f.mockRun).toHaveBeenCalledTimes(callsBefore);
    const resumes = await Promise.allSettled([
      f.service.resume(taskId, { mode: "continue" }),
      f.service.resume(taskId, { mode: "continue" }),
    ]);
    expect(resumes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    if (role !== "applier")
      await approve(f.service, await waitForTask(f.service, taskId, (s) => s.actions.canDecide));
    const completed = await waitForTask(f.service, taskId, (s) => s.task.phase === "completed");

    const roles = ["author", "reviewer", "applier"];
    roles.splice(roles.indexOf(role), 0, role);
    expect(f.mockRun.mock.calls.map(([r]) => r.role)).toEqual(roles);
    expect(f.mockRun.mock.calls[callsBefore]![0].contextText).toBe(
      f.mockRun.mock.calls[callsBefore - 1]![0].contextText,
    );
    expect(f.mockRun.mock.calls[callsBefore]![0].attemptId).not.toBe(
      f.mockRun.mock.calls[callsBefore - 1]![0].attemptId,
    );
    expect(completed.state.usedModelCalls).toBe(4);
    expect(completed.state.createdVersions).toBe(1);
    expect(completed.task.stopReason).toBeNull();
    expect(completed.events.filter((e) => e.type === "decision_recorded")).toHaveLength(1);
    expect(completed.events.filter((e) => e.type === "publication_finished")).toHaveLength(1);
    expect((await f.service.listTasks()).tasks).toHaveLength(1);
    expect((await f.service.getResultZip(taskId)).length).toBeGreaterThan(0);
  },
  15000,
);

it("Stop сохраняется при перезапуске и запрещает продолжение даже после входа", async () => {
  const f = await setup("author");
  const { taskId } = await f.service.createTask({ text: "mergeIntervals" });
  await waitForTask(f.service, taskId, (s) => s.task.phase === "awaiting_auth");

  await f.service.stop(taskId);
  await f.restart();
  f.login();

  expect((await f.service.getTask(taskId)).task.phase).toBe("stopped");
  await expect(f.service.resume(taskId, { mode: "continue" })).rejects.toMatchObject({
    code: "resume_not_allowed",
  });
  expect(f.mockRun).toHaveBeenCalledTimes(1);
});

it("продолжение не сбрасывает исчерпанный бюджет и не вызывает модель сверх лимита", async () => {
  const f = await setup("author", 1);
  const { taskId } = await f.service.createTask({ text: "mergeIntervals" });
  await waitForTask(f.service, taskId, (s) => s.task.phase === "awaiting_auth");
  await f.restart();
  f.login();

  await f.service.resume(taskId, { mode: "continue" });
  const stopped = await waitForTask(f.service, taskId, (s) => s.task.phase === "stopped");

  expect(stopped.task.stopReason).toContain("Исчерпан общий лимит");
  expect(stopped.state.usedModelCalls).toBe(1);
  expect(f.mockRun).toHaveBeenCalledTimes(1);
});

const legacyReason =
  "Вход в Codex CLI отсутствует или истёк. Выполните /opt/homebrew/bin/codex login в терминале на компьютере сервера, затем нажмите «Проверить снова». Если задача уже завершилась ошибкой, после входа создайте её заново.";

it("сбой между сохранением отказа и interrupt восстанавливает ожидание без автоматического вызова", async () => {
  const f = await setup("author");
  const { taskId } = await f.service.createTask({ text: "mergeIntervals" });
  await waitForTask(f.service, taskId, (s) => s.task.phase === "awaiting_auth");

  await f.checkpointBeforePause(taskId);

  expect((await f.service.getTask(taskId)).actions.canResume).toBe(true);
  expect(f.mockRun).toHaveBeenCalledTimes(1);
  f.login();
  await f.service.resume(taskId, { mode: "continue" });
  const ready = await waitForTask(f.service, taskId, (s) => s.actions.canDecide);
  expect(ready.state.usedModelCalls).toBe(3);
  expect(f.mockRun.mock.calls.map(([r]) => r.role)).toEqual(["author", "author", "reviewer"]);
});

it("старая auth-error задача продолжает ревью из checkpoint, но не параллельно другой задаче", async () => {
  const f = await setup("reviewer");
  const { taskId } = await f.service.createTask({ text: "mergeIntervals" });
  const paused = await waitForTask(f.service, taskId, (s) => s.task.phase === "awaiting_auth");
  await f.checkpointBeforePause(taskId, legacyReason);
  f.login();
  const other = await f.service.createTask({ text: "mergeIntervals" });
  await waitForTask(f.service, other.taskId, (s) => s.actions.canDecide);

  expect((await f.service.getTask(taskId)).actions.canResume).toBe(true);
  expect((await f.service.getTask(taskId)).task.stopReason).not.toContain("создайте её заново");
  await expect(f.service.resume(taskId, { mode: "continue" })).rejects.toMatchObject({
    code: "active_task",
  });
  await f.service.stop(other.taskId);
  await f.service.resume(taskId, { mode: "continue" });
  const ready = await waitForTask(f.service, taskId, (s) => s.actions.canDecide);

  expect(ready.state.currentVersionId).toBe(paused.state.currentVersionId);
  expect(ready.state.latestChecks).toEqual(paused.state.latestChecks);
  expect(f.mockRun.mock.calls.filter(([r]) => r.taskId === taskId).map(([r]) => r.role)).toEqual([
    "author",
    "reviewer",
    "reviewer",
  ]);
}, 15000);

it("произвольная ошибка с упоминанием login не становится возобновляемой", async () => {
  const f = await setup("author");
  const { taskId } = await f.service.createTask({ text: "mergeIntervals" });
  await waitForTask(f.service, taskId, (s) => s.task.phase === "awaiting_auth");
  await f.checkpointBeforePause(taskId, "Unexpected login error 401");
  f.login();

  expect((await f.service.getTask(taskId)).actions.canResume).toBe(false);
  await expect(f.service.resume(taskId, { mode: "continue" })).rejects.toMatchObject({
    code: "resume_not_allowed",
  });
  expect(f.mockRun).toHaveBeenCalledTimes(1);
});
