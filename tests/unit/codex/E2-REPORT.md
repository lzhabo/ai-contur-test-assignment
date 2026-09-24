# E2-B handoff

Workspace: `/Users/lidia/Desktop/BIOSINGULARITY/agent-workspace`; base E0 commit `4c11be9`. No commit was created by B. Shared contracts in `src/shared/{contracts,ports}.ts` are unchanged by B.

## Modules

- `src/server/codex/cli-port.ts`: `CodexCliPort` implements `CodexPort`. It pins Codex CLI `0.156.1`, requires explicit role/model mapping (`gpt-6-sol` author/applier, `gpt-6-luna` reviewer), limits prompt/output/events, uses an empty ephemeral cwd, ignores user config, disables local tools, rejects unexpected tool events, and kills the detached process group on abort/timeout. The version check is also bounded and abortable. Preliminary agent messages become process observations; only a validated structured message is returned.
- `src/server/artifacts/local-store.ts`: `LocalArtifactStore(dataRoot)` implements immutable revisions, canonical SHA-256 manifest, trusted runnable `solution.test.ts` generation, integrity verification, working copy, exact approval publication, safe file reads and ZIP. It refuses traversal and symlinked data directories/files; an existing different `result` is a conflict.
- `src/server/checks/quickjs-runner.ts` and `quickjs-worker.ts`: `QuickJsCheckRunner(store)` typechecks in a bounded worker, restricts compiler reads to TypeScript standard libs, rejects imports/references, executes generated source only in QuickJS/WASM with time/memory limits and no host bindings, validates JSON output and rejects input mutation.

## Verification

| Command | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npx vitest run tests/unit/codex/cli-port.test.ts tests/unit/artifacts/local-store.test.ts tests/unit/checks/quickjs-runner.test.ts` | 16/16 PASS |
| `node --import tsx tests/unit/codex/live-candidate.probe.ts` | Exit 0 via saved ChatGPT auth and final no-tools flags; requested `gpt-6-sol`, validated candidate `add`, one case `[2,3] -> 5`, [safe summary](e2-live-candidate.json) |
| Strict TypeScript compile and `node --experimental-strip-types --test` on a known generated artifact | PASS within artifact unit test |

The generated answer's model name is not independent server attestation. The CLI command explicitly requests the model; the JSONL response does not expose a separate backend model ID. The app must carry the requested model ID and CLI outcome as distinct facts.

## Schema compatibility finding

The original Zod JSON schema for recursive `JsonValue` was rejected with `invalid_json_schema: propertyNames is not permitted` ([raw error](e2-author-direct.jsonl)). A `casesJson` string envelope was accepted by the provider but a real response omitted its closing `]` ([raw response](e2-production-raw.jsonl)); the adapter correctly rejected it. Production now uses native structured `cases` and removes only the unsupported `propertyNames` keyword from Zod's schema. A real Codex call returned nested structured `cases` successfully ([raw response](e2-author-native-cases.jsonl)); the complete production adapter then returned a validated candidate. The shared `AuthorOutput` contract is unchanged.

The production backend should not execute the generated `solution.test.ts` with Node. It is a runnable deliverable for the user; backend checks read its generated case data and run `solution.ts` only inside QuickJS. Only the known static fixture was executed with Node during unit verification.
