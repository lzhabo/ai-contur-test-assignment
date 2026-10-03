import type { TaskState } from "./types.js";

const legacyPrefix = "Вход в Codex CLI отсутствует или истёк. Выполните ";
const legacySuffix =
  " login в терминале на компьютере сервера, затем нажмите «Проверить снова». Если задача уже завершилась ошибкой, после входа создайте её заново.";

// Старые checkpoints не хранят код ошибки: разрешаем только точное прежнее сообщение приложения.
export function isLegacyAuthFailure(state: TaskState): boolean {
  const reason = state.stopReason;
  if (
    state.phase !== "error" ||
    state.activeAttempt !== null ||
    state.resultPath !== null ||
    state.lastAttempt?.status !== "failed" ||
    !reason ||
    state.lastAttempt.error !== reason ||
    !reason.startsWith(legacyPrefix) ||
    !reason.endsWith(legacySuffix)
  )
    return false;
  const command = reason.slice(legacyPrefix.length, -legacySuffix.length);
  return /^(?:[a-zA-Z0-9_./-]+|'(?:[^'\r\n]|'\\'')*')$/.test(command);
}

// Историю сохраняем дословно; на экране старой задачи объясняем доступное сейчас продолжение.
export function taskStopReason(state: TaskState): string | null {
  return isLegacyAuthFailure(state)
    ? state.stopReason!.replace(
        "Если задача уже завершилась ошибкой, после входа создайте её заново.",
        "После входа нажмите «Продолжить», чтобы возобновить эту задачу.",
      )
    : state.stopReason;
}
