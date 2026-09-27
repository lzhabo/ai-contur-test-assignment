import { Worker } from "node:worker_threads";
import { parseTestArtifact } from "../storage/test-artifact.js";
import type { ArtifactStore, CheckRunHooks, CheckRunner } from "../tasks/ports.js";
import { type ArtifactRef, type CheckResult } from "../tasks/types.js";

const maxTimeoutMs = 5000;
const maxMemoryBytes = 64 * 1024 * 1024;

interface WorkerResult {
  compilation: CheckResult["compilation"];
  tests: CheckResult["tests"];
  passedCases: number;
  failedCases: number;
  fatal?: string;
}

export class QuickJsCheckRunner implements CheckRunner {
  /** Подключает проверенное хранилище версий к исполнителю тестов. */
  constructor(private readonly store: ArtifactStore) {}

  /** Проверяет файлы и запускает изолированный worker с ограничениями времени и памяти. */
  async run(ref: ArtifactRef, hooks: CheckRunHooks): Promise<CheckResult> {
    if (!Number.isInteger(hooks.timeoutMs) || hooks.timeoutMs < 1 || hooks.timeoutMs > maxTimeoutMs)
      throw new Error("Invalid check timeout");
    if (
      !Number.isInteger(hooks.memoryLimitBytes) ||
      hooks.memoryLimitBytes < 1024 * 1024 ||
      hooks.memoryLimitBytes > maxMemoryBytes
    )
      throw new Error("Invalid check memory limit");
    if (hooks.signal.aborted) throw new Error("Check aborted");
    await this.store.verifyVersion(ref);
    const solutionRef = ref.files.find(
      /* Находит исходник функции в проверенном манифесте. */ (file) => file.path === "solution.ts",
    );
    const testRef = ref.files.find(
      /* Находит доверенный файл тестовых случаев в манифесте. */ (file) =>
        file.path === "solution.test.ts",
    );
    if (!solutionRef || !testRef) throw new Error("Incomplete artifact");
    const solution = await this.store.getFile(ref.taskId, solutionRef.artifactId, "revision");
    const test = await this.store.getFile(ref.taskId, testRef.artifactId, "revision");
    const { functionName, cases } = parseTestArtifact(test.content);
    const started = Date.now();
    const worker = new Worker(new URL("./quickjs-worker.ts", import.meta.url), {
      workerData: {
        solutionTs: solution.content,
        functionName,
        cases,
        deadline: started + hooks.timeoutMs,
        memoryLimitBytes: hooks.memoryLimitBytes,
      },
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 },
    });
    const result = await new Promise<WorkerResult>(
      /* Связывает результат worker с отменой, таймером и освобождением процесса. */ (
        resolve,
        reject,
      ) => {
        let settled = false;
        const finish =
          /* Завершает проверку единожды и освобождает worker и обработчики отмены. */ (
            value?: WorkerResult,
            error?: Error,
          ) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            hooks.signal.removeEventListener("abort", abort);
            void worker.terminate();
            if (error) reject(error);
            else resolve(value!);
          };
        const abort = /* Прерывает проверку по сигналу остановки задачи. */ () =>
          finish(undefined, new Error("Check aborted"));
        const timer = setTimeout(
          /* Возвращает результат timeout, если worker не завершился вовремя. */ () =>
            finish({
              compilation: { status: "timeout", details: ["Check deadline exceeded"] },
              tests: { status: "timeout", details: ["Check deadline exceeded"] },
              passedCases: 0,
              failedCases: cases.length,
            }),
          hooks.timeoutMs,
        );
        hooks.signal.addEventListener("abort", abort, { once: true });
        worker.once(
          "message",
          /* Принимает итог выполнения от worker и закрывает его. */ (message: WorkerResult) =>
            finish(message),
        );
        worker.once(
          "error",
          /* Преобразует аварийное завершение worker в диагностический результат проверки. */ (
            error,
          ) =>
            finish({
              compilation: { status: "error", details: [String(error)] },
              tests: { status: "error", details: ["Worker failed"] },
              passedCases: 0,
              failedCases: cases.length,
            }),
        );
        worker.once(
          "exit",
          /* Обнаруживает ненулевой код завершения worker без итогового сообщения. */ (code) => {
            if (code !== 0)
              finish({
                compilation: { status: "error", details: [`Worker exited ${code}`] },
                tests: { status: "error", details: ["Worker exited"] },
                passedCases: 0,
                failedCases: cases.length,
              });
          },
        );
      },
    );
    if (result.fatal)
      return {
        versionId: ref.versionId,
        manifestHash: ref.manifestHash,
        compilation: { status: "error", details: [result.fatal] },
        tests: { status: "error", details: ["Check failed"] },
        passedCases: 0,
        failedCases: cases.length,
        durationMs: Date.now() - started,
        at: new Date().toISOString(),
      };
    return {
      versionId: ref.versionId,
      manifestHash: ref.manifestHash,
      compilation: result.compilation,
      tests: result.tests,
      passedCases: result.passedCases,
      failedCases: result.failedCases,
      durationMs: Date.now() - started,
      at: new Date().toISOString(),
    };
  }
}
