import express, { type Request, type Response, type Router } from "express";
import {
  CreateTaskRequestSchema,
  DecisionRequestSchema,
  ResumeRequestSchema,
} from "../../shared/api.js";
import type { AppService } from "../tasks/service.js";
import { installEventRoute } from "./events.js";
type TaskParams = { id: string };
type ArtifactParams = TaskParams & { artifactId: string };

// Проверяет входные схемы и связывает HTTP-маршруты с операциями задач.
export function createTaskRoutes(service: AppService, activeStreams: Set<Response>): Router {
  const api = express.Router();
  api.get(
    "/health",
    /* Возвращает доступность сервера и фактический режим Codex. */ (_request, response) => {
      response.json({ ok: true, executionMode: service.executionMode });
    },
  );
  api.get(
    "/tasks",
    /* Возвращает список задач и идентификатор активной задачи. */ async (_request, response) => {
      response.json(await service.listTasks());
    },
  );
  api.post(
    "/tasks",
    /* Проверяет текст задания и создаёт задачу с ключом идемпотентности. */ async (
      request,
      response,
    ) => {
      const input = CreateTaskRequestSchema.parse(request.body);
      const key = request.headers["idempotency-key"];
      response
        .status(202)
        .json(await service.createTask(input, typeof key === "string" ? key : undefined));
    },
  );
  api.get(
    "/tasks/:id",
    /* Возвращает текущее представление выбранной задачи. */ async (
      request: Request<TaskParams>,
      response,
    ) => {
      response.json(await service.getTask(request.params.id));
    },
  );
  api.post(
    "/tasks/:id/decision",
    /* Проверяет решение пользователя и передаёт подтверждение точной версии. */ async (
      request: Request<TaskParams>,
      response,
    ) => {
      response.json(
        await service.decide(request.params.id, DecisionRequestSchema.parse(request.body)),
      );
    },
  );
  api.post(
    "/tasks/:id/stop",
    /* Останавливает задачу и возвращает её актуальное состояние. */ async (
      request: Request<TaskParams>,
      response,
    ) => {
      response.json(await service.stop(request.params.id));
    },
  );
  api.post(
    "/tasks/:id/resume",
    /* Передаёт явное разрешение повторить вызов с неизвестным исходом. */ async (
      request: Request<TaskParams>,
      response,
    ) => {
      response.json(
        await service.resume(request.params.id, ResumeRequestSchema.parse(request.body)),
      );
    },
  );

  api.get(
    "/tasks/:id/artifacts/:artifactId",
    /* Возвращает проверенное содержимое файла для просмотра или скачивания. */ async (
      request: Request<ArtifactParams>,
      response,
    ) => {
      const file = await service.getFile(request.params.id, request.params.artifactId);
      response.type("text/plain; charset=utf-8");
      if (request.query.download === "1")
        response.setHeader("Content-Disposition", `attachment; filename="${file.path}"`);
      response.send(file.content);
    },
  );
  api.get(
    "/tasks/:id/result.zip",
    /* Отдаёт ZIP с точными байтами опубликованной одобренной версии. */ async (
      request: Request<TaskParams>,
      response,
    ) => {
      const zip = await service.getResultZip(request.params.id);
      response
        .type("application/zip")
        .setHeader("Content-Disposition", "attachment; filename=two-model-result.zip");
      response.send(Buffer.from(zip));
    },
  );
  installEventRoute(api, service, activeStreams);
  return api;
}
