# W2: Reject mismatched Antigravity usage command identity

## Authority and objective

This is one bounded, reversible, pre-Production W2 schema-6 coding task under Human GOAL #310 comment 6188322050 and its current bounded W2 authorization. Add a focused negative integration regression for `runAntigravityV2Readiness`: quota-shaped JSON must not establish authenticated quota evidence when the CLI envelope identifies another command or reports a nested command error.

This task changes tests only. Do not edit readiness code, quota parsing code, Worker or Executor logic, runtime settings, task schedules, credentials, claims, receipts, or any earlier attempt.

## Exact edit scope

- `tests/v2-readiness.test.mjs`

Do not edit any other file. The task spec is not an additional model edit path.

## Required implementation

Add one focused test near the existing Antigravity JSON usage readiness integration test. Use the existing temporary-profile and project helpers where practical. Supply quota-shaped Gemini weekly and five-hour buckets in two malformed-success cases:

1. The outer envelope has `status: "SUCCESS"`, but `command.name` is `credits`.
2. The command name is `usage`, but the envelope includes a non-null `command.error` (or a non-success nested command status).

For each case, assert that readiness:

- does not return `GEMINI_AGGREGATE_QUOTA_READ` and does not record `AUTHENTICATED_QUOTA_READ`;
- leaves authentication unchecked/unknown and reports the existing safe usage-output failure classification;
- fails the execution-readiness gate with the existing aggregate-quota-unknown reason;
- records `inference_executed: false` and does not expose any synthetic account/email marker from the envelope.

Reuse the current functions and stable result codes. Do not add a new status, change runtime behavior, or weaken any authorization check. Keep the test independent of live credentials, network, provider calls, and model inference.

## Verification after the Worker result

Run:

```text
node --test tests/v2-readiness.test.mjs
git diff --check
```

Report the exact changed path, worker diff hash/bytes, focused test totals, result PR/HEAD, exact-head trusted CI, and the Codex source acceptance. A model session or `FINISHED` receipt alone is not acceptance.
