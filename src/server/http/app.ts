import Fastify, { LogController, type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { CreateTaskRequestSchema, DecisionRequestSchema, ResumeRequestSchema } from "../../shared/api.js";
import { ServiceError, type AppService } from "../workflow/service.js";

function requireLocalOrigin(origin: string | undefined, host: string | undefined): void {
  if (!origin) return;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol === "http:" && parsed.host === host && ["localhost", "127.0.0.1"].includes(parsed.hostname)) return;
  } catch { /* invalid origin */ }
  throw new ServiceError(403, "origin_denied", "Команда разрешена только из локального приложения.");
}

export function createHttpApp(service: AppService): FastifyInstance {
  const app = Fastify({ logger: true, logController: new LogController({ disableRequestLogging: true }), forceCloseConnections: true });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ServiceError) return reply.code(error.statusCode).send({ code: error.code, message: error.message });
    if (error instanceof ZodError) return reply.code(400).send({ code: "invalid_request", message: error.issues.map(issue => issue.message).join("; ") });
    app.log.error(error);
    return reply.code(500).send({ code: "internal_error", message: "Внутренняя ошибка приложения." });
  });
  app.addHook("preHandler", async request => {
    if (request.method !== "GET" && request.method !== "HEAD") requireLocalOrigin(request.headers.origin, request.headers.host);
  });

  app.get("/api/health", async () => ({ ok: true, executionMode: service.executionMode }));
  app.get("/api/tasks", async () => service.listTasks());
  app.post("/api/tasks", async (request, reply) => {
    const input = CreateTaskRequestSchema.parse(request.body);
    const key = request.headers["idempotency-key"];
    const result = await service.createTask(input, typeof key === "string" ? key : undefined);
    return reply.code(202).send(result);
  });
  app.get<{ Params: { id: string } }>("/api/tasks/:id", async request => service.getTask(request.params.id));
  app.post<{ Params: { id: string } }>("/api/tasks/:id/decision", async request => service.decide(request.params.id, DecisionRequestSchema.parse(request.body)));
  app.post<{ Params: { id: string } }>("/api/tasks/:id/stop", async request => service.stop(request.params.id));
  app.post<{ Params: { id: string } }>("/api/tasks/:id/resume", async request => service.resume(request.params.id, ResumeRequestSchema.parse(request.body)));

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>("/api/tasks/:id/events", async (request, reply) => {
    await service.getTask(request.params.id); // Validate task before taking over the socket.
    const rawCursor = request.headers["last-event-id"] ?? request.query.after ?? "0";
    const after = Number(rawCursor);
    if (!Number.isSafeInteger(after) || after < 0) throw new ServiceError(400, "invalid_cursor", "Некорректный курсор событий.");
    reply.hijack();
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
    let seen = after;
    let ready = false;
    const pending: Array<{ sequence: number; data: string }> = [];
    const write = (sequence: number, data: string) => {
      if (sequence <= seen || reply.raw.destroyed) return;
      seen = sequence;
      reply.raw.write(`id: ${sequence}\ndata: ${data}\n\n`);
    };
    const unsubscribe = service.events.subscribe(request.params.id, event => {
      const item = { sequence: event.sequence, data: JSON.stringify(event) };
      if (ready) write(item.sequence, item.data);
      else pending.push(item);
    });
    const heartbeat = setInterval(() => { if (!reply.raw.destroyed) reply.raw.write(": heartbeat\n\n"); }, 15_000);
    reply.raw.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
    try {
      const replay = await service.events.readAfter(request.params.id, after);
      for (const event of replay) write(event.sequence, JSON.stringify(event));
      ready = true;
      for (const item of pending) write(item.sequence, item.data);
    } catch (error) {
      app.log.error(error);
      reply.raw.end();
    }
  });

  app.get<{ Params: { id: string; artifactId: string }; Querystring: { download?: string } }>("/api/tasks/:id/artifacts/:artifactId", async (request, reply) => {
    const file = await service.getFile(request.params.id, request.params.artifactId);
    reply.type("text/plain; charset=utf-8");
    if (request.query.download === "1") reply.header("Content-Disposition", `attachment; filename="${file.path}"`);
    return reply.send(file.content);
  });
  app.get<{ Params: { id: string } }>("/api/tasks/:id/result.zip", async (request, reply) => {
    const zip = await service.getResultZip(request.params.id);
    reply.type("application/zip").header("Content-Disposition", "attachment; filename=two-model-result.zip");
    return reply.send(Buffer.from(zip));
  });
  return app;
}
