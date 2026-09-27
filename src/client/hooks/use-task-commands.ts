import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TaskSnapshotResponse } from "../../shared/api";
import { createTask, decideTask, resumeTask, stopTask } from "../api/tasks";
import { errorMessage } from "../api/http";
import { acceptSnapshot, taskKeys } from "./task-cache";

type Command =
  | { type: "create"; text: string; key: string }
  | { type: "decide"; snapshot: TaskSnapshotResponse; decision: "approve" | "reject" }
  | { type: "stop"; taskId: string }
  | { type: "resume"; snapshot: TaskSnapshotResponse };

type CommandResult = { createdTaskId: string } | { snapshot: TaskSnapshotResponse };

/** Выполняет ровно одну команду; неизвестный исход повторяется только по явному действию. */
async function executeCommand(command: Command): Promise<CommandResult> {
  if (command.type === "create") {
    const result = await createTask(command.text, command.key);
    return { createdTaskId: result.taskId };
  }
  if (command.type === "stop") return { snapshot: await stopTask(command.taskId) };
  const { snapshot } = command;
  if (command.type === "resume") {
    const mode = snapshot.actions.resumeRequiresExplicitRetry ? "retry_unknown" : "continue";
    return { snapshot: await resumeTask(snapshot.task.taskId, mode) };
  }
  const { currentVersionId, currentManifestHash } = snapshot.state;
  if (!currentVersionId || !currentManifestHash)
    throw new Error("Версия ещё не готова для решения.");
  return {
    snapshot: await decideTask(snapshot.task.taskId, {
      decisionId: `${snapshot.task.taskId}:${currentManifestHash}:${command.decision}`,
      decision: command.decision,
      versionId: currentVersionId,
      manifestHash: currentManifestHash,
    }),
  };
}

export interface TaskCommands {
  busy: boolean;
  error: string;
  clearError: () => void;
  create: (text: string) => Promise<void>;
  decide: (snapshot: TaskSnapshotResponse, decision: "approve" | "reject") => Promise<void>;
  stop: (taskId: string) => Promise<void>;
  resume: (snapshot: TaskSnapshotResponse) => Promise<void>;
}

/** Управляет командами без автоматических повторов и защищает от двойного нажатия. */
export function useTaskCommands(
  onCreated: (taskId: string) => void,
  selectedTaskId?: string | null,
): TaskCommands {
  const client = useQueryClient();
  const lock = useRef(false);
  const createAttempt = useRef<{ text: string; key: string } | null>(null);
  const selection = useRef({ taskId: selectedTaskId, generation: 0 });
  if (selection.current.taskId !== selectedTaskId) {
    selection.current = { taskId: selectedTaskId, generation: selection.current.generation + 1 };
  }
  const [failure, setFailure] = useState<{ generation: number; message: string } | null>(null);
  const error = failure?.generation === selection.current.generation ? failure.message : "";
  const [busy, setBusy] = useState(false);
  const mutation = useMutation({ mutationFn: executeCommand, retry: false });

  /** Удерживает блокировку до ответа; ошибка оставляет возможность явного повтора. */
  async function perform(command: Command): Promise<void> {
    if (lock.current) return;
    lock.current = true;
    const generation = selection.current.generation;
    setBusy(true);
    setFailure(null);
    try {
      const result = await mutation.mutateAsync(command);
      if ("createdTaskId" in result) {
        createAttempt.current = null;
        if (selection.current.generation === generation) onCreated(result.createdTaskId);
      } else {
        // Ответ команды обновляет только кеш её задачи и не откатывает историю.
        client.setQueryData<TaskSnapshotResponse>(
          taskKeys.detail(result.snapshot.task.taskId),
          (previous) => acceptSnapshot(previous, result.snapshot),
        );
      }
      await client.invalidateQueries({ queryKey: taskKeys.list });
    } catch (cause) {
      if (selection.current.generation === generation) {
        setFailure({ generation, message: errorMessage(cause) });
      }
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  /** Сохраняет ключ при ошибке создания; изменение текста начинает новую попытку. */
  async function create(text: string): Promise<void> {
    if (lock.current) return;
    const input = text.trim();
    if (!input) {
      setFailure({
        generation: selection.current.generation,
        message: "Опишите функцию или выберите пример.",
      });
      return;
    }
    if (!createAttempt.current || createAttempt.current.text !== input) {
      createAttempt.current = { text: input, key: crypto.randomUUID() };
    }
    await perform({ type: "create", ...createAttempt.current });
  }

  /** Передаёт выбор человека вместе с показанной ему версией. */
  async function decide(
    snapshot: TaskSnapshotResponse,
    decision: "approve" | "reject",
  ): Promise<void> {
    await perform({ type: "decide", snapshot, decision });
  }

  /** Запрашивает остановку выбранной задачи. */
  async function stop(taskId: string): Promise<void> {
    await perform({ type: "stop", taskId });
  }

  /** Продолжает сохранённую задачу с режимом, указанным её доступными действиями. */
  async function resume(snapshot: TaskSnapshotResponse): Promise<void> {
    await perform({ type: "resume", snapshot });
  }

  /** Убирает сообщение при закрытии уведомления или смене задачи. */
  function clearError(): void {
    setFailure(null);
  }

  return { busy, error, clearError, create, decide, stop, resume };
}
