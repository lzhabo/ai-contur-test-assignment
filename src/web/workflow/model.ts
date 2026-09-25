import type { TaskEvent, TaskSnapshotResponse } from '../../shared/api';

export const STAGES = [
  { id: 'author', title: 'Автор', detail: 'Функция и тестовые случаи' },
  { id: 'checks', title: 'Проверки', detail: 'TypeScript · тесты' },
  { id: 'reviewer', title: 'Ревьюер', detail: 'Проверка требований' },
  { id: 'human', title: 'Ваше решение', detail: 'Подтвердить или отклонить' },
  { id: 'applier', title: 'Применяющий', detail: 'Одобренная версия' },
  { id: 'result', title: 'Результат', detail: 'Файлы на вашем Mac' },
] as const;
export type StageId = typeof STAGES[number]['id'];
export type StageStatus = 'waiting' | 'active' | 'observed' | 'stopped' | 'error' | 'unknown';
export const STATUS_LABELS: Record<StageStatus, string> = {
  waiting: 'Ещё не выполнялся', active: 'Текущий этап', observed: 'Есть результат этапа',
  stopped: 'Остановлено', error: 'Ошибка', unknown: 'Исход неизвестен',
};

export function orderedEvents(events: TaskEvent[]): TaskEvent[] {
  return [...new Map(events.map(event => [event.eventId, event])).values()].sort((a, b) => a.sequence - b.sequence);
}

export function eventStage(event: TaskEvent): StageId | null {
  if (event.type === 'publication_finished') return 'result';
  if (event.type === 'decision_recorded') return 'human';
  if (event.type === 'checks_finished') return 'checks';
  if (event.type === 'review_finished') return 'reviewer';
  if (event.type === 'version_created') return 'author';
  if (event.from === 'author' || event.from === 'reviewer' || event.from === 'applier') return event.from;
  return null;
}

/** Events report observed actions, never an inferred conversation or hidden reasoning. */
export function workflowView(snapshot: TaskSnapshotResponse) {
  const events = orderedEvents(snapshot.events);
  const versions = [...new Set(events.filter(e => e.type === 'version_created').flatMap(e => e.artifactVersionId ? [e.artifactVersionId] : []))];
  const reviews = events.filter(e => e.type === 'review_finished').map(event => ({
    event, verdict: event.to === 'author' ? 'changes_requested' as const : event.to === 'user' ? 'approved' as const : 'unknown' as const,
  }));
  const returns = reviews.filter(review => review.verdict === 'changes_requested');
  const phaseStage: Partial<Record<TaskSnapshotResponse['task']['phase'], StageId>> = {
    author: 'author', checking: 'checks', review: 'reviewer', awaiting_approval: 'human', applying: 'applier', completed: 'result',
  };
  const terminal = snapshot.task.phase === 'stopped' || snapshot.task.phase === 'error' || snapshot.task.phase === 'unknown_outcome';
  // Failure events often have system as sender; associate by durable attempt ID.
  const failure = [...events].reverse().find(e => ['task_stopped', 'task_failed', 'unknown_outcome'].includes(e.type));
  const failedAttempt = failure?.attemptId ? events.find(e => e.type === 'attempt_started' && e.attemptId === failure.attemptId) : undefined;
  const failedStage = failedAttempt ? eventStage(failedAttempt) : failure ? eventStage(failure) : null;
  const current = phaseStage[snapshot.task.phase] ?? (terminal ? failedStage ?? undefined : undefined);
  const completionTypes: Record<StageId, TaskEvent['type'][]> = {
    author: ['version_created'], checks: ['checks_finished'], reviewer: ['review_finished'], human: ['decision_recorded'], applier: ['publication_finished'], result: ['publication_finished'],
  };
  const stages = STAGES.map(stage => {
    let status: StageStatus = events.some(e => completionTypes[stage.id].includes(e.type)) ? 'observed' : 'waiting';
    if (stage.id === current && snapshot.task.phase !== 'completed') status = terminal
      ? snapshot.task.phase === 'unknown_outcome' ? 'unknown' : snapshot.task.phase === 'error' ? 'error' : 'stopped'
      : 'active';
    return { ...stage, status };
  });
  return { events, stages, reviews, returns, versions, current };
}

export function versionLabel(versionId: string | null, versions: string[]) {
  if (!versionId) return 'До первой версии';
  const index = versions.indexOf(versionId);
  return index >= 0 ? `Версия ${index + 1}` : `Версия ${versionId.slice(0, 8)}`;
}
