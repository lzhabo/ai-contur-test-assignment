import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { unzipSync } from "fflate";
import { LocalArtifactStore } from "../../../src/server/storage/local-store.js";

const roots: string[] = [];
// Создаёт хранилище в отдельном временном каталоге.
async function store() {
  const root = await mkdtemp(path.join(os.tmpdir(), "artifact-test-"));
  roots.push(root);
  return { root, artifacts: new LocalArtifactStore(root) };
}
afterEach(async () => {
  // Освобождает процессы и ресурсы сценария, затем удаляет временные данные.
  await Promise.all(
    roots
      .splice(0)
      .map(/* Удаляет временные данные. */ (root) => rm(root, { recursive: true, force: true })),
  );
});
const candidate = {
  kind: "candidate" as const,
  functionName: "add",
  solutionTs: "export function add(a: number, b: number): number { return a + b; }",
  cases: [{ name: "sum", args: [2, 3], expected: 5 }],
};

describe("неизменяемые версии файлов", () => {
  // Объединяет проверки: неизменяемые версии файлов.

  it("публикует подтверждённые байты однократно и возвращает совпадающий ZIP", async () => {
    // Публикует точную версию дважды, сверяет архив и запускает экспортированные тесты.
    const { root, artifacts } = await store();
    const ref = await artifacts.writeVersion({ taskId: "task_1", candidate });
    await artifacts.verifyVersion(ref);
    const approval = {
      decisionId: "yes",
      decision: "approve" as const,
      versionId: ref.versionId,
      manifestHash: ref.manifestHash,
      at: new Date().toISOString(),
    };
    const first = await artifacts.publishApprovedVersion(ref, approval);
    const second = await artifacts.publishApprovedVersion(ref, approval);

    expect(second).toEqual(first);
    expect(
      await readFile(path.join(root, "tasks", "task_1", "result", "solution.ts"), "utf8"),
    ).toBe(candidate.solutionTs);

    const zip = unzipSync(await artifacts.getResultZip("task_1", ref));

    expect(Buffer.from(zip["solution.ts"]!).toString("utf8")).toBe(candidate.solutionTs);
    expect(Buffer.from(zip["solution.test.ts"]!).toString("utf8")).toContain('"sum"');

    const check = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--test", path.join(first.resultPath, "solution.test.ts")],
      { encoding: "utf8" },
    );

    expect(check.status, check.stderr || check.stdout).toBe(0);

    const compilerOptions: ts.CompilerOptions = {
      noEmit: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowImportingTsExtensions: true,
      types: ["node"],
      typeRoots: [path.join(process.cwd(), "node_modules", "@types")],
    };
    const program = ts.createProgram(
      [path.join(first.resultPath, "solution.ts"), path.join(first.resultPath, "solution.test.ts")],
      compilerOptions,
    );

    expect(
      ts
        .getPreEmitDiagnostics(program)
        .map(
          /* Извлекает поле, сохраняя порядок записей. */ (diagnostic) =>
            ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        ),
    ).toEqual([]);
  }, 15_000); // Includes a separate Node test process and a full TypeScript program.

  it("отклоняет устаревшее решение, подмену файла, обход пути и ссылки", async () => {
    // Проверяет сценарий: отклоняет устаревшее решение, подмену файла, обход пути и ссылки.

    const { root, artifacts } = await store();
    const ref = await artifacts.writeVersion({ taskId: "task_1", candidate });
    const approval = {
      decisionId: "yes",
      decision: "approve" as const,
      versionId: ref.versionId,
      manifestHash: "0".repeat(64),
      at: new Date().toISOString(),
    };

    await expect(artifacts.publishApprovedVersion(ref, approval)).rejects.toThrow(/Stale/);
    await expect(
      artifacts.getFile("../outside", ref.files[0]!.artifactId, "revision"),
    ).rejects.toThrow(/Unsafe/);

    await writeFile(
      path.join(root, "tasks", "task_1", "revisions", ref.versionId, "solution.ts"),
      "tampered",
    );

    await expect(artifacts.verifyVersion(ref)).rejects.toThrow(/hash mismatch/i);
    await expect(
      artifacts.publishApprovedVersion(ref, {
        ...approval,
        manifestHash: ref.manifestHash,
      }),
    ).rejects.toThrow(/hash mismatch/i);
  });

  it("отклоняет чтение каталога версий через символическую ссылку", async () => {
    // Проверяет сценарий: отклоняет чтение каталога версий через символическую ссылку.

    const { root, artifacts } = await store();
    const ref = await artifacts.writeVersion({ taskId: "task_1", candidate });
    const revisions = path.join(root, "tasks", "task_1", "revisions");
    await rm(revisions, { recursive: true });
    await symlink(os.tmpdir(), revisions);

    await expect(artifacts.getFile("task_1", ref.files[0]!.artifactId, "revision")).rejects.toThrow(
      /Unsafe directory/,
    );
  });
});
