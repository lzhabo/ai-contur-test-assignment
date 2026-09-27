import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexCliPort } from '../../src/server/codex/cli-port.js';
import { LocalArtifactStore } from '../../src/server/artifacts/local-store.js';
import { QuickJsCheckRunner } from '../../src/server/checks/quickjs-runner.js';
import { createAppService } from '../../src/server/workflow/service.js';
import { TASK_EXAMPLES } from '../../src/shared/examples.js';
import { AuthorOutputSchema, TestCaseSchema } from '../../src/shared/contracts.js';
import type { CodexPort, CodexRunResult } from '../../src/shared/ports.js';

// Смешанная проба запускается отдельно: первая версия — замоканная версия с намеренной ошибкой.
// Все последующие ответы приходят от настоящего Codex CLI и проходят через рабочий граф приложения.
const weak = JSON.parse(await readFile(new URL('../fixtures/weak-self-tests.json', import.meta.url), 'utf8')) as {
  functionName: string; source: string; selfTests: unknown[];
};
const fixture = JSON.parse(await readFile(new URL('../fixtures/merge-intervals.json', import.meta.url), 'utf8')) as {
  cases: Array<{ name: string; args: unknown[]; expected: unknown }>;
};
const mockedIncorrectCandidate = AuthorOutputSchema.parse({
  kind: 'candidate', functionName: weak.functionName, solutionTs: weak.source, cases: weak.selfTests,
});
const boundaryCases = fixture.cases
  .filter(testCase => ['unsorted-disjoint', 'overlap', 'touching'].includes(testCase.name))
  .map(testCase => TestCaseSchema.parse(testCase));
// Вычисляет хеш исходного кода, чтобы отчёт однозначно указывал проверенную версию.
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const base = path.resolve(process.env.LIVE_REVIEW_DATA_DIR ?? '.local-data');
await mkdir(base, { recursive: true });
const dataDir = await mkdtemp(path.join(base, 'live-review-feedback-'));
const artifacts = new LocalArtifactStore(dataDir);
const checks = new QuickJsCheckRunner(artifacts);
const real = new CodexCliPort();
const calls: Array<{ role: string; modelId: string; source: 'mocked-incorrect-author-version' | 'codex-cli'; verdict?: string; findings?: string[] }> = [];
let authorCount = 0;
let secondAuthorSawReview = false;

const codex: CodexPort = {
  // Подставляет только первую ошибочную версию автора; остальные вызовы выполняет через настоящий Codex CLI.
  async run(request, hooks): Promise<CodexRunResult> {
    if (request.role === 'author' && authorCount++ === 0) {
      await hooks.onObservation({
        at: new Date().toISOString(), source: 'mocked-incorrect-author-version',
        name: 'mocked_incorrect_author_version_supplied', stage: 'process_event', detail: null,
      });
      calls.push({ role: request.role, modelId: request.modelId, source: 'mocked-incorrect-author-version' });
      console.log('1/4: подставлена замоканная версия с намеренной ошибкой; облачный автор не вызывался.');
      return { output: mockedIncorrectCandidate, modelId: request.modelId, responseAt: new Date().toISOString() };
    }
    if (request.role === 'author') {
      const context = JSON.parse(request.contextText) as { latestReview?: { verdict?: string; findings?: unknown[] }; currentArtifact?: { versionId?: string } };
      secondAuthorSawReview = context.latestReview?.verdict === 'changes_requested'
        && Boolean(context.latestReview.findings?.length) && Boolean(context.currentArtifact?.versionId);
    }
    const result = await real.run(request, hooks);
    const record: (typeof calls)[number] = { role: request.role, modelId: request.modelId, source: 'codex-cli' };
    if (result.output.kind === 'review') {
      record.verdict = result.output.verdict;
      record.findings = result.output.findings;
    }
    calls.push(record);
    console.log(`${calls.length}/4: ${request.role} (${request.modelId}) завершил вызов${record.verdict ? `: ${record.verdict}` : ''}.`);
    return result;
  },
};

// Сохраняет версию и проверяет её на независимых граничных случаях в изолированном QuickJS.
async function checkBoundary(source: string, name: string) {
  const checkStore = new LocalArtifactStore(path.join(dataDir, 'independent-checks'));
  const ref = await checkStore.writeVersion({
    taskId: name,
    candidate: { kind: 'candidate', functionName: 'mergeIntervals', solutionTs: source, cases: boundaryCases },
  });
  return new QuickJsCheckRunner(checkStore).run(ref, {
    signal: new AbortController().signal, timeoutMs: 5_000, memoryLimitBytes: 64 * 1024 * 1024,
  });
}

