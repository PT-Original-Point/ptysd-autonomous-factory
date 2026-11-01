# W1 Task: recover an ambiguous STARTED receipt after Worker restart

Project ID: CHATGPT_GLOBAL_SKILL_GOVERNANCE
Repository: PT-Original-Point/ptysd-autonomous-factory
Human authorization: Issue #310 comment 6188322050
Base main observed before dispatch: dbf0e726f0ec1912d241dfec5fae434873a9dc72

## Verified gap

The current source has a focused writeReceipt test for POST success followed by readback failure, and separate Worker tests that start from an already-persisted STARTED receipt. It does not join those cases by reconstructing a fresh Worker invocation after the ambiguous STARTED write. This task adds that integration regression only; it does not claim a live reboot or model recovery acceptance.

## Required implementation

1. Change only tests/native-bridge.test.mjs.
2. Add a deterministic integration test through the existing executeWorker entry point. Use a durable mock GitHub comment store and temporary local state directories; no real GitHub, CLI, model, scheduler, or credential calls.
3. In the first invocation, make the STARTED-receipt POST persist to the mock remote store, then make its immediate readback fail. Assert the Worker stops before executor/model dispatch and preserves the existing ambiguous-effect semantics.
4. Construct a fresh Worker/config/dependency context for a second invocation, using the same persisted mock GitHub comments and local state. Once readback succeeds, assert recovery is bound to the exact original request and attempt: it must not create a second STARTED receipt or a new attempt ID. If the existing contract retries a pending executor handoff, assert it uses that same attempt exactly once and does not directly invoke a model.
5. Preserve task_acceptance=UNKNOWN and external_effects=UNKNOWN. Do not turn a receipt or successful test into acceptance.
6. If exercising the real executeWorker path would require a runtime change or an unmocked external effect, stop and report the precise blocker; this test-only task does not authorize runtime changes.

## Exact edit scope

- tests/native-bridge.test.mjs

## Boundaries

- Do not modify Worker or Executor runtime code, task selection, model/provider settings, the Human GOAL, Task Scheduler, identity, OAuth/MFA, billing, Production, or any service.
- Do not touch operator-panel/index.html, tests/operator-panel-api.test.mjs, or the schema-4 continuation test. Existing attempts using those paths remain governed by their own leases.
- Do not replay any prior request or attempt. Keep all historical task_acceptance and external_effects values unchanged, including UNKNOWN.

## Completion evidence

A valid result requires a real OpenCode V2 Session and tool activity, a nonzero diff limited to the single test path, the focused test passing, a result PR, trusted checks on its exact HEAD, and Codex source acceptance. Preserve the source request, attempt, and readback-failure lineage in the receipt.
