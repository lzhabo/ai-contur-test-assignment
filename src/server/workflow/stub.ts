import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

// E1 placeholder that establishes the graph/checkpointer seam. E2 replaces
// its single node with the durable role workflow and external-action boundaries.
const StubState = Annotation.Root({
  taskId: Annotation<string>,
  phase: Annotation<"preparing">,
});

export function createWorkflowStub(checkpointPath: string) {
  return new StateGraph(StubState)
    .addNode("prepare", () => ({ phase: "preparing" as const }))
    .addEdge(START, "prepare")
    .addEdge("prepare", END)
    .compile({ checkpointer: SqliteSaver.fromConnString(checkpointPath) });
}
