import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createAppService, type AppService } from '../../src/server/workflow/service.js';
import { createFakeCodexPort } from '../../src/server/codex/fake-port.js';
import { LocalArtifactStore } from '../../src/server/artifacts/local-store.js';
import { QuickJsCheckRunner } from '../../src/server/checks/quickjs-runner.js';
import { DEFAULT_LIMITS, type DecisionRequest, type TaskSnapshotResponse, type CodexRunRequest } from '../../src/shared/index.js';
const roots: string[] = [];
const services: AppService[] = [];
afterEach(async () => {
  await Promise.allSettled(services.splice(0).map(service => service.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function setup(scenario: Parameters<typeof createFakeCodexPort>[0] = 'happy') {
  const root = await mkdtemp(path.join(tmpdir(), 'loop-qa-service-')); roots.push(root);
  const artifacts = new LocalArtifactStore(root);
  const fake = createFakeCodexPort(scenario);
  const calls: CodexRunRequest[] = [];
  const options = { dataDir: root, executionMode: 'fake' as const,
    limits: { ...DEFAULT_LIMITS, modelTimeoutMs: scenario === 'no_response' ? 50 : 10000 },
    ports: { artifacts, checks: new QuickJsCheckRunner(artifacts), codex: { run: (request: CodexRunRequest, hooks: Parameters<typeof fake.run>[1]) => { calls.push(request); return fake.run(request, hooks); } } } };
  const service = await createAppService(options); services.push(service);
  return { root, service, options, calls };
}
async function until(service: AppService, id: string, matches: (value: TaskSnapshotResponse) => boolean) {
  const end = Date.now() + 10000;
  let last: TaskSnapshotResponse | undefined;
  while (Date.now() < end) {
    last = await service.getTask(id);
    if (matches(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Task did not reach expected condition: ${JSON.stringify(last)}`);
}
function decision(value: TaskSnapshotResponse): DecisionRequest {
  return { decisionId: 'qa-approve', decision: 'approve', versionId: value.state.currentVersionId!, manifestHash: value.state.currentManifestHash! };
}
it('A-08: stale approval is rejected and concurrent duplicate approval publishes once', async () => {
  const f = await setup();
  const { taskId } = await f.service.createTask({ text: 'mergeIntervals' }, 'qa-create');
  const paused = await until(f.service, taskId, value => value.actions.canDecide);
  const approval = decision(paused);
  await expect(f.service.decide(taskId, { ...approval, manifestHash: '0'.repeat(64) })).rejects.toMatchObject({ statusCode: 409 });
  await Promise.all([f.service.decide(taskId, approval), f.service.decide(taskId, approval)]);
  const finished = await until(f.service, taskId, value => value.task.phase === 'completed');
  expect(f.calls.filter(call => call.role === 'applier')).toHaveLength(1);
  expect((await f.service.decide(taskId, approval)).state.currentManifestHash).toBe(finished.state.currentManifestHash);
  expect(f.calls.filter(call => call.role === 'applier')).toHaveLength(1);
}, 15000);

it('A-09: concurrent duplicate task submission is idempotent and permits only one task', async () => {
  const f = await setup('slow');
  const results = await Promise.all([f.service.createTask({ text: 'mergeIntervals' }, 'same-key'), f.service.createTask({ text: 'mergeIntervals' }, 'same-key')]);
  expect(results[0]).toEqual(results[1]);
  expect((await f.service.listTasks()).tasks).toHaveLength(1);
  await f.service.stop(results[0]!.taskId);
}, 15000);

it('A-09: distinct concurrent creates cannot run two active tasks', async () => {
  const f = await setup('slow');
  const results = await Promise.allSettled([f.service.createTask({ text: 'mergeIntervals' }, 'one'), f.service.createTask({ text: 'catify' }, 'two')]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect((await f.service.listTasks()).tasks).toHaveLength(1);
}, 15000);

it('A-03/A-04: unknown outcome survives service restart without retry or reset budget', async () => {
  const f = await setup('no_response');
  const { taskId } = await f.service.createTask({ text: 'mergeIntervals' });
  const before = await until(f.service, taskId, value => value.task.phase === 'unknown_outcome');
  await f.service.close(); services.splice(services.indexOf(f.service), 1);
  const restarted = await createAppService(f.options); services.push(restarted);
  const after = await restarted.getTask(taskId);
  expect(after.task.phase).toBe('unknown_outcome');
  expect(after.state.usedModelCalls).toBe(before.state.usedModelCalls);
  expect(f.calls).toHaveLength(1);
  expect(after.actions.resumeRequiresExplicitRetry).toBe(true);
  await expect(restarted.resume(taskId, { mode: 'continue' })).rejects.toMatchObject({ statusCode: 409 });
  await restarted.resume(taskId, { mode: 'retry_unknown' });
  await until(restarted, taskId, value => value.task.phase === 'unknown_outcome' && value.state.usedModelCalls === 2);
  expect(f.calls).toHaveLength(2);
}, 15000);


it('A-10: service restart detects a tampered completed artifact before presenting it as ready', async () => {
  const f = await setup();
  const { taskId } = await f.service.createTask({ text: 'mergeIntervals' });
  const paused = await until(f.service, taskId, value => value.actions.canDecide);
  await f.service.decide(taskId, decision(paused));
  const completed = await until(f.service, taskId, value => value.task.phase === 'completed');
  await f.service.close(); services.splice(services.indexOf(f.service), 1);
  await writeFile(path.join(completed.state.resultPath!, 'solution.ts'), 'changed after publication');
  const restarted = await createAppService(f.options); services.push(restarted);
  const visible = await restarted.getTask(taskId);
  expect(visible.task.phase).not.toBe('completed');
  expect(visible.task.stopReason).toBeTruthy();
}, 15000);

it('A-08: concurrent stop and approval cannot publish after stop wins', async () => {
  const f = await setup('slow');
  const { taskId } = await f.service.createTask({ text: 'mergeIntervals' });
  const paused = await until(f.service, taskId, value => value.actions.canDecide);
  await Promise.allSettled([f.service.stop(taskId), f.service.decide(taskId, decision(paused))]);
  const ended = await until(f.service, taskId, value => value.task.phase === 'stopped');
  expect(ended.state.resultPath).toBeNull();
  await expect(f.service.getResultZip(taskId)).rejects.toThrow();
}, 15000);
