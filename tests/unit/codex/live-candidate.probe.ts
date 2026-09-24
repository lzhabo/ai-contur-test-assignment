import { CodexCliPort } from "../../../src/server/codex/cli-port.js";

const observations: string[] = [];
const result = await new CodexCliPort(process.env.E2_CODEX_BINARY).run({
  taskId: "e2_probe",
  attemptId: "e2_probe_author_1",
  role: "author",
  modelId: "gpt-6-sol",
  expectedOutputKind: "candidate",
  timeoutMs: 60_000,
  contextText: "You are the author. Return a candidate for a pure synchronous TypeScript function named add(a: number, b: number): number that returns a + b. Include exactly one test case: name sum, args [2,3], expected 5. Return only the structured response.",
}, {
  signal: new AbortController().signal,
  onObservation: async (observation) => { observations.push(`${observation.stage}:${observation.name}`); },
});

console.log(JSON.stringify({
  requestedModelId: result.modelId,
  outputKind: result.output.kind,
  functionName: result.output.kind === "candidate" ? result.output.functionName : null,
  cases: result.output.kind === "candidate" ? result.output.cases : null,
  observations,
}));
