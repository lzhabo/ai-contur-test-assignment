import { type QueryFunctionContext } from "@tanstack/react-query";
import type { ArtifactFileSummary, TaskSnapshotResponse } from "../../shared/api";
import { getTaskSnapshot } from "../api/tasks";

export const taskKeys = {
  list: ["tasks"] as const,
  // Отделяет состояние одной задачи от ответов для всех остальных задач.
  detail: (taskId: string | null): readonly ["task", string | null] => ["task", taskId],
  // Хеш включает конкретное содержимое: новый файл никогда не получит старый кеш.
  artifact: (taskId: string, file: ArtifactFileSummary): readonly string[] => [
    "artifact",
    taskId,
    file.artifactId,
    file.sha256,
  ],
};

/** Не допускает отката истории; равный sequence может содержать обновлённые действия. */
export function acceptSnapshot(
  previous: TaskSnapshotResponse | undefined,
  incoming: TaskSnapshotResponse,
): TaskSnapshotResponse {
  if (
    previous?.task.taskId === incoming.task.taskId &&
    previous.lastEventSequence > incoming.lastEventSequence
  )
    return previous;
  return incoming;
}

interface TaskQueryOptions {
  queryKey: ReturnType<typeof taskKeys.detail>;
  queryFn: (
    context: QueryFunctionContext<ReturnType<typeof taskKeys.detail>>,
  ) => Promise<TaskSnapshotResponse>;
  retry: false;
  staleTime: number;
  structuralSharing: (previous: unknown, incoming: unknown) => TaskSnapshotResponse;
}

/** Задаёт единые правила загрузки и слияния snapshot для запросов и подписки. */
export function taskQueryOptions(taskId: string): TaskQueryOptions {
  return {
    queryKey: taskKeys.detail(taskId),
    // Передаёт отмену TanStack Query в HTTP-запрос выбранной задачи.
    queryFn: ({ signal }) => getTaskSnapshot(taskId, signal),
    retry: false,
    staleTime: 0,
    // Сверяет последовательность даже при запоздалом ответе текущего запроса.
    structuralSharing: (previous, incoming) =>
      acceptSnapshot(
        previous as TaskSnapshotResponse | undefined,
        incoming as TaskSnapshotResponse,
      ),
  };
}
