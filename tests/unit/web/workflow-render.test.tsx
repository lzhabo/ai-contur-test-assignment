import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkflowGraph } from "../../../src/client/workflow/WorkflowGraph";
import { event, snapshot } from "../../support/snapshot.js";

// Показывает прежнее замечание рядом с обеими версиями после последующего одобрения.
it("рендер истории сохраняет замечание первой версии после одобрения второй", () => {
  const firstVersion = event(1, "version_created", { artifactVersionId: "v1" });
  const rejectedReview = event(2, "review_finished", {
    from: "reviewer",
    to: "author",
    artifactVersionId: "v1",
    text: "Не обработан пустой массив",
  });
  const secondVersion = event(3, "version_created", {
    artifactVersionId: "v2",
  });
  const approvedReview = event(4, "review_finished", {
    from: "reviewer",
    to: "user",
    artifactVersionId: "v2",
    text: "Одобрено",
  });
  const data = snapshot(
    [firstVersion, rejectedReview, secondVersion, approvedReview],
    "awaiting_approval",
  );

  const html = renderToStaticMarkup(<WorkflowGraph snapshot={data} />);

  expect(html).toContain("Не обработан пустой массив");
  expect(html).toContain("Версия 1");
  expect(html).toContain("Версия 2");
  expect(html).not.toContain("В этом прогоне возврата к автору не было");
});

// Объясняет отсутствие замечаний только для действительно одобренной первой версии.
it("рендер сообщает, что возврата к автору не было", () => {
  const data = snapshot(
    [event(1, "review_finished", { from: "reviewer", to: "user" })],
    "awaiting_approval",
  );

  const html = renderToStaticMarkup(<WorkflowGraph snapshot={data} />);

  expect(html).toContain("В этом прогоне возврата к автору не было");
});

// Отличает ещё не выполненное ревью от одобрения.
it("рендер явно показывает незавершённое ревью", () => {
  const data = snapshot(
    [event(1, "version_created", { from: "author", artifactVersionId: "v1" })],
    "checking",
  );

  const html = renderToStaticMarkup(<WorkflowGraph snapshot={data} />);

  expect(html).toContain("Ревью ещё не завершено");
});

it("пауза из-за входа объясняет сохранение этапов вместо окончательного завершения ошибкой", () => {
  const data = snapshot([], "awaiting_auth");

  const html = renderToStaticMarkup(<WorkflowGraph snapshot={data} />);

  expect(html).toContain("Процесс приостановлен: нужен вход в Codex. Выполненные этапы сохранены.");
  expect(html).not.toContain("Процесс завершился ошибкой.");
});
