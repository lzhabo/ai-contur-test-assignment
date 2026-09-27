import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const IndexEntrySchema = z.object({
  taskId: z.string().uuid(),
  title: z.string(),
  createdAt: z.string(),
  idempotencyKey: z.string().nullable(),
  text: z.string(),
});
const IndexSchema = z.object({ tasks: z.array(IndexEntrySchema) });
export type TaskIndexEntry = z.infer<typeof IndexEntrySchema>;

export class TaskIndex {
  // Держит загруженный индекс задач и путь его атомарного сохранения.
  private constructor(
    private readonly file: string,
    readonly tasks: TaskIndexEntry[],
  ) {}

  // Читает и проверяет индекс; при первом запуске создаёт пустой список в памяти.
  static async open(dataDir: string): Promise<TaskIndex> {
    const file = join(dataDir, "tasks-index.json");
    try {
      const index = IndexSchema.parse(JSON.parse(await readFile(file, "utf8")));
      return new TaskIndex(file, index.tasks);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return new TaskIndex(file, []);
    }
  }

  // Публикует полную новую версию индекса заменой временного файла.
  async save(): Promise<void> {
    const temp = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify({ tasks: this.tasks }), { mode: 0o600 });
    await rename(temp, this.file);
  }
}
