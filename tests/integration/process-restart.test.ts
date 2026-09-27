import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { expect, it } from "vitest";

it("A-04: после SIGKILL на подтверждении новый процесс продолжает ту же версию без генерации", async () => {
  // Проверяет сценарий: A-04: после SIGKILL на подтверждении новый процесс продолжает ту же версию без генерации.

  const root = await mkdtemp(path.join(tmpdir(), "loop-qa-process-"));
  const children: ChildProcess[] = [];
  // Запускает отдельный процесс приложения и возвращает его сигналы для проверки перезапуска.
  function launch(mode: string) {
    const child = fork(
      fileURLToPath(new URL("./support/graph-process.ts", import.meta.url)),
      [root, mode],
      {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    children.push(child);
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      // Сохраняет вывод процесса для диагностики неудачного запуска.
      stderr += String(chunk);
    });
    const result = new Promise<{ phase: string; hash: string }>((resolve, reject) => {
      // Дожидается выхода дочернего процесса и сохраняет код завершения.

      child.once("message", (message: unknown) => {
        // Сохраняет вывод процесса для диагностики неудачного запуска.

        const value = message as {
          phase: string;
          hash: string;
          error?: string;
        };
        if (value.error) reject(new Error(value.error + stderr));
        else resolve(value);
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        // Сохраняет вывод процесса для диагностики неудачного запуска.
        if (code) reject(new Error(`Child exited ${code}: ${stderr}`));
      });
    });
    return { child, result };
  }
  try {
    const first = launch("seed");
    const before = await first.result;

    expect(before.phase).toBe("awaiting_approval");

    const exited = once(first.child, "exit");
    first.child.kill("SIGKILL");
    await exited;
    const second = launch("resume");
    const after = await second.result;

    expect(after.phase).toBe("completed");
    expect(after.hash).toBe(before.hash);

    const calls = (await readFile(path.join(root, "qa-calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(/* Читает сохранённую строку JSON как запись журнала. */ (line) => JSON.parse(line));

    expect(calls.map(/* Извлекает поле, сохраняя порядок записей. */ (call) => call.role)).toEqual([
      "author",
      "reviewer",
      "applier",
    ]);
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const ended = once(child, "exit");
        child.kill("SIGKILL");
        await ended;
      }
    }
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
