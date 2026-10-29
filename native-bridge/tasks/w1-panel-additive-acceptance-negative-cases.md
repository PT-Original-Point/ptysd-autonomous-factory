# W1: Add Negative Coverage for Current Additive Source Acceptance

## Authority and bounded objective

This is one bounded, reversible pre-Production W1 schema-6 task under Human GOAL #310 comment 6188322050. It verifies the current W1 source-acceptance implementation against the additive reconciliation record format used by later W1 deliveries. It does not authorize Production, new fees, credential changes, runtime changes, or changes to any prior attempt.

The current main implementation is intended to support both the legacy reviewed-source record format and the additive `ADDITIVE_CODEX_SOURCE_AND_DIFF_RECONCILIATION_NOT_NATIVE_WORKER_RECEIPT` format. Existing coverage includes legacy PR #590-style acceptance and a positive additive W1 record. Close the missing negative-case coverage for the additive format without duplicating the legacy fixture or weakening any acceptance rule.

## Exact edit scope

- `tests/operator-panel-api.test.mjs`

Do not change `operator-panel/index.html`, Worker or Executor source, runtime configuration, scheduler state, model selection, receipts, credentials, or any other file. Do not rewrite or remove existing PR #590 / PR #606 fixtures.

## Required regression coverage

Extend or add a focused test using the additive reconciliation format. Use distinct synthetic request, attempt, source PR/head, worker diff, result PR/head, and merge identities. Keep the result PR number data-driven; it must not rely on PR #590 or one fixed result PR.

The valid fixture must prove that acceptance requires the exact task comment/request, FINISHED receipt/attempt, source PR and source SHA, worker diff SHA and byte count, result PR/head/merge commit, allowed changed paths and merged blob identities, exact trusted required CI checks, focused test summary, Codex review, and the source-acceptance value derived from the same result PR. The displayed result PR must follow the fixture.

Add independent negative mutations for at least:

1. A mismatched request, task-comment, attempt, or project/GOAL identity.
2. A mismatched source SHA or source PR, and a mismatched worker diff SHA or byte count.
3. A forged `source_acceptance` value, or inconsistent `integration=PR_<n>_MERGED` versus result PR metadata.
4. A missing or failed required trusted check.
5. A changed path outside the pinned edit paths or a missing/invalid merged blob identity.

Each invalid case must be rejected as Codex source acceptance. Preserve the original Worker terminal as `FINISHED_NOT_ACCEPTANCE`, Worker `task_acceptance=UNKNOWN`, `external_effects=UNKNOWN`, and `live_acceptance=NOT_CLAIMED`. Do not convert source acceptance into Worker PASS.

Keep the existing legacy-format tests and the existing additive positive test passing. If a test demonstrates a production-code defect, stop within this pinned test-only scope and report the exact failing case; do not expand the allowed edit paths.

## Verification

Run:

```text
node --test tests/operator-panel-api.test.mjs
git diff --check
```

Report the exact changed path, diff identity, test totals, result PR/HEAD and exact-head trusted CI. A schema-6 source task candidate is not itself a Worker delivery or acceptance.
