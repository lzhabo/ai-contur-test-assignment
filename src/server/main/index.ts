import { readFile } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { loadAppConfig } from "../../shared/index.js";
import { LocalArtifactStore } from "../artifacts/local-store.js";
import { QuickJsCheckRunner } from "../checks/quickjs-runner.js";
import { CodexCliPort } from "../codex/cli-port.js";
import { createHttpApp } from "../http/app.js";
import { createFakeCodexPort } from "../codex/fake-port.js";
import { createAppService } from "../workflow/service.js";
import { createStructuredLogger, safeErrorClass } from "../observability/logger.js";

const config = loadAppConfig();
const dataDir = resolve(config.dataDir);
const artifacts = new LocalArtifactStore(dataDir);
const logger = await createStructuredLogger(dataDir);
const service = await createAppService({
  dataDir,
  ports: { artifacts, checks: new QuickJsCheckRunner(artifacts), codex: config.executionMode === "fake" ? createFakeCodexPort(config.fakeScenario) : new CodexCliPort() },
  models: config.models,
  limits: config.limits,
  executionMode: config.executionMode,
  logger,
}).catch(async error => {
  await logger.record({ event: "server_start_failed", source: "main", errorClass: safeErrorClass(error) });
  await logger.close();
  throw error;
});
const app = createHttpApp(service);
app.addHook("onClose", async () => { await service.close(); await logger.close(); });
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

try { await app.listen({ host: config.host, port: config.port }); }
catch (error) { await app.close(); throw error; }
process.once("SIGINT", () => { void app.close(); });
process.once("SIGTERM", () => { void app.close(); });
