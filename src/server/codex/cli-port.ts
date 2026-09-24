import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { ApplierOutputSchema, AuthorOutputSchema, ReviewerOutputSchema, type CodexOutput, type ProcessObservation } from "../../shared/contracts.js";
import type { CodexPort, CodexRunHooks, CodexRunRequest, CodexRunResult } from "../../shared/ports.js";

const CLI_VERSION = "codex-cli 0.156.1";
const MAX_CONTEXT_BYTES = 96 * 1024;
const MAX_EVENT_BYTES = 512 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const DISABLED = [
  "shell_tool", "unified_exec", "view_image", "apps", "browser_use", "browser_use_external",
  "browser_use_full_cdp_access", "computer_use", "image_generation", "code_mode_host",
  "plugins", "remote_plugin", "multi_agent", "skill_search", "workspace_dependencies", "in_app_browser",
] as const;
const transportSchemas = {
  candidate: AuthorOutputSchema,
  review: z.object({ kind: z.literal("review"), verdict: z.enum(["approved", "changes_requested"]), findings: z.array(z.string()) }),
  apply_request: z.object({ kind: z.literal("apply_request"), versionId: z.string(), manifestHash: z.string() }),
};
const roles = { author: "candidate", reviewer: "review", applier: "apply_request" } as const;
const authorTransportInstruction = "\n\nReturn solutionTs with an exported TypeScript function and cases as a JSON array of {name,args,expected} objects. Do not use markdown fences.";

function providerSchema(kind: CodexRunRequest["expectedOutputKind"]): object {
  const schema = z.toJSONSchema(transportSchemas[kind]) as Record<string, unknown>;
  // Codex 0.156.1 rejects `propertyNames` emitted for z.record; JSON object
  // keys are strings already, and the shared Zod schema validates the result.
  function removeUnsupported(node: unknown): void {
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    delete record.propertyNames;
    for (const value of Object.values(record)) removeUnsupported(value);
  }
  removeUnsupported(schema);
  return schema;
}

function normalizeOutput(kind: CodexRunRequest["expectedOutputKind"], value: unknown): CodexOutput {
  if (kind === "candidate") return AuthorOutputSchema.parse(value);
  if (kind === "review") return ReviewerOutputSchema.parse(value);
  return ApplierOutputSchema.parse(value);
}

function providerDiagnostic(raw: unknown): string {
  if (typeof raw !== "string") return "unknown provider error";
  const sanitize = (value: string) => value.replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 400);
  try {
    const parsed = JSON.parse(raw) as { error?: { code?: unknown; message?: unknown } };
    if (typeof parsed.error?.code === "string" && typeof parsed.error.message === "string") {
      return sanitize(`${parsed.error.code}: ${parsed.error.message}`);
    }
  } catch { /* plain diagnostic */ }
  return sanitize(raw);
}

function observed(source: string, name: string, stage: ProcessObservation["stage"], detail: string | null = null): ProcessObservation {
  return { at: new Date().toISOString(), source, name, stage, detail };
}

function killGroup(pid: number | undefined): void {
  if (!pid) return;
  try { process.kill(-pid, "SIGTERM"); } catch { return; }
  const force = setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch { /* already exited */ } }, 1000);
  force.unref();
}

async function commandVersion(binary: string, signal: AbortSignal, deadline: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["--version"], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let failed: Error | null = null;
    const fail = (message: string) => { failed ??= new Error(message); killGroup(child.pid); };
    const abort = () => fail("Codex run aborted");
    const timer = setTimeout(() => fail("Codex version check timed out"), Math.max(1, Math.min(2000, deadline - Date.now())));
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data: string) => { output += data; if (Buffer.byteLength(output) > 256) fail("Codex version output exceeded limit"); });
    let versionStderrBytes = 0;
    child.stderr.on("data", (data: string) => { versionStderrBytes += Buffer.byteLength(data); if (versionStderrBytes > 4096) fail("Codex version stderr exceeded limit"); });
    child.once("error", (error) => fail(`Codex version process error: ${error.message}`));
    child.once("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (failed) reject(failed);
      else if (code === 0) resolve(output.trim());
      else reject(new Error("Codex version check failed"));
    });
  });
}

export class CodexCliPort implements CodexPort {
  constructor(private readonly binary = "/opt/homebrew/bin/codex") {}

  private verifyCli(signal: AbortSignal, deadline: number): Promise<void> {
    return commandVersion(this.binary, signal, deadline).then((actual) => {
      if (actual !== CLI_VERSION) throw new Error(`Unsupported Codex CLI version: ${actual}`);
    });
  }

  async run(request: CodexRunRequest, hooks: CodexRunHooks): Promise<CodexRunResult> {
    if (roles[request.role] !== request.expectedOutputKind) throw new Error("Role and output kind mismatch");
    if (!/^[a-z0-9][a-z0-9.-]{1,80}$/.test(request.modelId)) throw new Error("Invalid model ID");
    if (request.role === "reviewer" && request.modelId !== "gpt-6-luna") throw new Error("Reviewer model mismatch");
    if (request.role !== "reviewer" && request.modelId !== "gpt-6-sol") throw new Error("Author/applier model mismatch");
    const prompt = request.contextText + (request.expectedOutputKind === "candidate" ? authorTransportInstruction : "");
    if (Buffer.byteLength(prompt) > MAX_CONTEXT_BYTES) throw new Error("Context limit exceeded");
    if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 180_000) throw new Error("Invalid model timeout");
    if (hooks.signal.aborted) throw new Error("Codex run aborted");
    const deadline = Date.now() + request.timeoutMs;
    await this.verifyCli(hooks.signal, deadline);
    if (hooks.signal.aborted || Date.now() >= deadline) throw new Error("Codex run aborted or timed out");
    const dir = await mkdtemp(path.join(os.tmpdir(), "two-model-codex-"));
    const schemaPath = path.join(dir, "response.schema.json");
    try {
      const schema = providerSchema(request.expectedOutputKind);
      await writeFile(schemaPath, JSON.stringify(schema), { flag: "wx", mode: 0o600 });
      return await this.execute(request, hooks, dir, schemaPath, deadline, prompt);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }

