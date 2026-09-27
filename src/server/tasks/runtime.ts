import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  DEFAULT_LIMITS,
  DEFAULT_MODELS,
  ModelAssignmentsSchema,
  type ModelAssignments,
} from "../config.js";
import {
  bestEffortLogger,
  noOpLogger,
  safeErrorClass,
  type ObservabilityLogger,
} from "../logger.js";
import { EventJournal } from "../storage/task-history.js";
import { createTaskGraph } from "./agent-loop.js";
import type { TaskRuntimePorts } from "./ports.js";
import {
  RuntimeLimitsSchema,
  TaskStateSchema,
  type Approval,
  type RuntimeLimits,
  type TaskState,
} from "./types.js";

import { TaskIndex } from "../storage/task-index.js";
import { ServiceError } from "./errors.js";
import type { AppServiceOptions } from "./service.js";
export const terminal = new Set<TaskState["phase"]>(["completed", "stopped", "error"]);
// Возвращает время записи состояния и события в едином ISO-формате.
export const now = (): string => new Date().toISOString();

export interface TaskRuntime {
  dataDir: string;
  models: ModelAssignments;
  limits: RuntimeLimits;
  executionMode: "real" | "mock";
  logger: ObservabilityLogger;
  events: EventJournal;
  ports: TaskRuntimePorts;
  index: TaskIndex;
  graph: ReturnType<typeof createTaskGraph>;
  activeRuns: Map<string, Promise<void>>;
  controllers: Map<string, AbortController>;
  stopRequested: Set<string>;
  publishing: Set<string>;
  pendingDecisions: Map<string, Approval>;
  config(taskId: string): { configurable: { thread_id: string }; durability: "sync" };
  stateOf(taskId: string): Promise<{ state: TaskState; next: string[] }>;
  startRun(taskId: string, input?: unknown): void;
  serializeMutation<T>(action: () => Promise<T>): Promise<T>;
}

// Собирает граф и координирует запуски, отмену и последовательное выполнение команд.
export async function createTaskRuntime(
  dataDir: string,
  events: EventJournal,
  options: AppServiceOptions,
): Promise<TaskRuntime> {
  const models = ModelAssignmentsSchema.parse(options.models ?? DEFAULT_MODELS);
  const limits = RuntimeLimitsSchema.parse(options.limits ?? DEFAULT_LIMITS);
  const executionMode = options.executionMode ?? "real";
  const logger = bestEffortLogger(options.logger ?? noOpLogger);
  const ports: TaskRuntimePorts = { ...options.ports, events };
  const activeRuns = new Map<string, Promise<void>>();
  const controllers = new Map<string, AbortController>();
  const stopRequested = new Set<string>();
  const publishing = new Set<string>();
  const pendingDecisions = new Map<string, Approval>();
  let mutationQueue: Promise<void> = Promise.resolve();
  /** Последовательно выполняет изменяющие команды, сохраняя работоспособность очереди после ошибок. */
  function serializeMutation<T>(action: () => Promise<T>): Promise<T> {
    const result = mutationQueue.then(action);
    mutationQueue = result.then(
      /* Освобождает очередь команд после успешной операции. */ () => undefined,
      /* Освобождает очередь команд после ошибки операции. */ () => undefined,
    );
    return result;
  }
  const checkpointPath = join(dataDir, "checkpoints.sqlite");
  const graph = createTaskGraph(checkpointPath, {
    ports,
    registerAbort: /* Регистрирует контроллер текущего вызова для команды остановки. */ (
      taskId,
      controller,
    ) => controllers.set(taskId, controller),
    clearAbort: /* Снимает только контроллер завершившегося вызова, не затрагивая новый. */ (
      taskId,
      controller,
    ) => {
      if (controllers.get(taskId) === controller) controllers.delete(taskId);
    },
    isStopRequested: /* Проверяет, запросил ли пользователь остановку задачи. */ (taskId) =>
      stopRequested.has(taskId),
    setPublishing:
      /* Отмечает участок публикации, завершения которого должна дождаться остановка. */ (
        taskId,
        active,
      ) => {
        if (active) publishing.add(taskId);
        else publishing.delete(taskId);
      },
    logger,
  });
  const config = /* Привязывает запуск графа к задаче и синхронной записи checkpoints. */ (
    taskId: string,
  ) => ({ configurable: { thread_id: taskId }, durability: "sync" as const });
  const index = await TaskIndex.open(dataDir);
  /** Проверяет наличие задачи в индексе и читает её проверенное состояние из checkpoint. */
  async function stateOf(taskId: string): Promise<{ state: TaskState; next: string[] }> {
    if (
      !index.tasks.some(
        /* Проверяет наличие идентификатора в индексе задач. */ (task) => task.taskId === taskId,
      )
    )
      throw new ServiceError("task_not_found", "Задача не найдена.");
    const snapshot = await graph.getState(config(taskId));
    const value = (snapshot.values as { value?: unknown }).value;
    if (!value) throw new ServiceError("checkpoint_missing", "Состояние задачи ещё не сохранено.");
    return { state: TaskStateSchema.parse(value), next: [...snapshot.next] };
  }

  /** Запускает не более одного графа для задачи и сохраняет ошибку фонового выполнения. */
  function startRun(taskId: string, input: unknown = null): void {
    if (activeRuns.has(taskId)) return;
    const run = Promise.resolve()
      .then(
        /* Продолжает граф с указанным входом и синхронным сохранением состояния. */ () =>
          graph.invoke(input as never, config(taskId)),
      )
      .then(/* Отбрасывает внутренний результат после завершения графа. */ () => undefined)
      .catch(
        /* Записывает сбой фонового графа в диагностику и историю задачи. */ async (error) => {
          await logger.record({
            event: "run_failed",
            source: "service",
            taskId,
            errorClass: safeErrorClass(error),
          });
          const message = error instanceof Error ? error.message : String(error);
          await events.append({
            taskId,
            eventId: `${taskId}:graph-error:${randomUUID()}`,
            at: now(),
            type: "task_failed",
            from: "system",
            to: null,
            attemptId: null,
            text: message,
            artifactVersionId: null,
            source: "langgraph",
          });
        },
      )
      .finally(
        /* Снимает отметку активного запуска после любого исхода графа. */ () => {
          activeRuns.delete(taskId);
        },
      );
    activeRuns.set(taskId, run);
  }

  return {
    dataDir,
    models,
    limits,
    executionMode,
    logger,
    events,
    ports,
    index,
    graph,
    activeRuns,
    controllers,
    stopRequested,
    publishing,
    pendingDecisions,
    config,
    stateOf,
    startRun,
    serializeMutation,
  };
}
