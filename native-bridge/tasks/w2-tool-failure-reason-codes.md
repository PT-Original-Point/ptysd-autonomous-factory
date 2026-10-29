# W2 schema-6: capture safe local file-tool failure reasons

## Objective

The native W2 attempt recorded in Issue #407 comment `6488419328` produced a Gemini session and preserved a nonzero diff, but correctly ended `BLOCKED` with `task_acceptance=UNKNOWN` and `external_effects=UNKNOWN`. Its local tool trace showed a missing `read_file` target and an `edit_file` target-text mismatch. The local Antigravity run evidence retains counts but omits safe reason codes, so Codex must inspect the raw stream to diagnose a failure.

Add bounded, privacy-safe reason codes to local Antigravity run evidence. This is a new task; do not replay, reopen, or modify the historical attempt or its preserved files.

## Required work

1. Add synthetic JSONL regression cases first in `tests/v2-readiness.test.mjs` for a missing read target, an edit target-text mismatch, and an unrecognized file-tool error.
2. In `native-bridge/v2-readiness.mjs`, classify only known error categories into stable enum values in the returned local run evidence. Do not return or persist provider error text, paths, prompts, or file contents. Unknown messages must map to a generic safe code. Preserve all existing tool failure counts and target evidence.
3. Confirm the new enum values flow only through the existing local `antigravity_run` evidence. Do not change public receipt fields, terminal `outcome`, acceptance, external-effect, or panel semantics. A failed attempt remains `BLOCKED`; no error code may be interpreted as acceptance or success.
4. Add focused tests for every stable code, unknown-error fallback, deduplication, and the absence of raw messages, paths, prompts, and file contents from returned evidence.
5. Read the exact current file text before editing. If a file-tool target fails, reread that file and use a fresh exact target; do not repeat the same stale edit target.

This is a pre-production source change. Do not use shell/network/browser/MCP tools, invoke another model, access credentials, modify Windows settings, write GitHub comments, commit, or publish from the model session. Codex owns tests, review, publication, CI, and acceptance.

## Exact edit scope

- `native-bridge/v2-readiness.mjs`
- `tests/v2-readiness.test.mjs`

Do not change Worker code, other lanes, public receipts, model settings, Task Scheduler, the historical W2 worktree, or any other path.
