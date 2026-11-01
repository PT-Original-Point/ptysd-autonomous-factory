# W2: Keep Expired Quota-Window Preflight Recoverable

## Authority and bounded objective

This is one reversible, pre-Production W2 schema-6 coding task under the Human V5.3-R4 GOAL in Issue #310 comment `6188322050`. Fix the Worker classification of the existing Antigravity preflight outcome `ANTIGRAVITY_QUOTA_WINDOW_EXPIRED_OR_INVALID`, so an expired or invalid quota-reset window remains a durable no-model `WAITING` result and can be checked again by a later poll under a new attempt.

The readiness layer already returns this outcome with `eligibility_state=WAITING`, `model_invoked=false`, and exit code `48`. The current Worker recoverable-outcome set omits it, so the Executor's existing nonzero-result path can classify the same transient preflight condition as terminal instead of waiting for fresh quota metadata.

## Exact edit scope

Edit only:

- `native-bridge/worker.mjs`
- `tests/executor.test.mjs`
- `tests/native-bridge.test.mjs`

Do not edit runtime or configuration files, the model allowlist, the quota parser/readiness rules, task schedules, credentials, manifests, receipts, or any other path. Do not change or replay any historical request or attempt.

## Required behavior

1. Add only `ANTIGRAVITY_QUOTA_WINDOW_EXPIRED_OR_INVALID` to `RECOVERABLE_MODEL_PREFLIGHT_OUTCOMES`. Preserve the existing guards requiring a model job, `eligibility_state=WAITING`, and `model_invoked=false`; do not treat `ANTIGRAVITY_QUOTA_EMPTY`, malformed identity, tool-policy failures, or unknown outcomes as success.
2. Add a focused executor regression using the exact expired-window outcome. Verify it persists a `WAITING` receipt bound to the pinned schema-6 request, attempt, source SHA, model/variant, source PR, GOAL identity, and edit paths; `model_invoked=false`, no Session or Diff, and unknown task acceptance/external effects remain unknown. Use injected synthetic preflight evidence only; no provider or model call.
3. Add a Worker integration regression using that exact outcome. Verify the existing WAITING result is reconciled once, an independent READY W1 job can still be dispatched in that poll, and the W2 request remains selectable for a later eligibility check using a new attempt ID. Keep the executor/model callback mocked and assert zero inline model calls.
4. Retain the original result and receipt identity exactly. Do not replay the prior attempt; the later eligibility check, if represented in the test, uses a distinct attempt ID for the same immutable request and source.

## Verification

Codex will run the focused affected tests and `git diff --check`, inspect the exact diff, then read back the Worker result PR, its exact HEAD, trusted CI, and source acceptance through the existing Publisher/Issue #407 receipt path. A task-spec PR or local/mock test is not delivery acceptance. Report any Windows-only skip as skipped, never as passed.

This task authorizes no Production change, paid fallback, model/provider change, authentication change, scheduler change, or broader permission.
