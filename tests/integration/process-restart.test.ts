import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { expect, it } from 'vitest';

it('A-04: SIGKILL on approval pause, fresh OS process resumes same version without regenerating', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'loop-qa-process-'));
  const children: ChildProcess[] = [];
  function launch(mode: string) {
    const child = fork(fileURLToPath(new URL('./support/graph-process.ts', import.meta.url)), [root, mode], {
      execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    children.push(child);
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    const result = new Promise<{ phase: string; hash: string }>((resolve, reject) => {
      child.once('message', (message: unknown) => {
        const value = message as { phase: string; hash: string; error?: string };
        if (value.error) reject(new Error(value.error + stderr)); else resolve(value);
      });
      child.once('error', reject);
      child.once('exit', code => { if (code) reject(new Error(`Child exited ${code}: ${stderr}`)); });
    });
    return { child, result };
  }
  try {
    const first = launch('seed');
    const before = await first.result;
    expect(before.phase).toBe('awaiting_approval');
    const exited = once(first.child, 'exit');
    first.child.kill('SIGKILL'); await exited;
    const second = launch('resume');
    const after = await second.result;
    expect(after.phase).toBe('completed');
    expect(after.hash).toBe(before.hash);
    const calls = (await readFile(path.join(root, 'qa-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(calls.map(call => call.role)).toEqual(['author', 'reviewer', 'applier']);
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended; }
    }
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
