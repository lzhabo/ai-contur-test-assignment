import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { safeErrorClass, stateSummary } from "../logger.js";
import { type TaskState } from "./types.js";

import { now, terminal, type TaskRuntime } from "./runtime.js";
const externalNodes = new Set(["callAuthor", "callReviewer", "callApplier"]);

// Проверяет незавершённые checkpoints: восстанавливает публикацию либо ждёт явного повтора.
export async function recoverTasks(runtime: TaskRuntime): Promise<void> {
  const { dataDir, index, graph, config, stateOf, ports, events, executionMode, logger, startRun } =
    runtime;
  // Persist an explicit unknown state before serving recovered tasks. `updateState`
  // skips the pending external node and routes only into the pure interrupt.
  for (const entry of index.tasks) {
    const { state, next } = await stateOf(entry.taskId);
    const pendingNode = next[0];
    await logger.record({
      event: "task_recovered",
      source: "service",
      taskId: entry.taskId,
      attemptId: state.activeAttempt?.attemptId ?? state.lastAttempt?.attemptId ?? null,
      node: pendingNode ?? null,
      after: stateSummary(state),
      executionMode,
    });
    // A different adapter mode may inspect history, but must never continue a
    // pending real task with mock output (or the reverse).
    if (state.executionMode !== executionMode) {
      await logger.record({
        event: "recovery_mode_mismatch",
        source: "service",
        taskId: entry.taskId,
        node: pendingNode ?? null,
        executionMode,
      });
      continue;
    }
    if (pendingNode === "pauseAuth" && state.phase === "awaiting_auth") {
      // Сбой мог случиться между checkpoint отказа и interrupt: сохраняем ожидание без вызова модели.
      await graph.invoke(null, config(entry.taskId));
      continue;
    }
    if (
      pendingNode === "callApplier" &&
      state.activeAttempt &&
      state.currentArtifact &&
      state.approval?.decision === "approve"
    ) {
      const resultPath = join(dataDir, "tasks", entry.taskId, "result");
      let resultExists = false;
      try {
        await lstat(resultPath);
        resultExists = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (resultExists) {
        try {
          await ports.artifacts.verifyVersion(state.currentArtifact);
          await ports.artifacts.getResultZip(entry.taskId, state.currentArtifact);
          const completedAttempt = {
            ...state.activeAttempt,
            status: "completed" as const,
            endedAt: now(),
          };
          const completed: TaskState = {
            ...state,
            phase: "completed",
            resultPath,
            activeAttempt: null,
            lastAttempt: completedAttempt,
            updatedAt: now(),
          };
          await graph.updateState(config(entry.taskId), { value: completed }, "callApplier");
          await logger.record({
            event: "recovery_publication_completed",
            source: "service",
            taskId: entry.taskId,
            attemptId: completedAttempt.attemptId,
            node: "callApplier",
            before: stateSummary(state),
            after: stateSummary(completed),
          });
          await events.append({
            taskId: entry.taskId,
            eventId: `${entry.taskId}:${completedAttempt.attemptId}:published`,
            at: now(),
            type: "publication_finished",
            from: "applier",
            to: "user",
            attemptId: completedAttempt.attemptId,
            text: "Одобренная версия восстановлена по опубликованным файлам.",
            artifactVersionId: state.currentArtifact.versionId,
            source: "recovery",
          });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          const failedAttempt = {
            ...state.activeAttempt,
            status: "failed" as const,
            endedAt: now(),
            error: reason,
          };
          const broken: TaskState = {
            ...state,
            phase: "error",
            stopReason: `Опубликованный результат повреждён после сбоя: ${reason}`,
            activeAttempt: null,
            lastAttempt: failedAttempt,
            updatedAt: now(),
          };
          await graph.updateState(config(entry.taskId), { value: broken }, "callApplier");
          await logger.record({
            event: "recovery_publication_failed",
            source: "service",
            taskId: entry.taskId,
            attemptId: failedAttempt.attemptId,
            node: "callApplier",
            before: stateSummary(state),
            after: stateSummary(broken),
            errorClass: safeErrorClass(error),
          });
          await events.append({
            taskId: entry.taskId,
            eventId: `${entry.taskId}:${failedAttempt.attemptId}:published-corrupt`,
            at: now(),
            type: "task_failed",
            from: "system",
            to: "user",
            attemptId: failedAttempt.attemptId,
            text: broken.stopReason!,
            artifactVersionId: state.currentArtifact.versionId,
            source: "recovery",
          });
        }
        continue;
      }
    }
    if (pendingNode && externalNodes.has(pendingNode) && state.activeAttempt) {
      const lastAttempt = {
        ...state.activeAttempt,
        status: "unknown" as const,
        endedAt: now(),
        error: "Backend stopped before the external call outcome was checkpointed.",
      };
      const unknown: TaskState = {
        ...state,
        phase: "unknown_outcome",
        stopReason: "Исход внешнего вызова после перезапуска неизвестен.",
        activeAttempt: null,
        lastAttempt,
        updatedAt: now(),
      };
      await graph.updateState(config(entry.taskId), { value: unknown }, pendingNode);
      await logger.record({
        event: "recovery_unknown_outcome",
        source: "service",
        taskId: entry.taskId,
        attemptId: lastAttempt.attemptId,
        node: pendingNode,
        before: stateSummary(state),
        after: stateSummary(unknown),
      });
      await events.append({
        taskId: entry.taskId,
        eventId: `${entry.taskId}:${lastAttempt.attemptId}:recovered-unknown`,
        at: now(),
        type: "unknown_outcome",
        from: "system",
        to: "user",
        attemptId: lastAttempt.attemptId,
        text: unknown.stopReason!,
        artifactVersionId: state.currentArtifact?.versionId ?? null,
        source: "checkpoint",
      });
      await graph.invoke(null, config(entry.taskId));
    } else if (
      pendingNode &&
      pendingNode !== "waitApproval" &&
      pendingNode !== "pauseUnknown" &&
      pendingNode !== "pauseAuth" &&
      !terminal.has(state.phase)
    ) {
      startRun(entry.taskId);
    }
  }
}
