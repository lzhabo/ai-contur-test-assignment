import type { TaskEvent, TaskSnapshotResponse } from "../../shared/api";

export const STAGES = [
  { id: "author", title: "Автор", detail: "Функция и тестовые случаи" },
  { id: "checks", title: "Проверки", detail: "TypeScript · тесты" },
  { id: "reviewer", title: "Ревьюер", detail: "Проверка требований" },
  { id: "human", title: "Ваше решение", detail: "Подтвердить или отклонить" },
  { id: "applier", title: "Применяющий", detail: "Одобренная версия" },
  { id: "result", title: "Результат", detail: "Файлы на вашем Mac" },
] as const;
export type StageId = (typeof STAGES)[number]["id"];
export type StageStatus = "waiting" | "active" | "observed" | "stopped" | "error" | "unknown";
export const STATUS_LABELS: Record<StageStatus, string> = {
  waiting: "Ещё не выполнялся",
  active: "Текущий этап",
  observed: "Есть результат этапа",
  stopped: "Остановлено",
  error: "Ошибка",
  unknown: "Исход неизвестен",
};

type Review = { event: TaskEvent; verdict: "changes_requested" | "approved" | "unknown" };
export interface WorkflowView {
  events: TaskEvent[];
  stages: Array<{ id: StageId; title: string; detail: string; status: StageStatus }>;
  reviews: Review[];
  returns: Review[];
  versions: string[];
  current: StageId | undefined;
}

/** Убирает повторную доставку одного события и восстанавливает серверный порядок. */
export function orderedEvents(events: TaskEvent[]): TaskEvent[] {
  const unique = new Map<string, TaskEvent>();
  for (const event of events) unique.set(event.eventId, event);
  // Порядок задаёт сохранённый sequence, а не время прихода в браузер.
  return [...unique.values()].sort((a, b) => a.sequence - b.sequence);
}

/** Относит наблюдаемое событие к этапу, не додумывая действия агентов. */
export function eventStage(event: TaskEvent): StageId | null {
  if (event.type === "publication_finished") return "result";
  if (event.type === "decision_recorded") return "human";
  if (event.type === "checks_finished") return "checks";
  if (event.type === "review_finished") return "reviewer";
  if (event.type === "version_created") return "author";
  if (event.from === "author" || event.from === "reviewer" || event.from === "applier")
    return event.from;
  return null;
}

/** Связывает ошибку с начатой попыткой, даже если ошибку записала сама система. */
function failureStage(events: TaskEvent[]): StageId | null {
  // Ищет последнее событие, прервавшее выполнение задачи.
  const failure = [...events]
    .reverse()
    .find((event) => ["task_stopped", "task_failed", "unknown_outcome"].includes(event.type));
  // Восстанавливает роль агента по устойчивому идентификатору попытки.
  const attempt = failure?.attemptId
    ? events.find(
        (event) => event.type === "attempt_started" && event.attemptId === failure.attemptId,
      )
    : undefined;
  return attempt ? eventStage(attempt) : failure ? eventStage(failure) : null;
}

/** Строит модель графа из сохранённых событий, версий и текущего этапа. */
export function workflowView(snapshot: TaskSnapshotResponse): WorkflowView {
  const events = orderedEvents(snapshot.events);
  const versions: string[] = [];
  const reviews: Review[] = [];
  for (const event of events) {
    if (
      event.type === "version_created" &&
      event.artifactVersionId &&
      !versions.includes(event.artifactVersionId)
    )
      versions.push(event.artifactVersionId);
    if (event.type === "review_finished")
      reviews.push({
        event,
        verdict:
          event.to === "author"
            ? "changes_requested"
            : event.to === "user"
              ? "approved"
              : "unknown",
      });
  }
  // Считает только явно сохранённые возвраты ревьюера к автору.
  const returns = reviews.filter((review) => review.verdict === "changes_requested");
  const phaseStage: Partial<Record<TaskSnapshotResponse["task"]["phase"], StageId>> = {
    author: "author",
    checking: "checks",
    review: "reviewer",
    awaiting_approval: "human",
    applying: "applier",
    completed: "result",
  };
  const terminal = ["stopped", "error", "unknown_outcome"].includes(snapshot.task.phase);
  const current =
    phaseStage[snapshot.task.phase] ?? (terminal ? (failureStage(events) ?? undefined) : undefined);
  const completionTypes: Record<StageId, TaskEvent["type"][]> = {
    author: ["version_created"],
    checks: ["checks_finished"],
    reviewer: ["review_finished"],
    human: ["decision_recorded"],
    applier: ["publication_finished"],
    result: ["publication_finished"],
  };
  // Помечает наблюдавшиеся этапы и отдельно выделяет текущий или прерванный этап.
  const stages = STAGES.map((stage) => {
    // Проверяет наличие фактического результата этапа в истории задачи.
    let status: StageStatus = events.some((event) => completionTypes[stage.id].includes(event.type))
      ? "observed"
      : "waiting";
    if (stage.id === current && snapshot.task.phase !== "completed")
      status = terminal
        ? snapshot.task.phase === "unknown_outcome"
          ? "unknown"
          : snapshot.task.phase === "error"
            ? "error"
            : "stopped"
        : "active";
    return { ...stage, status };
  });
  return { events, stages, reviews, returns, versions, current };
}

/** Называет версию по порядку появления, сохраняя ID для неизвестной версии. */
export function versionLabel(versionId: string | null, versions: string[]): string {
  if (!versionId) return "До первой версии";
  const index = versions.indexOf(versionId);
  return index >= 0 ? `Версия ${index + 1}` : `Версия ${versionId.slice(0, 8)}`;
}

/** Показывает локальную дату события в русской записи. */
export function eventDate(value: string): string {
  return new Date(value).toLocaleString("ru-RU");
}
