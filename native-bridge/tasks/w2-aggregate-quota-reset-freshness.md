# W2 task: reject stale Antigravity quota windows

## Objective

Make the existing Antigravity V2 execution-readiness gate fail closed when the aggregate Gemini quota snapshot has expired, even if its reported weekly and five-hour remaining percentages are positive.

## Evidence and scope

At source base 2dca79a5ad92f3cbd1422cecbac469fb13c11e08, `native-bridge/v2-readiness.mjs` parses `weekly_reset_at` and `five_hour_reset_at`, but `antigravityV2ReadinessExecutionFailure()` currently validates only the quota status, source, and percentages. It does not prove that both reset windows are still in the future at the execution decision time.

Allowed edit paths (exact):
- `native-bridge/v2-readiness.mjs`
- `tests/v2-readiness.test.mjs`

## Required behavior

- At the execution-readiness decision, require each reset timestamp to be a valid canonical UTC timestamp and strictly later than the decision time.
- Treat a timestamp equal to or earlier than the decision time, missing timestamps, or malformed timestamps as stale/unknown and refuse execution with a safe deterministic reason.
- Make decision time injectable for deterministic tests; production callers must use the current time.
- Preserve the existing pinned model, authentication, aggregate quota source, positive quota, credit-fallback-off, and tool-policy gates.
- Do not add CLI invocations, perform inference, change W2 enablement/configuration, change model/provider/variant, enable paid fallback, or modify dispatch/receipt behavior.

## Tests

Add deterministic tests showing:
1. two future reset windows with positive aggregate remaining quota pass this freshness check;
2. expired weekly reset fails closed;
3. expired five-hour reset fails closed;
4. either reset exactly equal to the injected decision time fails closed;
5. missing or malformed reset timestamps fail closed.

Keep existing tests passing. Do not reinterpret UNKNOWN entitlement, cost, source acceptance, or external effects as PASS.
