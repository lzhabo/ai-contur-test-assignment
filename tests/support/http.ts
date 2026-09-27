import { createServer, type Server } from "node:http";
import { afterEach } from "vitest";
import { createHttpApp } from "../../src/server/app.js";
import { createMockCodexPort } from "../../src/server/codex/mock-port.js";

const servers: Server[] = [];
export const aborts: AbortController[] = [];

// Закрывает HTTP-соединения и дожидается освобождения порта.
async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>(
    /* Дожидается освобождения локального порта. */ (resolve, reject) =>
      server.close(
        /* Завершает ожидание закрытия ресурса и передаёт ошибку при неудаче. */ (error) =>
          error ? reject(error) : resolve(),
      ),
  );
}

afterEach(async () => {
  // Освобождает процессы и ресурсы сценария, затем удаляет временные данные.

  aborts
    .splice(0)
    .forEach(
      /* Прерывает незавершённый HTTP-поток перед очисткой сервера. */ (controller) =>
        controller.abort(),
    );
  await Promise.all(servers.splice(0).map(closeServer));
});

// Запускает изолированный HTTP-сервис с заданным mock-сценарием ответов модели.
export async function setup(scenario: Parameters<typeof createMockCodexPort>[0] = "no_response") {
  const { service } = await setupService(scenario);
  const server = createServer(createHttpApp(service));
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    // Дожидается успешного запуска локального сервера.

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      // Подтверждает запуск сервера и снимает временный обработчик ошибки.
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Не назначен HTTP-порт");
  return { service, base: `http://127.0.0.1:${address.port}` };
}

// Отправляет JSON через настоящий HTTP с указанными заголовками.
export function post(
  base: string,
  route: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(`${base}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

// Завершает ожидание события по сроку и очищает таймер после ответа.
export function deadline<T>(promise: Promise<T>, timeout = 2500): Promise<T> {
  return new Promise((resolve, reject) => {
    // Отклоняет ожидание при отсутствии ответа до установленного срока.

    const timer = setTimeout(
      /* Прерывает ожидание при превышении отведённого срока. */ () =>
        reject(new Error("Expected SSE event did not arrive before deadline")),
      timeout,
    );
    promise.then(
      (value) => {
        // Снимает таймер и возвращает полученный результат.
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        // Передаёт ошибку операции и освобождает таймер ожидания.
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
import { setupService } from "./service.js";
export { waitForTask as until } from "./service.js";
