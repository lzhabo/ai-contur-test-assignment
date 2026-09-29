import { describe, expect, it } from "vitest";
import { loadAppConfig } from "../../src/server/config.js";
import { CreateTaskRequestSchema } from "../../src/shared/api.js";

describe("настройки приложения", () => {
  it("использует локальный каталог по умолчанию и сохраняет явно заданный путь", () => {
    const defaults = loadAppConfig({});
    const custom = loadAppConfig({ APP_DATA_DIR: "/tmp/kontur-custom-data" });

    expect(defaults.dataDir).toBe(".local-data");
    expect(custom.dataDir).toBe("/tmp/kontur-custom-data");
    expect(defaults.models).toEqual({
      author: "gpt-6-sol",
      reviewer: "gpt-6-luna",
      applier: "gpt-6-sol",
    });
  });

  it.each(["AUTHOR_MODEL", "REVIEWER_MODEL", "APPLIER_MODEL"])(
    "отклоняет неподдерживаемую модель из %s при загрузке настроек",
    (variable) => {
      const env = { [variable]: "unsupported-model" };

      expect(() => loadAppConfig(env)).toThrow(/gpt-6-sol|gpt-6-luna/);
    },
  );

  it("разрешает смену ролей моделей и запрещает одного автора и ревьюера", () => {
    const swapped = loadAppConfig({
      AUTHOR_MODEL: "gpt-6-luna",
      REVIEWER_MODEL: "gpt-6-sol",
      APPLIER_MODEL: "gpt-6-luna",
    });

    expect(swapped.models).toEqual({
      author: "gpt-6-luna",
      reviewer: "gpt-6-sol",
      applier: "gpt-6-luna",
    });
    expect(() => loadAppConfig({ REVIEWER_MODEL: "gpt-6-sol" })).toThrow(
      "author and reviewer must use different models",
    );
  });
});

it("принимает задачу из 8000 символов и отклоняет следующий символ после удаления пробелов", () => {
  const boundary = "я".repeat(8_000);

  const accepted = CreateTaskRequestSchema.parse({ text: `  ${boundary}  ` });
  const rejected = CreateTaskRequestSchema.safeParse({ text: `${boundary}я` });

  expect(accepted.text).toBe(boundary);
  expect(rejected.success).toBe(false);
  if (!rejected.success)
    expect(rejected.error.issues).toEqual([
      expect.objectContaining({ code: "too_big", path: ["text"], maximum: 8_000 }),
    ]);
});
