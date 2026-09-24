import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Command } from "@langchain/langgraph";
import { CreateTaskRequestSchema, DecisionRequestSchema, ResumeRequestSchema, TaskSnapshotResponseSchema, type DecisionRequest, type ResumeRequest, type TaskListResponse, type TaskSnapshotResponse, type TaskSummary } from "../../shared/api.js";
import { DEFAULT_LIMITS, DEFAULT_MODELS, ModelAssignmentsSchema, type ModelAssignments } from "../../shared/config.js";
import { ApprovalSchema, RuntimeLimitsSchema, TaskStateSchema, type Approval, type RuntimeLimits, type TaskState } from "../../shared/contracts.js";
import type { TaskRuntimePorts } from "../../shared/ports.js";
import { EventJournal } from "../events/journal.js";
import { acquireDataLock, type DataLock } from "./data-lock.js";
import { createTaskGraph } from "./graph.js";

type NonEventPorts = Omit<TaskRuntimePorts, "events">;
type IndexEntry = { taskId: string; title: string; createdAt: string; idempotencyKey: string | null; text: string };
type Index = { tasks: IndexEntry[] };
const terminal = new Set<TaskState["phase"]>(["completed", "stopped", "error"]);
const externalNodes = new Set(["callAuthor", "callReviewer", "callApplier"]);
const now = () => new Date().toISOString();

export class ServiceError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) { super(message); }
}

export interface AppServiceOptions {
  dataDir: string;
  ports: NonEventPorts;
  models?: ModelAssignments;
  limits?: RuntimeLimits;
  executionMode?: "real" | "fake";
}

export interface AppService {
  readonly events: EventJournal;
  readonly executionMode: "real" | "fake";
  createTask(input: { text: string }, idempotencyKey?: string): Promise<{ taskId: string }>;
  listTasks(): Promise<TaskListResponse>;
  getTask(taskId: string): Promise<TaskSnapshotResponse>;
  decide(taskId: string, input: DecisionRequest): Promise<TaskSnapshotResponse>;
  stop(taskId: string): Promise<TaskSnapshotResponse>;
  resume(taskId: string, input: ResumeRequest): Promise<TaskSnapshotResponse>;
  getFile(taskId: string, artifactId: string): Promise<{ content: string; path: string }>;
  getResultZip(taskId: string): Promise<Uint8Array>;
  close(): Promise<void>;
}

export async function createAppService(options: AppServiceOptions): Promise<AppService> {
  const dataDir = resolve(options.dataDir);
  const lock = await acquireDataLock(dataDir);
  try { return await initializeService(dataDir, lock, options); }
  catch (error) { await lock.release(); throw error; }
}

