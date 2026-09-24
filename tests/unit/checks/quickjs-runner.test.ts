import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalArtifactStore } from "../../../src/server/artifacts/local-store.js";
import { QuickJsCheckRunner } from "../../../src/server/checks/quickjs-runner.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function run(solutionTs: string, expected: number | null = 5) {
  const root = await mkdtemp(path.join(os.tmpdir(), "check-test-"));
  roots.push(root);
  const store = new LocalArtifactStore(root);
  const ref = await store.writeVersion({ taskId: "task_1", candidate: {
    kind: "candidate", functionName: "add", solutionTs,
    cases: [{ name: "sum", args: [2, 3], expected }],
  } });
  return new QuickJsCheckRunner(store).run(ref, { signal: new AbortController().signal, timeoutMs: 2000, memoryLimitBytes: 64 * 1024 * 1024 });
}

describe("isolated TypeScript checks", () => {
  it("typechecks and compares JSON results", async () => {
    const result = await run("export function add(a: number, b: number): number { return a + b; }");
    expect(result.compilation.status).toBe("passed");
    expect(result.tests.status).toBe("passed");
    expect([result.passedCases, result.failedCases]).toEqual([1, 0]);
  });

  it("reports type errors without executing the source", async () => {
    const result = await run("export function add(a: number, b: number): number { return 'wrong'; }");
    expect(result.compilation.status).toBe("failed");
    expect(result.passedCases).toBe(0);
  });

  it("rejects host imports", async () => {
    const result = await run("import { readFileSync } from 'node:fs'; export function add() { return readFileSync('/tmp/x', 'utf8'); }");
    expect(result.compilation.status).toBe("failed");
    expect(result.compilation.details.join(" ")).toMatch(/imports|side effects/i);
  });

  it("rejects external type references before compiler diagnostics can read them", async () => {
    const result = await run("/// <reference path='/tmp/external-secret.d.ts' />\nexport function add(a: number, b: number) { return a + b; }");
    expect(result.compilation.status).toBe("failed");
    expect(result.compilation.details.join(" ")).toMatch(/Reference directives are forbidden/);
  });

  it("rejects mutation even if the returned value matches", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "check-test-"));
    roots.push(root);
    const store = new LocalArtifactStore(root);
    const ref = await store.writeVersion({ taskId: "task_1", candidate: { kind: "candidate", functionName: "sortCopy", solutionTs: "export function sortCopy(values: number[]): number[] { return values.sort((a, b) => a - b); }", cases: [{ name: "sort", args: [[3, 1, 2]], expected: [1, 2, 3] }] } });
    const result = await new QuickJsCheckRunner(store).run(ref, { signal: new AbortController().signal, timeoutMs: 2000, memoryLimitBytes: 64 * 1024 * 1024 });
    expect(result.tests.status).toBe("failed");
    expect(result.tests.details.join(" ")).toMatch(/input mutated/);
  });

  it("interrupts an infinite loop", async () => {
    const result = await run("export function add(a: number, b: number): number { while (true) {} }");
    expect(result.tests.status).toBe("timeout");
  });

  it("reports cyclic output as a failed JSON check", async () => {
    const result = await run("export function add(a: number, b: number): any { const x: any = {}; x.self = x; return x; }");
    expect(result.tests.status).toBe("failed");
    expect(result.failedCases).toBe(1);
  });

  it("stops excessive allocation inside QuickJS", async () => {
    const result = await run("export function add(a: number, b: number): number[] { return new Array(100_000_000).fill(1); }");
    expect(result.tests.status).toBe("failed");
    expect(result.tests.details.join(" ")).toMatch(/memory|allocation/i);
  });
});
