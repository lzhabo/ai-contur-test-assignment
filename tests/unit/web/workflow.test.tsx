import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TaskEvent, TaskSnapshotResponse } from '../../../src/shared/api';
import { workflowView } from '../../../src/web/workflow/model';
import { WorkflowGraph } from '../../../src/web/workflow/WorkflowGraph';

const event = (sequence: number, type: TaskEvent['type'], extra: Partial<TaskEvent> = {}): TaskEvent => ({ taskId: 'task', sequence, eventId: `event-${sequence}`, at: '2026-09-25T10:00:00Z', type, from: 'system', to: null, attemptId: null, text: `Event ${sequence}`, artifactVersionId: null, source: null, ...extra });
function snapshot(events: TaskEvent[] = [], phase: TaskSnapshotResponse['task']['phase'] = 'preparing'): TaskSnapshotResponse {
  return { task: { taskId: 'task', title: 'Test', phase, createdAt: '2026-09-25T10:00:00Z', updatedAt: '2026-09-25T10:00:00Z', currentVersionId: null, stopReason: null }, state: { taskText: 'Test', executionMode: 'fake', models: { author: 'sol', reviewer: 'luna', applier: 'sol' }, currentVersionId: null, currentManifestHash: null, latestReview: null, latestChecks: null, activeAttempt: null, usedModelCalls: 0, maxModelCalls: 7, createdVersions: 0, maxVersions: 3, resultPath: null }, actions: { canStop: false, canDecide: false, canResume: false, resumeRequiresExplicitRetry: false }, files: [], events, lastEventSequence: events.at(-1)?.sequence ?? 0 };
}

describe('observable workflow graph', () => {
  it('retains prior findings after a newer approved review and deduplicates SSE history', () => {
    const first = event(2, 'review_finished', { from: 'reviewer', to: 'author', artifactVersionId: 'v1', text: 'Не обработан пустой массив' });
    const data = snapshot([event(3, 'version_created', { artifactVersionId: 'v2' }), first, event(1, 'version_created', { artifactVersionId: 'v1' }), first, event(4, 'review_finished', { from: 'reviewer', to: 'user', artifactVersionId: 'v2', text: 'Одобрено' })], 'awaiting_approval');
    const view = workflowView(data);
    expect(view.returns).toHaveLength(1);
    expect(view.reviews.map(review => review.verdict)).toEqual(['changes_requested', 'approved']);
    expect(view.versions).toEqual(['v1', 'v2']);
    const html = renderToStaticMarkup(<WorkflowGraph snapshot={data} />);
    expect(html).toContain('Не обработан пустой массив');
    expect(html).toContain('Версия 1');
    expect(html).toContain('Версия 2');
    expect(html).not.toContain('В этом прогоне возврата к автору не было');
  });
  it('does not invent feedback when first revision was approved', () => {
    const data = snapshot([event(1, 'review_finished', { from: 'reviewer', to: 'user' })], 'awaiting_approval');
    expect(workflowView(data).returns).toHaveLength(0);
    expect(renderToStaticMarkup(<WorkflowGraph snapshot={data} />)).toContain('В этом прогоне возврата к автору не было');
  });
  it('shows pending review explicitly and does not mark unvisited roles as completed', () => {
    const data = snapshot([event(1, 'version_created', { from: 'author', artifactVersionId: 'v1' })], 'checking');
    const stages = workflowView(data).stages;
    expect(stages.find(stage => stage.id === 'author')?.status).toBe('observed');
    expect(stages.find(stage => stage.id === 'checks')?.status).toBe('active');
    expect(stages.find(stage => stage.id === 'reviewer')?.status).toBe('waiting');
    expect(renderToStaticMarkup(<WorkflowGraph snapshot={data} />)).toContain('Ревью ещё не завершено');
  });
  it.each(['stopped', 'error', 'unknown_outcome'] as const)('does not show a running agent after %s', phase => {
    const data = snapshot([event(1, 'attempt_started', { from: 'author', attemptId: 'attempt' }), event(2, phase === 'stopped' ? 'task_stopped' : phase === 'error' ? 'task_failed' : 'unknown_outcome', { attemptId: 'attempt' })], phase);
    const stages = workflowView(data).stages;
    expect(stages.find(stage => stage.id === 'author')?.status).toBe(phase === 'unknown_outcome' ? 'unknown' : phase);
    expect(stages.some(stage => stage.status === 'active')).toBe(false);
    expect(stages.find(stage => stage.id === 'applier')?.status).toBe('waiting');
  });
  it('requires observed publication before marking final files as present', () => {
    const data = snapshot([event(1, 'decision_recorded')], 'applying');
    expect(workflowView(data).stages.find(stage => stage.id === 'result')?.status).toBe('waiting');
    data.events.push(event(2, 'publication_finished', { from: 'applier', to: 'user' }));
    data.task.phase = 'completed';
    expect(workflowView(data).stages.find(stage => stage.id === 'result')?.status).toBe('observed');
  });
});
