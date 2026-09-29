import { resolve } from "node:path";
import type { CodexReadiness } from "../../shared/connections.js";
import { readConnections } from "./connections.js";
import type {
  DecisionRequest,
  ResumeRequest,
  TaskListResponse,
  TaskSnapshotResponse,
} from "../../shared/api.js";
import type { ModelAssignments } from "../config.js";
import {
  bestEffortLogger,
  noOpLogger,
  safeErrorClass,
  type ObservabilityLogger,
} from "../logger.js";
import { acquireDataLock } from "../storage/data-lock.js";
import { EventJournal } from "../storage/task-history.js";
import { createTaskCommands } from "./commands.js";
import type { TaskRuntimePorts } from "./ports.js";
import { recoverTasks } from "./recovery.js";
import { createTaskRuntime } from "./runtime.js";
import { createTaskView } from "./task-view.js";
import type { RuntimeLimits } from "./types.js";
export { ServiceError } from "./errors.js";
type NonEventPorts = Omit<TaskRuntimePorts, "events">;

export interface AppServiceOptions {
  dataDir: string;
  ports: NonEventPorts;
  models?: ModelAssignments;
  limits?: RuntimeLimits;
  executionMode?: "real" | "mock";
  logger?: ObservabilityLogger;
}

export interface AppService {
  getConnections(): Promise<CodexReadiness>;
  readonly events: EventJournal;
  readonly executionMode: "real" | "mock";
  createTask(input: { text: string }, idempotencyKey?: string): Promise<{ taskId: string }>;
  listTasks(): Promise<TaskListResponse>;
  getTask(taskId: string): Promise<TaskSnapshotResponse>;
  decide(taskId: string, input: DecisionRequest): Promise<TaskSnapshotResponse>;
  stop(taskId: string): Promise<TaskSnapshotResponse>;
  resume(taskId: string, input: ResumeRequest): Promise<TaskSnapshotResponse>;
  getFile(taskId: string, artifactId: string): Promise<{ content: string; path: string }>;
  getResultZip(taskId: string): Promise<Uint8Array>;
  close(): Promise<void>;
}

// Захватывает каталог данных, собирает операции и восстанавливает задачи перед приёмом запросов.
export async function createAppService(options: AppServiceOptions): Promise<AppService> {
  const dataDir = resolve(options.dataDir);
  const lock = await acquireDataLock(dataDir);
  const logger = bestEffortLogger(options.logger ?? noOpLogger);
  try {
    const events = new EventJournal(dataDir);
    const runtime = await createTaskRuntime(dataDir, events, options);
    const view = createTaskView(runtime);
    const commands = createTaskCommands(runtime, view);
    await logger.record({
      event: "service_started",
      source: "service",
      executionMode: runtime.executionMode,
      taskCount: runtime.index.tasks.length,
    });
    await recoverTasks(runtime);

    // Отменяет вызовы, дожидается записи результатов и освобождает каталог данных.
    async function close(): Promise<void> {
      for (const controller of runtime.controllers.values()) controller.abort();
      await Promise.allSettled([...runtime.activeRuns.values()]);
      await lock.release();
      await logger.record({
        event: "service_stopped",
        source: "service",
        executionMode: runtime.executionMode,
      });
      await logger.flush();
    }

    return {
      events,
      executionMode: runtime.executionMode,
      getConnections: () => readConnections(runtime.ports.codex, runtime.executionMode),
      ...view,
      ...commands,
      close,
    };
  } catch (error) {
    await logger.record({
      event: "service_start_failed",
      source: "service",
      errorClass: safeErrorClass(error),
    });
    await lock.release();
    throw error;
  }
}
