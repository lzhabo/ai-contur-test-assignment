import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createAppService } from "../../src/server/tasks/service.js";
import type { DecisionRequest, TaskSnapshotResponse } from "../../src/shared/api.js";
import { setupService as setup, waitForTask as until, services } from "../support/service.js";

// Формирует подтверждение точной версии и хеша, показанных пользователю.
function decision(value: TaskSnapshotResponse): DecisionRequest {
  return {
    decisionId: "qa-approve",
    decision: "approve",
    versionId: value.state.currentVersionId!,
    manifestHash: value.state.currentManifestHash!,
  };
}
it("A-08: устаревший хеш подтверждения отклоняется без публикации", async () => {
  // Проверяет сценарий: A-08: устаревший хеш подтверждения отклоняется без публикации.

  const f = await setup();
  const { taskId } = await f.service.createTask({ text: "mergeIntervals" }, "qa-create");
  const paused = await until(
    f.service,
    taskId,
    /* Проверяет достижение нужного состояния. */ (value) => value.actions.canDecide,
  );
  const approval = { ...decision(paused), manifestHash: "0".repeat(64) };

  const approveStaleVersion =
    /* Отправляет решение, которое должно быть отклонено по проверяемому условию. */ () =>
      f.service.decide(taskId, approval);

  await expect(approveStaleVersion()).rejects.toMatchObject({
    code: "stale_version",
  });
  expect(
    f.calls.filter(/* Отбирает записи проверяемого вида. */ (call) => call.role === "applier"),
  ).toHaveLength(0);
}, 15000);

it("A-08: одновременное повторное подтверждение публикует ровно один раз", async () => {
  // Проверяет сценарий: A-08: одновременное повторное подтверждение публикует ровно один раз.

  const f = await setup();
  const { taskId } = await f.service.createTask({ text: "mergeIntervals" });
  const paused = await until(
    f.service,
    taskId,
    /* Проверяет достижение нужного состояния. */ (value) => value.actions.canDecide,
  );
  const approval = decision(paused);

  await Promise.all([f.service.decide(taskId, approval), f.service.decide(taskId, approval)]);
  const finished = await until(
    f.service,
    taskId,
    /* Проверяет достижение нужного состояния. */ (value) => value.task.phase === "completed",
  );

  expect(finished.state.resultPath).not.toBeNull();
  expect(
    f.calls.filter(/* Отбирает записи проверяемого вида. */ (call) => call.role === "applier"),
  ).toHaveLength(1);
}, 15000);

it("A-08: повтор подтверждения готовой задачи сохраняет результат без нового вызова", async () => {
  // Проверяет сценарий: A-08: повтор подтверждения готовой задачи сохраняет результат без нового вызова.

  const f = await setup();
  const { taskId } = await f.service.createTask({ text: "mergeIntervals" });
  const paused = await until(
    f.service,
    taskId,
    /* Проверяет достижение нужного состояния. */ (value) => value.actions.canDecide,
  );
  const approval = decision(paused);
  await f.service.decide(taskId, approval);
  const finished = await until(
    f.service,
    taskId,
    /* Проверяет достижение нужного состояния. */ (value) => value.task.phase === "completed",
  );

  const repeated = await f.service.decide(taskId, approval);

  expect(repeated.state.currentManifestHash).toBe(finished.state.currentManifestHash);
  expect(
    f.calls.filter(/* Отбирает записи проверяемого вида. */ (call) => call.role === "applier"),
  ).toHaveLength(1);
}, 15000);

it("A-09: одновременные создания с одним ключом возвращают одну задачу", async () => {
  // Проверяет сценарий: A-09: одновременные создания с одним ключом возвращают одну задачу.

  const f = await setup("slow");

  const results = await Promise.all([
    f.service.createTask({ text: "mergeIntervals" }, "same-key"),
    f.service.createTask({ text: "mergeIntervals" }, "same-key"),
  ]);

  expect(results[0]).toEqual(results[1]);
  expect((await f.service.listTasks()).tasks).toHaveLength(1);

  await f.service.stop(results[0]!.taskId);
}, 15000);

