import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getServerMode, getTaskList } from "../api/tasks";
import { errorMessage } from "../api/http";
import type { TaskSummary } from "../../shared/api";
import { taskKeys } from "./task-cache";

/** Читает ID задачи из адреса; повреждённое кодирование открывает новый черновик. */
function fromHash(): string | null {
  try {
    return decodeURIComponent(location.hash.slice(1)) || null;
  } catch {
    return null;
  }
}

export interface WorkspaceData {
  taskId: string | null;
  selectTask: (id: string | null) => void;
  tasks: TaskSummary[];
  activeId: string | null;
  serverMode: "real" | "mock" | undefined;
  error: string;
}

/** Хранит навигацию в URL, получает список задач и режим сервера через Query. */
export function useWorkspace(): WorkspaceData {
  const [taskId, setTaskId] = useState(fromHash);
  const list = useQuery({
    queryKey: taskKeys.list,
    // Отменяет загрузку списка вместе с запросом Query.
    queryFn: ({ signal }) => getTaskList(signal),
    refetchInterval: 5000,
    retry: false,
  });
  const health = useQuery({
    queryKey: ["server-mode"],
    // Проверяет реальный/mock режим при подключении к приложению.
    queryFn: ({ signal }) => getServerMode(signal),
    retry: false,
  });

  // Поддерживает переходы браузера назад/вперёд и прямую ссылку на задачу.
  useEffect(() => {
    /** Синхронизирует экран с выбранной задачей в адресной строке. */
    function onHashChange(): void {
      setTaskId(fromHash());
    }
    window.addEventListener("hashchange", onHashChange);
    // Убирает обработчик, когда рабочее пространство закрывается.
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  /** Меняет адрес и выбранную задачу в одном пользовательском действии. */
  function selectTask(id: string | null): void {
    location.hash = id ? encodeURIComponent(id) : "";
    setTaskId(id);
  }

  return {
    taskId,
    selectTask,
    tasks: list.data?.tasks ?? [],
    activeId: list.data?.activeTaskId ?? null,
    serverMode: health.data,
    error: list.error ? errorMessage(list.error) : "",
  };
}
