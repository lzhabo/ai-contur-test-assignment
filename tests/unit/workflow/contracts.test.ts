import { describe, expect, it } from "vitest";
import { ArtifactRefSchema } from "../../../src/server/tasks/types.js";
import {
  CreateTaskRequestSchema,
  DecisionRequestSchema,
  TaskEventSchema,
} from "../../../src/shared/api.js";
import { ModelAssignmentsSchema } from "../../../src/server/config.js";

describe("контракты внешних данных", () => {
  // Объединяет проверки: контракты внешних данных.

  it("отклоняет пустую задачу и принимает непустой текст", () => {
    expect(CreateTaskRequestSchema.safeParse({ text: "   " }).success).toBe(false);
    expect(CreateTaskRequestSchema.parse({ text: "  merge intervals  " }).text).toBe(
      "merge intervals",
    );
  });

  it("требует разные модели автора и ревьюера", () => {
    // Проверяет сценарий: требует разные модели автора и ревьюера.

    expect(
      ModelAssignmentsSchema.safeParse({
        author: "same",
        reviewer: "same",
        applier: "same",
      }).success,
    ).toBe(false);
  });

  it("связывает решение с конкретной версией и хешем SHA-256", () => {
    // Проверяет сценарий: связывает решение с конкретной версией и хешем SHA-256.

    expect(
      DecisionRequestSchema.safeParse({
        decisionId: "d1",
        decision: "approve",
        versionId: "v1",
        manifestHash: "bad",
      }).success,
    ).toBe(false);
    expect(
      DecisionRequestSchema.safeParse({
        decisionId: "d1",
        decision: "approve",
        versionId: "v1",
        manifestHash: "a".repeat(64),
      }).success,
    ).toBe(true);
  });

  it("разрешает только два предусмотренных имени файлов", () => {
    // Проверяет сценарий: разрешает только два предусмотренных имени файлов.

    const ref = {
      taskId: "t1",
      versionId: "v1",
      manifestHash: "a".repeat(64),
      files: [
        {
          artifactId: "f1",
          path: "solution.ts",
          sha256: "b".repeat(64),
          bytes: 10,
        },
        {
          artifactId: "f2",
          path: "solution.test.ts",
          sha256: "c".repeat(64),
          bytes: 20,
        },
      ],
    };

    expect(ArtifactRefSchema.safeParse(ref).success).toBe(true);
    expect(
      ArtifactRefSchema.safeParse({
        ...ref,
        files: [{ ...ref.files[0], path: "../outside.ts" }, ref.files[1]],
      }).success,
    ).toBe(false);
  });

  it("требует номер события и сведения о его происхождении", () => {
    // Проверяет сценарий: требует номер события и сведения о его происхождении.

    const event = {
      taskId: "t1",
      sequence: 1,
      eventId: "e1",
      at: "2026-09-24T12:00:00.000Z",
      type: "message",
      from: "author",
      to: "reviewer",
      attemptId: "a1",
      text: "Ready",
      artifactVersionId: "v1",
      source: "codex:event",
    };

    expect(TaskEventSchema.safeParse(event).success).toBe(true);
    expect(TaskEventSchema.safeParse({ ...event, sequence: 0 }).success).toBe(false);
  });
});
