import express, { type ErrorRequestHandler, type Express, type Request } from "express";
import { ZodError } from "zod";
import { safeErrorClass } from "../logger.js";
import { ServiceError, type ServiceErrorCode } from "../tasks/errors.js";

const serviceStatus: Record<ServiceErrorCode, number> = {
  idempotency_conflict: 409,
  active_task: 409,
  mode_mismatch: 409,
  decision_not_allowed: 409,
  stale_version: 409,
  decision_pending: 409,
  resume_not_allowed: 409,
  task_running: 409,
  task_not_found: 404,
  checkpoint_missing: 503,
  artifact_not_found: 404,
  artifact_changed: 409,
  result_unavailable: 404,
};

export class HttpError extends Error {
  // Описывает ошибку HTTP-протокола, которая не относится к операциям задач.
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Разрешает изменяющие запросы только с совпадающего локального origin. */
function requireLocalOrigin(origin: string | undefined, host: string | undefined): void {
  if (!origin) return;
  try {
    const parsed = new URL(origin);
    if (
      parsed.protocol === "http:" &&
      parsed.host === host &&
      ["localhost", "127.0.0.1"].includes(parsed.hostname)
    )
      return;
  } catch {
    /* invalid origin */
  }
  throw new HttpError(403, "origin_denied", "Команда разрешена только из локального приложения.");
}

/** Определяет, поддерживает ли приложение тип тела запроса. */
function hasSupportedContentType(request: Request): boolean {
  return request.is("application/json") !== false || request.is("text/plain") !== false;
}

// Проверяет локальный источник команд и ограничивает размер принимаемого тела запроса.
export function installRequestParsing(app: Express): void {
  app.use(
    /* Проверяет источник изменяющего запроса и передаёт ошибку общему обработчику. */ (
      request,
      _response,
      next,
    ) => {
      try {
        if (request.method !== "GET" && request.method !== "HEAD")
          requireLocalOrigin(request.headers.origin, request.headers.host);
        next();
      } catch (error) {
        next(error);
      }
    },
  );
  // Preserve Fastify's JSON body limit and public error shape.
  app.use(
    /* Отклоняет неподдерживаемый Content-Type перед разбором тела. */ (
      request,
      _response,
      next,
    ) => {
      if (
        ["POST", "PUT", "PATCH"].includes(request.method) &&
        (request.headers["content-length"] !== undefined ||
          request.headers["transfer-encoding"] !== undefined) &&
        !hasSupportedContentType(request)
      )
        return next(new Error("Unsupported content type"));
      next();
    },
  );
  app.use(express.json({ limit: 1024 * 1024, strict: false, type: "application/json" }));
  app.use(express.text({ limit: 1024 * 1024, type: "text/plain" }));
}

export const handleError: ErrorRequestHandler =
  /* Переводит ошибки операций и схем в единый HTTP-ответ без раскрытия внутренних деталей. */ (
    error: unknown,
    _request,
    response,
    _next,
  ) => {
    if (response.headersSent) {
      response.end();
      return;
    }
    if (error instanceof ServiceError || error instanceof HttpError) {
      const status = error instanceof ServiceError ? serviceStatus[error.code] : error.statusCode;
      response.status(status).json({ code: error.code, message: error.message });
      return;
    }
    if (error instanceof ZodError) {
      response.status(400).json({
        code: "invalid_request",
        message: error.issues
          .map(
            /* Извлекает понятное сообщение каждого нарушения входной схемы. */ (issue) =>
              issue.message,
          )
          .join("; "),
      });
      return;
    }
    console.error("HTTP request failed:", safeErrorClass(error));
    response.status(500).json({ code: "internal_error", message: "Внутренняя ошибка приложения." });
  };
