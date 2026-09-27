import { useEffect, useState, type ReactElement } from "react";

/** Показывает путь публикации и скачивание итогового ZIP. */
export function Result({ path, taskId }: { path: string; taskId: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  // Через две секунды возвращает обычную подпись кнопки копирования.
  useEffect(() => {
    if (!copied) return;
    // Убирает временное подтверждение успешного копирования.
    const timer = setTimeout(() => setCopied(false), 2000);
    // Освобождает таймер при закрытии результата или смене состояния.
    return () => clearTimeout(timer);
  }, [copied]);

  /** Копирует путь; недоступность буфера обмена объясняет рядом с результатом. */
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      setError("");
    } catch {
      setError("Не удалось скопировать автоматически. Выделите путь и скопируйте его.");
    }
  }
  return (
    <div className="approval">
      <h3>Файлы сохранены</h3>
      <code className="result-path">{path}</code>
      <div className="notice-actions">
        <button
          onClick={() => {
            // Копирует путь по явному нажатию пользователя.
            void copy();
          }}
        >
          {copied ? "Путь скопирован" : "Скопировать путь"}
        </button>
        <a href={`/api/tasks/${encodeURIComponent(taskId)}/result.zip`} download>
          Скачать комплект ZIP ↓
        </a>
      </div>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
