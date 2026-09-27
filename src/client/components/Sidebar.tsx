import type { ReactElement } from "react";
import type { TaskSummary } from "../../shared/api";
import { PHASES } from "./labels";

interface SidebarProps {
  tasks: TaskSummary[];
  taskId: string | null;
  selectTask: (id: string | null) => void;
}

/** Показывает историю задач и передаёт выбор в управление навигацией. */
export function Sidebar({ tasks, taskId, selectTask }: SidebarProps): ReactElement {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        контур<span className="muted">.</span>
      </div>
      <button
        className="primary sidebar-new"
        onClick={() => {
          // Открывает форму новой задачи.
          selectTask(null);
        }}
      >
        ＋ Новая задача
      </button>
      <div className="nav-label">Ваши задачи · {tasks.length}</div>
      <nav className="history" aria-label="История задач">
        {tasks.length === 0 && <p className="empty">Здесь появятся ваши задачи.</p>}
        {tasks.map((task) => (
          // Показывает заголовок, этап и выбор каждой задачи.
          <button
            key={task.taskId}
            className={`task-link ${taskId === task.taskId ? "selected" : ""}`}
            aria-current={taskId === task.taskId ? "page" : undefined}
            onClick={() => {
              // Открывает выбранную задачу из истории.
              selectTask(task.taskId);
            }}
          >
            <span className="task-link-title">{task.title}</span>
            <small>{PHASES[task.phase]}</small>
          </button>
        ))}
      </nav>
      <div className="sidebar-footer">
        <span className="status-dot" />
        Локальная рабочая папка
        <br />
        TypeScript · три агента · две модели
      </div>
    </aside>
  );
}
