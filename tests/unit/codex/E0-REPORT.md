# E0: Codex CLI and isolated checks

Date: 2026-09-24. Workspace: `/Users/lidia/Desktop/BIOSINGULARITY/agent-workspace`, base commit `d30c919`. Probe files in this directory contain synthetic prompts/results only; no credentials were read or copied.

## Versions and observed results

| Probe | Result |
| --- | --- |
| `codex --version` | `codex-cli 0.156.1` |
| `codex login status` | `Logged in using ChatGPT` |
| `node --version`, `npm --version` | `v26.9.0`, `11.19.1` |
| Explicit `--model gpt-6-sol`, `--output-schema`, JSONL | Exit 0 and `turn.completed`; `SOL_OK` schema-valid output in [e0-sol.jsonl](e0-sol.jsonl) |
| Explicit `--model gpt-6-luna`, same setup | Exit 0 and `turn.completed`; `LUNA_OK` schema-valid output in [e0-luna.jsonl](e0-luna.jsonl) |
| Sol with final local-tool-disabled flags | Exit 0 and `turn.completed`; `SOL_OK` schema-valid output in [e0-sol-no-tools.jsonl](e0-sol-no-tools.jsonl) |
| Shell access with `--sandbox read-only`, sterile `-C` | **Read boundary failed**: `cat` outside cwd returned a synthetic marker, [e0-archive-access.jsonl](e0-archive-access.jsonl) |
| Shell disabled, image viewer enabled | **Read boundary failed**: PNG outside cwd revealed a synthetic marker, [e0-image-access.jsonl](e0-image-access.jsonl) |
| Final local-tool-disabled flags, adversarial text + PNG prompt | Neither marker was revealed; Code Mode reported its host disabled and failed closed, then `turn.completed`, [e0-no-tools.jsonl](e0-no-tools.jsonl) |
| `--sandbox read-only`, shell write attempt | Command reported `operation not permitted`; independent `test ! -e` confirmed no file, [e0-read-only-write.jsonl](e0-read-only-write.jsonl) |
| Detached process-group cancellation | SIGTERM to negative PID stopped parent and `sleep` grandchild, [cancel-process-group.probe.mjs](cancel-process-group.probe.mjs) |
| QuickJS/WASM with TypeScript 5.9.3 | Five checks pass: pure synchronous function, interrupt, 64 MiB allocation failure, no `process`/`require`/`fetch`, and no `node:fs` import; [quickjs-e0.probe.ts](../checks/quickjs-e0.probe.ts) |

The model field in generated JSON is a self-report required by the probe schema. The evidence for model selection is the explicit CLI `--model` argument plus successful response; Codex JSONL does not independently attest the backend model ID. The short prompts consumed 10–19k input tokens, so the CLI adds context beyond our application prompt. The agreed 96 KiB limit can only bound application-supplied bytes, not hidden Codex context.

## Tool-disabled CLI configuration tested

`codex exec --model <explicit-id> --json --output-schema <schema> --ephemeral --ignore-user-config --strict-config --disable shell_tool --disable unified_exec --disable view_image --disable apps --disable browser_use --disable browser_use_external --disable browser_use_full_cdp_access --disable computer_use --disable image_generation --disable code_mode_host --disable plugins --disable remote_plugin --disable multi_agent --disable skill_search --disable workspace_dependencies --disable in_app_browser --config 'web_search="disabled"' --sandbox read-only --skip-git-repo-check -C <sterile-empty-dir> -`

`--disable view_image` is the recognized installed feature flag. The newer online `tools.view_image=false` config key fails `--strict-config` on CLI 0.156.1, so it must not be used for this pinned version. The disabled Code Mode emits an `item.completed` with `item.type="error"` before `turn.started`; the subsequent `turn.completed` and schema-valid answer demonstrate that this diagnostic is distinct from `turn.failed` or a failed process. A runtime adapter must classify diagnostics separately, reject unexpected tool execution events, and fail closed on unknown flags, version changes, or unsupported event types. These probes establish behavior for this CLI version and the listed channels; they are not a formal guarantee about future capabilities.

The CLI needed a narrow sandbox escalation for its own state SQLite under `~/.codex`; without it, the local tool sandbox reported a readonly database. The probe command never read or copied authentication files. Production must run with saved ChatGPT authentication and a separately controlled Codex state directory; do not fall back to API-key mode.

## Check runtime observations

Commands: `node --import tsx tests/unit/checks/quickjs-e0.probe.ts` and `node tests/unit/codex/cancel-process-group.probe.mjs`, both exit 0. QuickJS is a compatible candidate for the agreed pure synchronous functions. `ts.transpileModule` is not a TypeScript type checker, and the probe does not bound output serialization; the production runner must validate the source contract and output size separately. The process-group probe uses `detached: true` and `process.kill(-pid, "SIGTERM")`; production should retain a `SIGKILL` escalation after a grace period.
