import type { AgentRole, TaskEvent } from "../../shared/api.js";
import type { CodexReadiness } from "../../shared/connections.js";
import type {
  Approval,
  ArtifactFileRef,
  ArtifactRef,
  AuthorOutput,
  CheckResult,
  CodexOutput,
  ProcessObservation,
  Review,
} from "./types.js";

// `contextText` is the complete, bounded input assembled by the graph. Adapters
// must not attach a session history or grant tools/filesystem access implicitly.
export interface CodexRunRequest {
  taskId: string;
  attemptId: string;
  role: AgentRole;
  modelId: string;
  contextText: string;
  expectedOutputKind: CodexOutput["kind"];
  timeoutMs: number;
}

export interface CodexRunHooks {
  signal: AbortSignal;
  // Observable local process events are evidence only of their named source.
  onObservation: (observation: ProcessObservation) => Promise<void>;
}

export interface CodexRunResult {
  output: CodexOutput;
  modelId: string;
  responseAt: string;
}

export interface CodexPort {
  checkReadiness?(): Promise<CodexReadiness>;
  run(request: CodexRunRequest, hooks: CodexRunHooks): Promise<CodexRunResult>;
}

export interface WriteVersionRequest {
  taskId: string;
  candidate: AuthorOutput;
}

export interface PublishedResult {
  taskId: string;
  versionId: string;
  manifestHash: string;
  resultPath: string;
  files: ArtifactFileRef[];
}

export interface ArtifactFileContent {
  metadata: ArtifactFileRef;
  content: string;
}

export interface ArtifactStore {
  writeVersion(request: WriteVersionRequest): Promise<ArtifactRef>;
  // Throws when a file is missing, altered, unsafe or belongs to another task.
  verifyVersion(ref: ArtifactRef): Promise<void>;
  // Implementation must compare exact version/hash and refuse stale approval.
  publishApprovedVersion(ref: ArtifactRef, approval: Approval): Promise<PublishedResult>;
  getFile(
    taskId: string,
    artifactId: string,
    source: "revision" | "result",
  ): Promise<ArtifactFileContent>;
  getResultZip(taskId: string, ref: ArtifactRef): Promise<Uint8Array>;
}

export interface CheckRunHooks {
  signal: AbortSignal;
  timeoutMs: number;
  memoryLimitBytes: number;
}

export interface CheckRunner {
  run(ref: ArtifactRef, hooks: CheckRunHooks): Promise<CheckResult>;
}

export type TaskEventInput = Omit<TaskEvent, "sequence">;
export interface EventSink {
  // append persists a complete event before it can be sent over SSE.
  append(event: TaskEventInput): Promise<TaskEvent>;
  readAfter(taskId: string, sequence: number): Promise<TaskEvent[]>;
}

export interface TaskRuntimePorts {
  codex: CodexPort;
  artifacts: ArtifactStore;
  checks: CheckRunner;
  events: EventSink;
}

export interface ReviewContext {
  artifact: ArtifactRef;
  checks: CheckResult;
  previousReview: Review | null;
}
