# W1 V5.3-R4: Antigravity edit_file telemetry regression

This is a noncanonical, bounded task specification pinned by a schema-6 job. It does not authorize execution by itself. The only permitted executor is the official OpenCode V2 CLI with the exact model `opencode/deepseek-v4.1-flash-free`, variant `null`, and the already approved unauthenticated-free-model path. If that exact model is unavailable or rate-limited, preserve the CLI evidence and stop this attempt; never fall back to a paid or different model.

## Exact write scope

W1 may modify only:

- `native-bridge/v2-readiness.mjs`
- `tests/v2-readiness.test.mjs`

Do not modify the task spec, any other file, GitHub state, credentials, provider configuration, Task Scheduler, worker runtime, or project outside this repository. Do not call Antigravity/Gemini, do not perform network access from the model task, and do not read user quota or credentials.

## Required change

The existing stream-json file-change telemetry must count `edit_file` as a completed file-change tool in both equivalent classification paths in `v2-readiness.mjs`. Keep read errors and file-change results separate; successful writes must not be counted as failed because unrelated reads returned ENOENT. Preserve the rule that tool success is not proof of a captured diff or semantic acceptance.

Add synthetic, redacted tests using the real parser paths. Include this exact 31-event shape: 28 `read_file` events (25 DONE, 3 ERROR), 2 `write_file` DONE, and 1 `edit_file` DONE. Expected totals: 31 tools, 3 failed tools, 3 completed file-change tools, 0 failed file-change tools, and 0 incomplete file-change tools. Assert the two parser paths agree. Include negative cases for a failed/incomplete `edit_file`, malformed or missing tool status, and no file changes; do not weaken existing scope or acceptance gates.

The task must not make model calls in tests, use real user data, introduce new authorization or control layers, or change runtime behavior outside evidence classification.

## Handoff and acceptance boundary

W1 returns its model Session ID, exact allowed-path diff, CLI/session evidence, and attempt identifiers. W1 must not claim test, PR, CI, merge, or acceptance success. Codex will independently inspect the captured diff, run `node --test tests/v2-readiness.test.mjs`, check scope and `git diff --check`, and then handle integration and CI separately.