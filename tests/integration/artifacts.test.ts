import { mkdtemp, readFile, writeFile, rm, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { LocalArtifactStore } from '../../src/server/artifacts/local-store.js';
import type { Approval, AuthorOutput, ArtifactRef } from '../../src/shared/contracts.js';

const roots: string[] = [];
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'loop-qa-artifacts-'));
  roots.push(root);
  return { root, store: new LocalArtifactStore(root) };
}
const candidate: AuthorOutput = {
  kind: 'candidate', functionName: 'identity',
  solutionTs: 'export function identity(value: number): number { return value; }\n',
  cases: [{ name: 'number', args: [7], expected: 7 }],
};
function approve(ref: ArtifactRef): Approval {
  return { decisionId: 'qa-decision', decision: 'approve', versionId: ref.versionId,
    manifestHash: ref.manifestHash, at: new Date().toISOString() };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('A-08/A-10: exact approved files on real filesystem', () => {
  it('keeps drafts unpublished, rejects stale/rejected approval and returns identical downloaded bytes', async () => {
    const { root, store } = await setup();
    const ref = await store.writeVersion({ taskId: 'qa-one', candidate });
    await expect(readFile(path.join(root, 'tasks/qa-one/result/solution.ts'))).rejects.toThrow();
    await expect(store.publishApprovedVersion(ref, { ...approve(ref), manifestHash: '0'.repeat(64) })).rejects.toThrow();
    await expect(store.publishApprovedVersion(ref, { ...approve(ref), decision: 'reject' })).rejects.toThrow();
    const published = await store.publishApprovedVersion(ref, approve(ref));
    const again = await new LocalArtifactStore(root).publishApprovedVersion(ref, approve(ref));
    expect(again).toEqual(published);
    const zip = unzipSync(await store.getResultZip('qa-one', ref));
    expect(Object.keys(zip).sort()).toEqual(['solution.test.ts', 'solution.ts']);
    for (const file of ref.files) {
      const downloaded = await store.getFile('qa-one', file.artifactId, 'result');
      const disk = await readFile(path.join(published.resultPath, file.path));
      expect(downloaded.content).toBe(disk.toString('utf8'));
      expect(Buffer.from(zip[file.path]!)).toEqual(disk);
      expect(createHash('sha256').update(disk).digest('hex')).toBe(file.sha256);
    }
  });

  it('detects missing/tampered versions across store restart and never publishes them', async () => {
    const { root, store } = await setup();
    const ref = await store.writeVersion({ taskId: 'qa-tamper', candidate });
    await store.verifyVersion(ref);
    const file = path.join(root, 'tasks/qa-tamper/revisions', ref.versionId, 'solution.ts');
    await writeFile(file, 'changed after review');
    const restarted = new LocalArtifactStore(root);
    await expect(restarted.verifyVersion(ref)).rejects.toThrow();
    await expect(restarted.publishApprovedVersion(ref, approve(ref))).rejects.toThrow();
    await rm(file);
    await expect(restarted.verifyVersion(ref)).rejects.toThrow();
  });

  it('refuses publishing a different approved version over an existing result', async () => {
    const { store } = await setup();
    const ref = await store.writeVersion({ taskId: 'qa-conflict', candidate });
    await store.publishApprovedVersion(ref, approve(ref));
    const other = await store.writeVersion({ taskId: 'qa-conflict', candidate: { ...candidate, solutionTs: candidate.solutionTs + '// revision 2\n' } });
    await expect(store.publishApprovedVersion(other, approve(other))).rejects.toThrow();
    expect((await store.getFile('qa-conflict', ref.files[0]!.artifactId, 'result')).content).toBe(candidate.solutionTs);
  });

  it('rejects traversal and cross-task artifact lookup', async () => {
    const { store } = await setup();
    for (const taskId of ['../outside', '/tmp/outside', 'one/two']) {
      await expect(store.writeVersion({ taskId, candidate })).rejects.toThrow();
    }
    const ref = await store.writeVersion({ taskId: 'qa-owner', candidate });
    await store.writeVersion({ taskId: 'qa-other', candidate });
    await expect(store.getFile('qa-other', ref.files[0]!.artifactId, 'revision')).rejects.toThrow();
    await expect(store.getFile('qa-owner', `${ref.versionId}:../../outside`, 'revision')).rejects.toThrow();
  });

  it('rejects a symlink substituted for an artifact file', async () => {
    const { root, store } = await setup();
    const ref = await store.writeVersion({ taskId: 'qa-link', candidate });
    await store.verifyVersion(ref);
    const file = path.join(root, 'tasks/qa-link/revisions', ref.versionId, 'solution.ts');
    const external = path.join(root, 'external.ts');
    await writeFile(external, candidate.solutionTs);
    await rm(file);
    await symlink(external, file);
    await expect(store.getFile('qa-link', ref.files[0]!.artifactId, 'revision')).rejects.toThrow();
    await expect(store.publishApprovedVersion(ref, approve(ref))).rejects.toThrow();
  });

  it('rejects a symlink substituted for the revisions parent, including downloads', async () => {
    const { root, store } = await setup();
    const ref = await store.writeVersion({ taskId: 'qa-parent', candidate });
    await store.verifyVersion(ref);
    const revisions = path.join(root, 'tasks/qa-parent/revisions');
    const outside = path.join(root, 'outside-revisions');
    await rename(revisions, outside);
    await symlink(outside, revisions);
    await expect(store.verifyVersion(ref)).rejects.toThrow();
    await expect(store.getFile('qa-parent', ref.files[0]!.artifactId, 'revision')).rejects.toThrow();
  });

  it('rejects a symlink task root when downloading a published zip', async () => {
    const { root, store } = await setup();
    const ref = await store.writeVersion({ taskId: 'qa-zip', candidate });
    await store.publishApprovedVersion(ref, approve(ref));
    const taskDir = path.join(root, 'tasks/qa-zip');
    const outside = path.join(root, 'outside-task');
    await rename(taskDir, outside);
    await symlink(outside, taskDir);
    await expect(store.getResultZip('qa-zip', ref)).rejects.toThrow();
  });
});
