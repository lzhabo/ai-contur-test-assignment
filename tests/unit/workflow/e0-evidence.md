# E0: LangGraph + SQLite compatibility

Run on 2026-09-24 in `/Users/lidia/Desktop/BIOSINGULARITY/agent-workspace` at base commit `d30c919` plus uncommitted E0 files. Node `v26.9.0`, npm `11.19.1`, TypeScript `5.9.3`, `@langchain/langgraph` `1.4.17`, `@langchain/langgraph-checkpoint-sqlite` `1.0.4`, `better-sqlite3` `12.11.1`. `package.json` and `package-lock.json` pin the full dependency set.

Reproduce with a fresh directory; execute each `npm run` in a separate shell process:

```sh
npm install --save-exact --fetch-retries=0 --fetch-timeout=30000
npm run typecheck
probe_dir=$(mktemp -d /tmp/two-model-loop-e0.XXXXXX)
npm run test:workflow-probe -- start "$probe_dir/checkpoints.sqlite" "$probe_dir/author-calls.txt"
npm run test:workflow-probe -- resume "$probe_dir/checkpoints.sqlite" "$probe_dir/author-calls.txt"
npm ls --depth=0
git diff --check
```

Observed `typecheck`, `npm ls --depth=0`, and `git diff --check`: exit 0. The `start` process printed:

```json
{"stage":"start","next":["approval"],"state":{"authorRuns":1,"reservedCalls":1,"attemptId":"attempt-e0-1","phase":"awaiting_approval","decision":""},"authorCalls":1}
```

The independent `resume` process printed:

```json
{"stage":"resume","next":[],"state":{"authorRuns":1,"reservedCalls":1,"attemptId":"attempt-e0-1","phase":"complete","decision":"approved"},"authorCalls":1}
```

The probe uses `durability: "sync"`. Its `prepare` node reserves one call and records an attempt ID. Before the author side effect, the author node opens a **separate** `SqliteSaver` connection and asserts that the reservation and attempt ID are already in the SQLite checkpoint. The first process pauses at `interrupt`; the second reads that pause from the same file and uses `Command.resume`. The author call count stays one. These assertions passed against the native SQLite binding.

`npm install` exited 0 and reported zero vulnerabilities. npm warned that install scripts for `better-sqlite3` and `esbuild` were not covered by its `allowScripts` setting; after the TypeScript version change it also listed optional `fsevents`. The actual `SqliteSaver.fromConnString` import, database creation, checkpoint write/read, and cross-process resume all succeeded, so the native SQLite binding was functional in this installation. This does not establish how a clean install behaves on another machine; repeat the probe there.

TypeScript `7.0.2` was initially tried and rejected: its package root exports only a version module, so the `transpileModule` API needed by the QuickJS E0 probe was unavailable. `5.9.3` is pinned and `typecheck` passes. Running the `tsx` CLI directly in this sandbox hit `EPERM` on its IPC pipe; `node --import tsx` runs the probe successfully and is the pinned script.
