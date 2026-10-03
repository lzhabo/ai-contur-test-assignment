import { describe, expect, it } from "vitest";
import { workflowView } from "../../../src/client/workflow/model";

import { event, snapshot } from "../../support/snapshot.js";

describe("отображение истории работы агентов", () => {
  it("сохраняет прежние замечания после одобрения новой версии и удаляет дубликаты SSE", () => {
    // Строит историю без дубликатов и сохраняет замечание первой версии после одобрения второй.
    const first = event(2, "review_finished", {
      from: "reviewer",
      to: "author",
      artifactVersionId: "v1",
      text: "Не обработан пустой массив",
    });
    const data = snapshot(
      [
        event(3, "version_created", { artifactVersionId: "v2" }),
        first,
        event(1, "version_created", { artifactVersionId: "v1" }),
        first,
        event(4, "review_finished", {
          from: "reviewer",
          to: "user",
          artifactVersionId: "v2",
          text: "Одобрено",
        }),
      ],
      "awaiting_approval",
    );

    const view = workflowView(data);

    expect(view.returns).toHaveLength(1);
    expect(view.reviews.map((review) => review.verdict)).toEqual(["changes_requested", "approved"]);
    expect(view.versions).toEqual(["v1", "v2"]);
  });
  it("не придумывает замечания, если первая версия одобрена", () => {
    const data = snapshot(
      [event(1, "review_finished", { from: "reviewer", to: "user" })],
      "awaiting_approval",
    );

    expect(workflowView(data).returns).toHaveLength(0);
  });
  it("показывает ожидание ревью и не отмечает невыполненные роли завершёнными", () => {
    const data = snapshot(
      [
        event(1, "version_created", {
          from: "author",
          artifactVersionId: "v1",
        }),
      ],
      "checking",
    );
    const stages = workflowView(data).stages;

    expect(
      stages.find(
        /* Находит запись проверяемого этапа или события. */ (stage) => stage.id === "author",
      )?.status,
    ).toBe("observed");
    expect(
      stages.find(
        /* Находит запись проверяемого этапа или события. */ (stage) => stage.id === "checks",
      )?.status,
    ).toBe("active");
    expect(
      stages.find(
        /* Находит запись проверяемого этапа или события. */ (stage) => stage.id === "reviewer",
      )?.status,
    ).toBe("waiting");
  });
  it.each(["stopped", "error", "unknown_outcome"] as const)(
    "не показывает работающего агента после %s",
    (phase) => {
      const data = snapshot(
        [
          event(1, "attempt_started", { from: "author", attemptId: "attempt" }),
          event(
            2,
            phase === "stopped"
              ? "task_stopped"
              : phase === "error"
                ? "task_failed"
                : "unknown_outcome",
            { attemptId: "attempt" },
          ),
        ],
        phase,
      );
      const stages = workflowView(data).stages;

      expect(
        stages.find(
          /* Находит запись проверяемого этапа или события. */ (stage) => stage.id === "author",
        )?.status,
      ).toBe(phase === "unknown_outcome" ? "unknown" : phase);
      expect(
        stages.some(
          /* Проверяет наличие состояния, которое допускает или запрещает сценарий. */ (stage) =>
            stage.status === "active",
        ),
      ).toBe(false);
      expect(
        stages.find(
          /* Находит запись проверяемого этапа или события. */ (stage) => stage.id === "applier",
        )?.status,
      ).toBe("waiting");
    },
  );
  it("показывает готовые файлы только после события публикации", () => {
    const data = snapshot([event(1, "decision_recorded")], "applying");

    expect(
      workflowView(data).stages.find(
        /* Находит запись проверяемого этапа или события. */ (stage) => stage.id === "result",
      )?.status,
    ).toBe("waiting");

    data.events.push(event(2, "publication_finished", { from: "applier", to: "user" }));
    data.task.phase = "completed";

    expect(
      workflowView(data).stages.find(
        /* Находит запись проверяемого этапа или события. */ (stage) => stage.id === "result",
      )?.status,
    ).toBe("observed");
  });

  it("ожидание входа сохраняет готовые этапы без признака работающего агента", () => {
    const data = snapshot(
      [
        event(1, "version_created", { from: "author", artifactVersionId: "v1" }),
        event(2, "checks_finished"),
        event(3, "attempt_started", { from: "reviewer", attemptId: "review" }),
        event(4, "phase_changed", { attemptId: "review", text: "Выполните codex login" }),
      ],
      "awaiting_auth",
    );

    const view = workflowView(data);

    expect(view.stages.find((stage) => stage.id === "author")?.status).toBe("observed");
    expect(view.stages.find((stage) => stage.id === "checks")?.status).toBe("observed");
    expect(view.current).toBe("reviewer");
    expect(view.stages.find((stage) => stage.id === "reviewer")?.status).toBe("paused");
    expect(view.stages.some((stage) => stage.status === "active")).toBe(false);
    expect(view.versions).toEqual(["v1"]);
  });
});
