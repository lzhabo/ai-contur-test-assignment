// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { afterEach, expect, it, vi } from "vitest";
import * as api from "../../../src/client/api/tasks";
import * as events from "../../../src/client/api/events";
import { useTask } from "../../../src/client/hooks/use-task";
import { useTaskCommands } from "../../../src/client/hooks/use-task-commands";
import { acceptSnapshot, taskKeys } from "../../../src/client/hooks/task-cache";
import type { TaskSnapshotResponse } from "../../../src/shared/api";
import { event, snapshot } from "../../support/snapshot";

const clients: QueryClient[] = [];

// Размонтирует хуки, закрывает кеши и восстанавливает API после каждого сценария.
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
  vi.restoreAllMocks();
});

// Держит кеш до явной очистки afterEach; общие повторы намеренно разрешены для проверки запрета в командах.
function harness() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: 3, retryDelay: 0 },
    },
  });
  clients.push(client);
  // Передаёт один и тот же тестовый кеш всем перерендерам хука.
  function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { client, wrapper: Wrapper };
}

// Готовит ответ конкретной задачи с явно указанной последовательностью событий.
function taskResponse(taskId: string, sequence: number): TaskSnapshotResponse {
  const data = snapshot();
  data.task.taskId = taskId;
  data.lastEventSequence = sequence;
  return data;
}

// Позволяет тесту явно выбрать момент ответа HTTP без произвольной задержки.
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    // Даёт тесту возможность явно завершить ожидаемый ответ.
    resolve = complete;
  });
  return { promise, resolve };
}

// Устаревший ответ первой задачи приходит уже после переключения на вторую.
it("смена задачи отменяет старый запрос и не показывает его запоздалый ответ", async () => {
  const first = deferred<TaskSnapshotResponse>();
  let firstSignal: AbortSignal | undefined;
  vi.spyOn(api, "getTaskSnapshot").mockImplementation((id, signal) => {
    // Подставляет управляемый ответ внешней границы для данного сценария.

    if (id === "first") {
      firstSignal = signal;
      return first.promise;
    }
    return Promise.resolve(taskResponse("second", 2));
  });
  vi.spyOn(events, "subscribeTaskEvents").mockReturnValue(() => {
    // Оставляет необязательный callback пустым.
  });
  const { wrapper } = harness();
  const { result, rerender } = renderHook(
    /* Запускает проверяемый hook внутри изолированного провайдера кеша. */ ({ id }) => useTask(id),
    { wrapper, initialProps: { id: "first" } },
  );

  rerender({ id: "second" });
  await waitFor(
    /* Дожидается ожидаемого обновления React. */ () =>
      expect(result.current.snapshot?.task.taskId).toBe("second"),
  );
  await act(async () => {
    // Применяет действие и обновляет React.
    first.resolve(taskResponse("first", 100));
    await first.promise;
  });

  expect(firstSignal?.aborted).toBe(true);
  expect(result.current.snapshot?.task.taskId).toBe("second");
  expect(result.current.snapshot?.lastEventSequence).toBe(2);
});

// Смена выбранной задачи освобождает её SSE-подписку, а размонтирование — новую.
it("смена задачи и размонтирование закрывают принадлежащие им SSE-подписки", async () => {
  vi.spyOn(api, "getTaskSnapshot").mockImplementation(
    /* Подставляет управляемый ответ внешней границы для данного сценария. */ (id) =>
      Promise.resolve(taskResponse(id, 1)),
  );
  const closedFirst = vi.fn();
  const closedSecond = vi.fn();
  vi.spyOn(events, "subscribeTaskEvents").mockImplementation(
    /* Подставляет управляемый ответ внешней границы для данного сценария. */ (id) =>
      id === "first" ? closedFirst : closedSecond,
  );
  const { wrapper } = harness();
  const { rerender, unmount } = renderHook(
    /* Запускает проверяемый hook внутри изолированного провайдера кеша. */ ({ id }) => useTask(id),
    { wrapper, initialProps: { id: "first" } },
  );
  await waitFor(
    /* Дожидается ожидаемого обновления React. */ () =>
      expect(events.subscribeTaskEvents).toHaveBeenCalledTimes(1),
  );

  rerender({ id: "second" });
  await waitFor(
    /* Дожидается ожидаемого обновления React. */ () =>
      expect(events.subscribeTaskEvents).toHaveBeenCalledTimes(2),
  );

  expect(closedFirst).toHaveBeenCalledTimes(1);

  unmount();

  expect(closedSecond).toHaveBeenCalledTimes(1);
});

