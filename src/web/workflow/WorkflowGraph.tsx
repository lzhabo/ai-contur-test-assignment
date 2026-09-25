import { useEffect, useRef, useState } from 'react';
import type { TaskEvent, TaskSnapshotResponse } from '../../shared/api';
import { eventStage, STATUS_LABELS, versionLabel, workflowView, type StageId } from './model';

const ROLES: Record<string, string> = { author: 'Автор', reviewer: 'Ревьюер', applier: 'Применяющий агент', system: 'Приложение', user: 'Вы' };
const date = (value: string) => new Date(value).toLocaleString('ru-RU');

export function WorkflowGraph({ snapshot }: { snapshot: TaskSnapshotResponse }) {
  const view = workflowView(snapshot);
  const [selection, setSelection] = useState<StageId | 'all'>('all');
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const eventList = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const selected = view.events.find(event => event.eventId === selectedEventId);
  const events = selection === 'all' ? view.events : view.events.filter(event => eventStage(event) === selection || (selection === 'applier' && event.type === 'publication_finished'));
  useEffect(() => { if (eventList.current && follow.current) eventList.current.scrollTop = eventList.current.scrollHeight; }, [events.length, selection]);
  const selectEvent = (event: TaskEvent) => { setSelection('all'); setSelectedEventId(event.eventId); };
  const stopped = ['stopped', 'error', 'unknown_outcome'].includes(snapshot.task.phase);
  return <section className="panel workflow" aria-label="Граф работы агентов">
    <div className="panel-head"><h2>Как движется задача</h2><small>Версий {snapshot.state.createdVersions} / {snapshot.state.maxVersions} · вызовов {snapshot.state.usedModelCalls} / {snapshot.state.maxModelCalls}</small></div>
    <p className="workflow-intro">Нажмите на этап, чтобы увидеть его события. Стрелки показывают маршрут; выделение — фактически наблюдаемые этапы.</p>
    {stopped && <p className="workflow-state" role="status">{snapshot.task.phase === 'unknown_outcome' ? 'Процесс приостановлен: исход вызова неизвестен.' : snapshot.task.phase === 'error' ? 'Процесс завершился ошибкой.' : 'Процесс остановлен.'} Следующие этапы автоматически не выполняются.</p>}
    <div className="workflow-scroll">
      <div className="workflow-diagram">
        <svg className="workflow-lines" viewBox="0 0 960 180" preserveAspectRatio="none" aria-hidden="true">
          <defs><marker id="workflow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>
          {[0, 1, 2, 3, 4].map(index => <path key={index} d={`M ${index * 160 + 148} 61 H ${index * 160 + 168}`} markerEnd="url(#workflow-arrow)" />)}
          <path className={view.returns.length ? 'return-edge used' : 'return-edge'} d="M 400 116 V 150 H 80 V 116" markerEnd="url(#workflow-arrow)" />
          <text x="240" y="175" textAnchor="middle">Ревьюер → автор: {view.returns.length ? `возвратов ${view.returns.length}` : 'возвратов пока нет'}</text>
        </svg>
        <div className="workflow-nodes">{view.stages.map(stage => <button key={stage.id} aria-pressed={selection === stage.id} className={`workflow-node ${stage.status} ${selection === stage.id ? 'selected' : ''}`} onClick={() => { setSelection(stage.id); setSelectedEventId(null); }}><strong>{stage.title}</strong><span>{stage.id === 'author' || stage.id === 'reviewer' || stage.id === 'applier' ? snapshot.state.models[stage.id] : stage.detail}</span><small>{STATUS_LABELS[stage.status]}</small></button>)}</div>
      </div>
    </div>
    <div className="review-history"><h3>Ревью по версиям</h3>{view.reviews.length === 0 ? <p>Ревью ещё не завершено. Замечаний от ревьюера пока нет.</p> : <>
      {view.returns.length === 0 && view.reviews.some(review => review.verdict === 'approved') && <p>Ревьюер одобрил версию без запроса доработки. В этом прогоне возврата к автору не было.</p>}
      <ol>{view.reviews.map(review => <li key={review.event.eventId} className={review.verdict === 'changes_requested' ? 'review-return' : ''}><button onClick={() => selectEvent(review.event)}><strong>{versionLabel(review.event.artifactVersionId, view.versions)} · {review.verdict === 'changes_requested' ? 'Нужны изменения → автору' : review.verdict === 'approved' ? 'Одобрено → ваше решение' : 'Ревью завершено'}</strong><time dateTime={review.event.at}>{date(review.event.at)}</time><span>{review.event.text}</span></button></li>)}</ol>
    </>}</div>
    <div className="workflow-events"><div className="workflow-events-heading"><h3>{selection === 'all' ? 'События процесса' : `События: ${view.stages.find(stage => stage.id === selection)?.title}`}</h3><button className="text-button" aria-pressed={selection === 'all'} onClick={() => { setSelection('all'); setSelectedEventId(null); }}>Все события ({view.events.length})</button></div>
      <div ref={eventList} className="workflow-event-list" onScroll={() => { const element = eventList.current; if (element) follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 70; }}>{events.length ? events.map(event => <button key={event.eventId} className={selectedEventId === event.eventId ? 'selected' : ''} aria-pressed={selectedEventId === event.eventId} onClick={() => setSelectedEventId(event.eventId)}><span>#{event.sequence} · {ROLES[event.from ?? 'system']}{event.to ? ` → ${ROLES[event.to]}` : ''}</span><span>{event.text}</span><small>{versionLabel(event.artifactVersionId, view.versions)} · {date(event.at)}</small></button>) : <p>Для этого этапа ещё нет сохранённых событий.</p>}</div>
      {selected && <article className="workflow-event-detail" aria-label="Выбранное событие"><h3>Событие #{selected.sequence}</h3><p>{selected.text}</p><dl><dt>Время</dt><dd>{date(selected.at)}</dd><dt>Версия</dt><dd>{selected.artifactVersionId ?? 'Ещё не создана'}</dd><dt>Попытка</dt><dd>{selected.attemptId ?? 'Не относится к вызову модели'}</dd><dt>Источник</dt><dd>{selected.source ?? 'Событие приложения'}</dd><dt>Тип</dt><dd>{selected.type}</dd></dl></article>}
    </div>
  </section>;
}
