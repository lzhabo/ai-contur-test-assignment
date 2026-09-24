import { readFile } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import Fastify from "fastify";
import { loadAppConfig, TaskListResponseSchema } from "../../shared/index.js";

const config = loadAppConfig();
const app = Fastify({ logger: true });
const distRoot = resolve(process.cwd(), "dist");
const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

app.get("/api/health", async () => ({ ok: true }));

// E1 placeholder. E2 replaces this with checkpoint-backed task listing.
app.get("/api/tasks", async () => TaskListResponseSchema.parse({ tasks: [], activeTaskId: null }));

app.setNotFoundHandler(async (request, reply) => {
  if (request.url.startsWith("/api/")) {
    return reply.code(404).send({ code: "not_found", message: "Unknown API route" });
  }
  const requested = new URL(request.url, "http://localhost").pathname;
  const candidate = resolve(distRoot, `.${requested}`);
  const withinDist = candidate === distRoot || relative(distRoot, candidate).split(sep)[0] !== "..";
  if (!withinDist) {
    return reply.code(404).send("Not found");
  }
  try {
    const file = await readFile(candidate);
    reply.type(mimeTypes[extname(candidate)] ?? "application/octet-stream");
    return reply.send(file);
  } catch {
    try {
      const html = await readFile(resolve(distRoot, "index.html"));
      reply.type(mimeTypes[".html"]);
      return reply.send(html);
    } catch {
      return reply.code(503).send("Frontend build is unavailable; run npm run build");
    }
  }
});

await app.listen({ host: config.host, port: config.port });
