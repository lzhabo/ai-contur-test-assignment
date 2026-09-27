import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { createAppService, type AppService } from "../../src/server/tasks/service.js";
import { createMockCodexPort, type MockScenario } from "../../src/server/codex/mock-port.js";
import { LocalArtifactStore } from "../../src/server/storage/local-store.js";
import { QuickJsCheckRunner } from "../../src/server/code-runner/quickjs-runner.js";
import { DEFAULT_LIMITS } from "../../src/server/config.js";
import type { CodexRunRequest } from "../../src/server/tasks/ports.js";
import type { TaskSnapshotResponse } from "../../src/shared/api.js";

export const services: AppService[] = [];
const roots: string[] = [];

// Закрывает сервисы до удаления временных баз, даже если проверка завершилась ошибкой.
afterEach(async () => {
  // Освобождает процессы и ресурсы сценария, затем удаляет временные данные.

  await Promise.allSettled(
    services
      .splice(0)
      .map(/* Закрывает ресурс перед удалением временных данных. */ (service) => service.close()),
  );
  await Promise.all(
    roots
      .splice(0)
      .map(/* Удаляет временные данные. */ (root) => rm(root, { recursive: true, force: true })),
  );
});

// Создаёт настоящий сервис, SQLite и QuickJS во временном каталоге; подменяет только ответы Codex.
export async function setupService(scenario: MockScenario = "happy") {
  const root = await mkdtemp(path.join(tmpdir(), "loop-test-service-"));
  roots.push(root);
  const artifacts = new LocalArtifactStore(root);
  const mock = createMockCodexPort(scenario);
  const calls: CodexRunRequest[] = [];
  const options = {
    dataDir: root,
    executionMode: "mock" as const,
    limits: {
      ...DEFAULT_LIMITS,
      modelTimeoutMs: scenario === "no_response" ? 50 : 10000,
    },
    ports: {
      artifacts,
      checks: new QuickJsCheckRunner(artifacts),
      codex: {
        // Запоминает запрос для проверки числа и порядка ролей, затем отдаёт явный mock-ответ.
        run(request: CodexRunRequest, hooks: Parameters<typeof mock.run>[1]) {
          calls.push(request);
          return mock.run(request, hooks);
        },
      },
    },
  };
  const service = await createAppService(options);
  services.push(service);
  return { root, service, options, calls };
}

// Ожидает указанное условие до срока и включает последний ответ сервера в сообщение об ошибке.
export async function waitForTask(
  service: AppService,
  id: string,
  matches: (value: TaskSnapshotResponse) => boolean,
) {
  const end = Date.now() + 10000;
  let last: TaskSnapshotResponse | undefined;
  while (Date.now() < end) {
    last = await service.getTask(id);
    if (matches(last)) return last;
    await new Promise(
      /* Выдерживает короткий интервал перед повторной проверкой состояния. */ (resolve) =>
        setTimeout(resolve, 10),
    );
  }
  throw new Error(`Задача не достигла ожидаемого состояния: ${JSON.stringify(last)}`);
}
