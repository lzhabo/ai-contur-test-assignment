import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { TaskState } from "../../shared/contracts.js";
import { changedFields, safeErrorClass, stateSummary, type LogEvent, type ObservabilityLogger } from "./logger.js";

function checkpointState(value: unknown): TaskState | null {
  if (!value || typeof value !== "object") return null;
  const channels = (value as { channel_values?: { value?: unknown } }).channel_values;
  const state = channels?.value;
  return state && typeof state === "object" && "taskId" in state && "phase" in state ? state as TaskState : null;
}

// Proxying the official saver preserves its SQLite implementation, serializer,
// synchronous durability, and other saver methods. This is an application-level
// observation of a successful put, not a SQL statement/transaction trace.
export function observedSqliteSaver(path: string, logger: ObservabilityLogger, nodeForTask?: (taskId: string) => string | null): SqliteSaver {
  const saver = SqliteSaver.fromConnString(path);
  async function record(event: LogEvent) { try { await logger.record(event); } catch { /* diagnostics never affect durable state */ } }
  return new Proxy(saver, {
    get(target, property) {
      if (property === "put") {
        return async (...args: Parameters<SqliteSaver["put"]>): ReturnType<SqliteSaver["put"]> => {
          const [config, checkpoint, metadata] = args;
          const taskId = config.configurable?.thread_id as string | undefined;
          const checkpointId = checkpoint.id;
          const parentCheckpointId = config.configurable?.checkpoint_id as string | undefined;
          let previous: TaskState | null = null;
          try { previous = checkpointState((await target.getTuple(config))?.checkpoint); } catch { /* no prior readable checkpoint */ }
          try {
            const result = await target.put(config, checkpoint, metadata);
            const next = checkpointState(checkpoint);
            const before = stateSummary(previous);
            const after = stateSummary(next);
            const node = (metadata.source === "loop" && taskId) ? nodeForTask?.(taskId) ?? null : null;
            await record({ event: "checkpoint_persisted", source: "SqliteSaver.put", taskId, attemptId: next?.activeAttempt?.attemptId ?? next?.lastAttempt?.attemptId ?? null, node, checkpointId, parentCheckpointId: parentCheckpointId ?? null, before, after, changed: changedFields(before, after) });
            return result;
          } catch (error) {
            await record({ event: "checkpoint_failed", source: "SqliteSaver.put", taskId, checkpointId, parentCheckpointId: parentCheckpointId ?? null, errorClass: safeErrorClass(error) });
            throw error;
          }
        };
      }
      if (property === "putWrites") {
        return async (...args: Parameters<SqliteSaver["putWrites"]>): ReturnType<SqliteSaver["putWrites"]> => {
          const [config, writes, graphTaskId] = args;
          const taskId = config.configurable?.thread_id as string | undefined;
          const checkpointId = config.configurable?.checkpoint_id as string | undefined;
          const channels = writes.map(([channel]) => channel).filter(channel => channel === "value" || channel === "__interrupt__" || channel === "__error__");
          const next = writes.find(([channel]) => channel === "value")?.[1] as TaskState | undefined;
          let previous: TaskState | null = null;
          try { previous = checkpointState((await target.getTuple(config))?.checkpoint); } catch { /* missing prior checkpoint */ }
          try {
            await target.putWrites(config, writes, graphTaskId);
            const before = stateSummary(previous);
            const after = stateSummary(next);
            await record({ event: "pending_write_persisted", source: "SqliteSaver.putWrites", taskId, attemptId: next?.activeAttempt?.attemptId ?? next?.lastAttempt?.attemptId ?? null, checkpointId: checkpointId ?? null, channels, before, after, changed: changedFields(before, after) });
          } catch (error) {
            await record({ event: "pending_write_failed", source: "SqliteSaver.putWrites", taskId, checkpointId: checkpointId ?? null, errorClass: safeErrorClass(error) });
            throw error;
          }
        };
      }
      const member = Reflect.get(target, property, target) as unknown;
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
}
