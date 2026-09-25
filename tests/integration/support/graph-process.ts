// Trusted QA orchestration only; candidate code executes through QuickJsCheckRunner.
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { Command } from '@langchain/langgraph';
import { createTaskGraph } from '../../../src/server/workflow/graph.js';
import { createFakeCodexPort } from '../../../src/server/codex/fake-port.js';
import { LocalArtifactStore } from '../../../src/server/artifacts/local-store.js';
import { QuickJsCheckRunner } from '../../../src/server/checks/quickjs-runner.js';
import { EventJournal } from '../../../src/server/events/journal.js';
import { TaskStateSchema, DEFAULT_LIMITS, DEFAULT_MODELS } from '../../../src/shared/index.js';
const root = process.argv[2]!;
const mode = process.argv[3]!;
const fake = createFakeCodexPort('happy');
const artifacts = new LocalArtifactStore(root);
const graph = createTaskGraph(path.join(root, 'checkpoints.sqlite'), {
  ports: { artifacts, checks: new QuickJsCheckRunner(artifacts), events: new EventJournal(root), codex: {
    async run(request, hooks) {
      await appendFile(path.join(root, 'qa-calls.jsonl'), JSON.stringify({ role: request.role, attemptId: request.attemptId }) + '\n');
      return fake.run(request, hooks);
    },
  } }, registerAbort() {}, clearAbort() {}, isStopRequested: () => false,
});
const config = { configurable: { thread_id: 'qa-process' }, durability: 'sync' as const };
try {
  if (mode === 'seed') {
    const now = new Date().toISOString();
    const value = TaskStateSchema.parse({ schemaVersion: 1, executionMode: 'fake', taskId: 'qa-process', taskText: 'Implement mergeIntervals.', models: DEFAULT_MODELS,
      phase: 'preparing', currentArtifact: null, latestReview: null, latestChecks: null, approval: null, limits: DEFAULT_LIMITS, usedModelCalls: 0, createdVersions: 0,
      activeAttempt: null, lastAttempt: null, stopReason: null, resultPath: null, createdAt: now, updatedAt: now, lastEventSequence: 0 });
    const result = await graph.invoke({ value }, config);
    process.send?.({ phase: result.value.phase, hash: result.value.currentArtifact?.manifestHash });
  } else {
    const value = TaskStateSchema.parse((await graph.getState(config)).values.value);
    const artifact = value.currentArtifact!;
    const result = await graph.invoke(new Command({ resume: { decisionId: 'qa-process-approval', decision: 'approve', versionId: artifact.versionId, manifestHash: artifact.manifestHash, at: new Date().toISOString() } }), config);
    process.send?.({ phase: result.value.phase, hash: result.value.currentArtifact?.manifestHash });
  }
} catch (error) { process.send?.({ error: String(error) }); }
// Parent owns termination, to make abrupt crash timing explicit.
process.on('message', () => {});
