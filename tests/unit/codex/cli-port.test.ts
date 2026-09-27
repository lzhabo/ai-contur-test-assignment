import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexCliPort } from "../../../src/server/codex/cli-port.js";
import type { CodexRunRequest } from "../../../src/server/tasks/ports.js";

const roots: string[] = [];
afterEach(async () => {
  // Освобождает процессы и ресурсы сценария, затем удаляет временные данные.
  await Promise.all(
    roots
      .splice(0)
      .map(/* Удаляет временные данные. */ (root) => rm(root, { recursive: true, force: true })),
  );
});
// Создаёт временный исполняемый mock Codex CLI, который воспроизводит заданное поведение процесса.
async function mockCli(
  body: string | ((root: string) => string),
): Promise<{ binary: string; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mock-codex-"));
  roots.push(root);
  const binary = path.join(root, "codex");
  await writeFile(
    binary,
    `#!/usr/bin/env node\nif (process.argv[2] === '--version') { console.log('codex-cli 0.156.1'); process.exit(0); }\n${typeof body === "string" ? body : body(root)}\n`,
    { mode: 0o700 },
  );
  return { binary, root };
}
const request: CodexRunRequest = {
  taskId: "task_1",
  attemptId: "attempt_1",
  role: "author",
  modelId: "gpt-6-sol",
  contextText: "Create a pure function",
  expectedOutputKind: "candidate",
  timeoutMs: 2000,
};
const answer = {
  kind: "candidate",
  functionName: "add",
  solutionTs: "export function add(a: number,b: number) { return a+b; }",
  cases: [{ name: "sum", args: [2, 3], expected: 5 }],
};
const transportAnswer = answer;

