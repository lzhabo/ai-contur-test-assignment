import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { createHttpApp } from '../../src/server/http/app.js';
import { createAppService, type AppService } from '../../src/server/workflow/service.js';
import { createFakeCodexPort } from '../../src/server/codex/fake-port.js';
import { LocalArtifactStore } from '../../src/server/artifacts/local-store.js';
import { QuickJsCheckRunner } from '../../src/server/checks/quickjs-runner.js';
import type { TaskSnapshotResponse } from '../../src/shared/api.js';

const roots: string[] = [];
const services: AppService[] = [];
const servers: Server[] = [];
const aborts: AbortController[] = [];

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

afterEach(async () => {
  aborts.splice(0).forEach(controller => controller.abort());
  await Promise.all(servers.splice(0).map(closeServer));
  await Promise.all(services.splice(0).map(service => service.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function setup(scenario: Parameters<typeof createFakeCodexPort>[0] = 'no_response') {
  const root = await mkdtemp(path.join(tmpdir(), 'loop-qa-http-')); roots.push(root);
  const artifacts = new LocalArtifactStore(root);
  const service = await createAppService({ dataDir: root, executionMode: 'fake', ports: { artifacts, checks: new QuickJsCheckRunner(artifacts), codex: createFakeCodexPort(scenario) } });
  services.push(service);
  const server = createServer(createHttpApp(service)); servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No HTTP port');
  return { service, base: `http://127.0.0.1:${address.port}` };
}

function post(base: string, route: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

function deadline<T>(promise: Promise<T>, timeout = 2500): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Expected SSE event did not arrive before deadline')), timeout);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

async function until(service: AppService, id: string, predicate: (value: TaskSnapshotResponse) => boolean) {
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    const snapshot = await service.getTask(id);
    if (predicate(snapshot)) return snapshot;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Task did not reach expected phase');
}

it('A-09: public API validates input, origin, create idempotency and cursor', async () => {
  const { service, base } = await setup();
  expect((await post(base, '/api/tasks', { text: '' })).status).toBe(400);
  expect((await post(base, '/api/tasks', { text: 'mergeIntervals' }, { origin: 'https://example.com' })).status).toBe(403);
  const create = () => post(base, '/api/tasks', { text: 'mergeIntervals' }, { 'idempotency-key': 'qa-repeat' });
  const [a, b] = await Promise.all([create(), create()]);
  expect(a.status).toBe(202); expect(b.status).toBe(202);
  const first = await a.json() as { taskId: string };
  expect(first).toEqual(await b.json());
  const id = first.taskId;
  expect((await fetch(`${base}/api/tasks/${id}/events?after=-1`)).status).toBe(400);
  expect((await fetch(`${base}/api/tasks/${id}/events?after=9007199254740992`)).status).toBe(400);
  expect((await fetch(`${base}/api/tasks/missing/events`)).status).toBe(404);
  expect((await fetch(`${base}/api/tasks/${id}/result.zip`)).status).toBe(404);
  await service.stop(id);
});

it('HTTP parser preserves JSON errors, content type, size limit and HEAD response', async () => {
  const { base } = await setup();
  const malformed = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  expect(malformed.status).toBe(500);
  expect((await malformed.json() as { code: string }).code).toBe('internal_error');
  const scalar = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '1' });
  expect(scalar.status).toBe(400);
  expect((await scalar.json() as { code: string }).code).toBe('invalid_request');
  const plain = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'mergeIntervals' });
  expect(plain.status).toBe(400);
  expect((await plain.json() as { code: string }).code).toBe('invalid_request');
  const unsupported = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/problem+json' }, body: '{"text":"mergeIntervals"}' });
  expect(unsupported.status).toBe(500);
  expect((await unsupported.json() as { code: string }).code).toBe('internal_error');
  const oversized = await post(base, '/api/tasks', { text: 'x'.repeat(1_100_000) });
  expect(oversized.status).toBe(500);
  expect((await oversized.json() as { code: string }).code).toBe('internal_error');
  const health = await fetch(`${base}/api/health`);
  expect(await health.json()).toEqual({ ok: true, executionMode: 'fake' });
  const head = await fetch(`${base}/api/health`, { method: 'HEAD' });
  expect(head.status).toBe(200);
  expect(await head.text()).toBe('');
});

it('A-03/A-09: SSE streams a new live event then replays only events after Last-Event-ID', async () => {
  const { service, base } = await setup();
  const { taskId } = await service.createTask({ text: 'mergeIntervals' });
  const controller = new AbortController(); aborts.push(controller);
  const response = await deadline(fetch(`${base}/api/tasks/${taskId}/events?after=0`, { signal: controller.signal }));
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
  const replay = await deadline(fetch(`${base}/api/tasks/${taskId}/events?after=0`, { headers: { 'Last-Event-ID': String(live.sequence) }, signal: reconnect.signal }));
  const replayReader = replay.body!.getReader();
  let replayText = '';
  await deadline((async () => {
    while (!replayText.includes('QA_REPLAY_EVENT') || !replayText.endsWith('\n\n')) {
      const piece = await replayReader.read();
      if (piece.done) throw new Error('SSE closed before replay event');
      replayText += new TextDecoder().decode(piece.value);
    }
  })());
  expect(replayText).toContain('QA_REPLAY_EVENT');
  expect(replayText).toContain(`id: ${second.sequence}`);
  expect(replayText).not.toContain('QA_LIVE_EVENT');
  reconnect.abort();
  await service.stop(taskId);
});

it('SSE sends an event appended during replay exactly once', async () => {
  const { service, base } = await setup('happy');
  const { taskId } = await service.createTask({ text: 'mergeIntervals' });
  const paused = await until(service, taskId, value => value.task.phase === 'awaiting_approval');
  const cursor = paused.lastEventSequence;
  const original = service.events.readAfter.bind(service.events);
  let release: (() => void) | undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  let entered: (() => void) | undefined;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let firstRead = true;
  service.events.readAfter = async (id, after) => {
    if (firstRead && after === cursor) { firstRead = false; entered?.(); await held; }
    return original(id, after);
  };
  const controller = new AbortController(); aborts.push(controller);
  const response = await deadline(fetch(`${base}/api/tasks/${taskId}/events?after=${cursor}`, { signal: controller.signal }));
  const reader = response.body!.getReader();
  await deadline(reader.read());
  await deadline(started);
  const appended = await service.events.append({ taskId, eventId: 'qa-replay-boundary', at: new Date().toISOString(), type: 'message', from: 'author', to: 'reviewer', attemptId: null, text: 'QA_BOUNDARY_EVENT', artifactVersionId: null, source: 'qa' });
  release?.();
  let streamed = '';
  await deadline((async () => {
    while (!streamed.includes(`id: ${appended.sequence}\n`)) {
      const piece = await reader.read();
      if (piece.done) throw new Error('SSE closed during replay');
      streamed += new TextDecoder().decode(piece.value);
    }
  })());
  expect(streamed.split(`id: ${appended.sequence}\n`).length - 1).toBe(1);
  controller.abort();
  service.events.readAfter = original;
  await service.stop(taskId);
});

it('published artifacts retain text and binary ZIP bytes over HTTP', async () => {
  const { service, base } = await setup('happy');
  const created = await post(base, '/api/tasks', { text: 'mergeIntervals' });
  const { taskId } = await created.json() as { taskId: string };
  const paused = await until(service, taskId, value => value.actions.canDecide);
  const approval = { decisionId: 'qa-http-approval', decision: 'approve', versionId: paused.state.currentVersionId!, manifestHash: paused.state.currentManifestHash! };
  expect((await post(base, `/api/tasks/${taskId}/decision`, approval)).status).toBe(200);
  const completed = await until(service, taskId, value => value.task.phase === 'completed');
  const file = completed.files[0]!;
  const plain = await fetch(`${base}/api/tasks/${taskId}/artifacts/${file.artifactId}`);
  expect(plain.status).toBe(200);
  expect(plain.headers.get('content-type')).toContain('text/plain');
  expect(await plain.text()).toBe((await service.getFile(taskId, file.artifactId)).content);
  const download = await fetch(`${base}/api/tasks/${taskId}/artifacts/${file.artifactId}?download=1`);
  expect(download.headers.get('content-disposition')).toContain(`filename="${file.path}"`);
  const zip = await fetch(`${base}/api/tasks/${taskId}/result.zip`);
  expect(zip.status).toBe(200);
  expect(zip.headers.get('content-type')).toContain('application/zip');
  expect(zip.headers.get('content-disposition')).toContain('two-model-result.zip');
  const archive = new Uint8Array(await zip.arrayBuffer());
  expect(Buffer.from(archive.subarray(0, 2)).toString()).toBe('PK');
  const entries = unzipSync(archive);
  for (const published of completed.files) {
    expect(strFromU8(entries[published.path]!)).toBe((await service.getFile(taskId, published.artifactId)).content);
  }
}, 15_000);
