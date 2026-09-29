import { mkdtemp, rm, appendFile, writeFile, readFile, symlink, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { EventJournal } from "../../src/server/storage/task-history.js";
import type { TaskEventInput } from "../../src/server/tasks/ports.js";
const roots: string[] = [];
// Создаёт изолированные ресурсы сценария и регистрирует их для последующей очистки.
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "kontur-qa-events-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  // Удаляет временные каталоги журналов после каждого сценария.
  await Promise.all(
    roots
      .splice(0)
      .map(/* Удаляет временные данные. */ (root) => rm(root, { recursive: true, force: true })),
  );
});
// Создаёт событие с заданным номером и данными для восстановления истории.
function event(eventId: string): TaskEventInput {
  return {
    taskId: "qa-events",
    eventId,
    at: new Date().toISOString(),
    type: "message",
    from: "author",
    to: "reviewer",
    attemptId: "qa-attempt",
    text: "Review version",
    artifactVersionId: null,
    source: "qa",
  };
}
it("после переподключения возвращает только пропущенные события без дубликатов", async () => {
  const root = await setup();
  const journal = new EventJournal(root);
  const first = await journal.append(event("first"));
  const second = await journal.append(event("second"));

  expect(await journal.append(event("second"))).toEqual(second);

  const reopened = new EventJournal(root);

  expect(await reopened.readAfter("qa-events", first.sequence)).toEqual([second]);
  expect(await reopened.readAfter("qa-events", second.sequence)).toEqual([]);
});
it("восстанавливает оборванную последнюю запись и продолжает журнал после перезапуска", async () => {
  const root = await setup();
  const first = await new EventJournal(root).append(event("first"));
  await appendFile(path.join(root, "tasks/qa-events/events.jsonl"), '{"eventId":"torn');
  const reopened = new EventJournal(root);

  expect(await reopened.readAfter("qa-events", 0)).toEqual([first]);

  const next = await reopened.append(event("after-crash"));

  expect(next.sequence).toBe(first.sequence + 1);
  expect(await new EventJournal(root).readAfter("qa-events", first.sequence)).toEqual([next]);
});

it("не читает и не обрезает журнал по ссылке за пределы каталога задачи", async () => {
  const root = await setup();
  const journal = new EventJournal(root);
  await journal.append(event("first"));
  const journalPath = path.join(root, "tasks/qa-events/events.jsonl");
  const outside = path.join(root, "outside.jsonl");
  const original = "QA_OUTSIDE_DO_NOT_TRUNCATE";
  await writeFile(outside, original);
  await rm(journalPath);
  await symlink(outside, journalPath);

  await expect(journal.readAfter("qa-events", 0)).rejects.toMatchObject({ code: "ELOOP" });
  await expect(journal.append(event("unsafe-write"))).rejects.toMatchObject({ code: "ELOOP" });
  expect(await readFile(outside, "utf8")).toBe(original);
});

it("не читает и не дописывает журнал через ссылку вместо каталога задачи", async () => {
  const root = await setup();
  const journal = new EventJournal(root);
  await journal.append(event("first"));
  const task = path.join(root, "tasks/qa-events");
  const outside = path.join(root, "outside-task");
  await rename(task, outside);
  const original = await readFile(path.join(outside, "events.jsonl"), "utf8");
  await symlink(outside, task);

  await expect(journal.readAfter("qa-events", 0)).rejects.toThrow("Unsafe event directory");
  await expect(journal.append(event("unsafe-write"))).rejects.toThrow("Unsafe event directory");
  expect(await readFile(path.join(outside, "events.jsonl"), "utf8")).toBe(original);
});
