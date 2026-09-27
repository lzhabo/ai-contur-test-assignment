import type { Request, Response, Router } from "express";
import { safeErrorClass } from "../logger.js";
import { HttpError } from "./errors.js";
import type { AppService } from "../tasks/service.js";
type TaskParams = { id: string };

/** Читает курсор SSE из заголовка или query и требует неотрицательное целое число. */
function cursorOf(request: Request): number {
  const raw = request.header("Last-Event-ID") ?? request.query.after ?? "0";
  const after = Number(raw);
  if (!Number.isSafeInteger(after) || after < 0)
    throw new HttpError(400, "invalid_cursor", "Некорректный курсор событий.");
  return after;
}

// Подключает JSONL replay и живые события к одному SSE-потоку без пропусков между ними.
export function installEventRoute(
  api: Router,
  service: AppService,
  activeStreams: Set<Response>,
): void {
  api.get(
    "/tasks/:id/events",
    /* Открывает SSE-поток задачи, сначала воспроизводя историю, затем передавая новые события. */ async (
      request: Request<TaskParams>,
      response,
    ) => {
      await service.getTask(request.params.id);
      const after = cursorOf(request);
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      response.flushHeaders();
      response.write(": connected\n\n");
      activeStreams.add(response);
      let seen = after;
      let ready = false;
      const pending: Array<{ sequence: number; data: string }> = [];
      const write = /* Отправляет событие только один раз и только в открытое соединение. */ (
        sequence: number,
        data: string,
      ) => {
        if (sequence <= seen || response.destroyed || response.writableEnded) return;
        seen = sequence;
        response.write(`id: ${sequence}\ndata: ${data}\n\n`);
      };
      const unsubscribe = service.events.subscribe(
        request.params.id,
        /* Буферизует живые события до завершения воспроизведения истории. */ (event) => {
          const item = { sequence: event.sequence, data: JSON.stringify(event) };
          if (ready) write(item.sequence, item.data);
          else pending.push(item);
        },
      );
      const heartbeat = setInterval(
        /* Поддерживает открытое SSE-соединение периодическим служебным комментарием. */ () => {
          if (!response.destroyed && !response.writableEnded) response.write(": heartbeat\n\n");
        },
        15_000,
      );
      const cleanup = /* Снимает подписку и таймер после закрытия или ошибки соединения. */ () => {
        clearInterval(heartbeat);
        unsubscribe();
        activeStreams.delete(response);
      };
      response.once("close", cleanup);
      response.once("error", cleanup);
      try {
        const replay = await service.events.readAfter(request.params.id, after);
        for (const event of replay) write(event.sequence, JSON.stringify(event));
        ready = true;
        for (const item of pending) write(item.sequence, item.data);
      } catch (error) {
        console.error("SSE replay failed:", safeErrorClass(error));
        response.end();
      }
    },
  );
}
