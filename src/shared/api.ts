import { z } from "zod";
import { MAX_TASK_CHARS } from "./limits.js";

export const TaskPhaseSchema = z.enum([
  "preparing",
  "author",
  "checking",
  "review",
  "awaiting_approval",
  "awaiting_auth",
  "applying",
  "completed",
  "stopped",
  "error",
  "unknown_outcome",
]);
export type TaskPhase = z.infer<typeof TaskPhaseSchema>;

export const AgentRoleSchema = z.enum(["author", "reviewer", "applier"]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const TaskSummarySchema = z.object({
  taskId: z.string().min(1),
  title: z.string(),
  phase: TaskPhaseSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  currentVersionId: z.string().nullable(),
  stopReason: z.string().nullable(),
});
export type TaskSummary = z.infer<typeof TaskSummarySchema>;

export const TaskEventSchema = z.object({
  taskId: z.string().min(1),
  sequence: z.number().int().positive(),
  eventId: z.string().min(1),
  at: z.iso.datetime(),
  type: z.enum([
    "task_created",
    "phase_changed",
    "attempt_started",
    "attempt_observed",
    "attempt_finished",
    "message",
    "version_created",
    "checks_finished",
    "review_finished",
    "decision_recorded",
    "publication_finished",
    "task_stopped",
    "task_failed",
    "unknown_outcome",
  ]),
  from: AgentRoleSchema.or(z.literal("system")).or(z.literal("user")).nullable(),
  to: AgentRoleSchema.or(z.literal("system")).or(z.literal("user")).nullable(),
  attemptId: z.string().nullable(),
  text: z.string(),
  artifactVersionId: z.string().nullable(),
  source: z.string().nullable(),
});
export type TaskEvent = z.infer<typeof TaskEventSchema>;

export const ArtifactFileSummarySchema = z.object({
  artifactId: z.string().min(1),
  versionId: z.string().min(1),
  path: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  published: z.boolean(),
});
export type ArtifactFileSummary = z.infer<typeof ArtifactFileSummarySchema>;

export const TaskActionsSchema = z.object({
  canStop: z.boolean(),
  canDecide: z.boolean(),
  canResume: z.boolean(),
  resumeRequiresExplicitRetry: z.boolean(),
});
export type TaskActions = z.infer<typeof TaskActionsSchema>;

export const CheckSummarySchema = z.object({
  versionId: z.string().min(1),
  status: z.enum(["passed", "failed", "timeout", "error"]),
  compilationStatus: z.enum(["passed", "failed", "timeout", "error"]),
  testsStatus: z.enum(["passed", "failed", "timeout", "error"]),
  passedCases: z.number().int().nonnegative(),
  failedCases: z.number().int().nonnegative(),
  diagnostics: z.array(z.string()),
});
export type CheckSummary = z.infer<typeof CheckSummarySchema>;

export const TaskViewStateSchema = z.object({
  taskText: z.string(),
  executionMode: z.enum(["real", "mock"]),
  models: z.object({ author: z.string(), reviewer: z.string(), applier: z.string() }),
  currentVersionId: z.string().nullable(),
  currentManifestHash: z.string().nullable(),
  latestReview: z
    .object({
      verdict: z.enum(["approved", "changes_requested"]),
      findings: z.array(z.string()),
      versionId: z.string(),
    })
    .nullable(),
  latestChecks: CheckSummarySchema.nullable(),
  activeAttempt: z
    .object({
      attemptId: z.string(),
      role: AgentRoleSchema,
      modelId: z.string(),
      startedAt: z.iso.datetime(),
      lastObservedAt: z.iso.datetime().nullable(),
      lastObservedStage: z.string().nullable(),
    })
    .nullable(),
  usedModelCalls: z.number().int().nonnegative(),
  maxModelCalls: z.number().int().positive(),
  createdVersions: z.number().int().nonnegative(),
  maxVersions: z.number().int().positive(),
  resultPath: z.string().nullable(),
});
export type TaskViewState = z.infer<typeof TaskViewStateSchema>;

export const TaskListResponseSchema = z.object({
  tasks: z.array(TaskSummarySchema),
  activeTaskId: z.string().nullable(),
});
export type TaskListResponse = z.infer<typeof TaskListResponseSchema>;

export const TaskSnapshotResponseSchema = z.object({
  task: TaskSummarySchema,
  state: TaskViewStateSchema,
  actions: TaskActionsSchema,
  files: z.array(ArtifactFileSummarySchema),
  events: z.array(TaskEventSchema),
  lastEventSequence: z.number().int().nonnegative(),
});
export type TaskSnapshotResponse = z.infer<typeof TaskSnapshotResponseSchema>;

export const CreateTaskRequestSchema = z.object({
  text: z.string().trim().min(1).max(MAX_TASK_CHARS),
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;
export const CreateTaskResponseSchema = z.object({ taskId: z.string().min(1) });
export type CreateTaskResponse = z.infer<typeof CreateTaskResponseSchema>;

export const DecisionRequestSchema = z.object({
  decisionId: z.string().min(1),
  decision: z.enum(["approve", "reject"]),
  versionId: z.string().min(1),
  manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type DecisionRequest = z.infer<typeof DecisionRequestSchema>;

export const ResumeRequestSchema = z.object({ mode: z.enum(["continue", "retry_unknown"]) });
export type ResumeRequest = z.infer<typeof ResumeRequestSchema>;

export const ApiErrorSchema = z.object({ code: z.string(), message: z.string() });
export type ApiError = z.infer<typeof ApiErrorSchema>;

// SSE uses `id: <sequence>` and a JSON TaskEvent in `data:`.  The browser
// sends Last-Event-ID (or ?after=<sequence>) when reconnecting.
export type TaskEventCursor = number;
