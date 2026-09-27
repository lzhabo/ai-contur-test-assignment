import type { ReactElement } from "react";
import type { TaskEvent } from "../../shared/api";
import { eventDate, versionLabel, type WorkflowView } from "./model";

/** Выводит ревью по версиям и явно отмечает отсутствие возвратов автору. */
export function ReviewHistory({
  view,
  selectEvent,
}: {
  view: WorkflowView;
  selectEvent: (event: TaskEvent) => void;
}): ReactElement {
  return (
    <div className="review-history">
      <h3>Ревью по версиям</h3>
      {view.reviews.length === 0 ? (
        <p>Ревью ещё не завершено. Замечаний от ревьюера пока нет.</p>
      ) : (
        <>
          {view.returns.length === 0 &&
            view.reviews.some(
              (review) =>
                // Проверяет наличие одобрения без возврата автору.
                review.verdict === "approved",
            ) && (
              <p>
                Ревьюер одобрил версию без запроса доработки. В этом прогоне возврата к автору не
                было.
              </p>
            )}
          <ol>
            {view.reviews.map((review) => (
              // Показывает сохранённое ревью и связанную с ним версию.
              <li
                key={review.event.eventId}
                className={review.verdict === "changes_requested" ? "review-return" : ""}
              >
                <button
                  onClick={() => {
                    // Открывает подробности именно этого ревью.
                    selectEvent(review.event);
                  }}
                >
                  <strong>
                    {versionLabel(review.event.artifactVersionId, view.versions)} ·{" "}
                    {review.verdict === "changes_requested"
                      ? "Нужны изменения → автору"
                      : review.verdict === "approved"
                        ? "Одобрено → ваше решение"
                        : "Ревью завершено"}
                  </strong>
                  <time dateTime={review.event.at}>{eventDate(review.event.at)}</time>
                  <span>{review.event.text}</span>
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}
