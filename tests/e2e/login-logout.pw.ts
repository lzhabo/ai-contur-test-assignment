import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";

const taskText = "Напиши identity(value: number): number, возвращающую входное число.";

test.beforeEach(async ({ request }) => {
  expect((await request.post("/__qa/reset")).status()).toBe(204);
});

test("AUTH-1/2: logout обнаруживается опросом, сохраняет ввод и блокирует запуск", async ({
  page,
  request,
}) => {
  expect((await request.post("/__qa/auth/logged-in", { data: {} })).status()).toBe(204);
  await page.goto("/");
  const connection = page.getByRole("region", { name: "Подключение к Codex" });
  const input = page.getByLabel("Что должна делать функция?");
  const start = page.getByRole("button", { name: "Запустить агентов" });
  await input.fill(taskText);
  await expect(connection).toContainText("Вход в Codex — проверено");
  await expect(connection).toContainText("Облачные модели — не проверено");
  await expect(start).toBeEnabled();

  expect((await request.post("/__qa/auth/logged-out", { data: {} })).status()).toBe(204);

  await expect(connection).toContainText("Вход в Codex — требуется действие", { timeout: 20_000 });
  await expect(connection).toContainText("codex-mock.mjs login");
  await expect(start).toBeDisabled();
  await expect(input).toHaveValue(taskText);
  expect(await (await request.get("/__qa/evidence")).json()).toEqual({
    index: null,
    calls: [],
    taskDirectories: [],
  });
});

test("AUTH-3/4: logout перед POST не создаёт задачу; login снимает ошибку и повтор создаёт одну задачу", async ({
  page,
  request,
}) => {
  expect((await request.post("/__qa/auth/logged-in", { data: {} })).status()).toBe(204);
  // Заморожен только таймер браузера: logout гарантированно попадает между проверкой и POST.
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await page.goto("/");
  const connection = page.getByRole("region", { name: "Подключение к Codex" });
  const input = page.getByLabel("Что должна делать функция?");
  const start = page.getByRole("button", { name: "Запустить агентов" });
  await input.fill(taskText);
  await expect(connection).toContainText("Вход в Codex — проверено");
  await expect(start).toBeEnabled();
  expect((await request.post("/__qa/auth/logged-out", { data: {} })).status()).toBe(204);

  const deniedPromise = page.waitForResponse(
    (response) => response.url().endsWith("/api/tasks") && response.request().method() === "POST",
  );
  await start.click();
  const denied = await deniedPromise;
  await page.clock.resume();
  const key = denied.request().headers()["idempotency-key"]!;

  expect(denied.status()).toBe(503);
  expect(await denied.json()).toMatchObject({ code: "codex_not_ready" });
  expect(key).toBeTruthy();
  expect(await (await request.get("/__qa/evidence")).json()).toEqual({
    index: null,
    calls: [],
    taskDirectories: [],
  });
  await expect(connection).toContainText("Вход в Codex — требуется действие");
  await expect(connection).toContainText("codex-mock.mjs login");
  await expect(start).toBeDisabled();
  await expect(input).toHaveValue(taskText);

  expect((await request.post("/__qa/auth/logged-in", { data: {} })).status()).toBe(204);
  await page.getByRole("button", { name: "Проверить снова", exact: true }).click();

  await expect(connection).toContainText("Вход в Codex — проверено");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(start).toBeEnabled();
  await expect(input).toHaveValue(taskText);
  const createdPromise = page.waitForResponse(
    (response) => response.url().endsWith("/api/tasks") && response.request().method() === "POST",
  );
  await start.click();
  const created = await createdPromise;
  const { taskId } = await created.json();

  expect(created.status()).toBe(202);
  expect(created.request().headers()["idempotency-key"]).toBe(key);
  await expect(page.getByRole("button", { name: "Подтвердить", exact: true })).toBeVisible();
  const repeated = await request.post("/api/tasks", {
    data: { text: taskText },
    headers: { "Idempotency-Key": key },
  });
  expect(repeated.status()).toBe(202);
  expect(await repeated.json()).toMatchObject({ taskId });
  const evidence = await (await request.get("/__qa/evidence")).json();
  expect(evidence.index.tasks).toHaveLength(1);
  expect(evidence.index.tasks[0]).toMatchObject({ taskId, text: taskText, idempotencyKey: key });
  expect(evidence.taskDirectories).toEqual([taskId]);
  expect(evidence.calls).toEqual([{ kind: "candidate" }, { kind: "review" }]);
});

