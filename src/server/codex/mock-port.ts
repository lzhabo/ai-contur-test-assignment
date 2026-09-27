import type { CodexPort, CodexRunHooks, CodexRunRequest, CodexRunResult } from "../tasks/ports.js";
import type { AuthorOutput, CodexOutput } from "../tasks/types.js";

export type MockScenario = "happy" | "review_loop" | "no_response" | "review_once" | "slow";

const candidates: Record<string, AuthorOutput> = {
  mergeIntervals: {
    kind: "candidate",
    functionName: "mergeIntervals",
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
      {
        name: "touching",
        args: [
          [
            [1, 2],
            [2, 4],
          ],
        ],
        expected: [[1, 4]],
      },
      {
        name: "unsorted",
        args: [
          [
            [5, 6],
            [1, 3],
            [2, 4],
          ],
        ],
        expected: [
          [1, 4],
          [5, 6],
        ],
      },
    ],
  },
  shortestPath: {
    kind: "candidate",
    functionName: "shortestPath",
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
      {
        name: "path",
        args: [{ A: ["B"], B: ["A", "C"], C: ["B"] }, "A", "C"],
        expected: ["A", "B", "C"],
      },
      { name: "missing", args: [{ A: [] }, "A", "B"], expected: [] },
      { name: "same vertex", args: [{ A: [] }, "A", "A"], expected: ["A"] },
    ],
  },
  catify: {
    kind: "candidate",
    functionName: "catify",
    solutionTs:
      "export function catify(text: string): string { return text.replace(/\\p{L}+/gu, 'мяу'); }",
    cases: [
      { name: "unicode", args: ["Привет, world!"], expected: "мяу, мяу!" },
      { name: "digits", args: ["42 cats"], expected: "42 мяу" },
    ],
  },
};

// Создаёт ошибку отмены вызова замоканной модели.
function abortError(): Error {
  return Object.assign(new Error("Mock Codex aborted"), { name: "AbortError" });
}

// Ожидает заданную задержку и прекращает ожидание при отмене задачи.
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(
    /* Ожидает задержку mock-сценария и прекращает ожидание при отмене. */ (resolve, reject) => {
      if (signal.aborted) return reject(abortError());
      const timer = setTimeout(
        /* Завершает задержку и снимает обработчик отмены. */ () => {
          signal.removeEventListener("abort", abort);
          resolve();
        },
        ms,
      );
      const abort = /* Отменяет таймер и отклоняет задержку с ошибкой остановки. */ () => {
        clearTimeout(timer);
        reject(abortError());
      };
      signal.addEventListener("abort", abort, { once: true });
    },
  );
}

// Создаёт mock-адаптер с управляемыми ответами для проверки выбранного сценария.
export function createMockCodexPort(scenario: MockScenario): CodexPort {
  return {
    // Возвращает замоканный ответ роли и записывает наблюдаемые этапы вызова.
    async run(request: CodexRunRequest, hooks: CodexRunHooks): Promise<CodexRunResult> {
      await hooks.onObservation({
        at: new Date().toISOString(),
        source: "mock-adapter",
        name: "mock.started",
        stage: "local_started",
        detail: request.role,
      });
      if (scenario === "no_response") await wait(request.timeoutMs + 100, hooks.signal);
      else if (scenario === "slow")
        await wait(Math.min(request.timeoutMs / 2, 1_000), hooks.signal);
      else if (hooks.signal.aborted) throw abortError();

      let output: CodexOutput;
      if (request.role === "author") {
        const context = JSON.parse(request.contextText) as {
          taskText: string;
          createdVersions: number;
        };
        const candidate = context.taskText.includes("shortestPath")
          ? candidates.shortestPath
          : context.taskText.includes("catify")
            ? candidates.catify
            : candidates.mergeIntervals;
        output = structuredClone(candidate);
        // Замоканная версия с намеренной ошибкой: первый ответ автора нарушает
        // граничный случай, следующий исправляет его. Настоящие ответы не подменяются этим адаптером.
        if (scenario === "review_once" && context.createdVersions === 0) {
          if (candidate.functionName === "catify")
            output.solutionTs = output.solutionTs.replace("\\p{L}+", "[A-Za-z]+");
          else if (candidate.functionName === "shortestPath")
            output.solutionTs = output.solutionTs.replace(
              "return path;",
              "return path.length === 1 ? [] : path;",
            );
          else output.solutionTs = output.solutionTs.replace("start <= last[1]", "start < last[1]");
        }
      } else if (request.role === "reviewer") {
        const version = /"createdVersions":(\d+)/.exec(request.contextText)?.[1];
        const reject =
          scenario === "review_loop" || (scenario === "review_once" && version === "1");
        const context = JSON.parse(request.contextText) as { taskText: string };
        const finding =
          scenario === "review_loop"
            ? "Демонстрация лимита: ревьюер намеренно снова требует доработку."
            : context.taskText.includes("catify")
              ? "Для входа «Привет, world!» ожидается «мяу, мяу!»: кириллица не заменяется. Используйте Unicode-буквы."
              : context.taskText.includes("shortestPath")
                ? "При start=end=A и graph={A:[]} ожидается [A], а не []. Исправьте путь из одной вершины."
                : "Для [[1,2],[2,4]] ожидается [[1,4]]. Соприкасающиеся интервалы должны объединяться: учитывайте равенство границ.";
        output = {
          kind: "review",
          verdict: reject ? "changes_requested" : "approved",
          findings: reject ? [finding] : [],
        };
      } else {
        const parsed = JSON.parse(request.contextText) as {
          currentArtifact: { versionId: string; manifestHash: string };
        };
        output = {
          kind: "apply_request",
          versionId: parsed.currentArtifact.versionId,
          manifestHash: parsed.currentArtifact.manifestHash,
        };
      }
      await hooks.onObservation({
        at: new Date().toISOString(),
        source: "mock-adapter",
        name: "mock.completed",
        stage: "process_exited",
        detail: null,
      });
      return { output, modelId: request.modelId, responseAt: new Date().toISOString() };
    },
  };
}
