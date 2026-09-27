import { useCallback, useEffect, useRef, useState } from 'react';
import { TaskListResponseSchema, TaskSnapshotResponseSchema, type TaskPhase, type TaskSnapshotResponse, type TaskSummary } from '../shared/api';
import { TASK_EXAMPLES } from '../shared/examples';
import { ADVANCED_EXAMPLE } from '../shared/advanced-example';
import { WorkflowGraph } from './workflow/WorkflowGraph';

const PHASES: Record<TaskPhase, string> = { preparing: 'Подготовка', author: 'Автор пишет функцию', checking: 'Проверка функции', review: 'Ревью кода', awaiting_approval: 'Нужно ваше решение', applying: 'Сохранение результата', completed: 'Готово', stopped: 'Остановлено', error: 'Ошибка', unknown_outcome: 'Исход вызова неизвестен' };
const ROLES: Record<string, string> = { author: 'Автор', reviewer: 'Ревьюер', applier: 'Применяющий агент', system: 'Приложение', user: 'Вы' };
const EXAMPLE_DESCRIPTIONS = ['Пересечения, касания и вложенные интервалы. Проверим граничные случаи.', 'Путь между двумя вершинами графа. Поиск в ширину и проверка циклов.', 'Каждое слово превращается в «мяу». Пробелы, цифры и пунктуация остаются.'];
const time = (date: string) => new Date(date).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fromHash = () => { try { return decodeURIComponent(location.hash.slice(1)) || null; } catch { return null; } };
const navigate = (id: string | null) => { location.hash = id ? encodeURIComponent(id) : ''; };
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'Не удалось выполнить действие.'; }
async function request(path: string, options?: RequestInit): Promise<unknown> {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.message || `Запрос не выполнен (${response.status}).`);
  return body;
}
const post = (path: string, value: unknown, headers?: Record<string, string>) => request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) });

