import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { noOpLogger } from "../logger.js";
import { observedSqliteSaver } from "../storage/checkpointer.js";
import { createAgentSteps } from "./agent-steps.js";
import { createNodeLogger } from "./node-logging.js";
import type { AgentHooks } from "./role-call.js";
import type { TaskState } from "./types.js";

const GraphState = Annotation.Root({ value: Annotation<TaskState> });

// Собирает единственный порядок шагов; резервирование всегда предшествует внешнему вызову.
function buildGraph(checkpointPath: string, hooks: AgentHooks) {
  const logger = hooks.logger ?? noOpLogger;
  const lastCompletedNode = new Map<string, string>();
  const observedNode = createNodeLogger(logger, lastCompletedNode);
  const steps = createAgentSteps(hooks);
  const graph = new StateGraph(GraphState)
    .addNode("prepareAuthor", observedNode("prepareAuthor", steps.prepareAuthor))
    .addNode("callAuthor", observedNode("callAuthor", steps.callAuthor))
    .addNode("check", observedNode("check", steps.check))
    .addNode("prepareReviewer", observedNode("prepareReviewer", steps.prepareReviewer))
    .addNode("callReviewer", observedNode("callReviewer", steps.callReviewer))
    .addNode("waitApproval", observedNode("waitApproval", steps.waitApproval))
    .addNode("pauseUnknown", observedNode("pauseUnknown", steps.pauseUnknown))
    .addNode("pauseAuth", observedNode("pauseAuth", steps.pauseAuth))
    .addNode("prepareApplier", observedNode("prepareApplier", steps.prepareApplier))
    .addNode("callApplier", observedNode("callApplier", steps.callApplier))
    .addEdge(START, "prepareAuthor")
    .addConditionalEdges(
      "prepareAuthor",
      /* Вызывает автора только после успешного резервирования бюджета. */ (state) =>
        state.value.phase === "stopped" ? END : "callAuthor",
    )
    .addConditionalEdges(
      "callAuthor",
      /* Направляет новую версию на проверку, а неизвестный исход и отказ входа — на паузу. */ (
        state,
      ) =>
        state.value.phase === "checking"
          ? "check"
          : state.value.phase === "unknown_outcome"
            ? "pauseUnknown"
            : state.value.phase === "awaiting_auth"
              ? "pauseAuth"
              : END,
    )
    .addConditionalEdges(
      "check",
      /* Передаёт проверенную версию ревьюеру, если выполнение не остановлено. */ (state) =>
        state.value.phase === "review" ? "prepareReviewer" : END,
    )
    .addConditionalEdges(
      "prepareReviewer",
      /* Вызывает ревьюера только после резервирования попытки. */ (state) =>
        state.value.phase === "stopped" ? END : "callReviewer",
    )
    .addConditionalEdges(
      "callReviewer",
      /* Выбирает подтверждение, исправление автором или паузу по результату ревью. */ (state) =>
        state.value.phase === "awaiting_approval"
          ? "waitApproval"
          : state.value.phase === "author"
            ? "prepareAuthor"
            : state.value.phase === "unknown_outcome"
              ? "pauseUnknown"
              : state.value.phase === "awaiting_auth"
                ? "pauseAuth"
                : END,
    )
    .addConditionalEdges(
      "waitApproval",
      /* Передаёт подтверждённую версию применяющему агенту. */ (state) =>
        state.value.phase === "applying" ? "prepareApplier" : END,
    )
    .addConditionalEdges(
      "pauseUnknown",
      /* Повторяет роль неизвестной попытки только после явного возобновления. */ (state) =>
        state.value.phase === "stopped"
          ? END
          : state.value.lastAttempt?.role === "reviewer"
            ? "prepareReviewer"
            : state.value.lastAttempt?.role === "applier"
              ? "prepareApplier"
              : "prepareAuthor",
    )
    .addConditionalEdges(
      "pauseAuth",
      /* Возобновляет только роль, остановленную отсутствием входа. */ (state) =>
        state.value.phase === "stopped"
          ? END
          : state.value.lastAttempt?.role === "reviewer"
            ? "prepareReviewer"
            : state.value.lastAttempt?.role === "applier"
              ? "prepareApplier"
              : "prepareAuthor",
    )
    .addConditionalEdges(
      "prepareApplier",
      /* Вызывает применяющего агента после резервирования бюджета. */ (state) =>
        state.value.phase === "stopped" ? END : "callApplier",
    )
    .addConditionalEdges(
      "callApplier",
      /* Ожидает решения при неизвестном исходе или отсутствующем входе; остальные исходы завершает. */ (
        state,
      ) =>
        state.value.phase === "unknown_outcome"
          ? "pauseUnknown"
          : state.value.phase === "awaiting_auth"
            ? "pauseAuth"
            : END,
    );
  return graph.compile({
    checkpointer: observedSqliteSaver(
      checkpointPath,
      logger,
      /* Возвращает последний завершённый узел для записи диагностики checkpoint. */ (taskId) =>
        lastCompletedNode.get(taskId) ?? null,
    ),
  });
}

// Создаёт исполняемый граф с синхронным сохранением состояния в SQLite.
export function createTaskGraph(
  checkpointPath: string,
  hooks: AgentHooks,
): ReturnType<typeof buildGraph> {
  return buildGraph(checkpointPath, hooks);
}
