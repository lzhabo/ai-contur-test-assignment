import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import type { TaskSnapshotResponse } from "../../src/shared/api.js";
const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  // Освобождает процессы и ресурсы сценария, затем удаляет временные данные.

  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const ended = once(child, "exit");
      child.kill("SIGKILL");
      await ended;
    }
  }
  await Promise.all(
    roots
      .splice(0)
      .map(/* Удаляет временные данные. */ (root) => rm(root, { recursive: true, force: true })),
  );
});
// Создаёт временный каталог данных и запоминает его для очистки.
async function root() {
  const directory = await mkdtemp(path.join(tmpdir(), "kontur-qa-service-process-"));
  roots.push(directory);
  return directory;
}
// Запускает отдельный процесс приложения и возвращает его сигналы для проверки перезапуска.
function launch(directory: string, mode: string) {
  const child = fork(
    fileURLToPath(new URL("./support/service-process.ts", import.meta.url)),
    [directory, mode],
    {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  children.push(child);
  let stderr = "";
  child.stderr?.on("data", (value) => {
    // Сохраняет вывод процесса для диагностики неудачного запуска.
    stderr += String(value);
  });
  const result = new Promise<{
    event: string;
    taskId?: string;
    error?: string;
    snapshot?: TaskSnapshotResponse;
  }>((resolve, reject) => {
    // Дожидается выхода дочернего процесса и сохраняет код завершения.

    child.once(
      "message",
      /* Обрабатывает сигнал процесса и завершает соответствующее ожидание. */ (value) =>
        resolve(value as { event: string }),
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      // Сохраняет вывод процесса для диагностики неудачного запуска.
      if (code || signal) reject(new Error(`Service exited ${code}/${signal}: ${stderr}`));
    });
  });
  return { child, result };
}
it("A-04: авария во время вызова восстанавливается как неизвестный исход без скрытого повтора", async () => {
  const directory = await root();
  const original = launch(directory, "hang");
  const started = await original.result;

  expect(started.event).toBe("external-started");

  const exited = once(original.child, "exit");
  original.child.kill("SIGKILL");
  await exited;
  const recovered = await launch(directory, "inspect").result;

  expect(recovered.event, recovered.error).toBe("ready");
  expect(recovered.snapshot?.task.taskId).toBe(started.taskId);
  expect(recovered.snapshot?.task.phase).toBe("unknown_outcome");
  expect(recovered.snapshot?.state.usedModelCalls).toBe(1);
  expect(recovered.snapshot?.actions.resumeRequiresExplicitRetry).toBe(true);

  const calls = (await readFile(path.join(directory, "qa-calls.jsonl"), "utf8")).trim().split("\n");

  expect(calls).toHaveLength(1);
}, 15000);

it("только один конкурирующий процесс получает блокировку после гибели владельца", async () => {
  const directory = await root();
  const owner = launch(directory, "idle");

  expect((await owner.result).event).toBe("ready");

  const exited = once(owner.child, "exit");
  owner.child.kill("SIGKILL");
  await exited;
  const a = launch(directory, "idle");
  const b = launch(directory, "idle");
  const outcomes = await Promise.all([a.result, b.result]);

  expect(outcomes.map((value) => value.event).sort()).toEqual(["ready", "rejected"]);
}, 15000);
