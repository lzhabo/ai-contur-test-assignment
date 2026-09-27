import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { LocalArtifactStore } from "../../src/server/storage/local-store.js";
import { QuickJsCheckRunner } from "../../src/server/code-runner/quickjs-runner.js";
import {
  AuthorOutputSchema,
  TestCaseSchema,
  type AuthorOutput,
} from "../../src/server/tasks/types.js";
const roots: string[] = [];
afterEach(async () => {
  // Удаляет временные каталоги проверенных версий.
  await Promise.all(
    roots
      .splice(0)
      .map(/* Удаляет временные данные. */ (root) => rm(root, { recursive: true, force: true })),
  );
});
// Сохраняет переданный код и тестовые случаи во временной версии и выполняет их настоящим QuickJS.
async function run(candidate: AuthorOutput) {
  const root = await mkdtemp(path.join(tmpdir(), "loop-qa-checks-"));
  roots.push(root);
  const store = new LocalArtifactStore(root);
  const ref = await store.writeVersion({ taskId: "qa-checks", candidate });
  return new QuickJsCheckRunner(store).run(ref, {
    signal: new AbortController().signal,
    timeoutMs: 5000,
    memoryLimitBytes: 64 * 1024 * 1024,
  });
}
it("независимые граничные случаи находят ошибку, пропущенную тестами автора", async () => {
  // Проверяет сценарий: независимые граничные случаи находят ошибку, пропущенную тестами автора.

  const weak = JSON.parse(
    await readFile(new URL("../fixtures/weak-self-tests.json", import.meta.url), "utf8"),
  );
  const fixture = JSON.parse(
    await readFile(new URL("../fixtures/merge-intervals.json", import.meta.url), "utf8"),
  );
  const candidate = AuthorOutputSchema.parse({
    kind: "candidate",
    functionName: weak.functionName,
    solutionTs: weak.source,
    cases: weak.selfTests,
  });
  const self = await run(candidate);

  expect(self.compilation.status, JSON.stringify(self)).toBe("passed");
  expect(self.tests.status).toBe("passed");

  const independentCases = fixture.cases
    .filter(
      /* Отбирает записи проверяемого вида. */ (item: { name: string }) =>
        weak.independentFailureCases.includes(item.name),
    )
    .map(
      /* Проверяет весь граничный тестовый случай по схеме. */ (item: unknown) =>
        TestCaseSchema.parse(item),
    );
  const independent = await run({ ...candidate, cases: independentCases });

  expect(independent.compilation.status, JSON.stringify(independent)).toBe("passed");
  expect(independent.tests.status).toBe("failed");
  expect(independent.failedCases).toBe(independentCases.length);
}, 15000);

it("выполняет синхронный TypeScript и сообщает ошибки компиляции", async () => {
  // Проверяет сценарий: выполняет синхронный TypeScript и сообщает ошибки компиляции.

  const good = await run({
    kind: "candidate",
    functionName: "double",
    solutionTs: "export function double(n: number): number { return n * 2; }",
    cases: [
      { name: "zero", args: [0], expected: 0 },
      { name: "negative", args: [-3], expected: -6 },
    ],
  });

  expect(good.compilation.status, JSON.stringify(good)).toBe("passed");
  expect(good.tests.status).toBe("passed");
  expect(good.passedCases).toBe(2);

  const bad = await run({
    kind: "candidate",
    functionName: "double",
    solutionTs: 'export function double(n: number): number { return "wrong"; }',
    cases: [{ name: "zero", args: [0], expected: 0 }],
  });

  expect(bad.compilation.status).toBe("failed");
  expect(bad.tests.status).not.toBe("passed");
}, 15000);

it("отклоняет внешние ссылки TypeScript до чтения файлов компилятором", async () => {
  // Проверяет сценарий: отклоняет внешние ссылки TypeScript до чтения файлов компилятором.

  const externalRoot = await mkdtemp(path.join(tmpdir(), "loop-qa-compiler-outside-"));
  roots.push(externalRoot);
  const secretType = "QA_EXTERNAL_FILE_SENTINEL_54127";
  const externalFile = path.join(externalRoot, "outside.d.ts");
  await writeFile(externalFile, `type OutsideType = "${secretType}";`);
  const result = await run({
    kind: "candidate",
    functionName: "probe",
    solutionTs: `/// <reference path="${externalFile}" />\nexport function probe(): string { const value: OutsideType = "different"; return value; }`,
    cases: [{ name: "one", args: [], expected: "different" }],
  });

  expect(result.compilation.status).toBe("failed");
  expect(JSON.stringify(result)).not.toContain(secretType);
}, 10000);

it("отклоняет изменение входных данных при правильном результате", async () => {
  // Проверяет сценарий: отклоняет изменение входных данных при правильном результате.

  const result = await run({
    kind: "candidate",
    functionName: "sortCopy",
    solutionTs:
      "export function sortCopy(values: number[]): number[] { return values.sort((a, b) => a - b); }",
    cases: [
      {
        name: "input-must-stay-unchanged",
        args: [[3, 1, 2]],
        expected: [1, 2, 3],
      },
    ],
  });

  expect(result.compilation.status, JSON.stringify(result)).toBe("passed");
  expect(result.tests.status, JSON.stringify(result)).toBe("failed");
  expect(result.failedCases).toBe(1);
}, 10000);
