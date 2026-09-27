import { createServer } from "node:http";
import { resolve } from "node:path";
import { loadAppConfig } from "../../shared/index.js";
import { LocalArtifactStore } from "../artifacts/local-store.js";
import { QuickJsCheckRunner } from "../checks/quickjs-runner.js";
import { CodexCliPort } from "../codex/cli-port.js";
import { createHttpApp, closeHttpStreams } from "../http/app.js";
import { installFrontendFallback } from "../http/frontend.js";
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
  try { await logger.record({ event: "server_start_failed", source: "main", errorClass: safeErrorClass(error) }); }
  finally { await logger.close(); }
  throw error;
});
const app = createHttpApp(service);
installFrontendFallback(app, resolve(process.cwd(), "dist"));

const server = createServer(app);
let closing: Promise<void> | undefined;
function close(): Promise<void> {
  if (closing) return closing;
  closing = (async () => {
    closeHttpStreams(app);
    try {
      if (server.listening) {
        const stopped = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        server.closeAllConnections();
        await stopped;
      }
    } finally {
      try { await service.close(); }
      finally { await logger.close(); }
    }
  })();
  return closing;
}

try {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => { server.off("error", reject); resolve(); });
  });
} catch (error) {
  try { await logger.record({ event: "server_start_failed", source: "main", errorClass: safeErrorClass(error) }); }
  finally { await close(); }
  throw error;
}
await logger.record({ event: "server_started", source: "main", host: config.host, port: config.port, executionMode: config.executionMode }).catch(() => undefined);

function onSignal(): void {
  void close().then(
    () => process.exit(0),
    error => { console.error(error); process.exit(1); },
  );
}
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);