// Соединение восстанавливает состояние даже без нового события; пачка событий объединяется.
it("переподключение SSE обновляет данные, а пачка событий вызывает один запрос", async () => {
  const load = vi.spyOn(api, "getTaskSnapshot").mockResolvedValue(taskResponse("task", 1));
  let handlers!: Parameters<typeof events.subscribeTaskEvents>[2];
  vi.spyOn(events, "subscribeTaskEvents").mockImplementation((_id, _cursor, received) => {
    // Подставляет управляемый ответ внешней границы для данного сценария.
    handlers = received;
    return () => {
      // Оставляет необязательный callback пустым.
    };
  });
  const { wrapper } = harness();
  const { result } = renderHook(
    /* Запускает проверяемый hook внутри изолированного провайдера кеша. */ () => useTask("task"),
    { wrapper },
  );
  await waitFor(
    /* Дожидается ожидаемого обновления React. */ () =>
      expect(events.subscribeTaskEvents).toHaveBeenCalledTimes(1),
  );
  const initialLoads = load.mock.calls.length;

  act(() => {
    // Применяет действие и обновляет React.
    handlers.onOpen();
  });
  await waitFor(
    /* Дожидается ожидаемого обновления React. */ () =>
      expect(load).toHaveBeenCalledTimes(initialLoads + 1),
  );

  expect(result.current.connected).toBe(true);

  act(() => {
    // Применяет действие и обновляет React.
    handlers.onError();
  });

  expect(result.current.connected).toBe(false);

  act(() => {
    // Применяет действие и обновляет React.
    handlers.onOpen();
  });
  await waitFor(
    /* Дожидается ожидаемого обновления React. */ () =>
      expect(load).toHaveBeenCalledTimes(initialLoads + 2),
  );
  const beforeBurst = load.mock.calls.length;

  act(() => {
    // Применяет действие и обновляет React.
    for (let index = 0; index < 20; index++) handlers.onEvent(event(index + 1, "message"));
  });
  await waitFor(
    /* Дожидается ожидаемого обновления React. */ () =>
      expect(load).toHaveBeenCalledTimes(beforeBurst + 1),
  );

  expect(result.current.connected).toBe(true);
  expect(events.subscribeTaskEvents).toHaveBeenCalledTimes(1);
});

// Старая последовательность не должна откатывать экран; равная обновляет доступные действия.
it("кеш отклоняет меньший sequence и принимает обновлённые действия при равном", () => {
  const current = taskResponse("task", 10);
  const older = taskResponse("task", 9);
  const equal = taskResponse("task", 10);
  equal.actions.canStop = true;

  const rejected = acceptSnapshot(current, older);
  const accepted = acceptSnapshot(current, equal);

  expect(rejected).toBe(current);
  expect(accepted).toBe(equal);
  expect(accepted.actions.canStop).toBe(true);
});

// Потерянный ответ создания требует ручного повтора с тем же ключом идемпотентности.
it("повтор создания после ошибки сохраняет ключ, успешное создание начинает новую попытку", async () => {
  const create = vi
    .spyOn(api, "createTask")
    .mockRejectedValueOnce(new Error("Соединение оборвалось"))
    .mockResolvedValueOnce({ taskId: "created" })
    .mockResolvedValueOnce({ taskId: "next" });
  const onCreated = vi.fn();
  const { wrapper } = harness();
  const { result } = renderHook(
    /* Запускает проверяемый hook внутри изолированного провайдера кеша. */ () =>
      useTaskCommands(onCreated),
    { wrapper },
  );

  await act(async () => {
    // Применяет действие и обновляет React.
    await result.current.create("mergeIntervals");
  });

  expect(result.current.error).toContain("Соединение оборвалось");
  expect(create).toHaveBeenCalledTimes(1);

  await act(async () => {
    // Применяет действие и обновляет React.
    await result.current.create("mergeIntervals");
  });

  expect(create.mock.calls[1]?.[1]).toBe(create.mock.calls[0]?.[1]);
  expect(onCreated).toHaveBeenCalledWith("created");

  await act(async () => {
    // Применяет действие и обновляет React.
    await result.current.create("mergeIntervals");
  });

  expect(create.mock.calls[2]?.[1]).not.toBe(create.mock.calls[1]?.[1]);
});

// Даже при общих настройках retry команда остановки выполняется только один раз.
it("ошибка изменяющей команды не запускает автоматический повтор", async () => {
  const stop = vi.spyOn(api, "stopTask").mockRejectedValue(new Error("Ответ неизвестен"));
  const { wrapper, client } = harness();
  const { result } = renderHook(
    /* Запускает проверяемый hook внутри изолированного провайдера кеша. */ () =>
      useTaskCommands(vi.fn()),
    { wrapper },
  );

  await act(async () => {
    // Применяет действие и обновляет React.
    await result.current.stop("task");
  });

  expect(stop).toHaveBeenCalledTimes(1);
  expect(result.current.error).toBe("Ответ неизвестен");
  expect(client.getMutationCache().getAll()[0]?.options.retry).toBe(false);
});

// Ответ команды не должен заменять более свежую историю из SSE-запроса.
it("запоздалый ответ команды не откатывает sequence в кеше", async () => {
  const { wrapper, client } = harness();
  const current = taskResponse("task", 10);
  client.setQueryData(taskKeys.detail("task"), current);
  vi.spyOn(api, "stopTask").mockResolvedValue(taskResponse("task", 9));
  const { result } = renderHook(
    /* Запускает проверяемый hook внутри изолированного провайдера кеша. */ () =>
      useTaskCommands(vi.fn()),
    { wrapper },
  );

  await act(async () => {
    // Применяет действие и обновляет React.
    await result.current.stop("task");
  });

  expect(
    client.getQueryData<TaskSnapshotResponse>(taskKeys.detail("task"))?.lastEventSequence,
  ).toBe(10);
});
