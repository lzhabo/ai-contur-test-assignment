// E0 compatibility probe. Run `start` and `resume` in separate OS processes.
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { Annotation, Command, END, interrupt, START, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

const [stage, databasePath, counterPath] = process.argv.slice(2);
assert.ok(stage === "start" || stage === "resume", "stage must be start or resume");
assert.ok(databasePath && counterPath, "database and counter paths are required");

const State = Annotation.Root({
  authorRuns: Annotation<number>,
  reservedCalls: Annotation<number>,
  attemptId: Annotation<string>,
  phase: Annotation<string>,
  decision: Annotation<string>,
});

const graph = new StateGraph(State)
  .addNode(
    "prepare",
    /* Сохраняет номер попытки и расход бюджета перед внешним вызовом. */ (state) => ({
      phase: "reserved",
      reservedCalls: state.reservedCalls + 1,
      attemptId: "attempt-e0-1",
    }),
  )
  .addNode("author", async (state) => {
    // A fresh SQLite connection must see the reservation before the side effect.
    const committed = await SqliteSaver.fromConnString(databasePath).getTuple(config);

    assert.equal(committed?.checkpoint.channel_values.phase, "reserved");
    assert.equal(committed?.checkpoint.channel_values.reservedCalls, 1);
    assert.equal(committed?.checkpoint.channel_values.attemptId, "attempt-e0-1");
    assert.equal(state.reservedCalls, 1);

    appendFileSync(counterPath, "author\n");
    return { authorRuns: state.authorRuns + 1, phase: "awaiting_approval" };
  })
  .addNode("approval", () => {
    // Приостанавливает граф до решения и записывает его при возобновлении.

    const decision = interrupt({ version: "v1", action: "approve" });
    return { decision: String(decision), phase: "complete" };
  })
  .addEdge(START, "prepare")
  .addEdge("prepare", "author")
  .addEdge("author", "approval")
  .addEdge("approval", END)
  .compile({ checkpointer: SqliteSaver.fromConnString(databasePath) });

const config = {
  configurable: { thread_id: "e0-cross-process" },
  durability: "sync" as const,
};
const count = /* Подсчитывает сохранённые вызовы для обнаружения лишнего повтора. */ () =>
  readFileSync(counterPath, "utf8").trim().split("\n").length;

if (stage === "start") {
  await graph.invoke(
    {
      authorRuns: 0,
      reservedCalls: 0,
      attemptId: "",
      phase: "new",
      decision: "",
    },
    config,
  );
  const snapshot = await graph.getState(config);

  assert.deepEqual(snapshot.next, ["approval"]);
  assert.equal(snapshot.values.authorRuns, 1);
  assert.equal(snapshot.values.reservedCalls, 1);
  assert.equal(snapshot.values.attemptId, "attempt-e0-1");
  assert.equal(snapshot.values.phase, "awaiting_approval");
  assert.equal(count(), 1);
  assert.ok(statSync(databasePath).size > 0);

  console.log(
    JSON.stringify({
      stage,
      next: snapshot.next,
      state: snapshot.values,
      authorCalls: count(),
    }),
  );
} else {
  const before = await graph.getState(config);

  assert.deepEqual(before.next, ["approval"]);
  assert.equal(before.values.authorRuns, 1);
  assert.equal(before.values.reservedCalls, 1);
  assert.equal(before.values.attemptId, "attempt-e0-1");

  await graph.invoke(new Command({ resume: "approved" }), config);
  const after = await graph.getState(config);

  assert.deepEqual(after.next, []);
  assert.equal(after.values.decision, "approved");
  assert.equal(after.values.phase, "complete");
  assert.equal(after.values.authorRuns, 1);
  assert.equal(after.values.reservedCalls, 1);
  assert.equal(after.values.attemptId, "attempt-e0-1");
  assert.equal(count(), 1, "author must not run again after resume");

  console.log(
    JSON.stringify({
      stage,
      next: after.next,
      state: after.values,
      authorCalls: count(),
    }),
  );
}
