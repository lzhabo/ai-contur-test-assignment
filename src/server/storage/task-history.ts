import { EventEmitter } from "node:events";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TaskEventSchema, type TaskEvent } from "../../shared/api.js";
import type { EventSink, TaskEventInput } from "../tasks/ports.js";

export class EventJournal implements EventSink {
  private readonly emitter = new EventEmitter();
  private readonly queues = new Map<string, Promise<unknown>>();

  /** Сохраняет каталог JSONL-истории и создаёт локальные очереди подписчиков. */
  constructor(private readonly dataDir: string) {}

  /** Строит путь истории после проверки идентификатора задачи. */
  private path(taskId: string): string {
    if (!/^[a-zA-Z0-9-]+$/.test(taskId)) throw new Error("Invalid task ID");
    return join(this.dataDir, "tasks", taskId, "events.jsonl");
  }

  /** Отклоняет символьные ссылки и не-каталоги среди родителей истории. */
  private async assertSafeParents(taskId: string): Promise<void> {
    for (const path of [
      this.dataDir,
      join(this.dataDir, "tasks"),
      join(this.dataDir, "tasks", taskId),
    ]) {
      try {
        const entry = await lstat(path);
        if (entry.isSymbolicLink() || !entry.isDirectory())
          throw new Error(`Unsafe event directory: ${path}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  /** Читает завершённые строки JSONL после курсора, игнорируя оборванный хвост. */
  async readAfter(taskId: string, sequence: number): Promise<TaskEvent[]> {
    let content: string;
    await this.assertSafeParents(taskId);
    try {
      const file = await open(this.path(taskId), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        content = await file.readFile({ encoding: "utf8" });
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const complete = content.endsWith("\n")
      ? content
      : content.slice(0, content.lastIndexOf("\n") + 1);
    return complete
      .split("\n")
      .filter(Boolean)
      .map(
        /* Разбирает строку и проверяет схему сохранённого события. */ (line) =>
          TaskEventSchema.parse(JSON.parse(line)),
      )
      .filter(
        /* Отбирает события строго после переданного курсора. */ (event) =>
          event.sequence > sequence,
      );
  }

  /** Ставит событие в очередь задачи и сохраняет его до отправки подписчикам. */
  async append(input: TaskEventInput): Promise<TaskEvent> {
    const previous = this.queues.get(input.taskId) ?? Promise.resolve();
    const next = previous
      .catch(/* Позволяет следующей записи продолжиться после ошибки предыдущей. */ () => undefined)
      .then(
        /* Восстанавливает оборванный хвост, исключает дубль и синхронно сохраняет новое событие. */ async () => {
          const path = this.path(input.taskId);
          await this.assertSafeParents(input.taskId);
          // A crash can leave a partial final JSONL record. Repair the torn tail
          // before appending, otherwise the next valid record becomes unreadable.
          try {
            const file = await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
            try {
              const bytes = await file.readFile();
              const lastNewline = bytes.lastIndexOf(10);
              if (lastNewline !== bytes.length - 1) {
                await file.truncate(lastNewline + 1);
                await file.sync();
              }
            } finally {
              await file.close();
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          const existing = await this.readAfter(input.taskId, 0);
          const duplicate = existing.find(
            /* Находит ранее записанное событие по идемпотентному eventId. */ (event) =>
              event.eventId === input.eventId,
          );
          if (duplicate) return duplicate;
          const event = TaskEventSchema.parse({
            ...input,
            sequence: (existing.at(-1)?.sequence ?? 0) + 1,
          });
          await mkdir(dirname(path), { recursive: true });
          await this.assertSafeParents(input.taskId);
          const file = await open(
            path,
            constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
            0o600,
          );
          try {
            await file.writeFile(`${JSON.stringify(event)}\n`);
            await file.sync();
          } finally {
            await file.close();
          }
          this.emitter.emit(input.taskId, event);
          return event;
        },
      );
    this.queues.set(input.taskId, next);
    return next;
  }

  /** Подписывает слушателя на новые сохранённые события и возвращает функцию отписки. */
  subscribe(taskId: string, listener: (event: TaskEvent) => void): () => void {
    this.emitter.on(taskId, listener);
    return /* Снимает конкретного слушателя событий задачи. */ () =>
      this.emitter.off(taskId, listener);
  }
}
