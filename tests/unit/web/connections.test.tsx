// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import * as api from "../../../src/client/api/connections";
import * as tasks from "../../../src/client/api/tasks";
import { HttpError } from "../../../src/client/api/http";
import { ConnectionStatus } from "../../../src/client/components/ConnectionStatus";
import { NewTask } from "../../../src/client/components/NewTask";
import { useConnections } from "../../../src/client/hooks/use-connections";
import { useTaskCommands } from "../../../src/client/hooks/use-task-commands";
import type { CodexReadiness } from "../../../src/shared/connections";

const clients: QueryClient[] = [];
const loggedIn: CodexReadiness = {
  executionMode: "real",
  ready: true,
  checkedAt: "2026-09-29T10:00:00.000Z",
  checks: [
    { id: "cli", status: "passed", message: "Codex CLI установлен." },
    { id: "auth", status: "passed", message: "Вход через ChatGPT подтверждён." },
    { id: "cloud", status: "not_checked", message: "Облачный вызов не выполнялся." },
  ],
};

afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// Соединяет настоящий hook с компонентом; mock управляет только HTTP-ответами readiness.
function ConnectionScreen() {
  const connection = useConnections();
  return (
    <>
      <ConnectionStatus {...connection} />
      <button disabled={!connection.ready}>Начать задачу</button>
    </>
  );
}

function renderConnection(content: ReactNode = <ConnectionScreen />) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: 3, retryDelay: 0, gcTime: Infinity } },
  });
  clients.push(client);
  return render(<QueryClientProvider client={client}>{content}</QueryClientProvider>);
}

// Настоящие hooks и форма; mock ограничен ответами HTTP API.
function TaskConnectionScreen({ onCreated }: { onCreated: (id: string) => void }) {
  const connection = useConnections();
  const commands = useTaskCommands(onCreated);
  const [text, setText] = useState("");
  return (
    <>
      <ConnectionStatus {...connection} />
      {commands.error && <p role="alert">{commands.error}</p>}
      <NewTask
        text={text}
        setText={setText}
        serverMode="real"
        activeId={null}
        busy={commands.busy}
        connectionReady={connection.ready}
        create={commands.create}
        selectTask={() => {}}
      />
    </>
  );
}

it("logout до опроса обновляет подключение после отказа запуска; login убирает ошибку и позволяет один повтор с тем же текстом и ключом", async () => {
  const missingAuth: CodexReadiness = {
    ...loggedIn,
    ready: false,
    checks: [
      loggedIn.checks[0]!,
      { id: "auth", status: "failed", message: "Выполните codex login в терминале." },
      loggedIn.checks[2]!,
    ],
  };
  const load = vi
    .spyOn(api, "getConnections")
    .mockResolvedValueOnce(loggedIn)
    .mockResolvedValueOnce(missingAuth)
    .mockResolvedValueOnce(loggedIn);
  const create = vi
    .spyOn(tasks, "createTask")
    .mockRejectedValueOnce(new HttpError("Вход в Codex отсутствует.", 503, "codex_not_ready"))
    .mockResolvedValueOnce({ taskId: "created" });
  const onCreated = vi.fn();
  renderConnection(<TaskConnectionScreen onCreated={onCreated} />);
  await screen.findByText(/Вход через ChatGPT подтверждён/);
  const input = screen.getByLabelText("Что должна делать функция?") as HTMLTextAreaElement;
  const start = screen.getByRole("button", { name: "Запустить агентов →" }) as HTMLButtonElement;
  fireEvent.change(input, { target: { value: "Объединить интервалы" } });

  fireEvent.click(start);
  await screen.findByText("Вход в Codex — требуется действие.");

  expect(start.disabled).toBe(true);
  expect(input.value).toBe("Объединить интервалы");
  expect(screen.queryByText(/Вход через ChatGPT подтверждён/)).toBeNull();
  expect(screen.getByRole("alert").textContent).toContain("Вход в Codex отсутствует");
  expect(create).toHaveBeenCalledTimes(1);
  expect(onCreated).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Проверить снова" }));
  await screen.findByText(/Вход через ChatGPT подтверждён/);

  expect(screen.queryByRole("alert")).toBeNull();
  expect(start.disabled).toBe(false);
  expect(input.value).toBe("Объединить интервалы");
  expect(create).toHaveBeenCalledTimes(1);
  expect(load).toHaveBeenCalledTimes(3);

  fireEvent.click(start);
  fireEvent.click(start);
  await waitFor(() => expect(onCreated).toHaveBeenCalledExactlyOnceWith("created"));

  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[1]).toEqual(create.mock.calls[0]);
});

