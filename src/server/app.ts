import express, { type Express, type Response } from "express";
import { handleError, installRequestParsing } from "./routes/errors.js";
import { createTaskRoutes } from "./routes/tasks.js";
import type { AppService } from "./tasks/service.js";

const streams = new WeakMap<Express, Set<Response>>();

// Завершает SSE-подписки приложения перед остановкой HTTP-сервера.
export function closeHttpStreams(app: Express): void {
  for (const response of streams.get(app) ?? []) response.end();
}

// Собирает Express из разбора запросов, маршрутов и единого обработчика ошибок.
export function createHttpApp(service: AppService): Express {
  const app = express();
  const activeStreams = new Set<Response>();
  streams.set(app, activeStreams);
  app.disable("x-powered-by");
  installRequestParsing(app);
  app.use("/api", createTaskRoutes(service, activeStreams));
  app.use(handleError);
  return app;
}
