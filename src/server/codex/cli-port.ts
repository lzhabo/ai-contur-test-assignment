import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { CodexReadiness } from "../../shared/connections.js";
import { inspectCli, killGroup } from "./cli-readiness.js";
import { providerFailure } from "./connection-error.js";
import { SupportedModelSchema } from "./models.js";
import type { CodexPort, CodexRunHooks, CodexRunRequest, CodexRunResult } from "../tasks/ports.js";
import {
  ApplierOutputSchema,
  AuthorOutputSchema,
  ReviewerOutputSchema,
  type CodexOutput,
  type ProcessObservation,
} from "../tasks/types.js";

const MAX_CONTEXT_BYTES = 96 * 1024;
const MAX_EVENT_BYTES = 512 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const DISABLED = [
  "shell_tool",
  "unified_exec",
  "view_image",
  "apps",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "image_generation",
  "code_mode_host",
  "plugins",
  "remote_plugin",
  "multi_agent",
  "skill_search",
  "workspace_dependencies",
  "in_app_browser",
] as const;
const transportSchemas = {
  candidate: AuthorOutputSchema,
  review: z.object({
    kind: z.literal("review"),
    verdict: z.enum(["approved", "changes_requested"]),
    findings: z.array(z.string()),
  }),
  apply_request: z.object({
    kind: z.literal("apply_request"),
    versionId: z.string(),
    manifestHash: z.string(),
  }),
};
const roles = { author: "candidate", reviewer: "review", applier: "apply_request" } as const;
const authorTransportInstruction =
  "\n\nReturn solutionTs with an exported TypeScript function and cases as a JSON array of {name,args,expected} objects. Do not use markdown fences.";

/** Строит JSON-схему ответа в формате, поддерживаемом закреплённой версией Codex CLI. */
function providerSchema(kind: CodexRunRequest["expectedOutputKind"]): object {
  const schema = z.toJSONSchema(transportSchemas[kind]) as Record<string, unknown>;
  // Codex 0.156.1 rejects `propertyNames` emitted for z.record; JSON object
  // keys are strings already, and the shared Zod schema validates the result.
  /** Удаляет неподдерживаемое ограничение propertyNames из вложенных схем. */
  function removeUnsupported(node: unknown): void {
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    delete record.propertyNames;
    for (const value of Object.values(record)) removeUnsupported(value);
  }
  removeUnsupported(schema);
  return schema;
}

/** Проверяет ответ Codex схемой соответствующей роли. */
function normalizeOutput(kind: CodexRunRequest["expectedOutputKind"], value: unknown): CodexOutput {
  if (kind === "candidate") return AuthorOutputSchema.parse(value);
  if (kind === "review") return ReviewerOutputSchema.parse(value);
  return ApplierOutputSchema.parse(value);
}

/** Создаёт наблюдение с явным источником и стадией локального процесса. */
function observed(
  source: string,
  name: string,
  stage: ProcessObservation["stage"],
  detail: string | null = null,
): ProcessObservation {
  return { at: new Date().toISOString(), source, name, stage, detail };
}

export class CodexCliPort implements CodexPort {
  /** Сохраняет путь к локальному Codex CLI, использующему текущую авторизацию. */
  constructor(private readonly binary = "/opt/homebrew/bin/codex") {}

  /** Возвращает состояние локальных соединений без облачного вызова. */
  async checkReadiness(): Promise<CodexReadiness> {
    return (await inspectCli(this.binary, new AbortController().signal, Date.now() + 5000))
      .readiness;
  }

