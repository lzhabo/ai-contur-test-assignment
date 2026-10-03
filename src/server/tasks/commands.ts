import { Command } from "@langchain/langgraph";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  CreateTaskRequestSchema,
  DecisionRequestSchema,
  ResumeRequestSchema,
  type DecisionRequest,
  type ResumeRequest,
  type TaskSnapshotResponse,
} from "../../shared/api.js";
import { stateSummary } from "../logger.js";
import { ApprovalSchema, TaskStateSchema, type Approval, type TaskState } from "./types.js";

import { isLegacyAuthFailure, taskStopReason } from "./auth-resume.js";
import { ServiceError } from "./errors.js";
import { requireCodexReady } from "./connections.js";
import { now, terminal, type TaskRuntime } from "./runtime.js";
import type { AppService } from "./service.js";
import type { TaskView } from "./task-view.js";
export type TaskCommands = Pick<AppService, "createTask" | "decide" | "stop" | "resume">;

// Выполняет команды задач последовательно, сохраняя проверки версии и идемпотентности.
export function createTaskCommands(runtime: TaskRuntime, view: TaskView): TaskCommands {
  const {
    dataDir,
    models,
    limits,
    graph,
    config,
    stateOf,
    ports,
    events,
    executionMode,
    index,
    pendingDecisions,
    serializeMutation,
    startRun,
    logger,
    activeRuns,
    stopRequested,
    controllers,
    publishing,
  } = runtime;
  const { getTask: snapshot, listTasks } = view;
  /** Сохраняет решение пользователя в истории с идемпотентным идентификатором. */
  async function emitDecision(taskId: string, approval: Approval): Promise<void> {
    await events.append({
      taskId,
      eventId: `${taskId}:decision:${approval.decisionId}`,
      at: approval.at,
      type: "decision_recorded",
      from: "user",
      to: "applier",
      attemptId: null,
      text:
        approval.decision === "approve"
          ? "Пользователь подтвердил версию."
          : "Пользователь отклонил версию.",
      artifactVersionId: approval.versionId,
      source: "user",
    });
  }

  /** Проверяет идемпотентность и отсутствие активной задачи, сохраняет начальное состояние и запускает граф. */
  async function createTaskInternal(
    input: { text: string },
    idempotencyKey?: string,
  ): Promise<{ taskId: string }> {
    const parsed = CreateTaskRequestSchema.parse(input);
    if (idempotencyKey) {
      const previous = index.tasks.find(
        /* Ищет предыдущее создание с тем же ключом запроса. */ (task) =>
          task.idempotencyKey === idempotencyKey,
      );
      if (previous) {
        if (previous.text !== parsed.text)
          throw new ServiceError(
            "idempotency_conflict",
            "Ключ повторного запроса уже использован с другим заданием.",
          );
        return { taskId: previous.taskId };
      }
    }
    if ((await listTasks()).activeTaskId)
      throw new ServiceError("active_task", "Сначала завершите текущую задачу.");
    await requireCodexReady(ports.codex, executionMode);
    const taskId = randomUUID();
    const createdAt = now();
    const initial = TaskStateSchema.parse({
      schemaVersion: 1,
      taskId,
      taskText: parsed.text,
      executionMode,
      models,
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
      createdAt,
      updatedAt: createdAt,
      lastEventSequence: 0,
    });
    await mkdir(join(dataDir, "tasks", taskId), { recursive: true });
    await graph.invoke(
      { value: initial },
      { ...config(taskId), interruptBefore: ["prepareAuthor"] },
    );
    index.tasks.push({
      taskId,
      title: parsed.text.slice(0, 80),
      createdAt,
      idempotencyKey: idempotencyKey ?? null,
      text: parsed.text,
    });
    await index.save();
    await events.append({
      taskId,
      eventId: `${taskId}:created`,
      at: createdAt,
      type: "task_created",
      from: "user",
      to: "author",
      attemptId: null,
      text: "Задача создана.",
      artifactVersionId: null,
      source: "user",
    });
    await logger.record({
      event: "task_created",
      source: "service",
      taskId,
      executionMode,
      after: stateSummary(initial),
    });
    startRun(taskId);
    return { taskId };
  }
  const createTask = /* Ставит создание задачи в общую очередь изменяющих команд. */ (
    input: { text: string },
    idempotencyKey?: string,
  ) =>
    serializeMutation(
      /* Выполняет создание, когда предыдущая команда завершена. */ () =>
        createTaskInternal(input, idempotencyKey),
    );

  /** Проверяет режим и точную версию, сохраняет решение и возобновляет граф. */
  async function decideInternal(
    taskId: string,
    input: DecisionRequest,
  ): Promise<TaskSnapshotResponse> {
    const parsed = DecisionRequestSchema.parse(input);
    const { state } = await stateOf(taskId);
    if (state.executionMode !== executionMode)
      throw new ServiceError(
        "mode_mismatch",
        "Режим сохранённой задачи отличается от текущего режима сервера.",
      );
    const pending = pendingDecisions.get(taskId);
    if (
      pending &&
      pending.decisionId === parsed.decisionId &&
      pending.decision === parsed.decision &&
      pending.versionId === parsed.versionId &&
      pending.manifestHash === parsed.manifestHash
    )
      return snapshot(taskId);
    if (
      state.approval &&
      state.approval.decisionId === parsed.decisionId &&
      state.approval.decision === parsed.decision &&
      state.approval.versionId === parsed.versionId &&
      state.approval.manifestHash === parsed.manifestHash
    )
      return snapshot(taskId);
    if (
      state.phase !== "awaiting_approval" ||
      !state.currentArtifact ||
      !state.latestReview ||
      state.latestReview.verdict !== "approved"
    )
      throw new ServiceError(
        "decision_not_allowed",
        "Задача не ожидает решения по одобренной версии.",
      );
    if (
      parsed.versionId !== state.currentArtifact.versionId ||
      parsed.manifestHash !== state.currentArtifact.manifestHash ||
      parsed.manifestHash !== state.latestReview.manifestHash
    )
      throw new ServiceError("stale_version", "Показанная версия изменилась; обновите задачу.");
    if (pending) throw new ServiceError("decision_pending", "Решение уже обрабатывается.");
    if (parsed.decision === "approve") await requireCodexReady(ports.codex, executionMode);
    await ports.artifacts.verifyVersion(state.currentArtifact);
    const approval = ApprovalSchema.parse({ ...parsed, at: now() });
    await logger.record({
      event: "decision_received",
      source: "service",
      taskId,
      attemptId: state.lastAttempt?.attemptId ?? null,
      versionId: approval.versionId,
      manifestHash: approval.manifestHash,
      decisionId: approval.decisionId,
      decision: approval.decision,
    });
    pendingDecisions.set(taskId, approval);
    await emitDecision(taskId, approval);
    const run = graph
      .invoke(new Command({ resume: approval }), config(taskId))
      .then(/* Отбрасывает внутренний результат графа после завершения команды. */ () => undefined)
      .finally(
        /* Снимает отметки решения и активного запуска после завершения графа. */ () => {
          pendingDecisions.delete(taskId);
          activeRuns.delete(taskId);
        },
      );
    activeRuns.set(taskId, run);
    void run.catch(
      /* Предотвращает необработанное отклонение фонового запуска; состояние читается через snapshot. */ () =>
        undefined,
    );
    return snapshot(taskId);
  }
  const decide = /* Ставит решение пользователя в последовательную очередь команд. */ (
    taskId: string,
    input: DecisionRequest,
  ) =>
    serializeMutation(
      /* Применяет решение после завершения предыдущей команды. */ () =>
        decideInternal(taskId, input),
    );

  /** Запрашивает отмену и ожидает публикацию перед фиксацией остановки задачи. */
  async function stopInternal(taskId: string): Promise<TaskSnapshotResponse> {
    const { state, next } = await stateOf(taskId);
    if (terminal.has(state.phase)) return snapshot(taskId);
    stopRequested.add(taskId);
    await logger.record({
      event: "stop_requested",
      source: "service",
      taskId,
      attemptId: state.activeAttempt?.attemptId ?? null,
    });
    controllers.get(taskId)?.abort();
    const run = activeRuns.get(taskId);
    if (run) {
      if (publishing.has(taskId))
        await run.catch(
          /* Позволяет остановке продолжиться после ошибки завершающейся публикации. */ () =>
            undefined,
        );
      else
        await Promise.race([
          run.catch(
            /* Позволяет остановке продолжиться после ошибки активного запуска. */ () => undefined,
          ),
          new Promise(
            /* Ограничивает ожидание отмены внешнего вызова пятью секундами. */ (resolve) =>
              setTimeout(resolve, 5_000),
          ),
        ]);
    }
    const after = await stateOf(taskId);
    if (!terminal.has(after.state.phase)) {
      const updated: TaskState = {
        ...after.state,
        phase: "stopped",
        stopReason: "Остановлено пользователем.",
        activeAttempt: null,
        updatedAt: now(),
      };
      await graph.updateState(
        config(taskId),
        { value: updated },
        after.next[0] ?? next[0] ?? "waitApproval",
      );
      await events.append({
        taskId,
        eventId: `${taskId}:user-stopped`,
        at: now(),
        type: "task_stopped",
        from: "user",
        to: null,
        attemptId: state.activeAttempt?.attemptId ?? null,
        text: "Задача остановлена пользователем.",
        artifactVersionId: state.currentArtifact?.versionId ?? null,
        source: "user",
      });
    }
    return snapshot(taskId);
  }
  const stop = /* Ставит остановку задачи в очередь изменяющих команд. */ (taskId: string) =>
    serializeMutation(
      /* Выполняет остановку после предыдущей команды. */ () => stopInternal(taskId),
    );

  /** Продолжает сохранённую роль после входа либо явно повторяет неизвестный исход. */
  async function resumeInternal(
    taskId: string,
    input: ResumeRequest,
  ): Promise<TaskSnapshotResponse> {
    const parsed = ResumeRequestSchema.parse(input);
    const { state } = await stateOf(taskId);
    if (state.executionMode !== executionMode)
      throw new ServiceError(
        "mode_mismatch",
        "Режим сохранённой задачи отличается от текущего режима сервера.",
      );
    const legacyAuth = isLegacyAuthFailure(state);
    const continueAuth =
      (state.phase === "awaiting_auth" || legacyAuth) && parsed.mode === "continue";
    const retryUnknown = state.phase === "unknown_outcome" && parsed.mode === "retry_unknown";
    if (!continueAuth && !retryUnknown)
      throw new ServiceError(
        "resume_not_allowed",
        "Эту задачу нельзя продолжить выбранной командой.",
      );
    const activeTaskId = (await listTasks()).activeTaskId;
    if (activeTaskId && activeTaskId !== taskId)
      throw new ServiceError("active_task", "Сначала завершите текущую задачу.");
    if (activeRuns.has(taskId)) throw new ServiceError("task_running", "Задача ещё выполняется.");
    await requireCodexReady(ports.codex, executionMode);
    if (continueAuth && state.currentArtifact)
      await ports.artifacts.verifyVersion(state.currentArtifact);
    if (legacyAuth) {
      const paused: TaskState = {
        ...state,
        phase: "awaiting_auth",
        stopReason: taskStopReason(state),
        updatedAt: now(),
      };
      const role = state.lastAttempt!.role;
      const node =
        role === "author" ? "callAuthor" : role === "reviewer" ? "callReviewer" : "callApplier";
      await graph.updateState(config(taskId), { value: paused }, node);
      await graph.invoke(null, config(taskId));
    }
    startRun(taskId, new Command({ resume: { retry: true } }));
    await logger.record({
      event: "resume_requested",
      source: "service",
      taskId,
      attemptId: state.lastAttempt?.attemptId ?? null,
    });
    return snapshot(taskId);
  }
  const resume = /* Ставит явный повтор вызова в очередь команд задачи. */ (
    taskId: string,
    input: ResumeRequest,
  ) =>
    serializeMutation(
      /* Выполняет возобновление после завершения предыдущей команды. */ () =>
        resumeInternal(taskId, input),
    );

  return { createTask, decide, stop, resume };
}
