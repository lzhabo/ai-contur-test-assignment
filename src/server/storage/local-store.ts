import { zipSync } from "fflate";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { MAX_ARTIFACT_BYTES } from "../../shared/limits.js";
import type {
  ArtifactFileContent,
  ArtifactStore,
  PublishedResult,
  WriteVersionRequest,
} from "../tasks/ports.js";
import {
  ArtifactRefSchema,
  AuthorOutputSchema,
  type ArtifactFileRef,
  type ArtifactRef,
} from "../tasks/types.js";
import { renderTestArtifact } from "./test-artifact.js";

const names = ["solution.ts", "solution.test.ts"] as const;
const safeId = /^[A-Za-z0-9_-]{1,100}$/;

/** Вычисляет SHA-256 точных байтов для проверки неизменности файла. */
function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
/** Проверяет идентификатор перед включением в путь файловой системы. */
function id(value: string): string {
  if (!safeId.test(value)) throw new Error("Unsafe task or version ID");
  return value;
}
/** Требует настоящий каталог и отклоняет символьные ссылки. */
async function requireDirectory(directory: string): Promise<void> {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error(`Unsafe directory: ${directory}`);
}
/** Читает только обычный файл, запрещая переход по символьным ссылкам. */
async function readRegular(file: string): Promise<Uint8Array> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("Unsafe non-file artifact");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
/** Создаёт новый файл без перезаписи и синхронизирует содержимое с диском. */
async function writeNew(file: string, bytes: string | Uint8Array): Promise<void> {
  const handle = await open(
    file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
/** Создаёт закрытый каталог и проверяет безопасность его типа. */
async function ensureDir(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await requireDirectory(directory);
}
/** Собирает фиксированный набор полей манифеста для стабильного хеша. */
function manifestBody(ref: Omit<ArtifactRef, "manifestHash">): object {
  return {
    taskId: ref.taskId,
    versionId: ref.versionId,
    files: ref.files.map(
      /* Выбирает идентификатор, путь, размер и хеш файла для манифеста. */ (file) => ({
        artifactId: file.artifactId,
        path: file.path,
        sha256: file.sha256,
        bytes: file.bytes,
      }),
    ),
  };
}
/** Вычисляет хеш стабильного представления манифеста. */
function manifestHash(ref: Omit<ArtifactRef, "manifestHash">): string {
  return sha256(JSON.stringify(manifestBody(ref)));
}
/** Сравнивает хеш и содержимое двух ссылок на версию. */
function sameRef(a: ArtifactRef, b: ArtifactRef): boolean {
  return (
    a.manifestHash === b.manifestHash &&
    JSON.stringify(manifestBody(a)) === JSON.stringify(manifestBody(b))
  );
}

export class LocalArtifactStore implements ArtifactStore {
  /** Сохраняет корневой каталог локальных артефактов. */
  constructor(private readonly dataRoot: string) {}

  /** Строит путь задачи только из проверенного идентификатора. */
  private taskRoot(taskId: string): string {
    return path.join(this.dataRoot, "tasks", id(taskId));
  }
  /** Строит путь неизменяемой версии внутри каталога задачи. */
  private versionDir(taskId: string, versionId: string): string {
    return path.join(this.taskRoot(taskId), "revisions", id(versionId));
  }
  /** Создаёт и проверяет родительские каталоги новой задачи. */
  private async ensureTask(taskId: string): Promise<void> {
    await ensureDir(this.dataRoot);
    await ensureDir(path.join(this.dataRoot, "tasks"));
    await ensureDir(this.taskRoot(taskId));
  }
  /** Проверяет существующие родительские каталоги перед чтением файлов. */
  private async assertTask(taskId: string): Promise<void> {
    await requireDirectory(this.dataRoot);
    await requireDirectory(path.join(this.dataRoot, "tasks"));
    await requireDirectory(this.taskRoot(taskId));
  }
  /** Проверяет схему манифеста и сверяет хеш и размер каждого файла. */
  private async readManifest(directory: string): Promise<ArtifactRef> {
    await requireDirectory(directory);
    const ref = ArtifactRefSchema.parse(
      JSON.parse(
        Buffer.from(await readRegular(path.join(directory, "manifest.json"))).toString("utf8"),
      ),
    );
    if (manifestHash(ref) !== ref.manifestHash) throw new Error("Manifest hash mismatch");
    if (ref.files[0]?.path !== names[0] || ref.files[1]?.path !== names[1])
      throw new Error("Invalid manifest file set");
    for (const file of ref.files) {
      if (file.artifactId !== `${ref.versionId}:${file.path}`)
        throw new Error("Invalid artifact ID");
      const bytes = await readRegular(path.join(directory, file.path));
      if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256)
        throw new Error("Artifact hash mismatch");
    }
    return ref;
  }
  /** Сохраняет исходник и доверенные тесты как новую неизменяемую версию. */
  async writeVersion(request: WriteVersionRequest): Promise<ArtifactRef> {
    const taskId = id(request.taskId);
    const candidate = AuthorOutputSchema.parse(request.candidate);
    if (candidate.cases.length > 100) throw new Error("Test case count limit exceeded");
    const versionId = randomUUID();
    const content = [
      candidate.solutionTs,
      renderTestArtifact(candidate.functionName, candidate.cases),
    ];
    const totalBytes = content.reduce(
      /* Суммирует размер файлов версии в байтах для ограничения артефакта. */ (sum, value) =>
        sum + Buffer.byteLength(value),
      0,
    );
    if (totalBytes > MAX_ARTIFACT_BYTES) throw new Error("Artifact size limit exceeded");
    await this.ensureTask(taskId);
    const revisions = path.join(this.taskRoot(taskId), "revisions");
    await ensureDir(revisions);
    const temp = path.join(revisions, `.tmp-${randomUUID()}`);
    await mkdir(temp, { mode: 0o700 });
    try {
      const files: ArtifactFileRef[] = [];
      for (let index = 0; index < names.length; index++) {
        const bytes = Buffer.from(content[index]!);
        await writeNew(path.join(temp, names[index]), bytes);
        files.push({
          artifactId: `${versionId}:${names[index]}`,
          path: names[index],
          bytes: bytes.byteLength,
          sha256: sha256(bytes),
        });
      }
      const body = { taskId, versionId, files };
      const ref: ArtifactRef = { ...body, manifestHash: manifestHash(body) };
      await writeNew(path.join(temp, "manifest.json"), JSON.stringify(ref));
      await rename(temp, this.versionDir(taskId, versionId));
      return ref;
    } catch (error) {
      await rm(temp, { recursive: true, force: true });
      throw error;
    }
  }
  /** Сверяет сохранённую версию с переданной ссылкой и её манифестом. */
  async verifyVersion(input: ArtifactRef): Promise<void> {
    const ref = ArtifactRefSchema.parse(input);
    await this.assertTask(ref.taskId);
    await requireDirectory(path.join(this.taskRoot(ref.taskId), "revisions"));
    const disk = await this.readManifest(this.versionDir(ref.taskId, ref.versionId));
    if (!sameRef(disk, ref)) throw new Error("Artifact reference mismatch");
  }
  /** Копирует проверенные файлы через временный каталог и атомарно публикует копию. */
  private async copyVersion(ref: ArtifactRef, target: string): Promise<void> {
    const temp = path.join(path.dirname(target), `.tmp-${randomUUID()}`);
    await mkdir(temp, { mode: 0o700 });
    try {
      const source = this.versionDir(ref.taskId, ref.versionId);
      for (const name of [...names, "manifest.json"] as const)
        await writeNew(path.join(temp, name), await readRegular(path.join(source, name)));
      await this.readManifest(temp);
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { recursive: true, force: true });
      throw error;
    }
  }
  /** Публикует только версию с совпадающими подтверждением, идентификатором и хешем. */
  async publishApprovedVersion(
    ref: ArtifactRef,
    approval: { decision: "approve" | "reject"; versionId: string; manifestHash: string },
  ): Promise<PublishedResult> {
    if (
      approval.decision !== "approve" ||
      approval.versionId !== ref.versionId ||
      approval.manifestHash !== ref.manifestHash
    )
      throw new Error("Stale or rejected approval");
    await this.verifyVersion(ref);
    const target = path.join(this.taskRoot(ref.taskId), "result");
    try {
      const existing = await this.readManifest(target);
      if (!sameRef(existing, ref)) throw new Error("Published result conflict");
      return {
        taskId: ref.taskId,
        versionId: ref.versionId,
        manifestHash: ref.manifestHash,
        resultPath: target,
        files: ref.files,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await this.copyVersion(ref, target);
    return {
      taskId: ref.taskId,
      versionId: ref.versionId,
      manifestHash: ref.manifestHash,
      resultPath: target,
      files: ref.files,
    };
  }
  /** Читает файл текущей версии или результата после проверки манифеста. */
  async getFile(
    taskId: string,
    artifactId: string,
    source: "revision" | "result",
  ): Promise<ArtifactFileContent> {
    id(taskId);
    const [versionId, name, extra] = artifactId.split(":");
    if (extra !== undefined || !versionId || !names.includes(name as (typeof names)[number]))
      throw new Error("Invalid artifact ID");
    id(versionId);
    await this.assertTask(taskId);
    if (source === "revision")
      await requireDirectory(path.join(this.taskRoot(taskId), "revisions"));
    const directory =
      source === "result"
        ? path.join(this.taskRoot(taskId), "result")
        : this.versionDir(taskId, versionId);
    const ref = await this.readManifest(directory);
    if (ref.taskId !== taskId || ref.versionId !== versionId)
      throw new Error("Artifact belongs to another task or version");
    const metadata = ref.files.find(
      /* Ищет запрошенный файл по точному artifactId. */ (file) => file.artifactId === artifactId,
    );
    if (!metadata) throw new Error("Artifact not found");
    return {
      metadata,
      content: Buffer.from(await readRegular(path.join(directory, metadata.path))).toString("utf8"),
    };
  }
  /** Собирает ZIP из повторно проверенных опубликованных файлов. */
  async getResultZip(taskId: string, ref: ArtifactRef): Promise<Uint8Array> {
    if (taskId !== ref.taskId) throw new Error("Task mismatch");
    await this.assertTask(taskId);
    const result = path.join(this.taskRoot(id(taskId)), "result");
    const disk = await this.readManifest(result);
    if (!sameRef(disk, ref)) throw new Error("Published result conflict");
    return zipSync(
      Object.fromEntries(
        await Promise.all(
          ref.files.map(
            /* Читает точные байты файла и связывает их с именем внутри ZIP. */ async (file) => [
              file.path,
              await readRegular(path.join(result, file.path)),
            ],
          ),
        ),
      ),
    );
  }
}
