import { z } from "zod";
import { AgentRoleSchema, TaskPhaseSchema } from "../../shared/api.js";

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(
  /* Рекурсивно описывает JSON-значения, разрешённые в аргументах и результатах тестов. */ () =>
    z.union([
      z.null(),
      z.boolean(),
      z.number(),
      z.string(),
      z.array(JsonValueSchema),
      z.record(z.string(), JsonValueSchema),
    ]),
);

export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const ArtifactPathSchema = z.enum(["solution.ts", "solution.test.ts"]);
export const ArtifactFileRefSchema = z.object({
  artifactId: z.string().min(1),
  path: ArtifactPathSchema,
  sha256: Sha256Schema,
  bytes: z.number().int().nonnegative(),
});
export type ArtifactFileRef = z.infer<typeof ArtifactFileRefSchema>;
export const ArtifactRefSchema = z.object({
  taskId: z.string().min(1),
  versionId: z.string().min(1),
  manifestHash: Sha256Schema,
  files: z.array(ArtifactFileRefSchema).length(2),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

export const TestCaseSchema = z.object({
  name: z.string().min(1),
  args: z.array(JsonValueSchema),
  expected: JsonValueSchema,
});
export type TestCase = z.infer<typeof TestCaseSchema>;

export const AuthorOutputSchema = z.object({
  kind: z.literal("candidate"),
  functionName: z.string().regex(/^[A-Za-z_$][\w$]*$/),
  solutionTs: z.string().min(1),
  cases: z.array(TestCaseSchema).min(1),
});
export type AuthorOutput = z.infer<typeof AuthorOutputSchema>;
export const ReviewSchema = z.object({
  reviewId: z.string().min(1),
  versionId: z.string().min(1),
  manifestHash: Sha256Schema,
  verdict: z.enum(["approved", "changes_requested"]),
  findings: z.array(z.string()),
  at: z.iso.datetime(),
});
export type Review = z.infer<typeof ReviewSchema>;
export const ReviewerOutputSchema = z.object({
  kind: z.literal("review"),
  verdict: z.enum(["approved", "changes_requested"]),
  findings: z.array(z.string()),
});
export type ReviewerOutput = z.infer<typeof ReviewerOutputSchema>;
export const ApplierOutputSchema = z.object({
  kind: z.literal("apply_request"),
  versionId: z.string().min(1),
  manifestHash: Sha256Schema,
});
export type ApplierOutput = z.infer<typeof ApplierOutputSchema>;
export const CodexOutputSchema = z.discriminatedUnion("kind", [
  AuthorOutputSchema,
  ReviewerOutputSchema,
  ApplierOutputSchema,
]);
export type CodexOutput = z.infer<typeof CodexOutputSchema>;

export const CheckStepSchema = z.object({
  status: z.enum(["passed", "failed", "timeout", "error"]),
  details: z.array(z.string()),
});
export const CheckResultSchema = z.object({
  versionId: z.string().min(1),
  manifestHash: Sha256Schema,
  compilation: CheckStepSchema,
  tests: CheckStepSchema,
  passedCases: z.number().int().nonnegative(),
  failedCases: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  at: z.iso.datetime(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

export const ProcessObservationSchema = z.object({
  at: z.iso.datetime(),
  source: z.string().min(1),
  name: z.string().min(1),
  stage: z.enum(["local_started", "process_event", "response_started", "process_exited"]),
  detail: z.string().nullable(),
});
export type ProcessObservation = z.infer<typeof ProcessObservationSchema>;
export const AttemptSchema = z.object({
  attemptId: z.string().min(1),
  role: AgentRoleSchema,
  modelId: z.string().min(1),
  inputVersionId: z.string().nullable(),
  status: z.enum(["reserved", "running", "completed", "failed", "cancelled", "unknown"]),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  observations: z.array(ProcessObservationSchema),
  error: z.string().nullable(),
});
export type Attempt = z.infer<typeof AttemptSchema>;

export const ApprovalSchema = z.object({
  decisionId: z.string().min(1),
  decision: z.enum(["approve", "reject"]),
  versionId: z.string().min(1),
  manifestHash: Sha256Schema,
  at: z.iso.datetime(),
});
export type Approval = z.infer<typeof ApprovalSchema>;

export const RuntimeLimitsSchema = z.object({
  maxVersions: z.number().int().positive(),
  maxModelCalls: z.number().int().positive(),
  modelTimeoutMs: z.number().int().positive(),
  modelWarningMs: z.number().int().positive(),
  maxContextBytes: z.number().int().positive(),
  checkTimeoutMs: z.number().int().positive(),
  checkMemoryBytes: z.number().int().positive(),
});
export type RuntimeLimits = z.infer<typeof RuntimeLimitsSchema>;

export const TaskStateSchema = z.object({
  schemaVersion: z.literal(1),
  taskId: z.string().min(1),
  taskText: z.string().min(1),
  executionMode: z.enum(["real", "mock"]),
  models: z.object({
    author: z.string().min(1),
    reviewer: z.string().min(1),
    applier: z.string().min(1),
  }),
  phase: TaskPhaseSchema,
  currentArtifact: ArtifactRefSchema.nullable(),
  latestReview: ReviewSchema.nullable(),
  latestChecks: CheckResultSchema.nullable(),
  approval: ApprovalSchema.nullable(),
  limits: RuntimeLimitsSchema,
  usedModelCalls: z.number().int().nonnegative(),
  createdVersions: z.number().int().nonnegative(),
  activeAttempt: AttemptSchema.nullable(),
  lastAttempt: AttemptSchema.nullable(),
  stopReason: z.string().nullable(),
  resultPath: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  lastEventSequence: z.number().int().nonnegative(),
});
export type TaskState = z.infer<typeof TaskStateSchema>;
