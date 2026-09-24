import type { AuthorOutput, CodexOutput } from "../../shared/contracts.js";
import type { CodexPort, CodexRunHooks, CodexRunRequest, CodexRunResult } from "../../shared/ports.js";

export type FakeScenario = "happy" | "review_loop" | "no_response" | "review_once" | "slow";

const candidates: Record<string, AuthorOutput> = {
  mergeIntervals: {
    kind: "candidate", functionName: "mergeIntervals",
    solutionTs: `export function mergeIntervals(intervals: number[][]): number[][] {
  if (!Array.isArray(intervals) || intervals.some(item => !Array.isArray(item) || item.length !== 2 || !item.every(Number.isFinite) || item[0] > item[1])) return [];
  const sorted = intervals.map(item => [...item]).sort((a, b) => a[0] - b[0]);
  const result: number[][] = [];
  for (const [start, end] of sorted) {
    const last = result.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else result.push([start, end]);
  }
  return result;
}`,
    cases: [
      { name: "empty", args: [[]], expected: [] },
      { name: "touching", args: [[[1, 2], [2, 4]]], expected: [[1, 4]] },
      { name: "unsorted", args: [[[5, 6], [1, 3], [2, 4]]], expected: [[1, 4], [5, 6]] },
    ],
  },
  shortestPath: {
    kind: "candidate", functionName: "shortestPath",
    solutionTs: `export function shortestPath(graph: Record<string, string[]>, start: string, end: string): string[] {
  if (!(start in graph) || !(end in graph)) return [];
  const queue: string[][] = [[start]];
  const seen = new Set([start]);
  for (let index = 0; index < queue.length; index++) {
    const path = queue[index];
    const node = path[path.length - 1];
    if (node === end) return path;
    for (const neighbor of graph[node] ?? []) {
      if (!seen.has(neighbor)) { seen.add(neighbor); queue.push([...path, neighbor]); }
    }
  }
  return [];
}`,
    cases: [
      { name: "path", args: [{ A: ["B"], B: ["A", "C"], C: ["B"] }, "A", "C"], expected: ["A", "B", "C"] },
      { name: "missing", args: [{ A: [] }, "A", "B"], expected: [] },
    ],
  },
  catify: {
    kind: "candidate", functionName: "catify",
    solutionTs: "export function catify(text: string): string { return text.replace(/\\p{L}+/gu, 'мяу'); }",
    cases: [
      { name: "unicode", args: ["Привет, world!"], expected: "мяу, мяу!" },
      { name: "digits", args: ["42 cats"], expected: "42 мяу" },
    ],
  },
};

function abortError(): Error { return Object.assign(new Error("Fake Codex aborted"), { name: "AbortError" }); }

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(abortError()); };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function createFakeCodexPort(scenario: FakeScenario): CodexPort {
  return {
    async run(request: CodexRunRequest, hooks: CodexRunHooks): Promise<CodexRunResult> {
      await hooks.onObservation({ at: new Date().toISOString(), source: "fake-adapter", name: "fake.started", stage: "local_started", detail: request.role });
      if (scenario === "no_response") await wait(request.timeoutMs + 100, hooks.signal);
      else if (scenario === "slow") await wait(Math.min(request.timeoutMs / 2, 1_000), hooks.signal);
      else if (hooks.signal.aborted) throw abortError();

      let output: CodexOutput;
      if (request.role === "author") {
        const task = request.contextText;
        output = task.includes("shortestPath") ? candidates.shortestPath : task.includes("catify") ? candidates.catify : candidates.mergeIntervals;
      } else if (request.role === "reviewer") {
        const version = /"createdVersions":(\d+)/.exec(request.contextText)?.[1];
        const reject = scenario === "review_loop" || (scenario === "review_once" && version === "1");
        output = { kind: "review", verdict: reject ? "changes_requested" : "approved", findings: reject ? ["Добавьте граничный случай и повторите проверку."] : [] };
      } else {
        const parsed = JSON.parse(request.contextText) as { currentArtifact: { versionId: string; manifestHash: string } };
        output = { kind: "apply_request", versionId: parsed.currentArtifact.versionId, manifestHash: parsed.currentArtifact.manifestHash };
      }
      await hooks.onObservation({ at: new Date().toISOString(), source: "fake-adapter", name: "fake.completed", stage: "process_exited", detail: null });
      return { output, modelId: request.modelId, responseAt: new Date().toISOString() };
    },
  };
}
