# W2 schema-6: validate file-target aggregate consistency

## Objective

Harden the Antigravity receipt parser against impossible aggregate evidence. A file-change summary with `tool_count=3`, `target_count=1`, and `unidentified_tool_count=0` currently passes validation even though two tools have no reported target and are not marked unidentified.

## Required work

1. In `tests/native-bridge.test.mjs`, add a negative regression first: build an otherwise valid schema-6 Antigravity receipt whose `file_change_target_evidence` has three tools, one target, zero unidentified tools, and `CANDIDATE_ROOT_ONLY`; assert `parseReceipt()` rejects it.
2. In `native-bridge/worker.mjs`, make the smallest W2-only validation change so each identified file-change tool contributes at least one target. Preserve valid multi-target tools and summaries with explicitly unidentified tools. Keep the existing status/root-count checks and all unknown-effect semantics.
3. Run the focused regression and relevant existing test suite. Do not change other Worker lanes, CLI settings, Task Scheduler, production, or the panel. Do not publish, commit, or perform external writes from the model session.

## Exact edit scope

- `native-bridge/worker.mjs`
- `tests/native-bridge.test.mjs`

The work must remain a schema-6 Antigravity receipt-validation repair. Do not touch the quota parser/test files, the historical W2 worktree, or any additional path.