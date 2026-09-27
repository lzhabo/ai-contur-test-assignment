import { TaskEventSchema, type TaskEvent } from "../../shared/api";

export interface EventHandlers {
  onOpen: () => void;
  onEvent: (event: TaskEvent) => void;
  onError: () => void;
}

/** Открывает SSE с курсором; браузер использует Last-Event-ID при переподключении. */
export function subscribeTaskEvents(
  taskId: string,
  cursor: number,
  handlers: EventHandlers,
): () => void {
  const stream = new EventSource(`/api/tasks/${encodeURIComponent(taskId)}/events?after=${cursor}`);
  let closed = false;
  // Сообщает о каждом открытии, включая восстановление оборванного соединения.
  stream.onopen = () => {
    if (!closed) handlers.onOpen();
  };
  // Проверяет событие перед передачей в подписку и отвергает чужую задачу.
  stream.onmessage = (message) => {
    if (closed) return;
    try {
      const event = TaskEventSchema.parse(JSON.parse(message.data));
      if (event.taskId !== taskId) throw new Error("Событие относится к другой задаче.");
      handlers.onEvent(event);
    } catch {
      handlers.onError();
    }
  };
  // Уведомляет hook об обрыве; автоматическое переподключение выполняет EventSource.
  stream.onerror = () => {
    if (!closed) handlers.onError();
  };
  // Прекращает доставку событий и освобождает соединение при смене задачи.
  return () => {
    closed = true;
    stream.close();
  };
}
