import { expect, it } from "vitest";
import { setup, post } from "../support/http.js";

// Проверяет отклонение пустого пользовательского задания.
it("A-09: пустой текст задачи возвращает 400", async () => {
  const { base } = await setup();

  const response = await post(base, "/api/tasks", { text: "" });

  expect(response.status).toBe(400);
});

// Проверяет запрет изменения данных с постороннего сайта.
it("A-09: посторонний Origin возвращает 403", async () => {
  const { base } = await setup();

  const response = await post(
    base,
    "/api/tasks",
    { text: "mergeIntervals" },
    { origin: "https://example.com" },
  );

  expect(response.status).toBe(403);
});

// Проверяет повтор запроса создания на уровне настоящего HTTP-сервера.
it("A-09: параллельные POST с одним ключом возвращают одну задачу", async () => {
  const { service, base } = await setup();
  const body = { text: "mergeIntervals" };
  const headers = { "idempotency-key": "qa-repeat" };

  const [first, second] = await Promise.all([
    post(base, "/api/tasks", body, headers),
    post(base, "/api/tasks", body, headers),
  ]);
  const created = (await first.json()) as { taskId: string };

  expect(first.status).toBe(202);
  expect(second.status).toBe(202);
  expect(await second.json()).toEqual(created);

  await service.stop(created.taskId);
});

// Проверяет отрицательное и неточно представимое значение курсора отдельно от создания задачи.
it.each(["-1", "9007199254740992"])("A-09: курсор событий %s возвращает 400", async (cursor) => {
  const { service, base } = await setup();
  const { taskId } = await service.createTask({ text: "mergeIntervals" });

  const response = await fetch(`${base}/api/tasks/${taskId}/events?after=${cursor}`);

  expect(response.status).toBe(400);

  await service.stop(taskId);
});

// Проверяет отсутствие SSE у неизвестной задачи.
it("A-09: события отсутствующей задачи возвращают 404", async () => {
  const { base } = await setup();

  const response = await fetch(`${base}/api/tasks/missing/events`);

  expect(response.status).toBe(404);
});

// Проверяет отсутствие скачиваемого результата до публикации.
it("A-09: ZIP неопубликованной задачи возвращает 404", async () => {
  const { service, base } = await setup();
  const { taskId } = await service.createTask({ text: "mergeIntervals" });

  const response = await fetch(`${base}/api/tasks/${taskId}/result.zip`);

  expect(response.status).toBe(404);

  await service.stop(taskId);
});

// Сохраняет наблюдаемый контракт Express-базы для каждого независимого нарушения тела запроса.
it.each([
  {
    label: "повреждённый JSON",
    contentType: "application/json",
    body: "{",
    status: 500,
    code: "internal_error",
  },
  {
    label: "число вместо объекта",
    contentType: "application/json",
    body: "1",
    status: 400,
    code: "invalid_request",
  },
  {
    label: "обычный текст",
    contentType: "text/plain",
    body: "mergeIntervals",
    status: 400,
    code: "invalid_request",
  },
  {
    label: "неподдерживаемый тип JSON",
    contentType: "application/problem+json",
    body: '{"text":"mergeIntervals"}',
    status: 500,
    code: "internal_error",
  },
  {
    label: "превышение размера тела",
    contentType: "application/json",
    body: JSON.stringify({ text: "x".repeat(1_100_000) }),
    status: 500,
    code: "internal_error",
  },
])("HTTP: $label возвращает $status и $code", async ({ contentType, body, status, code }) => {
  const { base } = await setup();

  const response = await fetch(`${base}/api/tasks`, {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });

  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ code });
});

// Проверяет тело health и стандартную семантику HEAD без тела ответа.
it("HTTP: health сообщает режим mock, HEAD возвращает 200 без тела", async () => {
  const { base } = await setup();

  const health = await fetch(`${base}/api/health`);
  const head = await fetch(`${base}/api/health`, { method: "HEAD" });

  expect(await health.json()).toEqual({ ok: true, executionMode: "mock" });
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
});
