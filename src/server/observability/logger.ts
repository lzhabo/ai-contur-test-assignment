import { lstat, mkdir, open, rename } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import type { TaskState } from "../../shared/contracts.js";

// These fields are deliberately enumerated. Never serialize a TaskState, model
// response, prompt, code, diagnostics, error message, or HTTP request into logs.
export function stateSummary(state: TaskState | null | undefined) {
  if (!state) return null;
  return {
    phase: state.phase,
    usedModelCalls: state.usedModelCalls,
    createdVersions: state.createdVersions,
    versionId: state.currentArtifact?.versionId ?? null,
    manifestHash: state.currentArtifact?.manifestHash ?? null,
    reviewVerdict: state.latestReview?.verdict ?? null,
    compilationStatus: state.latestChecks?.compilation.status ?? null,
    testStatus: state.latestChecks?.tests.status ?? null,
    approvalDecision: state.approval?.decision ?? null,
    approvalId: state.approval?.decisionId ?? null,
    activeAttemptId: state.activeAttempt?.attemptId ?? null,
    activeAttemptRole: state.activeAttempt?.role ?? null,
    activeAttemptStatus: state.activeAttempt?.status ?? null,
    lastAttemptId: state.lastAttempt?.attemptId ?? null,
    lastAttemptStatus: state.lastAttempt?.status ?? null,
    resultPublished: state.resultPath !== null,
  };
}

export type StateSummary = NonNullable<ReturnType<typeof stateSummary>>;
export function changedFields(before: StateSummary | null, after: StateSummary | null): string[] {
  if (!after) return [];
  return (Object.keys(after) as Array<keyof StateSummary>).filter(key => before?.[key] !== after[key]);
}

export function safeErrorClass(error: unknown): string {
  const name = error instanceof Error ? error.name : "UnknownError";
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : "UnknownError";
}

export interface LogEvent {
  event: string;
  taskId?: string | null;
  attemptId?: string | null;
  node?: string | null;
  checkpointId?: string | null;
  parentCheckpointId?: string | null;
  source?: string;
  executionMode?: "real" | "mock";
  before?: StateSummary | null;
  after?: StateSummary | null;
  changed?: string[];
  errorClass?: string;
  [key: string]: unknown;
}

export interface ObservabilityLogger {
  record(event: LogEvent): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export const noOpLogger: ObservabilityLogger = {
  async record() {}, async flush() {}, async close() {},
};

export function bestEffortLogger(logger: ObservabilityLogger): ObservabilityLogger {
  return {
    async record(event) { try { await logger.record(event); } catch { /* logging cannot govern workflow */ } },
    async flush() { try { await logger.flush(); } catch { /* logging cannot govern workflow */ } },
    async close() { try { await logger.close(); } catch { /* logging cannot govern workflow */ } },
  };
}

export interface LoggerOptions {
  maxBytes?: number;
  writeStdout?: (line: string) => void;
  writeError?: (line: string) => void;
}

export async function createStructuredLogger(dataDir: string, options: LoggerOptions = {}): Promise<ObservabilityLogger> {
  const root = resolve(dataDir);
  await mkdir(root, { recursive: true });
  const file = join(root, "server-events.jsonl");
  const rotated = `${file}.1`;
  const maxBytes = Math.max(4096, options.maxBytes ?? 5 * 1024 * 1024);
  let queue: Promise<void> = Promise.resolve();
  let closed = false;
  let fileBytes = 0;
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe log file");
    fileBytes = info.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const writeStdout = options.writeStdout ?? (line => process.stdout.write(line));
  const writeError = options.writeError ?? (line => process.stderr.write(line));
  async function write(line: string): Promise<void> {
    try { writeStdout(line); } catch { /* file remains available */ }
    try {
      // Refuse a replaced symlink before either append or rotation.
      try { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe log file"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (fileBytes + Buffer.byteLength(line) > maxBytes) {
        try { const prior = await lstat(rotated); if (!prior.isFile() || prior.isSymbolicLink()) throw new Error("Unsafe rotated log file"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        try { await rename(file, rotated); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        fileBytes = 0;
      }
      const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(line); fileBytes = (await handle.stat()).size; }
      finally { await handle.close(); }
    } catch {
      // Observability must never turn a persisted checkpoint into a failed run.
      try { writeError(JSON.stringify({ at: new Date().toISOString(), event: "log_write_failed", errorClass: "FileWriteError" }) + "\n"); } catch { /* no safe sink */ }
    }
  }
  return {
    record(event) {
      if (closed) return Promise.resolve();
      // Only callers' fixed fields reach here; cap records in case a future
      // caller accidentally adds an unbounded identifier or array.
      const line = JSON.stringify({ at: new Date().toISOString(), ...event });
      const bounded = Buffer.byteLength(line) <= 8192 ? line : JSON.stringify({ at: new Date().toISOString(), event: "log_record_oversize", taskId: event.taskId ?? null });
      queue = queue.then(() => write(bounded + "\n"), () => write(bounded + "\n"));
      return queue;
    },
    flush: () => queue,
    async close() { closed = true; await queue; },
  };
}
