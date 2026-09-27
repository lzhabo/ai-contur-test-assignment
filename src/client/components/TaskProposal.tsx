import type { ReactElement } from "react";
import type { TaskSnapshotResponse } from "../../shared/api";
import type { TaskCommands } from "../hooks/use-task-commands";
import { Files } from "./Files";
import { Result } from "./Result";

/** Показывает файлы, проверки и ревью; решение относится к отображаемой версии. */
export function TaskProposal({
  snapshot,
  commands,
}: {
  snapshot: TaskSnapshotResponse;
  commands: TaskCommands;
}): ReactElement {
  const busy = commands.busy;
  return (
    <div className="task-proposal">
      <section className="panel">
        <div className="panel-head">
          <h2>{snapshot.task.phase === "completed" ? "Результат" : "Предложение"}</h2>
          <small>
            Версия {snapshot.state.createdVersions} / {snapshot.state.maxVersions}
          </small>
        </div>
        <Files snapshot={snapshot} />
        {snapshot.state.latestChecks && (
          <div className="approval">
            <h3>
              Проверки:{" "}
              {snapshot.state.latestChecks.status === "passed" ? "пройдены" : "есть ошибки"}
            </h3>
            <div className="checks">
              <p>
                TypeScript:{" "}
                {snapshot.state.latestChecks.compilationStatus === "passed"
                  ? "без ошибок"
                  : snapshot.state.latestChecks.compilationStatus}
              </p>
              <p>
                Тесты: {snapshot.state.latestChecks.passedCases} пройдено ·{" "}
                {snapshot.state.latestChecks.failedCases} не пройдено
              </p>
              {snapshot.state.latestChecks.diagnostics.map((message, index) => (
                // Выводит диагностику проверки без изменения её текста.
                <p key={index}>{message}</p>
              ))}
            </div>
          </div>
        )}
        {snapshot.state.latestReview && (
          <div className="approval">
            <h3>
              {snapshot.state.latestReview.verdict === "approved"
                ? "Ревьюер одобрил версию"
                : "Замечания ревьюера"}
            </h3>
            {snapshot.state.latestReview.findings.map((finding, index) => (
              // Выводит замечание ревьюера для этой версии.
              <p className="review-summary" key={index}>
                {finding}
              </p>
            ))}
          </div>
        )}
        {snapshot.actions.canDecide && (
          <div className="approval">
            <h3>Сохранить эту версию?</h3>
            <p>
              После подтверждения третий агент сохранит именно эти файлы в отдельную папку задачи.
              При отказе итоговые файлы не создаются.
            </p>
            <div className="approval-actions">
              <button
                className="primary"
                disabled={busy}
                onClick={() => {
                  // Подтверждает показанную версию с её хешем.
                  void commands.decide(snapshot, "approve");
                }}
              >
                Подтвердить
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  // Отклоняет показанную версию без публикации.
                  void commands.decide(snapshot, "reject");
                }}
              >
                Отклонить
              </button>
            </div>
          </div>
        )}
        {snapshot.task.phase === "completed" && snapshot.state.resultPath && (
          <Result path={snapshot.state.resultPath} taskId={snapshot.task.taskId} />
        )}
      </section>
    </div>
  );
}
