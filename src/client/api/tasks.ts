import { z } from "zod";
import {
  CreateTaskRequestSchema,
  CreateTaskResponseSchema,
  DecisionRequestSchema,
  ResumeRequestSchema,
  TaskListResponseSchema,
  TaskSnapshotResponseSchema,
  type ArtifactFileSummary,
  type CreateTaskResponse,
  type DecisionRequest,
  type ResumeRequest,
  type TaskListResponse,
  type TaskSnapshotResponse,
} from "../../shared/api";
import { jsonPost, requestJson, requestText } from "./http";

const HealthSchema = z.object({ executionMode: z.enum(["real", "mock"]) });

/** Возвращает безопасный путь выбранной задачи. */
function taskUrl(taskId: string): string {
  return `/api/tasks/${encodeURIComponent(taskId)}`;
}

/** Загружает режим работы сервера для явной маркировки mock-прогонов. */
export async function getServerMode(signal?: AbortSignal): Promise<"real" | "mock"> {
  return (await requestJson("/api/health", HealthSchema, { signal })).executionMode;
}

/** Получает список задач и идентификатор выполняющейся задачи. */
export function getTaskList(signal?: AbortSignal): Promise<TaskListResponse> {
  return requestJson("/api/tasks", TaskListResponseSchema, { signal });
}

/** Загружает проверенное состояние одной задачи; отмена передаётся в fetch. */
export async function getTaskSnapshot(
  taskId: string,
  signal?: AbortSignal,
): Promise<TaskSnapshotResponse> {
  const snapshot = await requestJson(taskUrl(taskId), TaskSnapshotResponseSchema, { signal });
  if (snapshot.task.taskId !== taskId) throw new Error("Сервер вернул другую задачу.");
  return snapshot;
}

/** Создаёт задачу с устойчивым ключом, позволяющим безопасно повторить запрос. */
export function createTask(text: string, key: string): Promise<CreateTaskResponse> {
  const input = CreateTaskRequestSchema.parse({ text });
  return requestJson(
    "/api/tasks",
    CreateTaskResponseSchema,
    jsonPost(input, { "Idempotency-Key": key }),
  );
}

/** Передаёт решение человека для конкретной версии и хеша файлов. */
export function decideTask(
  taskId: string,
  decision: DecisionRequest,
): Promise<TaskSnapshotResponse> {
  return requestJson(
    `${taskUrl(taskId)}/decision`,
    TaskSnapshotResponseSchema,
    jsonPost(DecisionRequestSchema.parse(decision)),
  );
}

/** Останавливает выбранную задачу и возвращает сохранённое состояние. */
export function stopTask(taskId: string): Promise<TaskSnapshotResponse> {
  return requestJson(`${taskUrl(taskId)}/stop`, TaskSnapshotResponseSchema, jsonPost({}));
}

/** Продолжает задачу; повтор неизвестного вызова требует явного режима. */
export function resumeTask(
  taskId: string,
  mode: ResumeRequest["mode"],
): Promise<TaskSnapshotResponse> {
  return requestJson(
    `${taskUrl(taskId)}/resume`,
    TaskSnapshotResponseSchema,
    jsonPost(ResumeRequestSchema.parse({ mode })),
  );
}

/** Формирует путь файла для просмотра и скачивания без повторения кодирования ID. */
export function artifactUrl(taskId: string, artifactId: string): string {
  return `${taskUrl(taskId)}/artifacts/${encodeURIComponent(artifactId)}`;
}

/** Читает содержимое файла; версия кеша определяется хешем в hook. */
export function getArtifact(
  taskId: string,
  file: ArtifactFileSummary,
  signal?: AbortSignal,
): Promise<string> {
  return requestText(artifactUrl(taskId, file.artifactId), signal);
}
