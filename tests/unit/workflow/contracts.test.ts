import { describe, expect, it } from "vitest";
import { ArtifactRefSchema } from "../../../src/server/tasks/types.js";
import {
  CreateTaskRequestSchema,
  DecisionRequestSchema,
  TaskEventSchema,
} from "../../../src/shared/api.js";
import { ModelAssignmentsSchema } from "../../../src/server/config.js";

describe("контракты внешних данных", () => {
  // Объединяет проверки внешнего ввода и данных, передаваемых между модулями.

  it("отклоняет пустую задачу и принимает непустой текст", () => {
    // Проверяет запрет пустого задания и удаление пробелов вокруг непустого текста.
    const emptyInput = { text: "   " };
    const nonEmptyInput = { text: "  merge intervals  " };

    const emptyResult = CreateTaskRequestSchema.safeParse(emptyInput);
    const nonEmptyResult = CreateTaskRequestSchema.parse(nonEmptyInput);

    expect(emptyResult.success).toBe(false);
    expect(nonEmptyResult.text).toBe("merge intervals");
  });

  it("требует разные модели автора и ревьюера", () => {
    // Проверяет, что одинаковая модель автора и ревьюера не проходит схему настроек.
    const input = { author: "same", reviewer: "same", applier: "same" };

    const result = ModelAssignmentsSchema.safeParse(input);

    expect(result.success).toBe(false);
  });

  it("связывает решение с конкретной версией и хешем SHA-256", () => {
    // Сравнивает решение с неверным хешем и решение с допустимым SHA-256 той же версии.
    const invalidInput = {
      decisionId: "d1",
      decision: "approve",
      versionId: "v1",
      manifestHash: "bad",
    };
    const validInput = { ...invalidInput, manifestHash: "a".repeat(64) };

    const invalidResult = DecisionRequestSchema.safeParse(invalidInput);
    const validResult = DecisionRequestSchema.safeParse(validInput);

    expect(invalidResult.success).toBe(false);
    expect(validResult.success).toBe(true);
  });

  it("разрешает только два предусмотренных имени файлов", () => {
    // Проверяет допустимую пару файлов и отклоняет путь, выходящий из каталога версии.
    const validInput = {
      taskId: "t1",
      versionId: "v1",
      manifestHash: "a".repeat(64),
      files: [
        { artifactId: "f1", path: "solution.ts", sha256: "b".repeat(64), bytes: 10 },
        { artifactId: "f2", path: "solution.test.ts", sha256: "c".repeat(64), bytes: 20 },
      ],
    };
    const invalidInput = {
      ...validInput,
      files: [{ ...validInput.files[0], path: "../outside.ts" }, validInput.files[1]],
    };

    const validResult = ArtifactRefSchema.safeParse(validInput);
    const invalidResult = ArtifactRefSchema.safeParse(invalidInput);

    expect(validResult.success).toBe(true);
    expect(invalidResult.success).toBe(false);
  });

  it("требует номер события и сведения о его происхождении", () => {
    // Принимает полное событие с положительным курсором и отклоняет нулевой курсор.
    const validInput = {
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
    const invalidInput = { ...validInput, sequence: 0 };

    const validResult = TaskEventSchema.safeParse(validInput);
    const invalidResult = TaskEventSchema.safeParse(invalidInput);

    expect(validResult.success).toBe(true);
    expect(invalidResult.success).toBe(false);
  });
});
