import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createAppService, type AppService } from '../../src/server/workflow/service.js';
import { createMockCodexPort, type MockScenario } from '../../src/server/codex/mock-port.js';
import { LocalArtifactStore } from '../../src/server/artifacts/local-store.js';
import { QuickJsCheckRunner } from '../../src/server/checks/quickjs-runner.js';
import { DEFAULT_LIMITS, type CheckResult, type CodexPort, type CodexRunRequest, type CodexOutput, type RuntimeLimits, type TaskSnapshotResponse } from '../../src/shared/index.js';

const roots: string[] = [];
const services = new Set<AppService>();
afterEach(async () => {
  await Promise.allSettled([...services].map(service => service.close())); services.clear();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
// Создаёт mock-сценарий и сохраняет запросы, ответы и результаты настоящего выполнения проверок.
async function setup(scenario: MockScenario, overrides: Partial<RuntimeLimits> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'loop-qa-demo-')); roots.push(root);
  const artifacts = new LocalArtifactStore(root);
  const checks = new QuickJsCheckRunner(artifacts);
  const mock = createMockCodexPort(scenario);
  const calls: CodexRunRequest[] = [];
  const outputs: CodexOutput[] = [];
  const checked: CheckResult[] = [];
  const codex: CodexPort = { async run(request, hooks) {
    calls.push(request);
    const result = await mock.run(request, hooks);
    outputs.push(structuredClone(result.output));
    return result;
  } };
  const options = { dataDir: root, executionMode: 'mock' as const,
    limits: { ...DEFAULT_LIMITS, ...overrides }, ports: { artifacts, codex, checks: {
      async run(...args: Parameters<QuickJsCheckRunner['run']>) {
        const result = await checks.run(...args); checked.push(result); return result;
      },
    } } };
  const service = await createAppService(options); services.add(service);
  return { root, service, options, calls, outputs, checked };
}
async function waitFor(service: AppService, id: string, matches: (snapshot: TaskSnapshotResponse) => boolean) {
  let last: TaskSnapshotResponse | undefined;
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    last = await service.getTask(id);
    if (matches(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Expected demo phase missing: ${JSON.stringify(last)}`);
}

it.each(['mergeIntervals', 'catify', 'shortestPath'])('review_once %s: замоканная версия с намеренной ошибкой получает замечания и заменяется исправленной mock-версией', async functionName => {
  const f = await setup('review_once');
  const { taskId } = await f.service.createTask({ text: `Implement ${functionName}; include boundary cases and do not mutate input.` });
  const paused = await waitFor(f.service, taskId, value => value.actions.canDecide);
  expect(f.calls.map(call => call.role)).toEqual(['author', 'reviewer', 'author', 'reviewer']);
  expect(f.checked).toHaveLength(2);
  expect(f.checked[0]!.compilation.status).toBe('passed');
  expect(f.checked[0]!.tests.status).toBe('failed');
  expect(f.checked[0]!.failedCases).toBeGreaterThan(0);
  expect(f.checked[1]!.compilation.status).toBe('passed');
  expect(f.checked[1]!.tests.status).toBe('passed');
  const candidates = f.outputs.filter(output => output.kind === 'candidate');
  expect(candidates).toHaveLength(2);
  expect(candidates[0]!.solutionTs).not.toBe(candidates[1]!.solutionTs);
  const reviews = f.outputs.filter(output => output.kind === 'review');
  expect(reviews.map(review => review.verdict)).toEqual(['changes_requested', 'approved']);
  expect(reviews[0]!.findings.length).toBeGreaterThan(0);
  expect(paused.state.createdVersions).toBe(2);
  expect(paused.state.usedModelCalls).toBe(4);
  expect(paused.events.filter(event => event.type === 'review_finished')).toHaveLength(2);
  await expect(access(path.join(f.root, 'tasks', taskId, 'result'))).rejects.toThrow();
}, 20000);

it('review_loop stops after three versions and six calls without publishing or asking approval', async () => {
  const f = await setup('review_loop');
  const { taskId } = await f.service.createTask({ text: 'mergeIntervals' });
  const stopped = await waitFor(f.service, taskId, value => value.task.phase === 'stopped');
  expect(stopped.state.createdVersions).toBe(3);
  expect(stopped.state.usedModelCalls).toBe(6);
  expect(f.calls.map(call => call.role)).toEqual(['author', 'reviewer', 'author', 'reviewer', 'author', 'reviewer']);
  expect(stopped.actions.canDecide).toBe(false);
  expect(stopped.state.resultPath).toBeNull();
  expect(stopped.task.stopReason).toBeTruthy();
  await expect(f.service.getResultZip(taskId)).rejects.toThrow();
}, 20000);

it('no_response requires explicit retries and stops at the same persisted total budget after restart', async () => {
  const f = await setup('no_response', { maxModelCalls: 2, modelTimeoutMs: 40, modelWarningMs: 10 });
  const { taskId } = await f.service.createTask({ text: 'mergeIntervals' });
  const unknown = await waitFor(f.service, taskId, value => value.task.phase === 'unknown_outcome');
  expect(unknown.state.usedModelCalls).toBe(1);
  expect(f.calls).toHaveLength(1);
  await expect(f.service.resume(taskId, { mode: 'continue' })).rejects.toMatchObject({ statusCode: 409 });
  await f.service.close(); services.delete(f.service);
  const restarted = await createAppService(f.options); services.add(restarted);
  expect((await restarted.getTask(taskId)).state.usedModelCalls).toBe(1);
  expect(f.calls).toHaveLength(1);
  await restarted.resume(taskId, { mode: 'retry_unknown' });
  await waitFor(restarted, taskId, value => value.task.phase === 'unknown_outcome' && value.state.usedModelCalls === 2);
  expect(f.calls).toHaveLength(2);
  await restarted.resume(taskId, { mode: 'retry_unknown' });
  const stopped = await waitFor(restarted, taskId, value => value.task.phase === 'stopped');
  expect(stopped.state.usedModelCalls).toBe(2);
  expect(f.calls).toHaveLength(2);
  expect(stopped.actions.canResume).toBe(false);
  expect(stopped.state.resultPath).toBeNull();
}, 15000);