it("A-09: разные одновременные запросы не запускают две активные задачи", async () => {
  // Проверяет сценарий: A-09: разные одновременные запросы не запускают две активные задачи.

  const f = await setup("slow");

  const results = await Promise.allSettled([
    f.service.createTask({ text: "mergeIntervals" }, "one"),
    f.service.createTask({ text: "catify" }, "two"),
  ]);

  expect(
    results.filter(
      /* Отбирает записи проверяемого вида. */ (result) => result.status === "fulfilled",
    ),
  ).toHaveLength(1);
  expect((await f.service.listTasks()).tasks).toHaveLength(1);
}, 15000);

it("A-03/A-04: неизвестный исход сохраняется после перезапуска без скрытого повтора", async () => {
  // Проверяет сценарий: A-03/A-04: неизвестный исход сохраняется после перезапуска без скрытого повтора.

  const f = await setup("no_response");

  const { taskId } = await f.service.createTask({ text: "mergeIntervals" });
  const before = await until(
    f.service,
    taskId,
    /* Проверяет достижение нужного состояния. */ (value) => value.task.phase === "unknown_outcome",
  );

  await f.service.close();
  services.splice(services.indexOf(f.service), 1);

  const restarted = await createAppService(f.options);
  services.push(restarted);
  const after = await restarted.getTask(taskId);

  expect(after.task.phase).toBe("unknown_outcome");
  expect(after.state.usedModelCalls).toBe(before.state.usedModelCalls);
  expect(f.calls).toHaveLength(1);
  expect(after.actions.resumeRequiresExplicitRetry).toBe(true);
  await expect(restarted.resume(taskId, { mode: "continue" })).rejects.toMatchObject({
    code: "resume_not_allowed",
  });

  await restarted.resume(taskId, { mode: "retry_unknown" });
  await until(
    restarted,
    taskId,
    /* Проверяет достижение нужного состояния. */ (value) =>
      value.task.phase === "unknown_outcome" && value.state.usedModelCalls === 2,
  );

  expect(f.calls).toHaveLength(2);
}, 15000);

it("A-10: перезапуск выявляет изменённый результат и не показывает его готовым", async () => {
  // Проверяет сценарий: A-10: перезапуск выявляет изменённый результат и не показывает его готовым.

  const f = await setup();
  const { taskId } = await f.service.createTask({ text: "mergeIntervals" });
  const paused = await until(
    f.service,
    taskId,
    /* Проверяет достижение нужного состояния. */ (value) => value.actions.canDecide,
  );
  await f.service.decide(taskId, decision(paused));
  const completed = await until(
    f.service,
    taskId,
    /* Проверяет достижение нужного состояния. */ (value) => value.task.phase === "completed",
  );
  await f.service.close();
  services.splice(services.indexOf(f.service), 1);
  await writeFile(
    path.join(completed.state.resultPath!, "solution.ts"),
    "changed after publication",
  );
  const restarted = await createAppService(f.options);
  services.push(restarted);
  const visible = await restarted.getTask(taskId);

  expect(visible.task.phase).not.toBe("completed");
  expect(visible.task.stopReason).toBeTruthy();
}, 15000);

it("A-08: победившая остановка запрещает публикацию при одновременном подтверждении", async () => {
  // Проверяет сценарий: A-08: победившая остановка запрещает публикацию при одновременном подтверждении.

  const f = await setup("slow");
  const { taskId } = await f.service.createTask({ text: "mergeIntervals" });
  const paused = await until(
    f.service,
    taskId,
    /* Проверяет достижение нужного состояния. */ (value) => value.actions.canDecide,
  );
  await Promise.allSettled([f.service.stop(taskId), f.service.decide(taskId, decision(paused))]);
  const ended = await until(
    f.service,
    taskId,
    /* Проверяет достижение нужного состояния. */ (value) => value.task.phase === "stopped",
  );

  expect(ended.state.resultPath).toBeNull();
  await expect(f.service.getResultZip(taskId)).rejects.toMatchObject({
    code: "result_unavailable",
  });
}, 15000);
