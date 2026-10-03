import { spawn } from "node:child_process";
import type { CodexReadiness } from "../../shared/connections.js";
import { CodexConnectionError, loginRequired } from "./connection-error.js";

/** Завершает всю группу, включая потомков, которые могут удерживать открытые потоки. */
export function killGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return;
  }
  const force = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Группа уже завершилась.
    }
  }, 1000);
  force.unref();
}

/** Читает ограниченный локальный ответ; содержимое никогда не попадает в ошибки и журнал. */
async function command(
  binary: string,
  args: string[],
  signal: AbortSignal,
  deadline: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  if (signal.aborted || Date.now() >= deadline)
    throw new CodexConnectionError("connection_check_failed");
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let failure: CodexConnectionError | undefined;
    const fail = (error = new CodexConnectionError("connection_check_failed")) => {
      failure ??= error;
      killGroup(child.pid);
    };
    const abort = () => fail();
    const timer = setTimeout(abort, Math.max(1, Math.min(2000, deadline - Date.now())));
    signal.addEventListener("abort", abort, { once: true });
    for (const [name, stream] of [
      ["stdout", child.stdout],
      ["stderr", child.stderr],
    ] as const) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 8192) return fail();
        if (name === "stdout") stdout += chunk;
        else stderr += chunk;
      });
    }
    child.once("error", () => fail(new CodexConnectionError("cli_unavailable")));
    child.once("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    if (signal.aborted) abort();
  });
}

/** Проверяет установленный CLI и локальную запись входа без запроса к модели. */
export async function inspectCli(
  binary: string,
  signal: AbortSignal,
  deadline: number,
): Promise<{ readiness: CodexReadiness; error?: CodexConnectionError }> {
  const readiness: CodexReadiness = {
    executionMode: "real",
    ready: false,
    checkedAt: new Date().toISOString(),
    checks: [
      { id: "cli", status: "not_checked", message: "Codex CLI ещё не проверен." },
      { id: "auth", status: "not_checked", message: "Вход можно проверить после проверки CLI." },
      {
        id: "cloud",
        status: "not_checked",
        message:
          "Сеть, доступ к моделям и лимиты проверяются при выполнении задачи. Локальная проверка входа не подтверждает действительность сессии в облаке.",
      },
    ],
  };
  let check = readiness.checks[0]!;
  try {
    const version = await command(binary, ["--version"], signal, deadline);
    if (version.code !== 0) throw new CodexConnectionError("connection_check_failed");
    if (version.stdout !== "codex-cli 0.156.1") throw new CodexConnectionError("cli_incompatible");
    check.status = "passed";
    check.message = "Codex CLI установлен, версия 0.156.1 поддерживается.";
    check = readiness.checks[1]!;
    const auth = await command(binary, ["login", "status"], signal, deadline);
    const status = `${auth.stdout}\n${auth.stderr}`;
    if (/^Not logged in\s*$/im.test(status)) throw loginRequired(binary);
    if (auth.code !== 0 || !/^Logged in using (?:ChatGPT|an API key)\b/im.test(status))
      throw new CodexConnectionError("connection_check_failed");
    check.status = "passed";
    check.message = "В Codex CLI сохранён вход. Проверка выполнена на компьютере сервера.";
    readiness.ready = true;
    return { readiness };
  } catch (error) {
    const failure =
      error instanceof CodexConnectionError
        ? error
        : new CodexConnectionError("connection_check_failed");
    check.status = "failed";
    check.message = failure.message;
    return { readiness, error: failure };
  } finally {
    readiness.checkedAt = new Date().toISOString();
  }
}
