import express, { type ErrorRequestHandler, type Express, type Request, type Response } from "express";
import { ZodError } from "zod";
import { CreateTaskRequestSchema, DecisionRequestSchema, ResumeRequestSchema } from "../../shared/api.js";
import { ServiceError, type AppService } from "../workflow/service.js";
import { safeErrorClass } from "../observability/logger.js";

type TaskParams = { id: string };
type ArtifactParams = TaskParams & { artifactId: string };
const streams = new WeakMap<Express, Set<Response>>();

function requireLocalOrigin(origin: string | undefined, host: string | undefined): void {
  if (!origin) return;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol === "http:" && parsed.host === host && ["localhost", "127.0.0.1"].includes(parsed.hostname)) return;
  } catch { /* invalid origin */ }
  throw new ServiceError(403, "origin_denied", "Команда разрешена только из локального приложения.");
}

function cursorOf(request: Request): number {
  const raw = request.header("Last-Event-ID") ?? request.query.after ?? "0";
  const after = Number(raw);
  if (!Number.isSafeInteger(after) || after < 0) throw new ServiceError(400, "invalid_cursor", "Некорректный курсор событий.");
  return after;
}

function hasSupportedContentType(request: Request): boolean {
  return request.is("application/json") !== false || request.is("text/plain") !== false;
}

export function closeHttpStreams(app: Express): void {
  for (const response of streams.get(app) ?? []) response.end();
}

export function createHttpApp(service: AppService): Express {
  const app = express();
  const activeStreams = new Set<Response>();
  streams.set(app, activeStreams);
  app.disable("x-powered-by");

  app.use((request, _response, next) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") requireLocalOrigin(request.headers.origin, request.headers.host);
      next();
    } catch (error) { next(error); }
  });
  // Preserve Fastify's JSON body limit and public error shape.
  app.use((request, _response, next) => {
    if (["POST", "PUT", "PATCH"].includes(request.method) &&
      (request.headers["content-length"] !== undefined || request.headers["transfer-encoding"] !== undefined) &&
      !hasSupportedContentType(request)) return next(new Error("Unsupported content type"));
    next();
  });
  app.use(express.json({ limit: 1024 * 1024, strict: false, type: "application/json" }));
  app.use(express.text({ limit: 1024 * 1024, type: "text/plain" }));

  const api = express.Router();
  api.get("/health", (_request, response) => { response.json({ ok: true, executionMode: service.executionMode }); });
  api.get("/tasks", async (_request, response) => { response.json(await service.listTasks()); });
  api.post("/tasks", async (request, response) => {
    const input = CreateTaskRequestSchema.parse(request.body);
    const key = request.headers["idempotency-key"];
    response.status(202).json(await service.createTask(input, typeof key === "string" ? key : undefined));
  });
  api.get("/tasks/:id", async (request: Request<TaskParams>, response) => { response.json(await service.getTask(request.params.id)); });
  api.post("/tasks/:id/decision", async (request: Request<TaskParams>, response) => {
    response.json(await service.decide(request.params.id, DecisionRequestSchema.parse(request.body)));
  });
  api.post("/tasks/:id/stop", async (request: Request<TaskParams>, response) => { response.json(await service.stop(request.params.id)); });
  api.post("/tasks/:id/resume", async (request: Request<TaskParams>, response) => {
    response.json(await service.resume(request.params.id, ResumeRequestSchema.parse(request.body)));
  });

  api.get("/tasks/:id/events", async (request: Request<TaskParams>, response) => {
    await service.getTask(request.params.id);
    const after = cursorOf(request);
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
    response.flushHeaders();
    response.write(": connected\n\n");
    activeStreams.add(response);
    let seen = after;
    let ready = false;
    const pending: Array<{ sequence: number; data: string }> = [];
    const write = (sequence: number, data: string) => {
      if (sequence <= seen || response.destroyed || response.writableEnded) return;
      seen = sequence;
      response.write(`id: ${sequence}\ndata: ${data}\n\n`);
    };
    const unsubscribe = service.events.subscribe(request.params.id, event => {
      const item = { sequence: event.sequence, data: JSON.stringify(event) };
      if (ready) write(item.sequence, item.data);
      else pending.push(item);
    });
    const heartbeat = setInterval(() => { if (!response.destroyed && !response.writableEnded) response.write(": heartbeat\n\n"); }, 15_000);
    const cleanup = () => { clearInterval(heartbeat); unsubscribe(); activeStreams.delete(response); };
    response.once("close", cleanup);
    response.once("error", cleanup);
    try {
      const replay = await service.events.readAfter(request.params.id, after);
      for (const event of replay) write(event.sequence, JSON.stringify(event));
      ready = true;
      for (const item of pending) write(item.sequence, item.data);
    } catch (error) {
      console.error("SSE replay failed:", safeErrorClass(error));
      response.end();
    }
  });

  api.get("/tasks/:id/artifacts/:artifactId", async (request: Request<ArtifactParams>, response) => {
    const file = await service.getFile(request.params.id, request.params.artifactId);
    response.type("text/plain; charset=utf-8");
    if (request.query.download === "1") response.setHeader("Content-Disposition", `attachment; filename="${file.path}"`);
    response.send(file.content);
  });
  api.get("/tasks/:id/result.zip", async (request: Request<TaskParams>, response) => {
    const zip = await service.getResultZip(request.params.id);
    response.type("application/zip").setHeader("Content-Disposition", "attachment; filename=two-model-result.zip");
    response.send(Buffer.from(zip));
  });
  app.use("/api", api);

  const handleError: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (response.headersSent) { response.end(); return; }
    if (error instanceof ServiceError) { response.status(error.statusCode).json({ code: error.code, message: error.message }); return; }
    if (error instanceof ZodError) { response.status(400).json({ code: "invalid_request", message: error.issues.map(issue => issue.message).join("; ") }); return; }
    console.error("HTTP request failed:", safeErrorClass(error));
    response.status(500).json({ code: "internal_error", message: "Внутренняя ошибка приложения." });
  };
  app.use(handleError);
  return app;
}
