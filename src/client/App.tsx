import { useState, type ReactElement } from "react";
import { useWorkspace } from "./hooks/use-workspace";
import { useTask } from "./hooks/use-task";
import { useTaskCommands } from "./hooks/use-task-commands";
import { Sidebar } from "./components/Sidebar";
import { NewTask } from "./components/NewTask";
import { TaskView } from "./components/TaskView";
import { ConnectionStatus } from "./components/ConnectionStatus";
import { useConnections } from "./hooks/use-connections";

/** Собирает страницы; запросы, подписки и команды выполняют специализированные hooks. */
export function App(): ReactElement {
  const workspace = useWorkspace();
  const connections = useConnections();
  const task = useTask(workspace.taskId);
  const commands = useTaskCommands(workspace.selectTask, workspace.taskId);
  const [draft, setDraft] = useState("");
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const error = commands.error || task.error?.message || workspace.error;
  const errorKey = `${workspace.taskId}:${error}`;

  /** Меняет выбранную задачу и убирает сообщение предыдущей команды. */
  function selectTask(id: string | null): void {
    commands.clearError();
    setDismissedError(null);
    workspace.selectTask(id);
  }

  return (
    <div className="app">
      <Sidebar tasks={workspace.tasks} taskId={workspace.taskId} selectTask={selectTask} />
      <main className="main">
        <header className="topbar">
          <span className="breadcrumb">
            Рабочее пространство / {workspace.taskId ? "Задача" : "Новая задача"}
          </span>
          <span className="local-badge">
            {workspace.serverMode === "mock"
              ? "ТЕСТОВЫЙ РЕЖИМ · БЕЗ ОБЛАКА"
              : "НА ВАШЕМ MAC · МОДЕЛИ В ОБЛАКЕ"}
          </span>
        </header>
        <div className="page">
          <ConnectionStatus {...connections} />
          {error && dismissedError !== errorKey && (
            <div className="notice error page-error" role="alert">
              {error}
              <button
                className="text-button"
                aria-label="Закрыть сообщение об ошибке"
                onClick={() => {
                  // Скрывает только текущее уведомление, сохраняя ошибки новых запросов видимыми.
                  setDismissedError(errorKey);
                  commands.clearError();
                }}
              >
                ×
              </button>
            </div>
          )}
          {!workspace.taskId ? (
            <NewTask
              text={draft}
              setText={setDraft}
              serverMode={workspace.serverMode}
              activeId={workspace.activeId}
              busy={commands.busy}
              connectionReady={connections.ready}
              create={commands.create}
              selectTask={selectTask}
            />
          ) : !task.snapshot ? (
            <div className="empty" role="status">
              Загружаем сохранённую задачу…
            </div>
          ) : (
            <TaskView
              key={workspace.taskId}
              snapshot={task.snapshot}
              connected={task.connected}
              commands={commands}
            />
          )}
        </div>
      </main>
    </div>
  );
}
