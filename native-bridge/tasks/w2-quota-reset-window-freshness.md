# W2: reject expired Antigravity quota reset windows

## Authority and objective

This is one bounded, reversible, pre-Production W2 schema-6 coding task under Human GOAL #310 comment 6188322050 and the current bounded W2 authorization. The current execution-readiness gate accepts positive aggregate quota percentages without checking that the corresponding weekly and five-hour reset timestamps are still in the future. A stale quota snapshot can therefore remain eligible after its reset window has expired.

Add a narrow freshness check to the existing Antigravity execution-readiness gate and deterministic regression coverage. Preserve the existing parser's ability to represent a structurally valid historical snapshot; only the execution gate decides whether it is fresh enough to authorize a run.

## Exact edit scope

Edit only:

- `native-bridge/v2-readiness.mjs`
- `tests/v2-readiness.test.mjs`

Do not modify Worker or Executor dispatch behavior, model selection, CLI settings, credentials, task schedules, issue receipts, acceptance state, Production, or any other file.

## Required implementation

1. Extend `antigravityV2ReadinessExecutionFailure` with a deterministic time input whose default is the current clock. The existing runtime call must continue to work without supplying that argument.
2. Before returning readiness success, require both `weekly_reset_at` and `five_hour_reset_at` to be present, canonical UTC timestamps, and strictly later than the supplied current time. Equality with the current time is expired.
3. Fail closed when either timestamp is missing, malformed, noncanonical, invalid, expired, or equal to now. Use a stable existing safe refusal when suitable, or add one narrow safe reason for an expired quota window. Do not include provider text or account details in the reason.
4. Preserve checks for exact pinned model, project identity, signature, authenticated `/usage`, no-G1-credit fallback, file-only tool policy, positive remaining quota, and existing UNKNOWN entitlement/cost semantics.
5. Keep `summarizeAntigravityUsage` as a structural parser; a past timestamp can still be parsed as data, but must not pass the execution-readiness gate.

## Required tests

Update the existing readiness fixtures to use deterministic timestamps. Add focused cases proving:

- valid weekly and five-hour reset timestamps strictly after `now` pass;
- an expired weekly timestamp fails;
- an expired five-hour timestamp fails;
- a timestamp equal to `now` fails;
- missing, invalid, or noncanonical timestamps fail closed;
- the structural parser still reports a valid historical snapshot without claiming it is execution-ready.

Tests must use an injected fixed `now`; they must not sleep, call a live CLI, access network/provider state, change credentials, or execute model inference.

## Worker execution boundaries

Use only the existing schema-6 Antigravity Worker and the currently authorized `gemini-3.8-flash-high` model with variant `high`. The existing preflight must be freshly read immediately before dispatch. Do not use paid fallback, G1 credits, another model, GUI automation, or a direct one-off CLI bypass. If CLI identity, exact model, no-additional-charge policy, authenticated aggregate quota, or unexpired quota windows fail preflight, stop this task before model inference and preserve the refusal evidence.

## Completion evidence

A valid delivery requires the new native Antigravity Session and tool activity, a nonzero diff limited to the two listed source/test paths, focused tests and `git diff --check`, a result PR, trusted CI on the exact result PR HEAD, and independent Codex source acceptance. Keep model usage, `task_acceptance`, and `external_effects` UNKNOWN unless their own source evidence proves otherwise. A session or FINISHED receipt alone is not acceptance.
