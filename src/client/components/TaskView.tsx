import type { ReactElement } from "react";
import type { TaskSnapshotResponse } from "../../shared/api";
import type { TaskCommands } from "../hooks/use-task-commands";
import { WorkflowGraph } from "../workflow/WorkflowGraph";
import { TaskStatus } from "./TaskStatus";
import { TaskProposal } from "./TaskProposal";

/** Собирает экран сохранённой задачи из состояния, истории и предложения. */
export function TaskView({
  snapshot,
  connected,
  commands,
}: {
  snapshot: TaskSnapshotResponse;
  connected: boolean;
  commands: TaskCommands;
}): ReactElement {
  return (
    <>
      <TaskStatus snapshot={snapshot} connected={connected} commands={commands} />
      <WorkflowGraph snapshot={snapshot} />
      <TaskProposal snapshot={snapshot} commands={commands} />
      <p className="footer-note">
        Показаны сообщения и наблюдаемые действия агентов. Модели настроены на указанные ID; скрытые
        рассуждения не отображаются. ID задачи: <span className="mono">{snapshot.task.taskId}</span>
      </p>
    </>
  );
}