  private async execute(request: CodexRunRequest, hooks: CodexRunHooks, cwd: string, schemaPath: string, deadline: number, prompt: string): Promise<CodexRunResult> {
    const args = ["exec", "--model", request.modelId, "--json", "--output-schema", schemaPath,
      "--ephemeral", "--ignore-user-config", "--strict-config"];
    for (const feature of DISABLED) args.push("--disable", feature);
    args.push("--config", 'web_search="disabled"', "--sandbox", "read-only", "--skip-git-repo-check", "-C", cwd, "-");
    const child = spawn(this.binary, args, { detached: true, stdio: ["pipe", "pipe", "pipe"], cwd, env: process.env });
    let raw = "";
    let stderrBytes = 0;
    let completed = false;
    let started = false;
    let output: CodexOutput | null = null;
    let failure: Error | null = null;
    let observationQueue = Promise.resolve();
    const emit = (name: string, stage: ProcessObservation["stage"], detail: string | null = null) => {
      observationQueue = observationQueue.then(() => hooks.onObservation(observed("codex-cli", name, stage, detail))).catch(() => fail("Observation persistence failed"));
    };
    const fail = (message: string) => { failure ??= new Error(message); killGroup(child.pid); };
    const abort = () => fail("Codex run aborted");
    const timer = setTimeout(() => fail("Codex run timed out"), Math.max(1, deadline - Date.now()));
    hooks.signal.addEventListener("abort", abort, { once: true });
    child.once("spawn", () => emit("process_spawned", "local_started"));
    child.once("error", (error) => fail(`Codex process error: ${error.message}`));
    child.stdin.on("error", () => fail("Codex stdin closed early"));
    try { child.stdin.end(prompt); } catch { fail("Codex stdin write failed"); }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > MAX_STDERR_BYTES) fail("Codex stderr limit exceeded");
    });
    const handleLine = (line: string) => {
      if (!line) return;
      if (Buffer.byteLength(line) > MAX_EVENT_BYTES) return fail("Codex event limit exceeded");
      let event: Record<string, unknown>;
      try { event = JSON.parse(line) as Record<string, unknown>; } catch { return fail("Invalid Codex JSONL event"); }
      if (event.type === "thread.started") return;
      if (event.type === "turn.started") { started = true; emit("turn_started", "response_started"); return; }
      if (event.type === "turn.completed") { completed = true; return; }
      if (event.type === "error") return fail(`Codex provider error: ${providerDiagnostic(event.message)}`);
      if (event.type === "turn.failed") return fail(`Codex turn failed: ${providerDiagnostic((event.error as { message?: unknown } | undefined)?.message)}`);
      if (event.type === "item.completed") {
        const item = event.item as Record<string, unknown> | undefined;
        if (item?.type === "error" && typeof item.message === "string" && item.message.startsWith("Code Mode is unavailable because code-mode host is disabled.")) return;
        if (item?.type !== "agent_message" || typeof item.text !== "string") return fail("Unexpected Codex tool or item event");
        if (Buffer.byteLength(item.text) > MAX_OUTPUT_BYTES) return fail("Codex output limit exceeded");
        let parsed: unknown;
        try { parsed = JSON.parse(item.text); }
        catch { emit("agent_progress", "process_event"); return; }
        if (!transportSchemas[request.expectedOutputKind].safeParse(parsed).success) { emit("agent_progress", "process_event"); return; }
        if (output !== null) return fail("Multiple structured Codex responses");
        try { output = normalizeOutput(request.expectedOutputKind, parsed); }
        catch (error) {
          const reason = error instanceof z.ZodError ? error.issues.map((issue) => `${issue.path.join(".")}:${issue.code}`).join(",") : error instanceof SyntaxError ? "invalid casesJson" : "unknown";
          return fail(`Invalid structured Codex response (${reason.slice(0, 300)})`);
        }
        return;
      }
      fail(`Unexpected Codex event: ${String(event.type)}`);
    };
    child.stdout.on("data", (chunk: string) => {
      raw += chunk;
      if (Buffer.byteLength(raw) > MAX_EVENT_BYTES) return fail("Codex stdout limit exceeded");
      let index: number;
      while ((index = raw.indexOf("\n")) !== -1) {
        const line = raw.slice(0, index);
        raw = raw.slice(index + 1);
        handleLine(line);
      }
    });
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
    clearTimeout(timer);
    hooks.signal.removeEventListener("abort", abort);
    emit("process_closed", "process_exited", exit.signal ?? String(exit.code));
    await observationQueue;
    if (raw.trim()) throw new Error("Truncated Codex JSONL event");
    if (failure) throw failure;
    if (exit.code !== 0 || !started || !completed || !output) throw new Error(`Incomplete Codex run (exit ${exit.code})`);
    return { output, modelId: request.modelId, responseAt: new Date().toISOString() };
  }
}
