# W1 Task: prove schema-6 dispatch survives a schema-4 Codex policy wait

Project ID: CHATGPT_GLOBAL_SKILL_GOVERNANCE
Repository: PT-Original-Point/ptysd-autonomous-factory
Human authorization: Issue #310 comment 6188322050

## Verified gap

The current tests prove that a valid schema-6 OpenCode candidate can be selected while the schema-4 Codex claim remains unresolved. They do not exercise the full `runWorker` tick through executor preflight, source-bundle preparation, and publication of a W1 `STARTED` receipt while the current Human GOAL fails the schema-4 scoped-action/policy gate. The regression test must establish that the wait code is lane-specific and does not suppress an independently authorized W1 job.

## Required implementation

1. Change only `tests/codex-continuation.test.mjs`.
2. Add a deterministic integration-style test that invokes the existing Worker with fully stubbed GitHub, observation, executor-readiness, source-bundle, dispatch, and receipt adapters. Use a byte-pinned Human GOAL fixture with no unique `Codex 下一動作` section and no schema-4 Codex execution policy, plus one valid schema-6 W1 candidate whose source PR/head and GOAL identity match exactly.
3. Assert the schema-4 path records its precise wait reason and does not build or dispatch a Codex request; in that same poll the valid schema-6 W1 request is selected and dispatched exactly once.
4. Assert the emitted W1 receipt is `STARTED`, bound to the exact request, attempt, source PR/head, edit paths, and GOAL comment/hash. Preserve `model_invoked=null`, `task_acceptance=UNKNOWN`, `external_effects=UNKNOWN`, and `source_diff_evidence=NOT_INSPECTED`; a dispatch acknowledgement is not model execution or acceptance.
5. Keep the test hermetic: no real GitHub, CLI, model, Task Scheduler, credential, or persistent filesystem effects. Do not weaken or alter the schema-4 guard.

## Exact edit scope

- `tests/codex-continuation.test.mjs`

## Boundaries

- Do not modify Worker, Executor, model/provider settings, task flags, the Human GOAL, Task Scheduler, identity, OAuth/MFA, billing, Production, receipts, or any control service.
- Do not touch `native-bridge/worker.mjs`, `tests/native-bridge.test.mjs`, `operator-panel/index.html`, or `tests/operator-panel-api.test.mjs`; those paths have separate recent Worker/lease evidence.
- Do not replay any prior request or attempt. Keep all prior `task_acceptance` and `external_effects` values unchanged, including `UNKNOWN`.
- This task proves lane separation in source tests only. It does not claim a live model run, a new Worker delivery, or formal task acceptance.

## Completion evidence

A valid result requires an actual W1 OpenCode V2 Session/tool trace, nonzero diff limited to the single test path, the focused test passing, a result PR, trusted checks on its exact HEAD, and independent Codex source acceptance. Preserve the original task and attempt lineage if dispatch or execution fails.