async function initializeService(dataDir: string, lock: DataLock, options: AppServiceOptions): Promise<AppService> {
  const models = ModelAssignmentsSchema.parse(options.models ?? DEFAULT_MODELS);
  const limits = RuntimeLimitsSchema.parse(options.limits ?? DEFAULT_LIMITS);
  const executionMode = options.executionMode ?? "real";
  const events = new EventJournal(dataDir);
  const ports: TaskRuntimePorts = { ...options.ports, events };
  const activeRuns = new Map<string, Promise<void>>();
  const controllers = new Map<string, AbortController>();
  const stopRequested = new Set<string>();
  const publishing = new Set<string>();
  const pendingDecisions = new Map<string, Approval>();
  let mutationQueue: Promise<void> = Promise.resolve();
  function serializeMutation<T>(action: () => Promise<T>): Promise<T> {
    const result = mutationQueue.then(action);
    mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
  const checkpointPath = join(dataDir, "checkpoints.sqlite");
  const graph = createTaskGraph(checkpointPath, {
    ports,
    registerAbort: (taskId, controller) => controllers.set(taskId, controller),
    clearAbort: (taskId, controller) => { if (controllers.get(taskId) === controller) controllers.delete(taskId); },
    isStopRequested: taskId => stopRequested.has(taskId),
    setPublishing: (taskId, active) => { if (active) publishing.add(taskId); else publishing.delete(taskId); },
  });
  const config = (taskId: string) => ({ configurable: { thread_id: taskId }, durability: "sync" as const });
  const indexPath = join(dataDir, "tasks-index.json");
  let index: Index;
  try { index = JSON.parse(await readFile(indexPath, "utf8")) as Index; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") index = { tasks: [] }; else throw error; }
  if (!Array.isArray(index.tasks)) throw new Error("Invalid task index");

  async function saveIndex(): Promise<void> {
    const temp = `${indexPath}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(index), { mode: 0o600 });
    await rename(temp, indexPath);
  }

  async function stateOf(taskId: string): Promise<{ state: TaskState; next: string[] }> {
    if (!index.tasks.some(task => task.taskId === taskId)) throw new ServiceError(404, "task_not_found", "Задача не найдена.");
    const snapshot = await graph.getState(config(taskId));
    const value = (snapshot.values as { value?: unknown }).value;
    if (!value) throw new ServiceError(503, "checkpoint_missing", "Состояние задачи ещё не сохранено.");
    return { state: TaskStateSchema.parse(value), next: [...snapshot.next] };
  }

  async function ensureCompletedIntegrity(taskId: string, state: TaskState): Promise<TaskState> {
    if (state.phase !== "completed" || !state.currentArtifact) return state;
    try {
      await ports.artifacts.verifyVersion(state.currentArtifact);
      for (const file of state.currentArtifact.files) {
        const result = await ports.artifacts.getFile(taskId, file.artifactId, "result");
        const hash = createHash("sha256").update(result.content).digest("hex");
        if (hash !== file.sha256) throw new Error(`Published file differs from approved version: ${file.path}`);
      }
      return state;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const updated: TaskState = { ...state, phase: "error", stopReason: `Повреждён или отсутствует опубликованный файл: ${message}`, updatedAt: now() };
      await graph.updateState(config(taskId), { value: updated }, "callApplier");
      await events.append({ taskId, eventId: `${taskId}:published-integrity-error`, at: now(), type: "task_failed", from: "system", to: "user", attemptId: null, text: updated.stopReason!, artifactVersionId: state.currentArtifact.versionId, source: "integrity-check" });
      return updated;
    }
  }

  function startRun(taskId: string, input: unknown = null): void {
    if (activeRuns.has(taskId)) return;
    const run = Promise.resolve().then(() => graph.invoke(input as never, config(taskId))).then(() => undefined).catch(async error => {
      const message = error instanceof Error ? error.message : String(error);
      await events.append({ taskId, eventId: `${taskId}:graph-error:${randomUUID()}`, at: now(), type: "task_failed", from: "system", to: null, attemptId: null, text: message, artifactVersionId: null, source: "langgraph" });
    }).finally(() => { activeRuns.delete(taskId); });
    activeRuns.set(taskId, run);
  }

  async function emitDecision(taskId: string, approval: Approval): Promise<void> {
    await events.append({ taskId, eventId: `${taskId}:decision:${approval.decisionId}`, at: approval.at, type: "decision_recorded", from: "user", to: "applier", attemptId: null, text: approval.decision === "approve" ? "Пользователь подтвердил версию." : "Пользователь отклонил версию.", artifactVersionId: approval.versionId, source: "user" });
  }

  async function snapshot(taskId: string): Promise<TaskSnapshotResponse> {
    const loaded = await stateOf(taskId);
    const state = await ensureCompletedIntegrity(taskId, loaded.state);
    const modeMismatch = state.executionMode !== executionMode;
    const entry = index.tasks.find(task => task.taskId === taskId)!;
    const taskEvents = await events.readAfter(taskId, 0);
    const lastObserved = [...taskEvents].reverse().find(event => event.type === "attempt_observed" && event.attemptId === state.activeAttempt?.attemptId);
    const activeAttempt = state.activeAttempt ? {
      attemptId: state.activeAttempt.attemptId, role: state.activeAttempt.role, modelId: state.activeAttempt.modelId,
      startedAt: state.activeAttempt.startedAt, lastObservedAt: lastObserved?.at ?? null, lastObservedStage: lastObserved?.text ?? null,
    } : null;
    const canDecide = !modeMismatch && state.phase === "awaiting_approval" && state.latestReview?.verdict === "approved" && state.latestChecks?.compilation.status === "passed" && state.latestChecks.tests.status === "passed" && !pendingDecisions.has(taskId);
    const files = state.currentArtifact?.files.map(file => ({ ...file, versionId: state.currentArtifact!.versionId, published: state.phase === "completed" })) ?? [];
    const check = state.latestChecks;
    const checkStatus = check ? check.compilation.status !== "passed" ? check.compilation.status : check.tests.status : null;
    const summary: TaskSummary = { taskId, title: entry.title, phase: state.phase, createdAt: state.createdAt, updatedAt: state.updatedAt, currentVersionId: state.currentArtifact?.versionId ?? null, stopReason: modeMismatch && !terminal.has(state.phase) ? `Задача сохранена в режиме ${state.executionMode}; текущий сервер запущен в режиме ${executionMode}. Для продолжения вернитесь к исходному режиму.` : state.stopReason };
    return TaskSnapshotResponseSchema.parse({
      task: summary,
      state: {
        taskText: state.taskText, executionMode: state.executionMode, models: state.models,
        currentVersionId: state.currentArtifact?.versionId ?? null, currentManifestHash: state.currentArtifact?.manifestHash ?? null,
        latestReview: state.latestReview ? { verdict: state.latestReview.verdict, findings: state.latestReview.findings, versionId: state.latestReview.versionId } : null,
        latestChecks: check ? { versionId: check.versionId, status: checkStatus, compilationStatus: check.compilation.status, testsStatus: check.tests.status, passedCases: check.passedCases, failedCases: check.failedCases, diagnostics: [...check.compilation.details, ...check.tests.details] } : null,
        activeAttempt, usedModelCalls: state.usedModelCalls, maxModelCalls: state.limits.maxModelCalls, createdVersions: state.createdVersions, maxVersions: state.limits.maxVersions, resultPath: state.resultPath,
      },
      actions: { canStop: !terminal.has(state.phase), canDecide, canResume: state.phase === "unknown_outcome" && !modeMismatch, resumeRequiresExplicitRetry: state.phase === "unknown_outcome" },
      files, events: taskEvents, lastEventSequence: taskEvents.at(-1)?.sequence ?? 0,
    });
  }

  async function listTasks(): Promise<TaskListResponse> {
    const tasks: TaskSummary[] = [];
    let activeTaskId: string | null = null;
    for (const entry of index.tasks) {
      const loaded = await stateOf(entry.taskId);
      const state = await ensureCompletedIntegrity(entry.taskId, loaded.state);
      const modeMismatch = state.executionMode !== executionMode;
      tasks.push({ taskId: entry.taskId, title: entry.title, phase: state.phase, createdAt: state.createdAt, updatedAt: state.updatedAt, currentVersionId: state.currentArtifact?.versionId ?? null, stopReason: modeMismatch && !terminal.has(state.phase) ? `Задача сохранена в режиме ${state.executionMode}; текущий сервер запущен в режиме ${executionMode}.` : state.stopReason });
      if (!terminal.has(state.phase)) activeTaskId = entry.taskId;
    }
    return { tasks: tasks.reverse(), activeTaskId };
  }

  async function createTaskInternal(input: { text: string }, idempotencyKey?: string): Promise<{ taskId: string }> {
    const parsed = CreateTaskRequestSchema.parse(input);
    if (idempotencyKey) {
      const previous = index.tasks.find(task => task.idempotencyKey === idempotencyKey);
      if (previous) {
        if (previous.text !== parsed.text) throw new ServiceError(409, "idempotency_conflict", "Ключ повторного запроса уже использован с другим заданием.");
        return { taskId: previous.taskId };
      }
    }
    if ((await listTasks()).activeTaskId) throw new ServiceError(409, "active_task", "Сначала завершите текущую задачу.");
    const taskId = randomUUID();
    const createdAt = now();
    const initial = TaskStateSchema.parse({
      schemaVersion: 1, taskId, taskText: parsed.text, executionMode, models, phase: "preparing", currentArtifact: null, latestReview: null, latestChecks: null, approval: null,
      limits, usedModelCalls: 0, createdVersions: 0, activeAttempt: null, lastAttempt: null, stopReason: null, resultPath: null, createdAt, updatedAt: createdAt, lastEventSequence: 0,
    });
    await mkdir(join(dataDir, "tasks", taskId), { recursive: true });
    await graph.invoke({ value: initial }, { ...config(taskId), interruptBefore: ["prepareAuthor"] });
    index.tasks.push({ taskId, title: parsed.text.slice(0, 80), createdAt, idempotencyKey: idempotencyKey ?? null, text: parsed.text });
    await saveIndex();
    await events.append({ taskId, eventId: `${taskId}:created`, at: createdAt, type: "task_created", from: "user", to: "author", attemptId: null, text: "Задача создана.", artifactVersionId: null, source: "user" });
    startRun(taskId);
    return { taskId };
  }
  const createTask = (input: { text: string }, idempotencyKey?: string) => serializeMutation(() => createTaskInternal(input, idempotencyKey));

  async function decideInternal(taskId: string, input: DecisionRequest): Promise<TaskSnapshotResponse> {
    const parsed = DecisionRequestSchema.parse(input);
    const { state } = await stateOf(taskId);
    if (state.executionMode !== executionMode) throw new ServiceError(409, "mode_mismatch", "Режим сохранённой задачи отличается от текущего режима сервера.");
    const pending = pendingDecisions.get(taskId);
    if (pending && pending.decisionId === parsed.decisionId && pending.decision === parsed.decision && pending.versionId === parsed.versionId && pending.manifestHash === parsed.manifestHash) return snapshot(taskId);
    if (state.approval && state.approval.decisionId === parsed.decisionId && state.approval.decision === parsed.decision && state.approval.versionId === parsed.versionId && state.approval.manifestHash === parsed.manifestHash) return snapshot(taskId);
    if (state.phase !== "awaiting_approval" || !state.currentArtifact || !state.latestReview || state.latestReview.verdict !== "approved") throw new ServiceError(409, "decision_not_allowed", "Задача не ожидает решения по одобренной версии.");
    if (parsed.versionId !== state.currentArtifact.versionId || parsed.manifestHash !== state.currentArtifact.manifestHash || parsed.manifestHash !== state.latestReview.manifestHash) throw new ServiceError(409, "stale_version", "Показанная версия изменилась; обновите задачу.");
    if (pending) throw new ServiceError(409, "decision_pending", "Решение уже обрабатывается.");
    await ports.artifacts.verifyVersion(state.currentArtifact);
    const approval = ApprovalSchema.parse({ ...parsed, at: now() });
    pendingDecisions.set(taskId, approval);
    await emitDecision(taskId, approval);
    const run = graph.invoke(new Command({ resume: approval }), config(taskId)).then(() => undefined).finally(() => { pendingDecisions.delete(taskId); activeRuns.delete(taskId); });
    activeRuns.set(taskId, run);
    void run.catch(() => undefined);
    return snapshot(taskId);
  }
  const decide = (taskId: string, input: DecisionRequest) => serializeMutation(() => decideInternal(taskId, input));

  async function stopInternal(taskId: string): Promise<TaskSnapshotResponse> {
    const { state, next } = await stateOf(taskId);
    if (terminal.has(state.phase)) return snapshot(taskId);
    stopRequested.add(taskId);
    controllers.get(taskId)?.abort();
    const run = activeRuns.get(taskId);
    if (run) {
      if (publishing.has(taskId)) await run.catch(() => undefined);
      else await Promise.race([run.catch(() => undefined), new Promise(resolve => setTimeout(resolve, 5_000))]);
    }
    const after = await stateOf(taskId);
    if (!terminal.has(after.state.phase)) {
      const updated: TaskState = { ...after.state, phase: "stopped", stopReason: "Остановлено пользователем.", activeAttempt: null, updatedAt: now() };
      await graph.updateState(config(taskId), { value: updated }, after.next[0] ?? next[0] ?? "waitApproval");
      await events.append({ taskId, eventId: `${taskId}:user-stopped`, at: now(), type: "task_stopped", from: "user", to: null, attemptId: state.activeAttempt?.attemptId ?? null, text: "Задача остановлена пользователем.", artifactVersionId: state.currentArtifact?.versionId ?? null, source: "user" });
    }
    return snapshot(taskId);
  }
  const stop = (taskId: string) => serializeMutation(() => stopInternal(taskId));

  async function resumeInternal(taskId: string, input: ResumeRequest): Promise<TaskSnapshotResponse> {
    const parsed = ResumeRequestSchema.parse(input);
    const { state } = await stateOf(taskId);
    if (state.executionMode !== executionMode) throw new ServiceError(409, "mode_mismatch", "Режим сохранённой задачи отличается от текущего режима сервера.");
    if (state.phase !== "unknown_outcome" || parsed.mode !== "retry_unknown") throw new ServiceError(409, "resume_not_allowed", "Нужен явный повтор неизвестного вызова.");
    if (activeRuns.has(taskId)) throw new ServiceError(409, "task_running", "Задача ещё выполняется.");
    startRun(taskId, new Command({ resume: { retry: true } }));
    return snapshot(taskId);
  }
  const resume = (taskId: string, input: ResumeRequest) => serializeMutation(() => resumeInternal(taskId, input));

  async function getFile(taskId: string, artifactId: string): Promise<{ content: string; path: string }> {
    const { state } = await stateOf(taskId);
    const ref = state.currentArtifact;
    const file = ref?.files.find(item => item.artifactId === artifactId);
    if (!ref || !file) throw new ServiceError(404, "artifact_not_found", "Файл не найден в текущей версии задачи.");
    await ports.artifacts.verifyVersion(ref);
    const result = await ports.artifacts.getFile(taskId, artifactId, state.phase === "completed" ? "result" : "revision");
    if (result.metadata.artifactId !== file.artifactId || result.metadata.path !== file.path || result.metadata.sha256 !== file.sha256 || result.metadata.bytes !== file.bytes || createHash("sha256").update(result.content).digest("hex") !== file.sha256 || Buffer.byteLength(result.content) !== file.bytes) {
      throw new ServiceError(409, "artifact_changed", "Файл не совпадает с сохранённой одобренной версией.");
    }
    return { content: result.content, path: result.metadata.path };
  }

  async function getResultZip(taskId: string): Promise<Uint8Array> {
    const { state } = await stateOf(taskId);
    if (state.phase !== "completed" || !state.currentArtifact || !state.approval || state.approval.decision !== "approve") throw new ServiceError(404, "result_unavailable", "Подтверждённый результат пока недоступен.");
    await ports.artifacts.verifyVersion(state.currentArtifact);
    return ports.artifacts.getResultZip(taskId, state.currentArtifact);
  }

  async function close(): Promise<void> {
    for (const controller of controllers.values()) controller.abort();
    await Promise.allSettled([...activeRuns.values()]);
    await lock.release();
  }

  // Persist an explicit unknown state before serving recovered tasks. `updateState`
  // skips the pending external node and routes only into the pure interrupt.
  for (const entry of index.tasks) {
    const { state, next } = await stateOf(entry.taskId);
    const pendingNode = next[0];
    // A different adapter mode may inspect history, but must never continue a
    // pending real task with fake output (or the reverse).
    if (state.executionMode !== executionMode) continue;
    if (pendingNode === "callApplier" && state.activeAttempt && state.currentArtifact && state.approval?.decision === "approve") {
      const resultPath = join(dataDir, "tasks", entry.taskId, "result");
      let resultExists = false;
      try { await lstat(resultPath); resultExists = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (resultExists) {
        try {
          await ports.artifacts.verifyVersion(state.currentArtifact);
          await ports.artifacts.getResultZip(entry.taskId, state.currentArtifact);
          const completedAttempt = { ...state.activeAttempt, status: "completed" as const, endedAt: now() };
          const completed: TaskState = { ...state, phase: "completed", resultPath, activeAttempt: null, lastAttempt: completedAttempt, updatedAt: now() };
          await graph.updateState(config(entry.taskId), { value: completed }, "callApplier");
          await events.append({ taskId: entry.taskId, eventId: `${entry.taskId}:${completedAttempt.attemptId}:published`, at: now(), type: "publication_finished", from: "applier", to: "user", attemptId: completedAttempt.attemptId, text: "Одобренная версия восстановлена по опубликованным файлам.", artifactVersionId: state.currentArtifact.versionId, source: "recovery" });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          const failedAttempt = { ...state.activeAttempt, status: "failed" as const, endedAt: now(), error: reason };
          const broken: TaskState = { ...state, phase: "error", stopReason: `Опубликованный результат повреждён после сбоя: ${reason}`, activeAttempt: null, lastAttempt: failedAttempt, updatedAt: now() };
          await graph.updateState(config(entry.taskId), { value: broken }, "callApplier");
          await events.append({ taskId: entry.taskId, eventId: `${entry.taskId}:${failedAttempt.attemptId}:published-corrupt`, at: now(), type: "task_failed", from: "system", to: "user", attemptId: failedAttempt.attemptId, text: broken.stopReason!, artifactVersionId: state.currentArtifact.versionId, source: "recovery" });
        }
        continue;
      }
    }
    if (pendingNode && externalNodes.has(pendingNode) && state.activeAttempt) {
      const lastAttempt = { ...state.activeAttempt, status: "unknown" as const, endedAt: now(), error: "Backend stopped before the external call outcome was checkpointed." };
      const unknown: TaskState = { ...state, phase: "unknown_outcome", stopReason: "Исход внешнего вызова после перезапуска неизвестен.", activeAttempt: null, lastAttempt, updatedAt: now() };
      await graph.updateState(config(entry.taskId), { value: unknown }, pendingNode);
      await events.append({ taskId: entry.taskId, eventId: `${entry.taskId}:${lastAttempt.attemptId}:recovered-unknown`, at: now(), type: "unknown_outcome", from: "system", to: "user", attemptId: lastAttempt.attemptId, text: unknown.stopReason!, artifactVersionId: state.currentArtifact?.versionId ?? null, source: "checkpoint" });
      await graph.invoke(null, config(entry.taskId));
    } else if (pendingNode && pendingNode !== "waitApproval" && pendingNode !== "pauseUnknown" && !terminal.has(state.phase)) {
      startRun(entry.taskId);
    }
  }

  return { events, executionMode, createTask, listTasks, getTask: snapshot, decide, stop, resume, getFile, getResultZip, close };
}
