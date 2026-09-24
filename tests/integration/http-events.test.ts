import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createHttpApp } from '../../src/server/http/app.js';
import { createAppService, type AppService } from '../../src/server/workflow/service.js';
import { createFakeCodexPort } from '../../src/server/workflow/fake-codex.js';
import { LocalArtifactStore } from '../../src/server/artifacts/local-store.js';
import { QuickJsCheckRunner } from '../../src/server/checks/quickjs-runner.js';
import type { FastifyInstance } from 'fastify';
const roots: string[] = [];
const services: AppService[] = [];
const apps: FastifyInstance[] = [];
const aborts: AbortController[] = [];
afterEach(async () => {
  aborts.splice(0).forEach(controller => controller.abort());
  await Promise.all(services.splice(0).map(service => service.close()));
  await Promise.all(apps.splice(0).map(app => app.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'loop-qa-http-')); roots.push(root);
  const artifacts = new LocalArtifactStore(root);
  const service = await createAppService({ dataDir: root, executionMode: 'fake', ports: { artifacts, checks: new QuickJsCheckRunner(artifacts), codex: createFakeCodexPort('no_response') } });
  services.push(service);
  const app = createHttpApp(service); apps.push(app);
  return { service, app };
}
function deadline<T>(promise: Promise<T>, timeout = 2500): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Expected SSE event did not arrive before deadline')), timeout);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
it('A-09: public API validates input, origin, create idempotency and cursor', async () => {
  const { service, app } = await setup();
  expect((await app.inject({ method: 'POST', url: '/api/tasks', payload: { text: '' } })).statusCode).toBe(400);
  expect((await app.inject({ method: 'POST', url: '/api/tasks', headers: { origin: 'https://example.com' }, payload: { text: 'mergeIntervals' } })).statusCode).toBe(403);
  const create = () => app.inject({ method: 'POST', url: '/api/tasks', headers: { 'idempotency-key': 'qa-repeat' }, payload: { text: 'mergeIntervals' } });
  const [a, b] = await Promise.all([create(), create()]);
  expect(a.statusCode).toBe(202); expect(b.statusCode).toBe(202);
  expect(a.json()).toEqual(b.json());
  const id = a.json().taskId;
  expect((await app.inject({ url: `/api/tasks/${id}/events?after=-1` })).statusCode).toBe(400);
  expect((await app.inject({ url: `/api/tasks/${id}/result.zip` })).statusCode).toBe(404);
  await service.stop(id);
});

it('A-03/A-09: SSE streams a new live event then replays only events after Last-Event-ID', async () => {
  const { service, app } = await setup();
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const { taskId } = await service.createTask({ text: 'mergeIntervals' });
  const controller = new AbortController(); aborts.push(controller);
  const response = await deadline(fetch(`${address}/api/tasks/${taskId}/events?after=0`, { signal: controller.signal }));
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const reader = response.body!.getReader();
  await deadline(reader.read());
  const live = await service.events.append({ taskId, eventId: 'qa-live-message', at: new Date().toISOString(), type: 'message', from: 'author', to: 'reviewer', attemptId: null, text: 'QA_LIVE_EVENT', artifactVersionId: null, source: 'qa' });
  let text = '';
  while (!text.includes('QA_LIVE_EVENT')) {
    const piece = await deadline(reader.read());
    if (piece.done) throw new Error('SSE closed before live event');
    text += new TextDecoder().decode(piece.value);
  }
  controller.abort();
  const second = await service.events.append({ taskId, eventId: 'qa-after-disconnect', at: new Date().toISOString(), type: 'message', from: 'reviewer', to: 'author', attemptId: null, text: 'QA_REPLAY_EVENT', artifactVersionId: null, source: 'qa' });
  const reconnect = new AbortController(); aborts.push(reconnect);
  const replay = await deadline(fetch(`${address}/api/tasks/${taskId}/events?after=0`, { headers: { 'Last-Event-ID': String(live.sequence) }, signal: reconnect.signal }));
  const piece = await deadline(replay.body!.getReader().read());
  const replayText = new TextDecoder().decode(piece.value);
  expect(replayText).toContain('QA_REPLAY_EVENT');
  expect(replayText).toContain(`id: ${second.sequence}`);
  expect(replayText).not.toContain('QA_LIVE_EVENT');
  reconnect.abort();
  await service.stop(taskId);
});
