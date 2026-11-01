# W2 schema-6 task: reject expired Antigravity quota windows

## Purpose
The current main revision validates that Gemini aggregate quota reset timestamps are syntactically valid, but `antigravityV2ReadinessExecutionFailure()` authorizes from the remaining percentages without checking whether the reported weekly and five-hour reset instants are still in the future. The existing parser test fixtures use expired reset instants. A stale quota snapshot must fail closed before an Antigravity model run.

## Pinned scope
- Source PR: this task-source PR; the schema-6 request must pin its exact head SHA.
- Edit paths, and only these paths:
  - `native-bridge/v2-readiness.mjs`
  - `tests/v2-readiness.test.mjs`
- Provider: official Antigravity CLI only.
- Model/variant: `gemini-3.8-flash-high` / `high`.
- No GUI, Computer Use, alternate provider/model, paid fallback, credential inspection, or external writes.

## Required change
1. Make `antigravityV2ReadinessExecutionFailure()` reject a quota snapshot if either `weekly_reset_at` or `five_hour_reset_at` is missing, noncanonical, invalid, equal to the captured decision time, or in the past.
2. Use one captured decision time and allow an injected numeric `nowMs` for deterministic tests; preserve existing callers by defaulting production behavior to the current clock.
3. Return the existing safe refusal `ANTIGRAVITY_AGGREGATE_QUOTA_UNKNOWN` for expired or invalid reset windows. Preserve all existing project, signature, auth, model, tool-policy, no-G1, quota-percentage, and empty-quota checks.
4. Do not interpret a catalog, quota percentage, or this gate as proof of model entitlement, cost, inference, or task acceptance.

## Tests and acceptance
- Add deterministic positive coverage for both reset times strictly in the future.
- Add negative coverage for weekly expired, five-hour expired, either reset exactly equal to `nowMs`, missing/invalid reset timestamps, and malformed readiness data.
- Keep the test fixtures time-independent by injecting the decision time or constructing future resets from the injected value.
- Run `node --test tests/v2-readiness.test.mjs`; report the exact result and changed paths.
- No other files or host settings may change. The existing Worker will perform the single formal attempt; do not create another attempt or task.
