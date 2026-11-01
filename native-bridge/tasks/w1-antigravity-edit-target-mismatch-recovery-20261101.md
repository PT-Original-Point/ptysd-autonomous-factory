# W1 Task: bound Antigravity exact-target edit recovery

Project ID: CHATGPT_GLOBAL_SKILL_GOVERNANCE
Repository: PT-Original-Point/ptysd-autonomous-factory
Human authorization: Issue #310 comment 6188322050

## Verified gap

The native W2 attempt `W2_USAGE_ZERO_INFERENCE_ENVELOPE_20261101_2031_9B2108E2` (attempt `14b21934-cacc-4d45-8757-9df007e15454`; terminal receipt: Issue #407 comment 6558363286) produced a captured diff but ended `BLOCKED / ANTIGRAVITY_EDIT_TOOL_EXECUTION_FAILED_DIFF_PRESERVED`. The receipt reports 10 tool failures, including 9 failed file-change calls. The existing prompt asks for one reread after an exact-target mismatch, but does not explicitly prohibit retrying the same stale target/replacement or bound the retry to one fresh, narrower target.

This task hardens only that failure-recovery instruction. It does not re-run or accept the W2 attempt, and it does not change its receipt or UNKNOWN external effects.

## Required implementation

1. Change only `native-bridge/worker.mjs` and `tests/native-bridge.test.mjs`.
2. In the existing Antigravity file-edit prompt, state that after an exact-target mismatch the worker must not repeat the same stale target/replacement. It must reread the affected section from the same attempt workspace, form one smaller exact target from the fresh text, and may make at most one retry for that mismatched section.
3. If that retry fails, or a unique exact target cannot be formed, stop editing that section and report the blocker. Do not use broad replacement, rewrite the whole file, or request broader permissions as a fallback.
4. Preserve existing absolute-path scope, bounded read rules, post-edit readback, file-edit-only tool policy, and Codex-owned test execution. Do not add shell, network, credential, test, or other non-file tool access.
5. Add/extend a focused deterministic test of the generated prompt asserting the bounded, non-repeating recovery rule and all existing restrictions.

## Exact edit scope

- `native-bridge/worker.mjs`
- `tests/native-bridge.test.mjs`

## Boundaries

- Do not change model/provider selection, eligibility, quotas, fees, Worker enable flags, Task Scheduler, task selection, schema-4 policy, Human GOAL, or runtime identity.
- Do not touch `native-bridge/v2-readiness.mjs`, `tests/v2-readiness.test.mjs`, the operator panel, or any other file.
- Do not replay the W2 request or any historical attempt. Keep `task_acceptance=UNKNOWN` and `external_effects=UNKNOWN` for the W2 attempt.
- The worker must only edit the two scoped files. Codex will run tests and review the result after the model session.

## Completion evidence

Require a real OpenCode V2 session and file-tool activity, a nonzero diff limited to the exact scope, the focused test passing, a result PR, trusted CI on its exact HEAD, and Codex source acceptance. A task spec PR, CLI exit status, or model session alone is not task acceptance.