const service = await createAppService({ dataDir, executionMode: 'real', ports: { codex, artifacts, checks } });
let taskId: string | null = null;
try {
  const firstBoundary = await checkBoundary(mockedIncorrectCandidate.solutionTs, 'known-bug');
  assert.equal(firstBoundary.compilation.status, 'passed');
  assert.equal(firstBoundary.tests.status, 'failed', 'Замоканная версия с намеренной ошибкой должна провалить независимые граничные проверки');

  taskId = (await service.createTask({ text: TASK_EXAMPLES[0]!.text })).taskId;
  const deadline = Date.now() + 10 * 60_000;
  let snapshot = await service.getTask(taskId);
  while (!['awaiting_approval', 'stopped', 'error', 'unknown_outcome'].includes(snapshot.task.phase) && Date.now() < deadline) {
    await delay(500);
    snapshot = await service.getTask(taskId);
  }

  const firstReview = calls.find(call => call.role === 'reviewer');
  const secondReview = calls.filter(call => call.role === 'reviewer')[1];
  const versions = snapshot.events.filter(event => event.type === 'version_created').map(event => event.artifactVersionId);
  const reviews = snapshot.events.filter(event => event.type === 'review_finished');
  const checkEvents = snapshot.events.filter(event => event.type === 'checks_finished');
  const solutionFile = snapshot.files.find(file => file.path === 'solution.ts');
  const correctedSource = solutionFile ? (await service.getFile(taskId, solutionFile.artifactId)).content : null;
  const finalBoundary = correctedSource ? await checkBoundary(correctedSource, 'corrected-code') : null;
  const report = {
    taskId, dataDir, phase: snapshot.task.phase, stopReason: snapshot.task.stopReason,
    executionKind: 'mixed',
    firstVersionSource: 'mocked-incorrect-author-version',
    firstVersionDescription: 'Замоканная версия с намеренной ошибкой',
    mockedIncorrectSourceSha256: sha256(mockedIncorrectCandidate.solutionTs),
    firstIndependentChecks: { status: firstBoundary.tests.status, failedCases: firstBoundary.failedCases },
    calls, secondAuthorSawReview, createdVersions: snapshot.state.createdVersions,
    usedModelCalls: snapshot.state.usedModelCalls, actualCloudCalls: calls.filter(call => call.source === 'codex-cli').length,
    versions, reviewVersionIds: reviews.map(event => event.artifactVersionId),
    checkEvents: checkEvents.map(event => ({ versionId: event.artifactVersionId, text: event.text })),
    currentVersionId: snapshot.state.currentVersionId,
    correctedSourceSha256: correctedSource ? sha256(correctedSource) : null,
    finalIndependentChecks: finalBoundary && { status: finalBoundary.tests.status, failedCases: finalBoundary.failedCases },
    resultPath: snapshot.state.resultPath,
  };
  await writeFile(path.join(dataDir, 'review-feedback-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));

  assert.deepEqual(calls.map(call => call.role), ['author', 'reviewer', 'author', 'reviewer']);
  assert.deepEqual(calls.map(call => call.source), ['mocked-incorrect-author-version', 'codex-cli', 'codex-cli', 'codex-cli']);
  assert.equal(firstReview?.verdict, 'changes_requested', 'Real reviewer must reject the known bug');
  assert.ok(firstReview.findings?.length, 'Real reviewer must explain its objection');
  assert.match(firstReview.findings.join(' '), /merge|overlap|touch|sort|объедин|пересеч|соприкаса|сортир/i,
    'Reviewer finding must identify a relevant failure, not just request arbitrary changes');
  assert.ok(secondAuthorSawReview, 'Real author must receive the stored review and version');
  assert.notEqual(correctedSource, mockedIncorrectCandidate.solutionTs, 'Real author must change the code');
  assert.equal(finalBoundary?.tests.status, 'passed', 'Corrected code must pass independent boundary cases');
  assert.equal(secondReview?.verdict, 'approved', 'Real reviewer must approve the corrected version');
  assert.equal(snapshot.task.phase, 'awaiting_approval');
  assert.equal(snapshot.state.createdVersions, 2);
  assert.equal(snapshot.state.usedModelCalls, 4);
  assert.equal(report.actualCloudCalls, 3);
  assert.equal(versions.length, 2);
  assert.notEqual(versions[0], versions[1]);
  assert.deepEqual(reviews.map(event => event.artifactVersionId), versions);
  assert.deepEqual(checkEvents.map(event => event.artifactVersionId), versions);
  assert.ok(checkEvents.every(event => event.text === 'Проверки: passed, тесты: passed.'),
    'Self-tests must pass so the first real review is not a forced rejection by failed checks');
  assert.equal(snapshot.state.latestReview?.versionId, versions[1]);
  assert.equal(snapshot.state.latestChecks?.testsStatus, 'passed');
  assert.equal(snapshot.state.resultPath, null, 'Human approval is still required');
  await assert.rejects(access(path.join(dataDir, 'tasks', taskId, 'result')));
  console.log('PASS: настоящий ревьюер вернул замечание, автор исправил код, повторное ревью одобрило версию.');
} finally {
  await service.close();
}
