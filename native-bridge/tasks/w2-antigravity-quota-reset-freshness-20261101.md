# W2 Task: Reject Expired Gemini Quota Windows

## Authority and task boundary

This is one bounded, reversible, pre-Production W2 source task authorized by Human Goal comment 6188322050 and its current W2 execution authorization. Use the existing schema-6 Antigravity Worker only, pinned to `gemini-3.8-flash-high` with variant `high`. The Worker must perform its normal fresh official CLI/auth/`/usage` and no-additional-charge checks immediately before model invocation. If any existing Worker gate fails, stop this W2 attempt with its exact safe code; do not retry, switch models, use paid/G1 credit fallback, alter config, or touch W1.

This task repairs a source-level freshness defect in the quota eligibility decision. Current main (`2dca79a5ad92f3cbd1422cecbac469fb13c11e08`) accepts positive quota percentages without checking whether either quota reset timestamp is still in the future. A reproduced readiness object with 95% weekly and 99% five-hour quota but reset dates in October currently returns `null` (eligible) on 2026-11-01.

## Exact write scope

Only edit these paths:

- `native-bridge/v2-readiness.mjs`
- `tests/v2-readiness.test.mjs`

Do not edit configuration, the Worker/Executor, project files, schedules, UI/panel, receipts, task definitions, or any other path.

## Required implementation

1. Extend `antigravityV2ReadinessExecutionFailure` with an optional deterministic time input (defaulting to the current time for production use). Reject invalid/unavailable time input fail-closed.
2. Require both `weekly_reset_at` and `five_hour_reset_at` to be valid canonical UTC timestamps emitted by the existing quota parsers. Accept only the parser's supported UTC forms (whole seconds or its canonical millisecond form); reject missing, malformed, non-canonical, or impossible dates.
3. Require both reset instants to be strictly later than the supplied current time. Equality is expired.
4. Return one explicit safe refusal for missing/invalid/expired quota windows, such as `ANTIGRAVITY_QUOTA_WINDOW_EXPIRED_OR_INVALID`. Preserve the existing empty-quota refusal, percentage validation, authentication, project, model, tool-policy, and no-G1 checks.
5. Keep the quota parser's output and the distinction between catalog, authenticated usage, entitlement, cost, inference and acceptance unchanged. This timestamp check is an eligibility freshness check; it must not claim entitlement or billing proof.

## Required tests

Use a fixed injected clock. Add positive coverage for both future reset windows and negative coverage for: weekly reset in the past, five-hour reset in the past, a reset exactly equal to now, missing reset, malformed/non-canonical timestamp, and invalid clock input. Update existing readiness fixtures to include valid future reset timestamps under their fixed clock. Keep parser-only tests showing that parsing and readiness eligibility are separate facts. Assert the exact safe refusal and preserve `entitlement=UNKNOWN` and `cost=UNKNOWN`.

Run the targeted `node --test tests/v2-readiness.test.mjs` suite and report the complete result. Inspect the final diff to confirm the two-path scope before committing. If successful, create/update the result PR and return the exact head, tests, and native Worker evidence. Do not claim Worker acceptance from tests or a zero exit code.
