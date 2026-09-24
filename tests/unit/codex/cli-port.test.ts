import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexCliPort } from "../../../src/server/codex/cli-port.js";
import type { CodexRunRequest } from "../../../src/shared/ports.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fakeCli(body: string | ((root: string) => string)): Promise<{ binary: string; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "fake-codex-"));
  roots.push(root);
  const binary = path.join(root, "codex");
  await writeFile(binary, `#!/usr/bin/env node\nif (process.argv[2] === '--version') { console.log('codex-cli 0.156.1'); process.exit(0); }\n${typeof body === "string" ? body : body(root)}\n`, { mode: 0o700 });
  return { binary, root };
}
const request: CodexRunRequest = { taskId: "task_1", attemptId: "attempt_1", role: "author", modelId: "gpt-6-sol", contextText: "Create a pure function", expectedOutputKind: "candidate", timeoutMs: 2000 };
const answer = { kind: "candidate", functionName: "add", solutionTs: "export function add(a: number,b: number) { return a+b; }", cases: [{ name: "sum", args: [2, 3], expected: 5 }] };
const transportAnswer = answer;

describe("Codex CLI boundary", () => {
  it("accepts one structured result after progress while passing exact no-tools flags", async () => {
    const { binary, root } = await fakeCli((root) => `
      require('node:fs').writeFileSync(${JSON.stringify(path.join(root, "args.json"))}, JSON.stringify(process.argv.slice(2)));
      const flags = process.argv.slice(2);
      require('node:fs').copyFileSync(flags[flags.indexOf('--output-schema') + 1], ${JSON.stringify(path.join(root, "schema.json"))});
      console.log(JSON.stringify({type:'thread.started',thread_id:'synthetic'}));
      console.log(JSON.stringify({type:'item.completed',item:{type:'error',message:'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable features.code_mode_host.'}}));
      console.log(JSON.stringify({type:'turn.started'}));
      console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Working on it'}}));
      console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(JSON.stringify(transportAnswer))}}}));
      console.log(JSON.stringify({type:'turn.completed'}));
    `);
    const observations: string[] = [];
    const result = await new CodexCliPort(binary).run(request, { signal: new AbortController().signal, onObservation: async (item) => { observations.push(item.name); } });
    expect(result.output).toEqual(answer);
    expect(observations).toContain("agent_progress");
    const flags = JSON.parse(await readFile(path.join(root, "args.json"), "utf8")) as string[];
    expect(flags).toContain("--strict-config");
    expect(flags).toContain("--ignore-user-config");
    expect(flags).toContain("view_image");
    expect(flags).toContain("shell_tool");
    const schema = await readFile(path.join(root, "schema.json"), "utf8");
    expect(schema).not.toContain("propertyNames");
    expect(schema).toContain("$defs");
  });

  it("accepts nested object and array JSON test cases", async () => {
    const nested = { kind: "candidate", functionName: "scan", solutionTs: "export function scan(value: unknown) { return value; }", cases: [{ name: "graph", args: [{ nodes: [{ id: "A", edges: ["B"] }, { id: "B", edges: [] }] }], expected: { seen: ["A", "B"] } }] };
    const { binary } = await fakeCli(`console.log(JSON.stringify({type:'turn.started'})); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(JSON.stringify(nested))}}})); console.log(JSON.stringify({type:'turn.completed'}));`);
    const result = await new CodexCliPort(binary).run(request, { signal: new AbortController().signal, onObservation: async () => {} });
    expect(result.output).toEqual(nested);
  });

  it("fails closed on a tool execution event", async () => {
    const { binary } = await fakeCli(`console.log(JSON.stringify({type:'turn.started'})); console.log(JSON.stringify({type:'item.started',item:{type:'command_execution',command:'cat /secret'}})); setInterval(()=>{},1000);`);
    await expect(new CodexCliPort(binary).run(request, { signal: new AbortController().signal, onObservation: async () => {} })).rejects.toThrow(/Unexpected Codex event/);
  });

  it("decodes a UTF-8 character split across stdout chunks", async () => {
    const unicode = { ...transportAnswer, solutionTs: `${transportAnswer.solutionTs} // мяу` };
    const { binary } = await fakeCli(`
      console.log(JSON.stringify({type:'turn.started'}));
      const line = JSON.stringify({type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(JSON.stringify(unicode))}}}) + '\\n';
      const bytes = Buffer.from(line);
      const cut = bytes.indexOf(Buffer.from('мяу')) + 1;
      process.stdout.write(bytes.subarray(0,cut));
      setTimeout(() => { process.stdout.write(bytes.subarray(cut)); console.log(JSON.stringify({type:'turn.completed'})); }, 20);
    `);
    const result = await new CodexCliPort(binary).run(request, { signal: new AbortController().signal, onObservation: async () => {} });
    expect(result.output.kind === "candidate" && result.output.solutionTs).toContain("мяу");
  });

  it("aborts a hanging CLI process and its child", async () => {
    const { binary, root } = await fakeCli((root) => `
      const child = require('node:child_process').spawn('sleep',['60'],{stdio:'ignore'});
      require('node:fs').writeFileSync(${JSON.stringify(path.join(root, "child.pid"))}, String(child.pid));
      console.log(JSON.stringify({type:'turn.started'}));
      setInterval(()=>{},1000);
    `);
    const controller = new AbortController();
    const running = new CodexCliPort(binary).run({ ...request, timeoutMs: 1500 }, { signal: controller.signal, onObservation: async (item) => { if (item.name === "turn_started") controller.abort(); } });
    await expect(running).rejects.toThrow(/aborted/i);
    const pid = Number(await readFile(path.join(root, "child.pid"), "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const status = await import("node:child_process").then(({ spawnSync }) => spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }));
    expect(status.status !== 0 || /^Z/.test(status.stdout.trim())).toBe(true);
  });
});