it("отказ запуска отменяет проверку, начатую до logout, и её поздний успех не разблокирует форму", async () => {
  let rejectCreate!: (cause: Error) => void;
  const creating = new Promise<never>((_resolve, reject) => {
    rejectCreate = reject;
  });
  let resolveOldCheck!: (value: CodexReadiness) => void;
  const oldCheck = new Promise<CodexReadiness>((resolve) => {
    resolveOldCheck = resolve;
  });
  let oldSignal: AbortSignal | undefined;
  const missingAuth: CodexReadiness = {
    ...loggedIn,
    ready: false,
    checks: [
      loggedIn.checks[0]!,
      { id: "auth", status: "failed", message: "Выполните codex login в терминале." },
      loggedIn.checks[2]!,
    ],
  };
  const load = vi
    .spyOn(api, "getConnections")
    .mockResolvedValueOnce(loggedIn)
    .mockImplementationOnce((signal) => {
      oldSignal = signal;
      return oldCheck;
    })
    .mockResolvedValueOnce(missingAuth);
  vi.spyOn(tasks, "createTask").mockReturnValueOnce(creating);
  renderConnection(<TaskConnectionScreen onCreated={vi.fn()} />);
  await screen.findByText(/Вход через ChatGPT подтверждён/);
  fireEvent.change(screen.getByLabelText("Что должна делать функция?"), {
    target: { value: "Объединить интервалы" },
  });

  fireEvent.click(screen.getByRole("button", { name: "Запустить агентов →" }));
  fireEvent.click(screen.getByRole("button", { name: "Проверить снова" }));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  await act(async () => {
    rejectCreate(new HttpError("Вход в Codex отсутствует.", 503, "codex_not_ready"));
  });
  await screen.findByText("Вход в Codex — требуется действие.");

  expect(oldSignal?.aborted).toBe(true);
  expect(load).toHaveBeenCalledTimes(3);

  await act(async () => {
    resolveOldCheck(loggedIn);
    await oldCheck;
  });

  expect(screen.queryByText(/Вход через ChatGPT подтверждён/)).toBeNull();
  expect(screen.getByRole("alert").textContent).toContain("Вход в Codex отсутствует");
  expect(
    (screen.getByRole("button", { name: "Запустить агентов →" }) as HTMLButtonElement).disabled,
  ).toBe(true);
});

