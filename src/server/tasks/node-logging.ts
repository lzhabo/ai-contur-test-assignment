import { isGraphInterrupt } from "@langchain/langgraph";
import {
  changedFields,
  safeErrorClass,
  stateSummary,
  type ObservabilityLogger,
} from "../logger.js";
import type { TaskState } from "./types.js";
export type TaskNode = (state: {
  value: TaskState;
}) => { value: TaskState } | Promise<{ value: TaskState }>;

// Оборачивает шаги графа диагностикой, сохраняя их результат и поведение interrupt.
export function createNodeLogger(
  logger: ObservabilityLogger,
  lastCompletedNode: Map<string, string>,
): <T extends TaskNode>(node: string, run: T) => T {
  /** Создаёт обёртку шага с записью состояния до и после выполнения. */
  function observedNode<T extends (state: { value: TaskState }) => unknown>(
    node: string,
    run: T,
  ): T {
    return /* Выполняет шаг и регистрирует завершение, паузу или ошибку, не меняя исход операции. */ (async (state: {
      value: TaskState;
    }) => {
      const before = stateSummary(state.value);
      try {
        const result = await run(state);
        lastCompletedNode.set(state.value.taskId, node);
        const next = (result as { value?: TaskState })?.value;
        const after = stateSummary(next);
        try {
          await logger.record({
            event: "node_completed",
            source: "LangGraph.node",
            taskId: state.value.taskId,
            attemptId: next?.activeAttempt?.attemptId ?? next?.lastAttempt?.attemptId ?? null,
            node,
            before,
            after,
            changed: changedFields(before, after),
          });
        } catch {
          /* logging cannot affect node */
        }
        return result;
      } catch (error) {
        try {
          await logger.record({
            event: isGraphInterrupt(error) ? "node_paused" : "node_failed",
            source: "LangGraph.node",
            taskId: state.value.taskId,
            attemptId: state.value.activeAttempt?.attemptId ?? null,
            node,
            before,
            errorClass: safeErrorClass(error),
          });
        } catch {
          /* logging cannot affect node */
        }
        throw error;
      }
    }) as T;
  }

  return observedNode;
}
