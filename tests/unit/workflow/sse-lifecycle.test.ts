import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { LocalArtifactStore } from "../../../src/server/storage/local-store.js";
import { QuickJsCheckRunner } from "../../../src/server/code-runner/quickjs-runner.js";
import { createHttpApp } from "../../../src/server/app.js";
import { acquireDataLock } from "../../../src/server/storage/data-lock.js";
import { createMockCodexPort } from "../../../src/server/codex/mock-port.js";
import { createAppService, type AppService } from "../../../src/server/tasks/service.js";

const roots: string[] = [];
afterEach(async () => {
  // Освобождает процессы и ресурсы сценария, затем удаляет временные данные.
  await Promise.all(
    roots
      .splice(0)
      .map(/* Удаляет временные данные. */ (root) => rm(root, { recursive: true, force: true })),
  );
});

// Ограничивает ожидание операции и отклоняет Promise при превышении срока.
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>(
      /* Отклоняет ожидание при отсутствии ответа до установленного срока. */ (_resolve, reject) =>
        setTimeout(
          /* Прерывает ожидание при превышении отведённого срока. */ () =>
            reject(new Error(`Timed out after ${ms} ms`)),
          ms,
        ),
    ),
  ]);
}

// Дожидается паузы перед подтверждением и возвращает текущий курсор событий.
async function paused(
  service: AppService,
  taskId: string,
): Promise<{ taskId: string; cursor: number }> {
  for (let index = 0; index < 100; index++) {
    const snapshot = await service.getTask(taskId);
    if (snapshot.task.phase === "awaiting_approval")
      return { taskId, cursor: snapshot.lastEventSequence };
    await new Promise(
      /* Выдерживает короткий интервал перед повторной проверкой состояния. */ (resolve) =>
        setTimeout(resolve, 20),
    );
  }
  throw new Error("Task did not reach approval pause");
}

