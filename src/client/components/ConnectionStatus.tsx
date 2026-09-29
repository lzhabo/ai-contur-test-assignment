import type { ReactElement } from "react";
import type { CodexReadiness } from "../../shared/connections";

interface ConnectionStatusProps {
  data?: CodexReadiness;
  checking: boolean;
  error: string;
  recheck: () => void;
}

const titles = { cli: "Codex CLI", auth: "Вход в Codex", cloud: "Облачные модели" };
const statuses = { passed: "проверено", failed: "требуется действие", not_checked: "не проверено" };

/** Показывает границы проверки: локальная авторизация не подтверждает доступность облачной модели. */
export function ConnectionStatus({
  data,
  checking,
  error,
  recheck,
}: ConnectionStatusProps): ReactElement {
  return (
    <section
      className={`notice connection-status ${error || data?.ready === false ? "warning" : ""}`}
      aria-label="Подключение к Codex"
    >
      <div className="connection-heading">
        <strong>Подключение к Codex</strong>
        <button className="text-button" onClick={recheck} disabled={checking}>
          {checking ? "Проверяем…" : "Проверить снова"}
        </button>
      </div>
      {error ? (
        <p role="alert">{error}</p>
      ) : checking ? (
        <p role="status">Проверяем сервер, Codex CLI и вход…</p>
      ) : !data ? (
        <p role="status">Ожидаем проверку подключения…</p>
      ) : (
        <>
          <p>
            Сервер приложения доступен.
            {data.executionMode === "mock" ? " Включён тестовый режим." : ""}
          </p>
          <ul>
            {data.checks.map((check) => (
              <li key={check.id}>
                <strong>
                  {titles[check.id]} — {statuses[check.status]}.
                </strong>{" "}
                {check.message}
              </li>
            ))}
          </ul>
          <small>Проверено: {new Date(data.checkedAt).toLocaleTimeString("ru-RU")}</small>
        </>
      )}
    </section>
  );
}
