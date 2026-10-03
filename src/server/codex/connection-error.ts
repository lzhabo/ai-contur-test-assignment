export type CodexConnectionErrorCode =
  | "auth_required"
  | "cli_unavailable"
  | "cli_incompatible"
  | "connection_check_failed"
  | "access_denied"
  | "rate_limited";

const messages: Record<CodexConnectionErrorCode, string> = {
  auth_required:
    "Вход в Codex CLI отсутствует или истёк. Выполните codex login в терминале на компьютере сервера, затем нажмите «Проверить снова». Если задача ожидает входа, нажмите «Продолжить».",
  cli_unavailable:
    "Codex CLI не найден или не запускается. Установите CLI и проверьте путь к нему на компьютере сервера, затем повторите проверку.",
  cli_incompatible:
    "Версия Codex CLI несовместима с приложением. Требуется codex-cli 0.156.1. Установите эту версию на компьютере сервера и повторите проверку.",
  connection_check_failed:
    "Не удалось проверить Codex CLI. На компьютере сервера выполните codex --version и codex login status, затем повторите проверку.",
  access_denied:
    "Codex отклонил запрос: у аккаунта нет доступа. Проверьте доступ к выбранной модели и ограничения рабочего пространства, затем создайте задачу заново.",
  rate_limited:
    "Codex отклонил запрос из-за лимита использования. Проверьте лимиты аккаунта и создайте задачу заново после их восстановления.",
};

export class CodexConnectionError extends Error {
  /** Передаёт известный отказ без исходного вывода CLI и возможных секретов. */
  constructor(
    readonly code: CodexConnectionErrorCode,
    message = messages[code],
  ) {
    super(message);
    this.name = "CodexConnectionError";
  }
}

/** Направляет пользователя к тому же CLI; экранирует путь для вставки команды в терминал. */
export function loginRequired(binary: string): CodexConnectionError {
  const command = /^[a-zA-Z0-9_./-]+$/.test(binary)
    ? binary
    : `'${binary.replaceAll("'", "'\\''")}'`;
  return new CodexConnectionError(
    "auth_required",
    messages.auth_required.replace("codex login", () => `${command} login`),
  );
}

/** Распознаёт только явные отказы провайдера; сетевой обрыв сохраняет неизвестный исход. */
export function providerFailure(raw: unknown, binary = "codex"): Error {
  const text = typeof raw === "string" ? raw : "";
  if (/\b401\b|\bunauthorized\b|\binvalid_api_key\b|\bauthentication_error\b/i.test(text))
    return loginRequired(binary);
  if (/\b403\b|\bforbidden\b|\bpermission_denied\b/i.test(text))
    return new CodexConnectionError("access_denied");
  if (/\b429\b|\brate_limit_exceeded\b|\binsufficient_quota\b/i.test(text))
    return new CodexConnectionError("rate_limited");
  return new Error(
    "Codex не подтвердил завершение запроса. Проверьте сеть и доступность сервиса. Повтор может создать новый вызов модели.",
  );
}