it("сразу открывает пустой SSE и закрывает его вместе с сервером, освобождая блокировку", async () => {
  // Проверяет сценарий: сразу открывает пустой SSE и закрывает его вместе с сервером, освобождая блокировку.

  const root = await mkdtemp(join(tmpdir(), "loop-sse-close-"));
  roots.push(root);
  const artifacts = new LocalArtifactStore(root);
  const service = await createAppService({
    dataDir: root,
    executionMode: "mock",
    ports: {
      artifacts,
      checks: new QuickJsCheckRunner(artifacts),
      codex: createMockCodexPort("happy"),
    },
  });
  const server = createHttpServer(createHttpApp(service));
  let closed = false;
  const close = async () => {
    // Закрывает сервер и сервис однократно, освобождая блокировку данных.

    if (closed) return;
    closed = true;
    if (server.listening) {
      server.closeAllConnections();
      await new Promise<void>(
        /* Дожидается освобождения локального порта. */ (resolve, reject) =>
          server.close(
            /* Завершает ожидание закрытия ресурса и передаёт ошибку при неудаче. */ (error) =>
              error ? reject(error) : resolve(),
          ),
      );
    }
    await service.close();
  };
  try {
    const created = await service.createTask({ text: "Implement mergeIntervals." });
    const { taskId, cursor } = await paused(service, created.taskId);
    await new Promise<void>(
      /* Дожидается успешного запуска локального сервера. */ (resolve) =>
        server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No HTTP port");
    const response = await within(
      fetch(`http://127.0.0.1:${address.port}/api/tasks/${taskId}/events?after=${cursor}`),
      1_000,
    );

    expect(response.status).toBe(200);

    const reader = response.body!.getReader();
    const first = await within(reader.read(), 1_000);

    expect(new TextDecoder().decode(first.value)).toContain(": connected\n\n");

    await within(close(), 2_000);
    const lock = await within(acquireDataLock(root), 1_000);
    await lock.release();
    await reader
      .cancel()
      .catch(/* Обрабатывает ожидаемую ошибку завершения или очистки ресурса. */ () => undefined);
  } finally {
    await close();
  }
}, 10_000);

it("SIGTERM завершает сервер с пустым SSE и освобождает блокировку данных", async () => {
  // Проверяет сценарий: SIGTERM завершает сервер с пустым SSE и освобождает блокировку данных.

  const root = await mkdtemp(join(tmpdir(), "loop-sse-signal-"));
  roots.push(root);
  const socket = createServer();
  await new Promise<void>(
    /* Дожидается успешного запуска локального сервера. */ (resolve) =>
      socket.listen(0, "127.0.0.1", resolve),
  );
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("No TCP port");
  await new Promise<void>(
    /* Дожидается освобождения локального порта. */ (resolve) =>
      socket.close(
        /* Завершает ожидание закрытия ресурса и передаёт ошибку при неудаче. */ () => resolve(),
      ),
  );
  const port = address.port;
  const child = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      APP_PORT: String(port),
      APP_DATA_DIR: root,
      APP_CODEX_MODE: "mock",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stderr.on("data", (chunk) => {
    // Сохраняет вывод процесса для диагностики неудачного запуска.
    logs += String(chunk);
  });
  const exit = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>(
    /* Дожидается выхода дочернего процесса и сохраняет код завершения. */ (resolve) =>
      child.once(
        "exit",
        /* Обрабатывает сигнал процесса и завершает соответствующее ожидание. */ (code, signal) =>
          resolve({ code, signal }),
      ),
  );
  try {
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let index = 0; index < 100; index++) {
      try {
        ready = (await fetch(`${base}/api/health`)).ok;
        if (ready) break;
      } catch {
        /* process may still be starting */
      }
      await new Promise(
        /* Выдерживает короткий интервал перед повторной проверкой состояния. */ (resolve) =>
          setTimeout(resolve, 30),
      );
    }

    expect(ready, logs).toBe(true);

    const created = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Implement mergeIntervals." }),
    });

    expect(created.status).toBe(202);

    const { taskId } = (await created.json()) as { taskId: string };
    let cursor = 0;
    for (let index = 0; index < 100; index++) {
      const state = (await (await fetch(`${base}/api/tasks/${taskId}`)).json()) as {
        task: { phase: string };
        lastEventSequence: number;
      };
      if (state.task.phase === "awaiting_approval") {
        cursor = state.lastEventSequence;
        break;
      }
      await new Promise(
        /* Выдерживает короткий интервал перед повторной проверкой состояния. */ (resolve) =>
          setTimeout(resolve, 20),
      );
    }

    expect(cursor).toBeGreaterThan(0);

    const stream = await within(fetch(`${base}/api/tasks/${taskId}/events?after=${cursor}`), 1_000);
    const reader = stream.body!.getReader();

    expect(new TextDecoder().decode((await within(reader.read(), 1_000)).value)).toContain(
      ": connected\n\n",
    );

    child.kill("SIGTERM");

    expect(await within(exit, 2_000)).toEqual({ code: 0, signal: null });

    const lock = await within(acquireDataLock(root), 1_000);
    await lock.release();
    await reader
      .cancel()
      .catch(/* Обрабатывает ожидаемую ошибку завершения или очистки ресурса. */ () => undefined);
  } finally {
    child.kill("SIGKILL");
    await exit;
  }
}, 15_000);

it("освобождает блокировку данных при занятом HTTP-порте", async () => {
  // Проверяет сценарий: освобождает блокировку данных при занятом HTTP-порте.

  const root = await mkdtemp(join(tmpdir(), "loop-listen-fail-"));
  roots.push(root);
  const socket = createServer();
  await new Promise<void>(
    /* Дожидается успешного запуска локального сервера. */ (resolve) =>
      socket.listen(0, "127.0.0.1", resolve),
  );
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("No TCP port");
  const child = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      APP_PORT: String(address.port),
      APP_DATA_DIR: root,
      APP_CODEX_MODE: "mock",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    const exit = await within(
      new Promise<number | null>(
        /* Дожидается выхода дочернего процесса и сохраняет код завершения. */ (resolve) =>
          child.once(
            "exit",
            /* Обрабатывает сигнал процесса и завершает соответствующее ожидание. */ (code) =>
              resolve(code),
          ),
      ),
      5_000,
    );

    expect(exit).not.toBe(0);

    const lock = await within(acquireDataLock(root), 1_000);
    await lock.release();
  } finally {
    child.kill("SIGKILL");
    await new Promise<void>(
      /* Дожидается освобождения локального порта. */ (resolve) =>
        socket.close(
          /* Завершает ожидание закрытия ресурса и передаёт ошибку при неудаче. */ () => resolve(),
        ),
    );
  }
}, 10_000);
