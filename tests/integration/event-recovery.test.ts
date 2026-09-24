import { mkdtemp, rm, appendFile, writeFile, readFile, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { EventJournal } from '../../src/server/events/journal.js';
import type { TaskEventInput } from '../../src/shared/ports.js';
const roots: string[] = [];
async function setup() { const root = await mkdtemp(path.join(tmpdir(), 'loop-qa-events-')); roots.push(root); return root; }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function event(eventId: string): TaskEventInput {
  return { taskId: 'qa-events', eventId, at: new Date().toISOString(), type: 'message',
    from: 'author', to: 'reviewer', attemptId: 'qa-attempt', text: 'Review version', artifactVersionId: null, source: 'qa' };
}
it('replays only missing persisted events after reconnect/restart and deduplicates a repeated event', async () => {
  const root = await setup();
  const journal = new EventJournal(root);
  const first = await journal.append(event('first'));
  const second = await journal.append(event('second'));
  expect(await journal.append(event('second'))).toEqual(second);
  const reopened = new EventJournal(root);
  expect(await reopened.readAfter('qa-events', first.sequence)).toEqual([second]);
  expect(await reopened.readAfter('qa-events', second.sequence)).toEqual([]);
});
it('recovers a torn final record and can append another readable event after restart', async () => {
  const root = await setup();
  const first = await new EventJournal(root).append(event('first'));
  await appendFile(path.join(root, 'tasks/qa-events/events.jsonl'), '{"eventId":"torn');
  const reopened = new EventJournal(root);
  expect(await reopened.readAfter('qa-events', 0)).toEqual([first]);
  const next = await reopened.append(event('after-crash'));
  expect(next.sequence).toBe(first.sequence + 1);
  expect(await new EventJournal(root).readAfter('qa-events', first.sequence)).toEqual([next]);
});


it('never reads or truncates a journal symlink outside its task directory', async () => {
  const root = await setup();
  const journal = new EventJournal(root);
  await journal.append(event('first'));
  const journalPath = path.join(root, 'tasks/qa-events/events.jsonl');
  const outside = path.join(root, 'outside.jsonl');
  const original = 'QA_OUTSIDE_DO_NOT_TRUNCATE';
  await writeFile(outside, original);
  await rm(journalPath);
  await symlink(outside, journalPath);
  await expect(journal.readAfter('qa-events', 0)).rejects.toThrow();
  await expect(journal.append(event('unsafe-write'))).rejects.toThrow();
  expect(await readFile(outside, 'utf8')).toBe(original);
});

it('never reads or appends through a symlink task directory', async () => {
  const root = await setup();
  const journal = new EventJournal(root);
  await journal.append(event('first'));
  const task = path.join(root, 'tasks/qa-events');
  const outside = path.join(root, 'outside-task');
  await rename(task, outside);
  const original = await readFile(path.join(outside, 'events.jsonl'), 'utf8');
  await symlink(outside, task);
  await expect(journal.readAfter('qa-events', 0)).rejects.toThrow();
  await expect(journal.append(event('unsafe-write'))).rejects.toThrow();
  expect(await readFile(path.join(outside, 'events.jsonl'), 'utf8')).toBe(original);
});
