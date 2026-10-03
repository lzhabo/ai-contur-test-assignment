import { useState, type ReactElement } from "react";
import type { TaskEvent, TaskSnapshotResponse } from "../../shared/api";
import { eventStage, workflowView, type StageId } from "./model";
import { StageDiagram } from "./StageDiagram";
import { ReviewHistory } from "./ReviewHistory";
import { EventHistory } from "./EventHistory";

/** Связывает рисунок этапов, ревью и фильтр событий одной сохранённой задачи. */
export function WorkflowGraph({ snapshot }: { snapshot: TaskSnapshotResponse }): ReactElement {
  const view = workflowView(snapshot);
  const [selection, setSelection] = useState<StageId | "all">("all");
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  // Ограничивает список выбранным этапом; публикация также относится к применению.
  const events =
    selection === "all"
      ? view.events
      : view.events.filter(
          (event) =>
            eventStage(event) === selection ||
            (selection === "applier" && event.type === "publication_finished"),
        );
  const stopped = ["stopped", "error", "unknown_outcome", "awaiting_auth"].includes(
    snapshot.task.phase,
  );

  /** Выбирает этап и убирает выделение события прежнего фильтра. */
  function selectStage(stage: StageId): void {
    setSelection(stage);
    setSelectedEventId(null);
  }
  /** Открывает ревью в полном списке событий. */
  function selectEvent(event: TaskEvent): void {
    setSelection("all");
    setSelectedEventId(event.eventId);
  }
  /** Возвращает полный список событий без выделенной строки. */
  function showAll(): void {
    setSelection("all");
    setSelectedEventId(null);
  }

  return (
    <section className="panel workflow" aria-label="Граф работы агентов">
      <div className="panel-head">
        <h2>Как движется задача</h2>
        <small>
          Версий {snapshot.state.createdVersions} / {snapshot.state.maxVersions} · вызовов{" "}
          {snapshot.state.usedModelCalls} / {snapshot.state.maxModelCalls}
        </small>
      </div>
      <p className="workflow-intro">
        Нажмите на этап, чтобы увидеть его события. Стрелки показывают маршрут; выделение —
        фактически наблюдаемые этапы.
      </p>
      {stopped && (
        <p className="workflow-state" role="status">
          {snapshot.task.phase === "awaiting_auth"
            ? "Процесс приостановлен: нужен вход в Codex. Выполненные этапы сохранены."
            : snapshot.task.phase === "unknown_outcome"
              ? "Процесс приостановлен: исход вызова неизвестен."
              : snapshot.task.phase === "error"
                ? "Процесс завершился ошибкой."
                : "Процесс остановлен."}{" "}
          Следующие этапы автоматически не выполняются.
        </p>
      )}
      <StageDiagram
        snapshot={snapshot}
        view={view}
        selection={selection}
        selectStage={selectStage}
      />
      <ReviewHistory view={view} selectEvent={selectEvent} />
      <EventHistory
        view={view}
        events={events}
        selection={selection}
        selectedEventId={selectedEventId}
        selectEventId={setSelectedEventId}
        showAll={showAll}
      />
    </section>
  );
}