it("успешная проверка входа не скрывает ошибку команды с неизвестным исходом", async () => {
  vi.spyOn(api, "getConnections").mockResolvedValue(loggedIn);
  const create = vi
    .spyOn(tasks, "createTask")
    .mockRejectedValue(new Error("Соединение оборвалось"));
  renderConnection(<TaskConnectionScreen onCreated={vi.fn()} />);
  await screen.findByText(/Вход через ChatGPT подтверждён/);
  fireEvent.change(screen.getByLabelText("Что должна делать функция?"), {
    target: { value: "Объединить интервалы" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Запустить агентов →" }));
  await screen.findByRole("alert");

  fireEvent.click(screen.getByRole("button", { name: "Проверить снова" }));
  await screen.findByText(/Вход через ChatGPT подтверждён/);

  expect(screen.getByRole("alert").textContent).toBe("Соединение оборвалось");
  expect(create).toHaveBeenCalledTimes(1);
});

it("отсутствие входа показывает codex login; повторная проверка разрешает запуск после входа", async () => {
  const missingAuth: CodexReadiness = {
    ...loggedIn,
    ready: false,
    checks: [
      loggedIn.checks[0]!,
      { id: "auth", status: "failed", message: "Выполните codex login в терминале." },
      loggedIn.checks[2]!,
    ],
  };
  const load = vi
    .spyOn(api, "getConnections")
    .mockResolvedValueOnce(missingAuth)
    .mockResolvedValueOnce(loggedIn);
  renderConnection();

  await screen.findByText(/Выполните codex login/);

  expect(
    (screen.getByRole("button", { name: "Начать задачу" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(screen.getByText("Вход в Codex — требуется действие.")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Проверить снова" }));
  await screen.findByText(/Вход через ChatGPT подтверждён/);

  expect(
    (screen.getByRole("button", { name: "Начать задачу" }) as HTMLButtonElement).disabled,
  ).toBe(false);
  expect(screen.queryByText(/Выполните codex login/)).toBeNull();
  expect(screen.getByText("Облачные модели — не проверено.")).toBeTruthy();
  expect(load).toHaveBeenCalledTimes(2);
});

it("ошибка backend после успешной проверки блокирует запуск и убирает устаревшее сообщение об успехе без retry", async () => {
  const load = vi
    .spyOn(api, "getConnections")
    .mockResolvedValueOnce(loggedIn)
    .mockRejectedValue(new Error("backend unavailable"));
  renderConnection();
  await screen.findByText(/Вход через ChatGPT подтверждён/);

  fireEvent.click(screen.getByRole("button", { name: "Проверить снова" }));
  const alert = await screen.findByRole("alert");

  expect(alert.textContent).toContain("Не удалось связаться с сервером приложения");
  expect(alert.textContent).toContain("Проверить снова");
  expect(
    (screen.getByRole("button", { name: "Начать задачу" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(screen.queryByText(/Вход через ChatGPT подтверждён/)).toBeNull();
  expect(screen.queryByText(/Сервер приложения доступен/)).toBeNull();
  expect(load).toHaveBeenCalledTimes(2);
});

it("во время повторной проверки скрывает прежний успех и запрещает запуск до ответа", async () => {
  let finish!: (value: CodexReadiness) => void;
  const pending = new Promise<CodexReadiness>((resolve) => {
    finish = resolve;
  });
  vi.spyOn(api, "getConnections").mockResolvedValueOnce(loggedIn).mockReturnValueOnce(pending);
  renderConnection();
  await screen.findByText(/Вход через ChatGPT подтверждён/);

  fireEvent.click(screen.getByRole("button", { name: "Проверить снова" }));
  await screen.findByRole("status");

  expect(screen.queryByText(/Вход через ChatGPT подтверждён/)).toBeNull();
  expect(
    (screen.getByRole("button", { name: "Начать задачу" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect((screen.getByRole("button", { name: "Проверяем…" }) as HTMLButtonElement).disabled).toBe(
    true,
  );

  await act(async () => {
    finish(loggedIn);
    await pending;
  });
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Начать задачу" }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
});

it("mock-режим явно сообщает имитацию и отсутствие проверки облачных моделей", () => {
  const mockReadiness: CodexReadiness = {
    ...loggedIn,
    executionMode: "mock",
    checks: [
      { id: "cli", status: "not_checked", message: "Mock не использует Codex CLI." },
      { id: "auth", status: "not_checked", message: "Вход не проверялся." },
      {
        id: "cloud",
        status: "not_checked",
        message: "Ответы имитируются; облачные модели не вызываются.",
      },
    ],
  };

  render(<ConnectionStatus data={mockReadiness} checking={false} error="" recheck={vi.fn()} />);

  expect(screen.getByText(/Включён тестовый режим/)).toBeTruthy();
  expect(screen.getByText(/Ответы имитируются; облачные модели не вызываются/)).toBeTruthy();
  expect(screen.getByText("Облачные модели — не проверено.")).toBeTruthy();
  expect(screen.queryByText("Облачные модели — проверено.")).toBeNull();
});

it("форма без подключения блокирует кнопку и прямую отправку, после восстановления передаёт текст", () => {
  const create = vi.fn().mockResolvedValue(undefined);
  const props = {
    text: "Объединить интервалы",
    setText: vi.fn(),
    serverMode: "real" as const,
    activeId: null,
    busy: false,
    create,
    selectTask: vi.fn(),
  };
  const { rerender } = render(<NewTask {...props} connectionReady={false} />);
  const button = screen.getByRole("button", { name: "Запустить агентов →" }) as HTMLButtonElement;
  const form = button.closest("form")!;

  fireEvent.click(button);
  fireEvent.submit(form);

  expect(button.disabled).toBe(true);
  expect(create).not.toHaveBeenCalled();

  rerender(<NewTask {...props} connectionReady={true} />);
  fireEvent.submit(form);

  expect(button.disabled).toBe(false);
  expect(create).toHaveBeenCalledExactlyOnceWith("Объединить интервалы");
});

it("повторяет проверку подключения через 15 секунд без команды пользователя", async () => {
  vi.useFakeTimers();
  const load = vi.spyOn(api, "getConnections").mockResolvedValue(loggedIn);
  renderConnection();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });

  expect(load).toHaveBeenCalledTimes(1);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(14_998);
  });

  expect(load).toHaveBeenCalledTimes(1);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });

  expect(load).toHaveBeenCalledTimes(2);
});
