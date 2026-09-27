import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { createAppService } from '../../../src/server/workflow/service.js';
import { createMockCodexPort } from '../../../src/server/codex/mock-port.js';
import { LocalArtifactStore } from '../../../src/server/artifacts/local-store.js';
import { QuickJsCheckRunner } from '../../../src/server/checks/quickjs-runner.js';
const root = process.argv[2]!;
const mode = process.argv[3]!;
try {
  const artifacts = new LocalArtifactStore(root);
  const mock = createMockCodexPort('no_response');
  const service = await createAppService({ dataDir: root, executionMode: 'mock', ports: { artifacts, checks: new QuickJsCheckRunner(artifacts), codex: {
    // Записывает попытку на диск перед выполнением управляемого mock-сценария.
    async run(request, hooks) {
      await appendFile(path.join(root, 'qa-calls.jsonl'), JSON.stringify({ role: request.role, attemptId: request.attemptId }) + '\n');
      process.send?.({ event: 'external-started', taskId: request.taskId });
      return mock.run(request, hooks);
    },
  } } });
  if (mode === 'hang') {
    await service.createTask({ text: 'Implement mergeIntervals.' });
  } else if (mode === 'inspect') {
    const list = await service.listTasks();
    const snapshot = await service.getTask(list.tasks[0]!.taskId);
    process.send?.({ event: 'ready', snapshot });
  } else process.send?.({ event: 'ready' });
  process.on('message', async message => { if (message === 'close') { await service.close(); process.exit(0); } });
} catch (error) { process.send?.({ event: 'rejected', error: String(error) }); process.exitCode = 1; }
