import { useEffect, useRef, type ReactElement } from "react";
import type { TaskEvent } from "../../shared/api";
import { ROLES } from "../components/labels";
import { eventDate, versionLabel, type StageId, type WorkflowView } from "./model";

interface EventHistoryProps {
  view: WorkflowView;
  events: TaskEvent[];
  selection: StageId | "all";
  selectedEventId: string | null;
  selectEventId: (id: string) => void;
  showAll: () => void;
}

/** Показывает историю и подробности события, сохраняя позицию при ручной прокрутке. */
export function EventHistory({
  view,
  events,
  selection,
  selectedEventId,
  selectEventId,
  showAll,
}: EventHistoryProps): ReactElement {
  const eventList = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  // Ищет выбранное сообщение в полной истории, независимо от текущего фильтра.
  const selected = view.events.find((event) => event.eventId === selectedEventId);
  // Новые сообщения прокручиваются вниз, только если человек уже был внизу списка.
  useEffect(() => {
    if (eventList.current && follow.current)
      eventList.current.scrollTop = eventList.current.scrollHeight;
  }, [events.length, selection]);
  /** Запоминает, читает ли человек конец списка или более ранние события. */
  function trackScroll(): void {
    const element = eventList.current;
    if (element)
      follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 70;
  }
  return (
    <div className="workflow-events">
      <div className="workflow-events-heading">
        <h3>
          {selection === "all"
            ? "События процесса"
            : `События: ${
                view.stages.find(
                  (stage) =>
                    // Находит название выбранного фильтра.
                    stage.id === selection,
                )?.title
              }`}
        </h3>
        <button
          className="text-button"
          aria-pressed={selection === "all"}
          onClick={() => {
            // Сбрасывает фильтр и выделение события.
            showAll();
          }}
        >
          Все события ({view.events.length})
        </button>
      </div>
      <div ref={eventList} className="workflow-event-list" onScroll={trackScroll}>
        {events.length ? (
          events.map((event) => (
            // Показывает сохранённое сообщение с последовательностью и версией.
            <button
              key={event.eventId}
              className={selectedEventId === event.eventId ? "selected" : ""}
              aria-pressed={selectedEventId === event.eventId}
              onClick={() => {
                // Выделяет событие для подробного просмотра.
                selectEventId(event.eventId);
              }}
            >
              <span>
                #{event.sequence} · {ROLES[event.from ?? "system"]}
                {event.to ? ` → ${ROLES[event.to]}` : ""}
              </span>
              <span>{event.text}</span>
              <small>
                {versionLabel(event.artifactVersionId, view.versions)} · {eventDate(event.at)}
              </small>
            </button>
          ))
        ) : (
          <p>Для этого этапа ещё нет сохранённых событий.</p>
        )}
      </div>
      {selected && (
        <article className="workflow-event-detail" aria-label="Выбранное событие">
          <h3>Событие #{selected.sequence}</h3>
          <p>{selected.text}</p>
          <dl>
            <dt>Время</dt>
            <dd>{eventDate(selected.at)}</dd>
            <dt>Версия</dt>
            <dd>{selected.artifactVersionId ?? "Ещё не создана"}</dd>
            <dt>Попытка</dt>
            <dd>{selected.attemptId ?? "Не относится к вызову модели"}</dd>
            <dt>Источник</dt>
            <dd>{selected.source ?? "Событие приложения"}</dd>
            <dt>Тип</dt>
            <dd>{selected.type}</dd>
          </dl>
        </article>
      )}
    </div>
  );
}
