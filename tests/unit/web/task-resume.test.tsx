// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import * as connectionsApi from "../../../src/client/api/connections";
import * as tasksApi from "../../../src/client/api/tasks";
import { HttpError } from "../../../src/client/api/http";
import { ConnectionStatus } from "../../../src/client/components/ConnectionStatus";
import { TaskStatus } from "../../../src/client/components/TaskStatus";
import { useConnections } from "../../../src/client/hooks/use-connections";
import { useTaskCommands } from "../../../src/client/hooks/use-task-commands";
import { taskKeys } from "../../../src/client/hooks/task-cache";
import type { CodexReadiness } from "../../../src/shared/connections";
import type { TaskSnapshotResponse } from "../../../src/shared/api";
import { event, snapshot } from "../../support/snapshot";

const clients: QueryClient[] = [];
const loggedIn: CodexReadiness = {
  executionMode: "real",
  ready: true,
  checkedAt: "2026-10-02T10:00:00.000Z",
  checks: [{ id: "auth", status: "passed", message: "Вход подтверждён." }],
};
const loggedOut: CodexReadiness = {
  ...loggedIn,
  ready: false,
  checks: [{ id: "auth", status: "failed", message: "Выполните codex login." }],
};

afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function pausedTask(): TaskSnapshotResponse {
  const data = snapshot(
    [event(5, "phase_changed", { text: "Нужен вход в Codex." })],
    "awaiting_auth",
  );
  data.state.executionMode = "real";
  data.state.currentVersionId = "saved-version";
  data.state.usedModelCalls = 2;
  data.actions.canResume = true;
  return data;
}

// Компонент и hooks настоящие; mock ограничен HTTP-ответами входа и продолжения.
function ResumeScreen({ data }: { data: TaskSnapshotResponse }) {
  const connection = useConnections();
  const commands = useTaskCommands(() => {}, data.task.taskId);
  return (
    <>
      <ConnectionStatus {...connection} />
      {commands.error && <p role="alert">{commands.error}</p>}
      <TaskStatus
        snapshot={data}
        connected={true}
        connectionReady={connection.ready}
        commands={commands}
      />
    </>
  );
}

function renderResume(data: TaskSnapshotResponse) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  clients.push(client);
  const rendered = render(
    <QueryClientProvider client={client}>
      <ResumeScreen data={data} />
    </QueryClientProvider>,
  );
  return { client, ...rendered };
}

it("после login ждёт окончания проверки и явного продолжения; двойное нажатие создаёт один вызов для сохранённой задачи", async () => {
  const checking = deferred<CodexReadiness>();
  const continuing = deferred<TaskSnapshotResponse>();
  vi.spyOn(connectionsApi, "getConnections")
    .mockResolvedValueOnce(loggedOut)
    .mockReturnValueOnce(checking.promise);
  const resume = vi.spyOn(tasksApi, "resumeTask").mockReturnValue(continuing.promise);
  const create = vi.spyOn(tasksApi, "createTask");
  const data = pausedTask();
  const { client } = renderResume(data);
  await screen.findByText("Выполните codex login.");
  const button = screen.getByRole("button", {
    name: "Продолжить",
  }) as HTMLButtonElement;

  fireEvent.click(button);

  expect(button.disabled).toBe(true);
  expect(resume).not.toHaveBeenCalled();
  expect(screen.getByText(/Данные и завершённые этапы сохранены/)).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Проверить снова" }));
  await screen.findByRole("button", { name: "Проверяем…" });

  expect(button.disabled).toBe(true);

  await act(async () => {
    checking.resolve(loggedIn);
    await checking.promise;
  });
  await waitFor(() => expect(button.disabled).toBe(false));

  expect(resume).not.toHaveBeenCalled();

  fireEvent.click(button);
  fireEvent.click(button);
  await waitFor(() => expect(resume).toHaveBeenCalledExactlyOnceWith("task", "continue"));

  expect(button.disabled).toBe(true);
  expect(create).not.toHaveBeenCalled();

  const latest = { ...data, lastEventSequence: 8 };
  client.setQueryData(taskKeys.detail("task"), latest);
  await act(async () => {
    continuing.resolve({ ...data, lastEventSequence: 6 });
    await continuing.promise;
  });

  expect(client.getQueryData(taskKeys.detail("task"))).toEqual(latest);
  expect(data.state.currentVersionId).toBe("saved-version");
});

it("logout перед продолжением показывает отказ и обновляет вход; после relogin повтор остаётся явным", async () => {
  vi.spyOn(connectionsApi, "getConnections")
    .mockResolvedValueOnce(loggedIn)
    .mockResolvedValueOnce(loggedOut)
    .mockResolvedValueOnce(loggedIn);
  const data = pausedTask();
  const resume = vi
    .spyOn(tasksApi, "resumeTask")
    .mockRejectedValueOnce(new HttpError("Вход в Codex отсутствует.", 503, "codex_not_ready"))
    .mockResolvedValueOnce(data);
  renderResume(data);
  await screen.findByText("Вход подтверждён.");
  const button = screen.getByRole("button", {
    name: "Продолжить",
  }) as HTMLButtonElement;

  fireEvent.click(button);
  await screen.findByText("Выполните codex login.");

  expect(screen.getByRole("alert").textContent).toContain("Вход в Codex отсутствует.");
  expect(button.disabled).toBe(true);
  expect(resume).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole("button", { name: "Проверить снова" }));
  await screen.findByText("Вход подтверждён.");

  expect(screen.queryByRole("alert")).toBeNull();
  expect(button.disabled).toBe(false);
  expect(resume).toHaveBeenCalledTimes(1);

  fireEvent.click(button);
  await waitFor(() => expect(resume).toHaveBeenCalledTimes(2));

  expect(resume.mock.calls).toEqual([
    ["task", "continue"],
    ["task", "continue"],
  ]);
});

it("неизвестный исход сохраняет отдельное предупреждение и явный retry_unknown после восстановления входа", async () => {
  vi.spyOn(connectionsApi, "getConnections").mockResolvedValue(loggedIn);
  const data = snapshot([], "unknown_outcome");
  data.actions.canResume = true;
  data.actions.resumeRequiresExplicitRetry = true;
  const resume = vi.spyOn(tasksApi, "resumeTask").mockRejectedValue(new Error("Ответ потерян"));
  renderResume(data);
  await screen.findByText("Вход подтверждён.");

  expect(screen.getByText(/Исход предыдущего вызова неизвестен/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Продолжить" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Повторить неизвестный вызов" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Проверить снова" }));
  await screen.findByText("Вход подтверждён.");

  expect(resume).toHaveBeenCalledExactlyOnceWith("task", "retry_unknown");
  expect(screen.getByRole("alert").textContent).toBe("Ответ потерян");
});

it("обычная ошибка без разрешения сервера не предлагает продолжение", () => {
  vi.spyOn(connectionsApi, "getConnections").mockResolvedValue(loggedIn);
  renderResume(snapshot([], "error"));

  expect(screen.queryByRole("button", { name: "Продолжить" })).toBeNull();
});
