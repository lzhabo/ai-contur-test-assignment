import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  TaskSnapshotResponseSchema,
  type TaskListResponse,
  type TaskSnapshotResponse,
  type TaskSummary,
} from "../../shared/api.js";
import { type TaskState } from "./types.js";

import { ServiceError } from "./errors.js";
import { now, terminal, type TaskRuntime } from "./runtime.js";
import type { AppService } from "./service.js";
export type TaskView = Pick<AppService, "getTask" | "listTasks" | "getFile" | "getResultZip">;

// Собирает ответы для браузера и проверяет целостность отдаваемых файлов.
export function createTaskView(runtime: TaskRuntime): TaskView {
  const { graph, config, stateOf, ports, events, executionMode, index, pendingDecisions } = runtime;
  /** Сверяет опубликованные байты; при повреждении переводит завершённую задачу в ошибку. */
  async function ensureCompletedIntegrity(taskId: string, state: TaskState): Promise<TaskState> {
    if (state.phase !== "completed" || !state.currentArtifact) return state;
    try {
      await ports.artifacts.verifyVersion(state.currentArtifact);
      for (const file of state.currentArtifact.files) {
        const result = await ports.artifacts.getFile(taskId, file.artifactId, "result");
        const hash = createHash("sha256").update(result.content).digest("hex");
        if (hash !== file.sha256)
          throw new Error(`Published file differs from approved version: ${file.path}`);
      }
      return state;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const updated: TaskState = {
        ...state,
        phase: "error",
        stopReason: `Повреждён или отсутствует опубликованный файл: ${message}`,
        updatedAt: now(),
      };
      await graph.updateState(config(taskId), { value: updated }, "callApplier");
      await events.append({
        taskId,
        eventId: `${taskId}:published-integrity-error`,
        at: now(),
        type: "task_failed",
        from: "system",
        to: "user",
        attemptId: null,
        text: updated.stopReason!,
        artifactVersionId: state.currentArtifact.versionId,
        source: "integrity-check",
      });
      return updated;
    }
  }

  /** Собирает состояние экрана и историю; путь опубликованного результата привязывает к текущему каталогу данных. */
  async function snapshot(taskId: string): Promise<TaskSnapshotResponse> {
    const loaded = await stateOf(taskId);
    const state = await ensureCompletedIntegrity(taskId, loaded.state);
    const modeMismatch = state.executionMode !== executionMode;
    const entry = index.tasks.find(
      /* Находит заголовок выбранной задачи в индексе. */ (task) => task.taskId === taskId,
    )!;
    const taskEvents = await events.readAfter(taskId, 0);
    const lastObserved = [...taskEvents]
      .reverse()
      .find(
        /* Находит последнее наблюдение текущей попытки модели. */ (event) =>
          event.type === "attempt_observed" && event.attemptId === state.activeAttempt?.attemptId,
      );
    const activeAttempt = state.activeAttempt
      ? {
          attemptId: state.activeAttempt.attemptId,
          role: state.activeAttempt.role,
          modelId: state.activeAttempt.modelId,
          startedAt: state.activeAttempt.startedAt,
          lastObservedAt: lastObserved?.at ?? null,
          lastObservedStage: lastObserved?.text ?? null,
        }
      : null;
    const canDecide =
      !modeMismatch &&
      state.phase === "awaiting_approval" &&
      state.latestReview?.verdict === "approved" &&
      state.latestChecks?.compilation.status === "passed" &&
      state.latestChecks.tests.status === "passed" &&
      !pendingDecisions.has(taskId);
    const files =
      state.currentArtifact?.files.map(
        /* Дополняет файл версией и признаком завершённой публикации для интерфейса. */ (file) => ({
          ...file,
          versionId: state.currentArtifact!.versionId,
          published: state.phase === "completed",
        }),
      ) ?? [];
    const check = state.latestChecks;
    const checkStatus = check
      ? check.compilation.status !== "passed"
        ? check.compilation.status
        : check.tests.status
      : null;
    const summary: TaskSummary = {
      taskId,
      title: entry.title,
      phase: state.phase,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      currentVersionId: state.currentArtifact?.versionId ?? null,
      stopReason:
        modeMismatch && !terminal.has(state.phase)
          ? `Задача сохранена в режиме ${state.executionMode}; текущий сервер запущен в режиме ${executionMode}. Для продолжения вернитесь к исходному режиму.`
          : state.stopReason,
    };
    return TaskSnapshotResponseSchema.parse({
      task: summary,
      state: {
        taskText: state.taskText,
        executionMode: state.executionMode,
        models: state.models,
        currentVersionId: state.currentArtifact?.versionId ?? null,
        currentManifestHash: state.currentArtifact?.manifestHash ?? null,
        latestReview: state.latestReview
          ? {
              verdict: state.latestReview.verdict,
              findings: state.latestReview.findings,
              versionId: state.latestReview.versionId,
            }
          : null,
        latestChecks: check
          ? {
              versionId: check.versionId,
              status: checkStatus,
              compilationStatus: check.compilation.status,
              testsStatus: check.tests.status,
              passedCases: check.passedCases,
              failedCases: check.failedCases,
              diagnostics: [...check.compilation.details, ...check.tests.details],
            }
          : null,
        activeAttempt,
        usedModelCalls: state.usedModelCalls,
        maxModelCalls: state.limits.maxModelCalls,
        createdVersions: state.createdVersions,
        maxVersions: state.limits.maxVersions,
        resultPath:
          state.resultPath === null ? null : join(runtime.dataDir, "tasks", taskId, "result"),
      },
      actions: {
        canStop: !terminal.has(state.phase),
        canDecide,
        canResume: state.phase === "unknown_outcome" && !modeMismatch,
        resumeRequiresExplicitRetry: state.phase === "unknown_outcome",
      },
      files,
      events: taskEvents,
      lastEventSequence: taskEvents.at(-1)?.sequence ?? 0,
    });
  }

  /** Собирает краткие сведения о задачах и определяет единственную незавершённую задачу. */
  async function listTasks(): Promise<TaskListResponse> {
    const tasks: TaskSummary[] = [];
    let activeTaskId: string | null = null;
    for (const entry of index.tasks) {
      const loaded = await stateOf(entry.taskId);
      const state = await ensureCompletedIntegrity(entry.taskId, loaded.state);
      const modeMismatch = state.executionMode !== executionMode;
      tasks.push({
        taskId: entry.taskId,
        title: entry.title,
        phase: state.phase,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
        currentVersionId: state.currentArtifact?.versionId ?? null,
        stopReason:
          modeMismatch && !terminal.has(state.phase)
            ? `Задача сохранена в режиме ${state.executionMode}; текущий сервер запущен в режиме ${executionMode}.`
            : state.stopReason,
      });
      if (!terminal.has(state.phase)) activeTaskId = entry.taskId;
    }
    return { tasks: tasks.reverse(), activeTaskId };
  }

  /** Возвращает файл только при совпадении его метаданных и точных байтов с текущей версией. */
  async function getFile(
    taskId: string,
    artifactId: string,
  ): Promise<{ content: string; path: string }> {
    const { state } = await stateOf(taskId);
    const ref = state.currentArtifact;
    const file = ref?.files.find(
      /* Находит запрошенный артефакт в текущей версии задачи. */ (item) =>
        item.artifactId === artifactId,
    );
    if (!ref || !file)
      throw new ServiceError("artifact_not_found", "Файл не найден в текущей версии задачи.");
    await ports.artifacts.verifyVersion(ref);
    const result = await ports.artifacts.getFile(
      taskId,
      artifactId,
      state.phase === "completed" ? "result" : "revision",
    );
    if (
      result.metadata.artifactId !== file.artifactId ||
      result.metadata.path !== file.path ||
      result.metadata.sha256 !== file.sha256 ||
      result.metadata.bytes !== file.bytes ||
      createHash("sha256").update(result.content).digest("hex") !== file.sha256 ||
      Buffer.byteLength(result.content) !== file.bytes
    ) {
      throw new ServiceError(
        "artifact_changed",
        "Файл не совпадает с сохранённой одобренной версией.",
      );
    }
    return { content: result.content, path: result.metadata.path };
  }

  /** Разрешает архив только завершённой версии с явным одобрением пользователя. */
  async function getResultZip(taskId: string): Promise<Uint8Array> {
    const { state } = await stateOf(taskId);
    if (
      state.phase !== "completed" ||
      !state.currentArtifact ||
      !state.approval ||
      state.approval.decision !== "approve"
    )
      throw new ServiceError("result_unavailable", "Подтверждённый результат пока недоступен.");
    await ports.artifacts.verifyVersion(state.currentArtifact);
    return ports.artifacts.getResultZip(taskId, state.currentArtifact);
  }

  return { getTask: snapshot, listTasks, getFile, getResultZip };
}
