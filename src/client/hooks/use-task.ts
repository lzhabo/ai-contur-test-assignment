import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { TaskSnapshotResponse } from "../../shared/api";
import { subscribeTaskEvents } from "../api/events";
import { taskKeys, taskQueryOptions } from "./task-cache";

export interface TaskData {
  snapshot: TaskSnapshotResponse | undefined;
  connected: boolean;
  error: Error | null;
}

/** Загружает выбранную задачу и объединяет SSE-уведомления в последовательные обновления. */
export function useTask(taskId: string | null): TaskData {
  const client = useQueryClient();
  const [connection, setConnection] = useState<{ taskId: string | null; connected: boolean }>({
    taskId: null,
    connected: false,
  });
  const query = useQuery({ ...taskQueryOptions(taskId ?? ""), enabled: Boolean(taskId) });

  // Подписка принадлежит выбранной задаче; очистка отменяет запросы, таймеры и SSE.
  useEffect(() => {
    if (!taskId) return;
    const id = taskId;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    let scheduled: ReturnType<typeof setTimeout> | undefined;
    let refreshing = false;
    let refreshAgain = false;

    /** Записывает состояние соединения только пока эта подписка ещё актуальна. */
    function setConnected(connected: boolean): void {
      if (!disposed) setConnection({ taskId: id, connected });
    }

    /** Откладывает обновление, объединяя пачку событий в один запрос состояния и списка. */
    function scheduleRefresh(): void {
      if (disposed || scheduled) return;
      // Запускает одно обновление после короткого окна накопления событий.
      scheduled = setTimeout(() => {
        scheduled = undefined;
        void refresh();
      }, 25);
    }

    /** Обновляет кеш; события во время запроса вызывают максимум один следующий запрос. */
    async function refresh(): Promise<void> {
      if (disposed) return;
      if (refreshing) {
        refreshAgain = true;
        return;
      }
      refreshing = true;
      try {
        const snapshot = await client.fetchQuery(taskQueryOptions(id));
        if (disposed) return;
        if (!unsubscribe) {
          unsubscribe = subscribeTaskEvents(id, snapshot.lastEventSequence, {
            // При каждом переподключении сверяет состояние, даже если новых событий нет.
            onOpen: () => {
              setConnected(true);
              scheduleRefresh();
            },
            // Полный snapshot загружается один раз для всей полученной пачки событий.
            onEvent: () => {
              scheduleRefresh();
            },
            // Polling продолжает работать во время отсутствия соединения.
            onError: () => {
              setConnected(false);
            },
          });
        }
        await client.invalidateQueries({ queryKey: taskKeys.list });
      } catch {
        setConnected(false);
      } finally {
        refreshing = false;
        if (refreshAgain && !disposed) {
          refreshAgain = false;
          scheduleRefresh();
        }
      }
    }

    setConnected(false);
    void refresh();
    // Резервный опрос восстанавливает данные и подписку после временной ошибки загрузки.
    const timer = setInterval(() => {
      void refresh();
    }, 4000);
    // Прекращает запросы старой задачи; их ответы не попадут в новый экран.
    return () => {
      disposed = true;
      unsubscribe?.();
      clearInterval(timer);
      clearTimeout(scheduled);
      void client.cancelQueries({ queryKey: taskKeys.detail(id), exact: true });
    };
  }, [taskId, client]);

  return {
    snapshot: taskId ? query.data : undefined,
    connected: connection.taskId === taskId && connection.connected,
    error: taskId ? query.error : null,
  };
}