test("AUTH-5: logout во время ревью сохраняет версию; после login продолжает ту же задачу до ZIP", async ({
  page,
  request,
}) => {
  expect((await request.post("/__qa/review-auth-once")).status()).toBe(204);
  await page.goto("/");
  const connection = page.getByRole("region", { name: "Подключение к Codex" });
  await expect(connection).toContainText("Вход в Codex — проверено");
  await page.getByLabel("Что должна делать функция?").fill(taskText);
  const createdPromise = page.waitForResponse(
    (response) => response.url().endsWith("/api/tasks") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Запустить агентов" }).click();
  const created = await createdPromise;
  const { taskId } = await created.json();
  const key = created.request().headers()["idempotency-key"]!;
  await expect
    .poll(async () => (await (await request.get("/__qa/evidence")).json()).calls)
    .toEqual([{ kind: "candidate" }, { kind: "review" }]);
  const before = await (await request.get(`/api/tasks/${taskId}`)).json();
  const content = page.getByLabel("Содержимое solution.ts");
  await expect(content).toContainText("export function identity");
  const source = await content.innerText();

  expect((await request.post("/__qa/auth/logged-out")).status()).toBe(204);

  await expect
    .poll(async () => (await (await request.get(`/api/tasks/${taskId}`)).json()).task.phase)
    .toBe("awaiting_auth");
  const paused = await (await request.get(`/api/tasks/${taskId}`)).json();
  expect(paused.state).toMatchObject({
    currentVersionId: before.state.currentVersionId,
    currentManifestHash: before.state.currentManifestHash,
    createdVersions: 1,
    usedModelCalls: 2,
    activeAttempt: null,
  });
  expect(paused.actions).toMatchObject({
    canStop: true,
    canResume: true,
    resumeRequiresExplicitRetry: false,
  });
  expect(paused.files).toEqual(before.files);
  await expect(content).toHaveText(source);
  const resume = page.getByRole("button", { name: "Продолжить", exact: true });
  await expect(resume).toBeVisible();
  await page.getByRole("button", { name: "Проверить снова", exact: true }).click();
  await expect(connection).toContainText("Вход в Codex — требуется действие");
  await expect(resume).toBeDisabled();

  // Обход disabled-кнопки не должен расходовать бюджет и менять сохранённую версию.
  const denied = await request.post(`/api/tasks/${taskId}/resume`, { data: { mode: "continue" } });
  expect(denied.status()).toBe(503);
  expect(await denied.json()).toMatchObject({ code: "codex_not_ready" });
  const stillPaused = await (await request.get(`/api/tasks/${taskId}`)).json();
  expect(stillPaused.state).toEqual(paused.state);

  expect((await request.post("/__qa/auth/logged-in")).status()).toBe(204);
  await page.getByRole("button", { name: "Проверить снова", exact: true }).click();
  await expect(connection).toContainText("Вход в Codex — проверено");
  await expect(resume).toBeEnabled();
  expect((await (await request.get("/__qa/evidence")).json()).calls).toHaveLength(2);
  const resumedPromise = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/tasks/${taskId}/resume`) &&
      response.request().method() === "POST",
  );
  await resume.click();
  expect((await resumedPromise).status()).toBe(200);

  await expect(page.getByRole("button", { name: "Подтвердить", exact: true })).toBeVisible();
  await expect(content).toHaveText(source);
  const reviewed = await (await request.get(`/api/tasks/${taskId}`)).json();
  expect(reviewed.state).toMatchObject({
    currentVersionId: before.state.currentVersionId,
    currentManifestHash: before.state.currentManifestHash,
    createdVersions: 1,
    usedModelCalls: 3,
  });
  await page.getByRole("button", { name: "Подтвердить", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Файлы сохранены" })).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: /Скачать комплект ZIP/ }).click();
  const archive = unzipSync(await readFile((await (await downloadPromise).path())!));

  expect(Buffer.from(archive["solution.ts"]!).toString("utf8")).toBe(source);
  const evidence = await (await request.get("/__qa/evidence")).json();
  expect(evidence.index.tasks).toHaveLength(1);
  expect(evidence.index.tasks[0]).toMatchObject({ taskId, idempotencyKey: key });
  expect(evidence.taskDirectories).toEqual([taskId]);
  expect(evidence.calls).toEqual([
    { kind: "candidate" },
    { kind: "review" },
    { kind: "review" },
    { kind: "apply_request" },
  ]);
});
