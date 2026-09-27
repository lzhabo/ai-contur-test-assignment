import { createServer } from "node:http";
import { resolve } from "node:path";
import { closeHttpStreams, createHttpApp } from "./app.js";
import { QuickJsCheckRunner } from "./code-runner/quickjs-runner.js";
import { CodexCliPort } from "./codex/cli-port.js";
import { createMockCodexPort } from "./codex/mock-port.js";
import { loadAppConfig } from "./config.js";
import { createStructuredLogger, safeErrorClass } from "./logger.js";
import { installFrontendFallback } from "./routes/frontend.js";
import { LocalArtifactStore } from "./storage/local-store.js";
import { createAppService } from "./tasks/service.js";

const config = loadAppConfig();
const dataDir = resolve(config.dataDir);
const artifacts = new LocalArtifactStore(dataDir);
const logger = await createStructuredLogger(dataDir);
const service = await createAppService({
  dataDir,
  ports: {
    artifacts,
    checks: new QuickJsCheckRunner(artifacts),
    codex:
      config.executionMode === "mock"
        ? createMockCodexPort(config.mockScenario)
        : new CodexCliPort(),
  },
  models: config.models,
  limits: config.limits,
  executionMode: config.executionMode,
  logger,
}).catch(
  /* Записывает ошибку запуска и закрывает журнал перед повторным выбросом ошибки. */ async (
    error,
  ) => {
    try {
      await logger.record({
        event: "server_start_failed",
        source: "main",
        errorClass: safeErrorClass(error),
      });
    } finally {
      await logger.close();
    }
    throw error;
  },
);
const app = createHttpApp(service);
installFrontendFallback(app, resolve(process.cwd(), "dist"));

const server = createServer(app);
let closing: Promise<void> | undefined;
/** Останавливает сервер единожды и возвращает общее ожидание завершения. */
function close(): Promise<void> {
  if (closing) return closing;
  closing = (
    /* Закрывает HTTP-соединения, активные задачи и файловый журнал. */ async () => {
      closeHttpStreams(app);
      try {
        if (server.listening) {
          const stopped = new Promise<void>(
            /* Ожидает завершения прослушивания HTTP-сервера. */ (resolve, reject) =>
              server.close(
                /* Передаёт ошибку закрытия сервера в ожидающий Promise. */ (error) =>
                  error ? reject(error) : resolve(),
              ),
          );
          server.closeAllConnections();
          await stopped;
        }
      } finally {
        try {
          await service.close();
        } finally {
          await logger.close();
        }
      }
    }
  )();
  return closing;
}

try {
  await new Promise<void>(
    /* Запускает HTTP-сервер и отклоняет ожидание при ошибке привязки порта. */ (
      resolve,
      reject,
    ) => {
      server.once("error", reject);
      server.listen(
        config.port,
        config.host,
        /* Подтверждает успешное открытие порта и снимает временный обработчик ошибки. */ () => {
          server.off("error", reject);
          resolve();
        },
      );
    },
  );
} catch (error) {
  try {
    await logger.record({
      event: "server_start_failed",
      source: "main",
      errorClass: safeErrorClass(error),
    });
  } finally {
    await close();
  }
  throw error;
}
await logger
  .record({
    event: "server_started",
    source: "main",
    host: config.host,
    port: config.port,
    executionMode: config.executionMode,
  })
  .catch(/* Не прерывает работающий сервер из-за сбоя диагностической записи. */ () => undefined);

/** Обрабатывает системный сигнал через штатное завершение всех ресурсов. */
function onSignal(): void {
  void close().then(
    /* Завершает процесс после успешной очистки ресурсов. */ () => process.exit(0),
    /* Сообщает об ошибке очистки и завершает процесс с ненулевым кодом. */ (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);