export function App() {
  const [taskId, setTaskId] = useState<string | null>(fromHash);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [serverMode, setServerMode] = useState<'real' | 'mock' | null>(null);
  const [snapshot, setSnapshot] = useState<TaskSnapshotResponse | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(Date.now());
  const createAttempt = useRef<{ text: string; key: string } | null>(null);
  const mutationPending = useRef(false);
  const selection = useRef(taskId);
  selection.current = taskId;
  const loadList = useCallback(async () => {
    const data = TaskListResponseSchema.parse(await request('/api/tasks'));
    setTasks(data.tasks); setActiveId(data.activeTaskId);
  }, []);
  const loadTask = useCallback(async (id: string, signal?: AbortSignal) => {
    const data = TaskSnapshotResponseSchema.parse(await request(`/api/tasks/${encodeURIComponent(id)}`, { signal }));
    if (selection.current === id) setSnapshot(current => {
      if (current?.task.taskId === id && current.lastEventSequence > data.lastEventSequence) return current;
      return data;
    });
    return data;
  }, []);

  useEffect(() => { void request('/api/health').then(data => { const mode = (data as { executionMode?: unknown } | null)?.executionMode; if (mode === 'real' || mode === 'mock') setServerMode(mode); }).catch(() => {}); }, []);
  useEffect(() => { const handler = () => { setTaskId(fromHash()); setError(''); }; window.addEventListener('hashchange', handler); return () => window.removeEventListener('hashchange', handler); }, []);
  useEffect(() => { void loadList().catch(e => setError(errorMessage(e))); const timer = setInterval(() => void loadList().catch(() => {}), 5000); return () => clearInterval(timer); }, [loadList]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    setSnapshot(null); setConnected(false);
    if (!taskId) return;
    const id = taskId;
    const controller = new AbortController();
    let stream: EventSource | undefined;
    let refreshPending = false;
    let refreshAgain = false;
    const refresh = async () => {
      if (refreshPending) { refreshAgain = true; return; }
      refreshPending = true;
      try { await loadTask(id, controller.signal); }
      catch (e) { if (!controller.signal.aborted) { setConnected(false); setError(errorMessage(e)); } }
      finally { refreshPending = false; if (refreshAgain && !controller.signal.aborted) { refreshAgain = false; void refresh(); } }
    };
    void loadTask(id, controller.signal).then(data => {
      if (controller.signal.aborted) return;
      stream = new EventSource(`/api/tasks/${encodeURIComponent(id)}/events?after=${data.lastEventSequence}`);
      stream.onopen = () => { setConnected(true); void refresh(); };
      stream.onmessage = () => { void refresh(); void loadList().catch(() => {}); };
      stream.onerror = () => setConnected(false);
    }).catch(e => { if (!controller.signal.aborted) setError(errorMessage(e)); });
    const timer = setInterval(() => void refresh(), 4000);
    return () => { controller.abort(); stream?.close(); clearInterval(timer); };
  }, [taskId, loadTask, loadList]);

  const perform = async (action: () => Promise<unknown>) => {
    if (mutationPending.current) return;
    mutationPending.current = true; setBusy(true); setError('');
    try { await action(); await loadList(); if (selection.current) await loadTask(selection.current); }
    catch (e) { setError(errorMessage(e)); }
    finally { mutationPending.current = false; setBusy(false); }
  };
  const create = () => perform(async () => {
    const input = text.trim();
    if (!input) throw new Error('Опишите функцию или выберите пример.');
    if (!createAttempt.current || createAttempt.current.text !== input) createAttempt.current = { text: input, key: crypto.randomUUID() };
    const data = await post('/api/tasks', { text: input }, { 'Idempotency-Key': createAttempt.current.key }) as { taskId: string };
    createAttempt.current = null; // A successful creation consumes the key; retries after failures retain it.
    navigate(data.taskId); setTaskId(data.taskId);
  });
  const decide = (decision: 'approve' | 'reject') => perform(async () => {
    if (!snapshot?.state.currentVersionId || !snapshot.state.currentManifestHash) throw new Error('Версия ещё не готова для решения.');
    await post(`/api/tasks/${encodeURIComponent(snapshot.task.taskId)}/decision`, { decisionId: `${snapshot.task.taskId}:${snapshot.state.currentManifestHash}:${decision}`, decision, versionId: snapshot.state.currentVersionId, manifestHash: snapshot.state.currentManifestHash });
  });
  const stop = () => perform(() => post(`/api/tasks/${encodeURIComponent(taskId!)}/stop`, {}));
  const resume = () => perform(() => post(`/api/tasks/${encodeURIComponent(taskId!)}/resume`, { mode: snapshot?.actions.resumeRequiresExplicitRetry ? 'retry_unknown' : 'continue' }));
  const pending = snapshot?.state.activeAttempt;
  const age = pending ? Math.max(0, Math.floor((now - Date.parse(pending.startedAt)) / 1000)) : 0;

  return <div className="app">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark" aria-hidden="true" />контур<span className="muted">.</span></div>
      <button className="primary sidebar-new" onClick={() => { navigate(null); setTaskId(null); setError(''); }}>＋ Новая задача</button>
      <div className="nav-label">Ваши задачи · {tasks.length}</div>
      <nav className="history" aria-label="История задач">
        {tasks.length === 0 && <p className="empty">Здесь появятся ваши задачи.</p>}
        {tasks.map(task => <button key={task.taskId} className={`task-link ${taskId === task.taskId ? 'selected' : ''}`} aria-current={taskId === task.taskId ? 'page' : undefined} onClick={() => { navigate(task.taskId); setTaskId(task.taskId); setError(''); }}><span className="task-link-title">{task.title}</span><small>{PHASES[task.phase]}</small></button>)}
      </nav>
      <div className="sidebar-footer"><span className="status-dot" />Локальная рабочая папка<br />TypeScript · три агента · две модели</div>
    </aside>
    <main className="main">
      <header className="topbar"><span className="breadcrumb">Рабочее пространство / {taskId ? 'Задача' : 'Новая задача'}</span><span className="local-badge">{serverMode === 'mock' ? 'ТЕСТОВЫЙ РЕЖИМ · БЕЗ ОБЛАКА' : 'НА ВАШЕМ MAC · МОДЕЛИ В ОБЛАКЕ'}</span></header>
      <div className="page">
        {error && <div className="notice error page-error" role="alert">{error}<button className="text-button" aria-label="Закрыть сообщение об ошибке" onClick={() => setError('')}>×</button></div>}
        {!taskId ? <>
          <div className="intro"><div className="eyebrow">От идеи к проверенной функции</div><h1>Опишите задачу.<br />Агенты займутся кодом.</h1><p>Автор напишет функцию, ревьюер проверит её и вернёт замечания. Вы просмотрите предложение и решите, сохранять ли результат.</p></div>
          {serverMode === 'mock' && <div className="notice warning">Тестовый режим: ответы агентов имитируются. Облачные модели не вызываются.</div>}
          {activeId && <div className="notice warning">Сейчас выполняется другая задача. <button className="text-button" onClick={() => { navigate(activeId); setTaskId(activeId); }}>Открыть её →</button></div>}
          <form className="composer" onSubmit={e => { e.preventDefault(); void create(); }}>
            <label htmlFor="task-text">Что должна делать функция?</label>
            <textarea id="task-text" maxLength={8000} value={text} onChange={e => setText(e.target.value)} placeholder="Например: объединить пересекающиеся интервалы, не изменяя исходный массив…" />
            <div className="composer-bottom"><small>TypeScript · {text.length.toLocaleString('ru-RU')} / 8 000</small><button type="submit" className="primary" disabled={busy || !text.trim() || Boolean(activeId)}>{busy ? 'Создаём задачу…' : 'Запустить агентов →'}</button></div>
          </form>
          <div className="examples-title"><h3>Начните с примера</h3><small className="muted">Можно отредактировать</small></div>
          <div className="examples">{TASK_EXAMPLES.map((example, index) => <button key={example.id} className="example" onClick={() => { setText(example.text); document.getElementById('task-text')?.focus(); }}><small>0{index + 1} / ПРИМЕР</small><strong>{example.title} ↗</strong><p>{EXAMPLE_DESCRIPTIONS[index]}</p></button>)}</div>
          <button className="advanced-example" onClick={() => { setText(ADVANCED_EXAMPLE.text); document.getElementById('task-text')?.focus(); }}><strong>Сложный пример: расчёт корзины ↗</strong><span>{ADVANCED_EXAMPLE.description}</span><small>Заполнить поле задачи · запуск отдельной кнопкой</small></button>
          <div className="flow-preview"><span><b>01 · Автор</b>Функция и тестовые случаи</span><span><b>02 · Ревьюер</b>Проверка и доработка</span><span><b>03 · Применение</b>После вашего решения</span></div>
          <p className="scope-note">Одна чистая синхронная функция с JSON-входом и результатом. Без сети, файлов и сторонних зависимостей. Для каждой задачи создаётся отдельная папка результата.</p>
        </> : !snapshot ? <div className="empty" role="status">Загружаем сохранённую задачу…</div> : <>
          <div className="task-heading"><div><div className="eyebrow">{PHASES[snapshot.task.phase]}</div><h1>{snapshot.task.title}</h1><p className="task-request">{snapshot.state.taskText}</p></div>{snapshot.actions.canStop && <button className="danger" onClick={() => void stop()} disabled={busy}>Остановить</button>}</div>
          {snapshot.state.executionMode === 'mock' && <div className="notice warning"><strong>Тестовый режим.</strong> Ответы агентов имитируются локально. Этот прогон проверяет работу приложения, но не подключение к облачным моделям.</div>}
          {!connected && <div className="notice warning" role="status">Нет соединения с потоком событий. Пробуем подключиться снова; показано последнее полученное состояние. Это не подтверждение завершения работы.</div>}
          {snapshot.task.stopReason && <div className={`notice ${snapshot.task.phase === 'completed' ? '' : 'warning'}`}><strong>{PHASES[snapshot.task.phase]}.</strong> {snapshot.task.stopReason}</div>}
          {pending && <div className={`notice ${age >= 30 ? 'warning' : ''}`} role="status"><strong>{ROLES[pending.role]}: ожидаем результат {age} с.</strong>{age >= 30 && <p>Ответ пока не получен. Можно продолжать ждать или остановить задачу.</p>}<br />Последнее наблюдение: {pending.lastObservedStage || 'Попытка сохранена; подтверждения запуска ещё нет'}.{pending.lastObservedAt && ` ${time(pending.lastObservedAt)}`}<br /><small>Запуск локального процесса сам по себе не подтверждает доставку облачной модели.</small></div>}
          {snapshot.actions.canResume && <div className="notice warning"><strong>Продолжить сохранённую задачу</strong><p>{snapshot.actions.resumeRequiresExplicitRetry ? 'Исход предыдущего вызова неизвестен. Повтор создаст новый вызов модели и потратит ещё одну попытку.' : 'Продолжение начнётся с сохранённого этапа.'}</p><div className="notice-actions"><button onClick={() => void resume()} disabled={busy}>{snapshot.actions.resumeRequiresExplicitRetry ? 'Повторить неизвестный вызов' : 'Продолжить'}</button></div></div>}
          <WorkflowGraph key={snapshot.task.taskId} snapshot={snapshot} />
          <div className="task-proposal">
            <section className="panel"><div className="panel-head"><h2>{snapshot.task.phase === 'completed' ? 'Результат' : 'Предложение'}</h2><small>Версия {snapshot.state.createdVersions} / {snapshot.state.maxVersions}</small></div><Files snapshot={snapshot} />
              {snapshot.state.latestChecks && <div className="approval"><h3>Проверки: {snapshot.state.latestChecks.status === 'passed' ? 'пройдены' : 'есть ошибки'}</h3><div className="checks"><p>TypeScript: {snapshot.state.latestChecks.compilationStatus === 'passed' ? 'без ошибок' : snapshot.state.latestChecks.compilationStatus}</p><p>Тесты: {snapshot.state.latestChecks.passedCases} пройдено · {snapshot.state.latestChecks.failedCases} не пройдено</p>{snapshot.state.latestChecks.diagnostics.map((message, index) => <p key={index}>{message}</p>)}</div></div>}
              {snapshot.state.latestReview && <div className="approval"><h3>{snapshot.state.latestReview.verdict === 'approved' ? 'Ревьюер одобрил версию' : 'Замечания ревьюера'}</h3>{snapshot.state.latestReview.findings.map((finding, index) => <p className="review-summary" key={index}>{finding}</p>)}</div>}
              {snapshot.actions.canDecide && <div className="approval"><h3>Сохранить эту версию?</h3><p>После подтверждения третий агент сохранит именно эти файлы в отдельную папку задачи. При отказе итоговые файлы не создаются.</p><div className="approval-actions"><button className="primary" disabled={busy} onClick={() => void decide('approve')}>Подтвердить</button><button disabled={busy} onClick={() => void decide('reject')}>Отклонить</button></div></div>}
              {snapshot.task.phase === 'completed' && snapshot.state.resultPath && <Result path={snapshot.state.resultPath} taskId={snapshot.task.taskId} />}
            </section>
          </div>
          <p className="footer-note">Показаны сообщения и наблюдаемые действия агентов. Модели настроены на указанные ID; скрытые рассуждения не отображаются. ID задачи: <span className="mono">{snapshot.task.taskId}</span></p>
        </>}
      </div>
    </main>
  </div>;
}
function Files({ snapshot }: { snapshot: TaskSnapshotResponse }) {
  const files = snapshot.files.filter(file => file.versionId === snapshot.state.currentVersionId);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const current = files.find(file => file.artifactId === selected) || files[0];
  const path = current ? `/api/tasks/${encodeURIComponent(snapshot.task.taskId)}/artifacts/${encodeURIComponent(current.artifactId)}` : '';
  useEffect(() => {
    setContent(''); setError(''); if (!path) return;
    const controller = new AbortController(); setLoading(true);
    void fetch(path, { signal: controller.signal }).then(async response => { if (!response.ok) { const body = await response.json().catch(() => null); throw new Error(body?.message || 'Не удалось прочитать файл.'); } return response.text(); }).then(setContent).catch(e => { if (!controller.signal.aborted) setError(errorMessage(e)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, current?.sha256]);
  if (!current) return <p className="empty">Здесь появятся функция и тесты, когда автор подготовит первую версию.</p>;
  return <><div className="file-tabs" role="tablist" aria-label="Файлы версии">{files.map(file => <button key={file.artifactId} role="tab" aria-selected={file.artifactId === current.artifactId} className={file.artifactId === current.artifactId ? 'active' : ''} onClick={() => setSelected(file.artifactId)}>{file.path}</button>)}</div>{error ? <div role="alert" className="notice error">{error}</div> : <pre className="code-preview" aria-label={`Содержимое ${current.path}`}><code>{loading ? 'Читаем файл…' : content}</code></pre>}<div className="file-footer"><span className="muted mono" title={current.sha256}>SHA-256 {current.sha256.slice(0, 12)}…</span><a href={`${path}?download=1`} download={current.path}>Скачать {current.published ? 'файл' : 'черновик'} ↓</a></div></>;
}
function Result({ path, taskId }: { path: string; taskId: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const copy = async () => { try { await navigator.clipboard.writeText(path); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setError('Не удалось скопировать автоматически. Выделите путь и скопируйте его.'); } };
  return <div className="approval"><h3>Файлы сохранены</h3><code className="result-path">{path}</code><div className="notice-actions"><button onClick={() => void copy()}>{copied ? 'Путь скопирован' : 'Скопировать путь'}</button><a href={`/api/tasks/${encodeURIComponent(taskId)}/result.zip`} download>Скачать комплект ZIP ↓</a></div>{error && <p role="alert">{error}</p>}</div>;
}
