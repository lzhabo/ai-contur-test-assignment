import type { ReactElement } from "react";
import type { TaskSnapshotResponse } from "../../shared/api";
import type { TaskCommands } from "../hooks/use-task-commands";
import { useClock } from "../hooks/use-clock";
import { PHASES, ROLES, time } from "./labels";

interface TaskStatusProps {
  snapshot: TaskSnapshotResponse;
  connected: boolean;
  commands: TaskCommands;
}

/** Показывает состояние выполнения, ожидание и доступные команды остановки/продолжения. */
export function TaskStatus({ snapshot, connected, commands }: TaskStatusProps): ReactElement {
  const now = useClock();
  const pending = snapshot.state.activeAttempt;
  const age = pending ? Math.max(0, Math.floor((now - Date.parse(pending.startedAt)) / 1000)) : 0;
  const busy = commands.busy;
  return (
    <>
      <div className="task-heading">
        <div>
          <div className="eyebrow">{PHASES[snapshot.task.phase]}</div>
          <h1>{snapshot.task.title}</h1>
          <p className="task-request">{snapshot.state.taskText}</p>
        </div>
        {snapshot.actions.canStop && (
          <button
            className="danger"
            onClick={() => {
              // Запрашивает остановку именно показанной задачи.
              void commands.stop(snapshot.task.taskId);
            }}
            disabled={busy}
          >
            Остановить
          </button>
        )}
      </div>
      {snapshot.state.executionMode === "mock" && (
        <div className="notice warning">
          <strong>Тестовый режим.</strong> Ответы агентов имитируются локально. Этот прогон
          проверяет работу приложения, но не подключение к облачным моделям.
        </div>
      )}
      {!connected && (
        <div className="notice warning" role="status">
          Нет соединения с потоком событий. Пробуем подключиться снова; показано последнее
          полученное состояние. Это не подтверждение завершения работы.
        </div>
      )}
      {snapshot.task.stopReason && (
        <div className={`notice ${snapshot.task.phase === "completed" ? "" : "warning"}`}>
          <strong>{PHASES[snapshot.task.phase]}.</strong> {snapshot.task.stopReason}
        </div>
      )}
      {pending && (
        <div className={`notice ${age >= 30 ? "warning" : ""}`} role="status">
          <strong>
            {ROLES[pending.role]}: ожидаем результат {age} с.
          </strong>
          {age >= 30 && <p>Ответ пока не получен. Можно продолжать ждать или остановить задачу.</p>}
          <br />
          Последнее наблюдение:{" "}
          {pending.lastObservedStage || "Попытка сохранена; подтверждения запуска ещё нет"}.
          {pending.lastObservedAt && ` ${time(pending.lastObservedAt)}`}
          <br />
          <small>
            Запуск локального процесса сам по себе не подтверждает доставку облачной модели.
          </small>
        </div>
      )}
      {snapshot.actions.canResume && (
        <div className="notice warning">
          <strong>Продолжить сохранённую задачу</strong>
          <p>
            {snapshot.actions.resumeRequiresExplicitRetry
              ? "Исход предыдущего вызова неизвестен. Повтор создаст новый вызов модели и потратит ещё одну попытку."
              : "Продолжение начнётся с сохранённого этапа."}
          </p>
          <div className="notice-actions">
            <button
              onClick={() => {
                // Явно подтверждает продолжение или повтор неизвестного вызова.
                void commands.resume(snapshot);
              }}
              disabled={busy}
            >
              {snapshot.actions.resumeRequiresExplicitRetry
                ? "Повторить неизвестный вызов"
                : "Продолжить"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
