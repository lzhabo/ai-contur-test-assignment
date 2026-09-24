import { describe, expect, it } from "vitest";
import { ArtifactRefSchema, CreateTaskRequestSchema, DecisionRequestSchema, ModelAssignmentsSchema, TaskEventSchema } from "../../../src/shared/index.js";

describe("boundary contracts", () => {
  it("rejects empty tasks and accepts editable text", () => {
    expect(CreateTaskRequestSchema.safeParse({ text: "   " }).success).toBe(false);
    expect(CreateTaskRequestSchema.parse({ text: "  merge intervals  " }).text).toBe("merge intervals");
  });

  it("requires distinct author and reviewer models", () => {
    expect(ModelAssignmentsSchema.safeParse({ author: "same", reviewer: "same", applier: "same" }).success).toBe(false);
  });

  it("binds a decision to a concrete version and SHA-256 manifest", () => {
    expect(DecisionRequestSchema.safeParse({ decisionId: "d1", decision: "approve", versionId: "v1", manifestHash: "bad" }).success).toBe(false);
    expect(DecisionRequestSchema.safeParse({ decisionId: "d1", decision: "approve", versionId: "v1", manifestHash: "a".repeat(64) }).success).toBe(true);
  });

  it("allows only the two versioned artifact paths", () => {
    const ref = { taskId: "t1", versionId: "v1", manifestHash: "a".repeat(64), files: [
      { artifactId: "f1", path: "solution.ts", sha256: "b".repeat(64), bytes: 10 },
      { artifactId: "f2", path: "solution.test.ts", sha256: "c".repeat(64), bytes: 20 },
    ] };
    expect(ArtifactRefSchema.safeParse(ref).success).toBe(true);
    expect(ArtifactRefSchema.safeParse({ ...ref, files: [{ ...ref.files[0], path: "../outside.ts" }, ref.files[1]] }).success).toBe(false);
  });

  it("requires event cursor and provenance fields", () => {
    const event = { taskId: "t1", sequence: 1, eventId: "e1", at: "2026-09-24T12:00:00.000Z", type: "message", from: "author", to: "reviewer", attemptId: "a1", text: "Ready", artifactVersionId: "v1", source: "codex:event" };
    expect(TaskEventSchema.safeParse(event).success).toBe(true);
    expect(TaskEventSchema.safeParse({ ...event, sequence: 0 }).success).toBe(false);
  });
});
