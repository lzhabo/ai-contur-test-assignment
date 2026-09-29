import { CodexReadinessSchema, type CodexReadiness } from "../../shared/connections.js";
import type { CodexPort } from "./ports.js";
import { ServiceError } from "./errors.js";

/** Проверяет локальный доступ к Codex, не создавая задачу и не вызывая облачную модель. */
export async function readConnections(
  codex: CodexPort,
  executionMode: "real" | "mock",
): Promise<CodexReadiness> {
  if (executionMode === "mock") {
    return {
      executionMode,
      ready: true,
      checkedAt: new Date().toISOString(),
      checks: [
        {
          id: "cloud",
          status: "not_checked",
          message:
            "Тестовый режим: ответы подготовлены локально, вход в Codex и облако не используются.",
        },
      ],
    };
  }
  if (codex.checkReadiness) return CodexReadinessSchema.parse(await codex.checkReadiness());
  return {
    executionMode,
    ready: false,
    checkedAt: new Date().toISOString(),
    checks: [
      {
        id: "cli",
        status: "failed",
        message: "Этот адаптер не поддерживает проверку подключения к Codex.",
      },
    ],
  };
}

/** Повторно проверяет вход перед изменяющей командой с обращением к настоящим моделям. */
export async function requireCodexReady(codex: CodexPort, mode: "real" | "mock"): Promise<void> {
  if (mode === "mock") return;
  const status = await readConnections(codex, mode);
  if (!status.ready) {
    throw new ServiceError(
      "codex_not_ready",
      status.checks.find((check) => check.status === "failed")?.message ??
        "Codex пока не готов к запуску. Проверьте подключение.",
    );
  }
}