  /** Проверяет запрос и запускает Codex в отдельной временной папке, затем удаляет её. */
  async run(request: CodexRunRequest, hooks: CodexRunHooks): Promise<CodexRunResult> {
    if (roles[request.role] !== request.expectedOutputKind)
      throw new Error("Role and output kind mismatch");
    if (!SupportedModelSchema.safeParse(request.modelId).success)
      throw new Error(`Unsupported model ID: ${request.modelId}`);
    const prompt =
      request.contextText +
      (request.expectedOutputKind === "candidate" ? authorTransportInstruction : "");
    if (Buffer.byteLength(prompt) > MAX_CONTEXT_BYTES) throw new Error("Context limit exceeded");
    if (
      !Number.isInteger(request.timeoutMs) ||
      request.timeoutMs < 1 ||
      request.timeoutMs > 180_000
    )
      throw new Error("Invalid model timeout");
    if (hooks.signal.aborted) throw new Error("Codex run aborted");
    const deadline = Date.now() + request.timeoutMs;
    const { error } = await inspectCli(this.binary, hooks.signal, deadline);
    if (error) throw error;
    if (hooks.signal.aborted || Date.now() >= deadline)
      throw new Error("Codex run aborted or timed out");
    const dir = await mkdtemp(path.join(os.tmpdir(), "kontur-codex-"));
    const schemaPath = path.join(dir, "response.schema.json");
    try {
      const schema = providerSchema(request.expectedOutputKind);
      await writeFile(schemaPath, JSON.stringify(schema), { flag: "wx", mode: 0o600 });
      return await this.execute(request, hooks, dir, schemaPath, deadline, prompt);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Выполняет один вызов Codex, разбирает поток JSONL и контролирует завершение и лимиты. */
  private async execute(
    request: CodexRunRequest,
    hooks: CodexRunHooks,
    cwd: string,
    schemaPath: string,
    deadline: number,
    prompt: string,
  ): Promise<CodexRunResult> {
    const args = [
      "exec",
      "--model",
      request.modelId,
      "--json",
      "--output-schema",
      schemaPath,
      "--ephemeral",
      "--ignore-user-config",
      "--strict-config",
    ];
    for (const feature of DISABLED) args.push("--disable", feature);
    args.push(
      "--config",
      'web_search="disabled"',
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "-C",
      cwd,
      "-",
    );
    const child = spawn(this.binary, args, {
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
      env: process.env,
    });
    let raw = "";
    let stderrBytes = 0;
    let completed = false;
    let started = false;
    let output: CodexOutput | null = null;
    let failure: Error | null = null;
    let observationQueue = Promise.resolve();
    const emit = /* Ставит наблюдение процесса в последовательную очередь сохранения. */ (
      name: string,
      stage: ProcessObservation["stage"],
      detail: string | null = null,
    ) => {
      observationQueue = observationQueue
        .then(
          /* Передаёт очередное наблюдение обработчику задачи. */ () =>
            hooks.onObservation(observed("codex-cli", name, stage, detail)),
        )
        .catch(
          /* Останавливает вызов, если наблюдение не удалось сохранить. */ () =>
            fail("Observation persistence failed"),
        );
    };
    const fail = /* Сохраняет первую ошибку вызова и завершает группу процессов Codex. */ (
      message: string | Error,
    ) => {
      failure ??= typeof message === "string" ? new Error(message) : message;
      killGroup(child.pid);
    };
    const abort = /* Отменяет выполняющийся вызов по сигналу задачи. */ () =>
      fail("Codex run aborted");
    const timer = setTimeout(
      /* Останавливает вызов по общему сроку ожидания, сохраняя неизвестность результата. */ () =>
        fail(
          "Codex не завершил запрос за отведённое время. Проверьте сеть и доступность сервиса. Повтор может создать новый вызов модели.",
        ),
      Math.max(1, deadline - Date.now()),
    );
    hooks.signal.addEventListener("abort", abort, { once: true });
    child.once(
      "spawn",
      /* Фиксирует фактический запуск локального процесса. */ () =>
        emit("process_spawned", "local_started"),
    );
    child.once(
      "error",
      /* Не раскрывает окружение процесса при неизвестном исходе вызова. */ () =>
        fail(providerFailure(null)),
    );
    child.stdin.on(
      "error",
      /* Останавливает вызов при преждевременном закрытии входа процесса. */ () =>
        fail("Codex stdin closed early"),
    );
    try {
      child.stdin.end(prompt);
    } catch {
      fail("Codex stdin write failed");
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on(
      "data",
      /* Контролирует объём stderr без сохранения его потенциально чувствительного содержимого. */ (
        chunk: string,
      ) => {
        stderrBytes += Buffer.byteLength(chunk);
        if (stderrBytes > MAX_STDERR_BYTES) fail("Codex stderr limit exceeded");
      },
    );
    const handleLine =
      /* Разбирает одно событие Codex, проверяет протокол и извлекает структурированный ответ. */ (
        line: string,
      ) => {
        if (!line) return;
        if (Buffer.byteLength(line) > MAX_EVENT_BYTES) return fail("Codex event limit exceeded");
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return fail("Invalid Codex JSONL event");
        }
        if (event.type === "thread.started") return;
        if (event.type === "turn.started") {
          started = true;
          emit("turn_started", "response_started");
          return;
        }
        if (event.type === "turn.completed") {
          completed = true;
          return;
        }
        if (event.type === "error") return fail(providerFailure(event.message));
        if (event.type === "turn.failed")
          return fail(providerFailure((event.error as { message?: unknown } | undefined)?.message));
        if (event.type === "item.completed") {
          const item = event.item as Record<string, unknown> | undefined;
          if (
            item?.type === "error" &&
            typeof item.message === "string" &&
            item.message.startsWith("Code Mode is unavailable because code-mode host is disabled.")
          )
            return;
          if (item?.type !== "agent_message" || typeof item.text !== "string")
            return fail("Unexpected Codex tool or item event");
          if (Buffer.byteLength(item.text) > MAX_OUTPUT_BYTES)
            return fail("Codex output limit exceeded");
          let parsed: unknown;
          try {
            parsed = JSON.parse(item.text);
          } catch {
            emit("agent_progress", "process_event");
            return;
          }
          if (!transportSchemas[request.expectedOutputKind].safeParse(parsed).success) {
            emit("agent_progress", "process_event");
            return;
          }
          if (output !== null) return fail("Multiple structured Codex responses");
          try {
            output = normalizeOutput(request.expectedOutputKind, parsed);
          } catch (error) {
            const reason =
              error instanceof z.ZodError
                ? error.issues
                    .map(
                      /* Описывает нарушение схемы через путь и код, не копируя содержимое ответа. */ (
                        issue,
                      ) => `${issue.path.join(".")}:${issue.code}`,
                    )
                    .join(",")
                : "unknown";
            return fail(`Invalid structured Codex response (${reason.slice(0, 300)})`);
          }
          return;
        }
        fail(`Unexpected Codex event: ${String(event.type)}`);
      };
    child.stdout.on(
      "data",
      /* Разбивает stdout на законченные строки событий и ограничивает размер буфера. */ (
        chunk: string,
      ) => {
        raw += chunk;
        if (Buffer.byteLength(raw) > MAX_EVENT_BYTES) return fail("Codex stdout limit exceeded");
        let index: number;
        while ((index = raw.indexOf("\n")) !== -1) {
          const line = raw.slice(0, index);
          raw = raw.slice(index + 1);
          handleLine(line);
        }
      },
    );
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      /* Ожидает завершения процесса Codex после закрытия его потоков. */ (resolve) =>
        child.once(
          "close",
          /* Возвращает код и сигнал завершения дочернего процесса. */ (code, signal) =>
            resolve({ code, signal }),
        ),
    );
    clearTimeout(timer);
    hooks.signal.removeEventListener("abort", abort);
    emit("process_closed", "process_exited", exit.signal ?? String(exit.code));
    await observationQueue;
    if (failure) throw failure;
    if (raw.trim()) throw new Error("Truncated Codex JSONL event");
    if (exit.code !== 0 || !started || !completed || !output) throw providerFailure(null);
    return { output, modelId: request.modelId, responseAt: new Date().toISOString() };
  }
}
