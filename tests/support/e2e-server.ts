import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHttpApp, closeHttpStreams } from "../../src/server/app.js";
import { installFrontendFallback } from "../../src/server/routes/frontend.js";
import { createAppService } from "../../src/server/tasks/service.js";
import { LocalArtifactStore } from "../../src/server/storage/local-store.js";
import { QuickJsCheckRunner } from "../../src/server/code-runner/quickjs-runner.js";
import { CodexCliPort } from "../../src/server/codex/cli-port.js";
import { createMockCodexPort } from "../../src/server/codex/mock-port.js";
import type { CodexPort } from "../../src/server/tasks/ports.js";

// Каждый прогон начинает с новых данных; real включается только явной переменной окружения.
const executionMode = process.env.QA_REAL_CODEX === "1" ? "real" : "mock";
const dataDir = await mkdtemp(join(tmpdir(), `kontur-e2e-${executionMode}-`));
const artifacts = new LocalArtifactStore(dataDir);
const adapter = executionMode === "real" ? new CodexCliPort() : createMockCodexPort("happy");
const roles: string[] = [];
const codex: CodexPort = {
  // Учитывает фактические вызовы ролей без записи пользовательского текста или авторизации.
  async run(request, hooks) {
    roles.push(request.role);
    console.log(JSON.stringify({ e2eModelCall: request.role, executionMode }));
    return adapter.run(request, hooks);
  },
};
let close: (() => Promise<void>) | undefined;
try {
  const service = await createAppService({
    dataDir,
    executionMode,
    ports: { artifacts, checks: new QuickJsCheckRunner(artifacts), codex },
  });
  const app = createHttpApp(service);
  installFrontendFallback(app, resolve("dist"));
  const server = createServer(app);
  let closing: Promise<void> | undefined;
  // Закрывает SSE и сервис до удаления SQLite/JSONL; повторный сигнал использует тот же Promise.
  close = () => {
    // Возвращает общее ожидание очистки при повторном сигнале завершения.

    closing ??= (async () => {
      // Закрывает потоки, сервер и сервис, затем удаляет временные данные.

      closeHttpStreams(app);
      if (server.listening) {
        const stopped = new Promise<void>(
          /* Дожидается освобождения локального порта. */ (complete, reject) =>
            server.close(
              /* Завершает ожидание закрытия ресурса и передаёт ошибку при неудаче. */ (error) =>
                error ? reject(error) : complete(),
            ),
        );
        server.closeAllConnections();
        await stopped;
      }
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
      console.log(JSON.stringify({ e2eClosed: true, executionMode, roles }));
    })();
    return closing;
  };
  // Обрабатывает штатное завершение Playwright и возвращает ошибку при неудачной очистке.
  function onSignal() {
    void close!().then(
      /* Завершает сервер с кодом успеха после очистки. */ () => process.exit(0),
      (error) => {
        // Печатает ошибку очистки и завершает сервер с кодом ошибки.
        console.error(error);
        process.exit(1);
      },
    );
  }
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  await new Promise<void>((complete, reject) => {
    // Дожидается успешного запуска локального сервера.

    server.once("error", reject);
    server.listen(Number(process.env.QA_E2E_PORT ?? 4318), "127.0.0.1", () => {
      // Подтверждает запуск сервера и снимает временный обработчик ошибки.
      server.off("error", reject);
      complete();
    });
  });
} catch (error) {
  if (close) await close();
  else await rm(dataDir, { recursive: true, force: true });
  throw error;
}
