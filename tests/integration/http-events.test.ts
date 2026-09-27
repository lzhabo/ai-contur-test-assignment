import { expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { setup, post, until, deadline, aborts } from "../support/http.js";

it("A-03/A-09: SSE доставляет новое событие и повторяет только события после Last-Event-ID", async () => {
  // Проверяет сценарий: A-03/A-09: SSE доставляет новое событие и повторяет только события после Last-Event-ID.

  const { service, base } = await setup();
  const { taskId } = await service.createTask({ text: "mergeIntervals" });
  const controller = new AbortController();
  aborts.push(controller);
  const response = await deadline(
    fetch(`${base}/api/tasks/${taskId}/events?after=0`, {
      signal: controller.signal,
    }),
  );

  expect(response.headers.get("content-type")).toContain("text/event-stream");

  const reader = response.body!.getReader();
  await deadline(reader.read());
  const live = await service.events.append({
    taskId,
    eventId: "qa-live-message",
    at: new Date().toISOString(),
    type: "message",
    from: "author",
    to: "reviewer",
    attemptId: null,
    text: "QA_LIVE_EVENT",
    artifactVersionId: null,
    source: "qa",
  });
  let text = "";
  while (!text.includes("QA_LIVE_EVENT")) {
    const piece = await deadline(reader.read());
    if (piece.done) throw new Error("SSE closed before live event");
    text += new TextDecoder().decode(piece.value);
  }
  controller.abort();
  const second = await service.events.append({
    taskId,
    eventId: "qa-after-disconnect",
    at: new Date().toISOString(),
    type: "message",
    from: "reviewer",
    to: "author",
    attemptId: null,
    text: "QA_REPLAY_EVENT",
    artifactVersionId: null,
    source: "qa",
  });
  const reconnect = new AbortController();
  aborts.push(reconnect);
  const replay = await deadline(
    fetch(`${base}/api/tasks/${taskId}/events?after=0`, {
      headers: { "Last-Event-ID": String(live.sequence) },
      signal: reconnect.signal,
    }),
  );
  const replayReader = replay.body!.getReader();
  let replayText = "";
  await deadline(
    (async () => {
      // Читает поток до полного сообщения, сохранённого после разрыва соединения.

      while (!replayText.includes("QA_REPLAY_EVENT") || !replayText.endsWith("\n\n")) {
        const piece = await replayReader.read();
        if (piece.done) throw new Error("SSE closed before replay event");
        replayText += new TextDecoder().decode(piece.value);
      }
    })(),
  );

  expect(replayText).toContain("QA_REPLAY_EVENT");
  expect(replayText).toContain(`id: ${second.sequence}`);
  expect(replayText).not.toContain("QA_LIVE_EVENT");

  reconnect.abort();
  await service.stop(taskId);
});

it("SSE доставляет событие на границе истории и подписки ровно один раз", async () => {
  // Проверяет сценарий: SSE доставляет событие на границе истории и подписки ровно один раз.

  const { service, base } = await setup("happy");
  const { taskId } = await service.createTask({ text: "mergeIntervals" });
  const paused = await until(
    service,
    taskId,
    /* Проверяет достижение нужного состояния. */ (value) =>
      value.task.phase === "awaiting_approval",
  );
  const cursor = paused.lastEventSequence;
  const original = service.events.readAfter.bind(service.events);
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    // Сохраняет сигнал, которым тест разрешит продолжить обработку.
    release = resolve;
  });
  let entered: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    // Сохраняет сигнал о входе в проверяемый участок обработки.
    entered = resolve;
  });
  let firstRead = true;
  service.events.readAfter = async (id, after) => {
    // Удерживает первое чтение истории, чтобы добавить событие на границе replay и live.

    if (firstRead && after === cursor) {
      firstRead = false;
      entered?.();
      await held;
    }
    return original(id, after);
  };
  const controller = new AbortController();
  aborts.push(controller);
  const response = await deadline(
    fetch(`${base}/api/tasks/${taskId}/events?after=${cursor}`, {
      signal: controller.signal,
    }),
  );
  const reader = response.body!.getReader();
  await deadline(reader.read());
  await deadline(started);
  const appended = await service.events.append({
    taskId,
    eventId: "qa-replay-boundary",
    at: new Date().toISOString(),
    type: "message",
    from: "author",
    to: "reviewer",
    attemptId: null,
    text: "QA_BOUNDARY_EVENT",
    artifactVersionId: null,
    source: "qa",
  });
  release?.();
  let streamed = "";
  await deadline(
    (async () => {
      // Читает поток до события, добавленного во время восстановления истории.

      while (!streamed.includes(`id: ${appended.sequence}\n`)) {
        const piece = await reader.read();
        if (piece.done) throw new Error("SSE closed during replay");
        streamed += new TextDecoder().decode(piece.value);
      }
    })(),
  );

  expect(streamed.split(`id: ${appended.sequence}\n`).length - 1).toBe(1);

  controller.abort();
  service.events.readAfter = original;
  await service.stop(taskId);
});

it("HTTP сохраняет текст файлов и двоичные байты опубликованного ZIP", async () => {
  // Проверяет сценарий: HTTP сохраняет текст файлов и двоичные байты опубликованного ZIP.

  const { service, base } = await setup("happy");
  const created = await post(base, "/api/tasks", { text: "mergeIntervals" });
  const { taskId } = (await created.json()) as { taskId: string };
  const paused = await until(
    service,
    taskId,
    /* Проверяет достижение нужного состояния. */ (value) => value.actions.canDecide,
  );
  const approval = {
    decisionId: "qa-http-approval",
    decision: "approve",
    versionId: paused.state.currentVersionId!,
    manifestHash: paused.state.currentManifestHash!,
  };

  expect((await post(base, `/api/tasks/${taskId}/decision`, approval)).status).toBe(200);

  const completed = await until(
    service,
    taskId,
    /* Проверяет достижение нужного состояния. */ (value) => value.task.phase === "completed",
  );
  const file = completed.files[0]!;
  const plain = await fetch(`${base}/api/tasks/${taskId}/artifacts/${file.artifactId}`);

  expect(plain.status).toBe(200);
  expect(plain.headers.get("content-type")).toContain("text/plain");
  expect(await plain.text()).toBe((await service.getFile(taskId, file.artifactId)).content);

  const download = await fetch(
    `${base}/api/tasks/${taskId}/artifacts/${file.artifactId}?download=1`,
  );

  expect(download.headers.get("content-disposition")).toContain(`filename="${file.path}"`);

  const zip = await fetch(`${base}/api/tasks/${taskId}/result.zip`);

  expect(zip.status).toBe(200);
  expect(zip.headers.get("content-type")).toContain("application/zip");
  expect(zip.headers.get("content-disposition")).toContain("two-model-result.zip");

  const archive = new Uint8Array(await zip.arrayBuffer());

  expect(Buffer.from(archive.subarray(0, 2)).toString()).toBe("PK");

  const entries = unzipSync(archive);
  for (const published of completed.files) {
    expect(strFromU8(entries[published.path]!)).toBe(
      (await service.getFile(taskId, published.artifactId)).content,
    );
  }
}, 15_000);
