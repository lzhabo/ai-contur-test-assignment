import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalArtifactStore } from "../../../src/server/storage/local-store.js";
import { QuickJsCheckRunner } from "../../../src/server/code-runner/quickjs-runner.js";
import type { JsonValue } from "../../../src/server/tasks/types.js";

const roots: string[] = [];
afterEach(async () => {
  // Освобождает процессы и ресурсы сценария, затем удаляет временные данные.
  await Promise.all(
    roots
      .splice(0)
      .map(/* Удаляет временные данные. */ (root) => rm(root, { recursive: true, force: true })),
  );
});
// Запускает переданную функцию add в QuickJS с аргументами 2 и 3 и указанным ожидаемым результатом.
async function run(solutionTs: string, expected: JsonValue = 5) {
  const root = await mkdtemp(path.join(os.tmpdir(), "check-test-"));
  roots.push(root);
  const store = new LocalArtifactStore(root);
  const ref = await store.writeVersion({
    taskId: "task_1",
    candidate: {
      kind: "candidate",
      functionName: "add",
      solutionTs,
      cases: [{ name: "sum", args: [2, 3], expected }],
    },
  });
  return new QuickJsCheckRunner(store).run(ref, {
    signal: new AbortController().signal,
    timeoutMs: 2000,
    memoryLimitBytes: 64 * 1024 * 1024,
  });
}

describe("изолированное выполнение TypeScript", () => {
  it("проверяет типы и сравнивает результаты JSON", async () => {
    // Выполняет корректную функцию сложения и проверяет успешную компиляцию и сравнение результата.
    const result = await run("export function add(a: number, b: number): number { return a + b; }");

    expect(result.compilation.status).toBe("passed");
    expect(result.tests.status).toBe("passed");
    expect([result.passedCases, result.failedCases]).toEqual([1, 0]);
  });

  it("сообщает ошибки типов без выполнения исходника", async () => {
    const result = await run(
      "export function add(a: number, b: number): number { return 'wrong'; }",
    );

    expect(result.compilation.status).toBe("failed");
    expect(result.passedCases).toBe(0);
  });

  it("запрещает импорт модулей хоста", async () => {
    const result = await run(
      "import { readFileSync } from 'node:fs'; export function add() { return readFileSync('/tmp/x', 'utf8'); }",
    );

    expect(result.compilation.status).toBe("failed");
    expect(result.compilation.details.join(" ")).toMatch(/imports|side effects/i);
  });

  it("запрещает внешние ссылки типов до чтения компилятором", async () => {
    const result = await run(
      "/// <reference path='/tmp/external-secret.d.ts' />\nexport function add(a: number, b: number) { return a + b; }",
    );

    expect(result.compilation.status).toBe("failed");
    expect(result.compilation.details.join(" ")).toMatch(/Reference directives are forbidden/);
  });

  it("запрещает изменение входа даже при верном результате", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "check-test-"));
    roots.push(root);
    const store = new LocalArtifactStore(root);
    const ref = await store.writeVersion({
      taskId: "task_1",
      candidate: {
        kind: "candidate",
        functionName: "sortCopy",
        solutionTs:
          "export function sortCopy(values: number[]): number[] { return values.sort((a, b) => a - b); }",
        cases: [{ name: "sort", args: [[3, 1, 2]], expected: [1, 2, 3] }],
      },
    });

    const result = await new QuickJsCheckRunner(store).run(ref, {
      signal: new AbortController().signal,
      timeoutMs: 2000,
      memoryLimitBytes: 64 * 1024 * 1024,
    });

    expect(result.tests.status).toBe("failed");
    expect(result.tests.details.join(" ")).toMatch(/input mutated/);
  });

  it("прерывает бесконечный цикл", async () => {
    const result = await run(
      "export function add(a: number, b: number): number { while (true) {} }",
    );

    expect(result.tests.status).toBe("timeout");
  });

  it("не доверяет замене JSON.stringify и глобальных объектов проверки", async () => {
    const result = await run(`export function add(a: number, b: number): number {
      JSON.stringify = (() => '5') as typeof JSON.stringify;
      (globalThis as any).__result = 5;
      (globalThis as any).__args = [2, 3];
      return 999;
    }`);

    expect(result.compilation.status).toBe("passed");
    expect(result.tests.status).toBe("failed");
    expect(result.passedCases).toBe(0);
  });

  it("не вызывает toJSON и геттеры проверяемого кода для сравнения результата", async () => {
    for (const source of [
      "export function add(): any { return { toJSON() { return 5; } }; }",
      "export function add(): any { return { get value() { while (true) {} } }; }",
    ]) {
      const result = await run(source);

      expect(result.compilation.status).toBe("passed");
      expect(result.tests.status).toBe("failed");
      expect(result.passedCases).toBe(0);
    }
  });

  it("отклоняет Proxy, скрывающий реальное возвращаемое значение", async () => {
    const result = await run(
      "export function add(): any { return new Proxy({ value: 999 }, { getOwnPropertyDescriptor() { return { value: 5, enumerable: true, configurable: true, writable: true }; } }); }",
      { value: 5 },
    );

    expect(result.compilation.status).toBe("passed");
    expect(result.tests.status).toBe("failed");
    expect(result.passedCases).toBe(0);
  });

  it("считает циклический результат ошибкой JSON", async () => {
    const result = await run(
      "export function add(a: number, b: number): any { const x: any = {}; x.self = x; return x; }",
    );

    expect(result.tests.status).toBe("failed");
    expect(result.failedCases).toBe(1);
  });

  it("останавливает чрезмерное выделение памяти в QuickJS", async () => {
    const result = await run(
      "export function add(a: number, b: number): number[] { return new Array(100_000_000).fill(1); }",
    );

    expect(result.tests.status).toBe("failed");
    expect(result.tests.details.join(" ")).toMatch(/memory|allocation/i);
  });
});
