import { useState, type ReactElement } from "react";
import type { TaskSnapshotResponse } from "../../shared/api";
import { artifactUrl } from "../api/tasks";
import { useArtifact } from "../hooks/use-artifact";

/** Показывает вкладки текущей версии; загрузкой выбранного файла управляет hook. */
export function Files({ snapshot }: { snapshot: TaskSnapshotResponse }): ReactElement {
  // Исключает файлы других версий из текущего предложения.
  const files = snapshot.files.filter((file) => file.versionId === snapshot.state.currentVersionId);
  const [selected, setSelected] = useState<string | null>(null);
  // Сохраняет выбранную вкладку, пока файл присутствует в текущей версии.
  const current = files.find((file) => file.artifactId === selected) || files[0];
  const query = useArtifact(snapshot.task.taskId, current);
  if (!current)
    return (
      <p className="empty">Здесь появятся функция и тесты, когда автор подготовит первую версию.</p>
    );
  const path = artifactUrl(snapshot.task.taskId, current.artifactId);
  return (
    <>
      <div className="file-tabs" role="tablist" aria-label="Файлы версии">
        {files.map((file) => (
          // Создаёт вкладку для каждого файла показанной версии.
          <button
            key={file.artifactId}
            role="tab"
            aria-selected={file.artifactId === current.artifactId}
            className={file.artifactId === current.artifactId ? "active" : ""}
            onClick={() => {
              // Выбирает файл без изменения серверного состояния.
              setSelected(file.artifactId);
            }}
          >
            {file.path}
          </button>
        ))}
      </div>
      {query.error ? (
        <div role="alert" className="notice error">
          {query.error.message}
        </div>
      ) : (
        <pre className="code-preview" aria-label={`Содержимое ${current.path}`}>
          <code>{query.isPending ? "Читаем файл…" : query.data}</code>
        </pre>
      )}
      <div className="file-footer">
        <span className="muted mono" title={current.sha256}>
          SHA-256 {current.sha256.slice(0, 12)}…
        </span>
        <a href={`${path}?download=1`} download={current.path}>
          Скачать {current.published ? "файл" : "черновик"} ↓
        </a>
      </div>
    </>
  );
}
