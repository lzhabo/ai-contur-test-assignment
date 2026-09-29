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
  options: { auth?: string; version?: string } = {},
): Promise<{ binary: string; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mock-codex-"));
  roots.push(root);
  const binary = path.join(root, "codex");
  await writeFile(
    binary,
    `#!/usr/bin/env node\nif (process.argv[2] === '--version') { ${options.version ?? "console.log('codex-cli 0.156.1'); process.exit(0);"} } else if (process.argv[2] === 'login') { ${options.auth ?? "console.error('Logged in using ChatGPT'); process.exit(0);"} } else {\n${typeof body === "string" ? body : body(root)}\n}\n`,
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
  it("проверяет CLI и локальный вход без вызова модели и без раскрытия ключа", async () => {
    const { binary } = await mockCli("throw new Error('exec must not run')", {
      auth: "console.error('Logged in using an API key - sk-private-secret'); process.exit(0);",
    });

    const readiness = await new CodexCliPort(binary).checkReadiness();

    expect(readiness.ready).toBe(true);
    expect(readiness.checks.map(({ status }) => status)).toEqual([
      "passed",
      "passed",
      "not_checked",
    ]);
    expect(JSON.stringify(readiness)).not.toContain("sk-private-secret");
  });

  it("после выхода из аккаунта повторно проверяет вход и не вызывает exec", async () => {
    const { binary, root } = await mockCli("throw new Error('exec must not run')", {
      auth: "if (require('node:fs').existsSync(__dirname + '/logout')) { console.error('Not logged in'); process.exit(1); } console.error('Logged in using ChatGPT'); process.exit(0);",
    });
    const cli = new CodexCliPort(binary);
    expect((await cli.checkReadiness()).ready).toBe(true);
    await writeFile(path.join(root, "logout"), "");

    await expect(
      cli.run(request, {
        signal: new AbortController().signal,
        onObservation: async () => {},
      }),
    ).rejects.toMatchObject({
      code: "auth_required",
      message: expect.stringContaining("codex login"),
    });
    expect((await cli.checkReadiness()).checks[1]?.status).toBe("failed");
  });

  it.each([
    {
      options: { version: "console.log('codex-cli 0.100.0'); process.exit(0);" },
      code: "cli_incompatible",
    },
    {
      options: { auth: "console.error('Unknown failure sk-private-secret'); process.exit(1);" },
      code: "connection_check_failed",
    },
    { options: { auth: "console.log('Not logged in'); process.exit(0);" }, code: "auth_required" },
    {
      options: { auth: "process.stdout.write('x'.repeat(40000)); setInterval(() => {}, 1000);" },
      code: "connection_check_failed",
    },
  ])("отклоняет неподтверждённую готовность: $code", async ({ options, code }) => {
    const { binary } = await mockCli("throw new Error('exec must not run')", options);

    const failure = await new CodexCliPort(binary)
      .run(request, {
        signal: new AbortController().signal,
        onObservation: async () => {},
      })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code });
    expect(String(failure)).not.toContain("sk-private-secret");
  });

  it("объясняет отсутствие бинарника и пропускает проверку входа", async () => {
    const cli = new CodexCliPort("/missing-kontur-codex");

    const readiness = await cli.checkReadiness();

    expect(readiness.ready).toBe(false);
    expect(readiness.checks.map(({ status }) => status)).toEqual([
      "failed",
      "not_checked",
      "not_checked",
    ]);
    await expect(
      cli.run(request, { signal: new AbortController().signal, onObservation: async () => {} }),
    ).rejects.toMatchObject({ code: "cli_unavailable" });
  });

  it("ограничивает время проверки входа до запуска модели", async () => {
    const { binary } = await mockCli("throw new Error('exec must not run')", {
      auth: "setInterval(() => {}, 1000);",
    });

    await expect(
      new CodexCliPort(binary).run(
        { ...request, timeoutMs: 300 },
        {
          signal: new AbortController().signal,
          onObservation: async () => {},
        },
      ),
    ).rejects.toMatchObject({ code: "connection_check_failed" });
  });

  it.each([
    { status: 401, code: "auth_required", action: "codex login" },
    { status: 403, code: "access_denied", action: "доступ" },
    { status: 429, code: "rate_limited", action: "лимит" },
  ])(
    "объясняет отказ $status в turn.failed без вывода диагностики",
    async ({ status, code, action }) => {
      const { binary } = await mockCli(
        `console.log(JSON.stringify({type:'turn.failed',error:{message:'unexpected status ${status} secret-private-text'}}));`,
      );

      const failure = await new CodexCliPort(binary)
        .run(request, {
          signal: new AbortController().signal,
          onObservation: async () => {},
        })
        .catch((error: unknown) => error);

      expect(failure).toMatchObject({ code, message: expect.stringContaining(action) });
      expect(String(failure)).not.toContain("secret-private-text");
    },
  );

  it("сохраняет неизвестный исход при сетевом обрыве", async () => {
    const { binary } = await mockCli(
      "console.log(JSON.stringify({type:'error',message:'connection reset by peer'}));",
    );

    const failure = await new CodexCliPort(binary)
      .run(request, {
        signal: new AbortController().signal,
        onObservation: async () => {},
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toHaveProperty("code");
    expect(String(failure)).not.toContain("connection reset by peer");
  });

  it("при отмене проверки входа завершает её группу процессов и не запускает модель", async () => {
    const { binary, root } = await mockCli("throw new Error('exec must not run')", {
      // Потомок подтверждает запуск обработчика SIGTERM: проверяется также отложенный SIGKILL.
      auth: `const pidPath = __dirname + '/auth-child.pid';
        require('node:child_process').spawn(process.execPath, ['-e',
          "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(" + JSON.stringify(pidPath) + ", String(process.pid)); setInterval(() => {}, 1000);"
        ], {stdio: 'ignore'});
        setInterval(() => {}, 1000);`,
    });
    const controller = new AbortController();
    const running = new CodexCliPort(binary)
      .run(request, {
        signal: controller.signal,
        onObservation: async () => {},
      })
      .catch((error: unknown) => error);
    const pidPath = path.join(root, "auth-child.pid");
    await expect
      .poll(() => readFile(pidPath, "utf8").catch(() => ""), { timeout: 1500 })
      .not.toBe("");

    controller.abort();

    expect(await running).toMatchObject({ code: "connection_check_failed" });
    const pid = Number(await readFile(pidPath, "utf8"));
    const { spawnSync } = await import("node:child_process");
    await expect
      .poll(
        () => {
          const status = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
          if (status.error || status.stderr.trim())
            throw new Error(
              `Не удалось проверить дочерний процесс: ${status.error?.message ?? status.stderr}`,
            );
          return status.status !== 0 || /^Z/.test(status.stdout.trim());
        },
        { timeout: 3000 },
      )
      .toBe(true);
  });

  it("объясняет таймаут модели по-русски и сохраняет неизвестность исхода", async () => {
    const { binary, root } = await mockCli(
      (root) => `
      require('node:fs').writeFileSync(${JSON.stringify(path.join(root, "exec-started"))}, 'yes');
      console.log(JSON.stringify({type:'turn.started'}));
      setInterval(() => {}, 1000);
    `,
    );

    const failure = await new CodexCliPort(binary)
      .run(
        { ...request, timeoutMs: 1500 },
        {
          signal: new AbortController().signal,
          onObservation: async () => {},
        },
      )
      .catch((error: unknown) => error);

    expect(await readFile(path.join(root, "exec-started"), "utf8")).toBe("yes");
    expect(failure).toMatchObject({ message: expect.stringContaining("Проверьте сеть") });
    expect(failure).not.toHaveProperty("code");
  });

  it("объясняет 401 как отсутствие авторизации, а не неизвестный исход", async () => {
    const { binary } = await mockCli(`
      console.log(JSON.stringify({type:'turn.started'}));
      console.log(JSON.stringify({type:'error',message:'Reconnecting... 2/5 (unexpected status 401 Unauthorized: Missing Bearer authentication in header)'}));
    `);

    const running = new CodexCliPort(binary).run(request, {
      signal: new AbortController().signal,
      onObservation: async () => {},
    });

    await expect(running).rejects.toMatchObject({
      code: "auth_required",
      message: expect.stringContaining("codex login"),
    });
    await expect(running).rejects.toThrow(
      "Если задача уже завершилась ошибкой, после входа создайте её заново.",
    );
  });

  it.each([
    { role: "author", modelId: "gpt-6-luna", expectedOutputKind: "candidate", output: answer },
    {
      role: "reviewer",
      modelId: "gpt-6-sol",
      expectedOutputKind: "review",
      output: { kind: "review", verdict: "approved", findings: [] },
    },
  ] as const)("передаёт модель $modelId для роли $role", async (assignment) => {
    const { binary, root } = await mockCli(
      // Сохраняет фактические аргументы CLI и возвращает ответ выбранной роли.
      (root) => `
        require('node:fs').writeFileSync(${JSON.stringify(path.join(root, "args.json"))}, JSON.stringify(process.argv.slice(2)));
        console.log(JSON.stringify({type:'turn.started'}));
        console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(JSON.stringify(assignment.output))}}}));
        console.log(JSON.stringify({type:'turn.completed'}));
      `,
    );

    const result = await new CodexCliPort(binary).run(
      { ...request, ...assignment },
      {
        signal: new AbortController().signal,
        // Наблюдения процесса не влияют на проверку выбора модели.
        onObservation: async () => {},
      },
    );
    const args = JSON.parse(await readFile(path.join(root, "args.json"), "utf8")) as string[];

    expect(args[args.indexOf("--model") + 1]).toBe(assignment.modelId);
    expect(result.modelId).toBe(assignment.modelId);
    expect(result.output).toEqual(assignment.output);
  });

  it("отклоняет неизвестную модель до запуска CLI", async () => {
    const cli = new CodexCliPort("/missing-kontur-codex");

    await expect(
      cli.run(
        { ...request, modelId: "unsupported-model" },
        {
          signal: new AbortController().signal,
          // Валидация должна завершиться до первого наблюдения процесса.
          onObservation: async () => {},
        },
      ),
    ).rejects.toThrow("Unsupported model ID: unsupported-model");
  });

  it("принимает один структурированный результат после прогресса и передаёт флаги запрета инструментов", async () => {
    // Сверяет флаги запуска и схему, проверяет структурированный результат и наличие сообщения о прогрессе.
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
      onObservation: async () => {},
    });

    expect(result.output).toEqual(nested);
  });

  it("отклоняет ответ при событии запуска инструмента", async () => {
    const { binary } = await mockCli(
      `console.log(JSON.stringify({type:'turn.started'})); console.log(JSON.stringify({type:'item.started',item:{type:'command_execution',command:'cat /secret'}})); setInterval(()=>{},1000);`,
    );

    await expect(
      new CodexCliPort(binary).run(request, {
        signal: new AbortController().signal,
        onObservation: async () => {},
      }),
    ).rejects.toThrow(/Unexpected Codex event/);
  });

  it("собирает символ UTF-8, разделённый между порциями stdout", async () => {
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
      onObservation: async () => {},
    });

    expect(result.output.kind === "candidate" && result.output.solutionTs).toContain("мяу");
  });

  it("отменяет зависший CLI и его дочерний процесс", async () => {
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
