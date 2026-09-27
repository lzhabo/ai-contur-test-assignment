import { z } from "zod";
import { ApiErrorSchema } from "../../shared/api";

/** Сохраняет смысловой код ответа сервера вместе с сообщением для интерфейса. */
export class HttpError extends Error {
  /** Создаёт ошибку запроса с HTTP-статусом и кодом операции. */
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Читает серверную ошибку; повреждённый ответ заменяет понятным сообщением. */
async function responseError(response: Response): Promise<HttpError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const parsed = ApiErrorSchema.safeParse(body);
  return new HttpError(
    parsed.success ? parsed.data.message : `Запрос не выполнен (${response.status}).`,
    response.status,
    parsed.success ? parsed.data.code : "invalid_response",
  );
}

/** Выполняет HTTP-запрос и проверяет JSON до передачи данных в кеш. */
export async function requestJson<T>(
  path: string,
  schema: z.ZodType<T>,
  options?: RequestInit,
): Promise<T> {
  const response = await fetch(path, options);
  if (!response.ok) throw await responseError(response);
  return schema.parse(await response.json());
}

/** Загружает текст файла с поддержкой отмены при переключении вкладки. */
export async function requestText(path: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(path, { signal });
  if (!response.ok) throw await responseError(response);
  return response.text();
}

/** Подготавливает JSON-команду; повтором управляет пользователь, а не транспорт. */
export function jsonPost(value: unknown, headers?: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(value),
  };
}

/** Преобразует неизвестную ошибку в сообщение для пользователя. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Не удалось выполнить действие.";
}