describe("взаимодействие с Codex CLI", () => {
  // Объединяет проверки: взаимодействие с Codex CLI.

  it("принимает один структурированный результат после прогресса и передаёт флаги запрета инструментов", async () => {
    const { binary, root } = await mockCli(
      /* Готовит mock CLI, который сохраняет флаги и схему и возвращает структурированный ответ. */ (
        root,
      ) => `
      require('node:fs').writeFileSync(${JSON.stringify(path.join(root, "args.json"))}, JSON.stringify(process.argv.slice(2)));
      const flags = process.argv.slice(2);
      require('node:fs').copyFileSync(flags[flags.indexOf('--output-schema') + 1], ${JSON.stringify(path.join(root, "schema.json"))});
      console.log(JSON.stringify({type:'thread.started',thread_id:'synthetic'}));
      console.log(JSON.stringify({type:'item.completed',item:{type:'error',message:'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable features.code_mode_host.'}}));
      console.log(JSON.stringify({type:'turn.started'}));
      console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Working on it'}}));
      console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(JSON.stringify(transportAnswer))}}}));
      console.log(JSON.stringify({type:'turn.completed'}));
    `,
    );
    const observations: string[] = [];
    const result = await new CodexCliPort(binary).run(request, {
      signal: new AbortController().signal,
      onObservation: async (item) => {
        // Запоминает наблюдения CLI для проверки порядка событий.
        observations.push(item.name);
      },
    });

    expect(result.output).toEqual(answer);
    expect(observations).toContain("agent_progress");

    const flags = JSON.parse(await readFile(path.join(root, "args.json"), "utf8")) as string[];

    expect(flags).toContain("--strict-config");
    expect(flags).toContain("--ignore-user-config");
    expect(flags).toContain("view_image");
    expect(flags).toContain("shell_tool");

    const schema = await readFile(path.join(root, "schema.json"), "utf8");

    expect(schema).not.toContain("propertyNames");
    expect(schema).toContain("$defs");
  });

  it("принимает вложенные объекты и массивы в тестовых случаях JSON", async () => {
    // Проверяет сценарий: принимает вложенные объекты и массивы в тестовых случаях JSON.

    const nested = {
      kind: "candidate",
      functionName: "scan",
      solutionTs: "export function scan(value: unknown) { return value; }",
      cases: [
        {
          name: "graph",
          args: [
            {
              nodes: [
                { id: "A", edges: ["B"] },
                { id: "B", edges: [] },
              ],
            },
          ],
          expected: { seen: ["A", "B"] },
        },
      ],
    };
    const { binary } = await mockCli(
      `console.log(JSON.stringify({type:'turn.started'})); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(JSON.stringify(nested))}}})); console.log(JSON.stringify({type:'turn.completed'}));`,
    );
    const result = await new CodexCliPort(binary).run(request, {
      signal: new AbortController().signal,
      onObservation: async () => {
        // Оставляет необязательный callback пустым.
      },
    });

    expect(result.output).toEqual(nested);
  });

  it("отклоняет ответ при событии запуска инструмента", async () => {
    // Проверяет сценарий: отклоняет ответ при событии запуска инструмента.

    const { binary } = await mockCli(
      `console.log(JSON.stringify({type:'turn.started'})); console.log(JSON.stringify({type:'item.started',item:{type:'command_execution',command:'cat /secret'}})); setInterval(()=>{},1000);`,
    );

    await expect(
      new CodexCliPort(binary).run(request, {
        signal: new AbortController().signal,
        onObservation: async () => {
          // Оставляет необязательный callback пустым.
        },
      }),
    ).rejects.toThrow(/Unexpected Codex event/);
  });

  it("собирает символ UTF-8, разделённый между порциями stdout", async () => {
    // Проверяет сценарий: собирает символ UTF-8, разделённый между порциями stdout.

    const unicode = {
      ...transportAnswer,
      solutionTs: `${transportAnswer.solutionTs} // мяу`,
    };
    const { binary } = await mockCli(`
      console.log(JSON.stringify({type:'turn.started'}));
      const line = JSON.stringify({type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(JSON.stringify(unicode))}}}) + '\\n';
      const bytes = Buffer.from(line);
      const cut = bytes.indexOf(Buffer.from('мяу')) + 1;
      process.stdout.write(bytes.subarray(0,cut));
      setTimeout(() => { process.stdout.write(bytes.subarray(cut)); console.log(JSON.stringify({type:'turn.completed'})); }, 20);
    `);
    const result = await new CodexCliPort(binary).run(request, {
      signal: new AbortController().signal,
      onObservation: async () => {
        // Оставляет необязательный callback пустым.
      },
    });

    expect(result.output.kind === "candidate" && result.output.solutionTs).toContain("мяу");
  });

  it("отменяет зависший CLI и его дочерний процесс", async () => {
    // Проверяет сценарий: отменяет зависший CLI и его дочерний процесс.

    const { binary, root } = await mockCli(
      /* Готовит зависший mock CLI с дочерним процессом sleep. */ (root) => `
      const child = require('node:child_process').spawn('sleep',['60'],{stdio:'ignore'});
      require('node:fs').writeFileSync(${JSON.stringify(path.join(root, "child.pid"))}, String(child.pid));
      console.log(JSON.stringify({type:'turn.started'}));
      setInterval(()=>{},1000);
    `,
    );
    const controller = new AbortController();
    const running = new CodexCliPort(binary).run(
      { ...request, timeoutMs: 1500 },
      {
        signal: controller.signal,
        onObservation: async (item) => {
          // Отменяет вызов сразу после сообщения о начале выполнения.
          if (item.name === "turn_started") controller.abort();
        },
      },
    );

    await expect(running).rejects.toThrow(/aborted/i);

    const pid = Number(await readFile(path.join(root, "child.pid"), "utf8"));
    await new Promise(
      /* Выдерживает короткий интервал перед повторной проверкой состояния. */ (resolve) =>
        setTimeout(resolve, 100),
    );
    const status = await import("node:child_process").then(
      /* Проверяет состояние дочернего процесса системной командой ps. */ ({ spawnSync }) =>
        spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
          encoding: "utf8",
        }),
    );

    expect(status.status !== 0 || /^Z/.test(status.stdout.trim())).toBe(true);
  });
});
