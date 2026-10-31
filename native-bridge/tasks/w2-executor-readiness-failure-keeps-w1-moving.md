# W2: Reconcile W2 Preflight WAITING While W1 Continues

## Authority and bounded objective

This is one reversible, pre-Production W2 schema-6 task under the Human V5.3-R4 GOAL in Issue #310 comment 6188322050. Add an integration regression for same-poll recovery: after the W2 Executor has already written an exact, effect-free preflight WAITING result for a STARTED schema-6 attempt, the existing Publisher must reconcile that result and continue to dispatch an independent READY W1 edit in the same poll.

This task uses the existing Antigravity Executor and GitHub receipt path. It does not authorize Production, paid fallback, identity or credential changes, Task Scheduler changes, configuration changes, runtime deployment, or modification/replay of historical attempts.

## Verified test gap

Current tests separately cover: W2 executor preflight WAITING persistence; W1 continuation while W2 is disabled; W2 authorization waiting while an independent ping proceeds; and W1 executor WAITING followed by a ping. They do not combine a native W2 STARTED receipt plus its persisted no-model WAITING result with a separate schema-6 W1 edit that is dispatched by executeWorker in that same recovery poll. This leaves the R4 result-recovery and lane-isolation criteria unverified together.

## Exact edit scope

Only this file may change:

- tests/native-bridge.test.mjs

Do not change Worker or Executor source, scheduler definitions, manifests, configuration, model policy, permissions, receipts, runtime files, or any other path. Do not alter or replay W1 attempt 84e8dfee-a704-43ef-9cc5-3bb6da0279c7 or W2 attempt 7ef0cb8a-b084-4c2a-8db3-2b2ecfe704e6.

## Required regression behavior

Add one focused executeWorker integration test with:

1. A valid, source-pinned schema-6 W2 request with one synthetic STARTED receipt and its exact persisted Executor WAITING result, bound to the same request, attempt, source, and task. The WAITING result must explicitly state model_invoked=false and have no model Session or file diff.
2. A distinct, independently READY schema-6 W1 edit request with non-overlapping edit paths and a qualified OpenCode Executor.
3. Publisher reconciliation of the W2 WAITING result exactly once, without invoking or redispatching W2 in this same poll.
4. Exactly one W1 STARTED receipt and one W1 Executor dispatch during that same poll, preserving the exact W1 request, source SHA, source PR, and edit paths.
5. Assertions that the W2 receipt remains an effect-free preflight wait, no W2 model call/session/diff is invented, no previous attempt is replayed, and W1 is not marked blocked.

Keep model/provider and Task Scheduler behavior mocked in this regression; the separate live schema-6 W2 run is performed only by the existing native Worker.

## Verification

Run:

node --test tests/native-bridge.test.mjs
git diff --check

Report the exact changed path, diff digest, test totals, W2 Session and tool evidence, result PR/head and trusted exact-head CI. A schema-6 source PR is only a pinned task specification, not a Worker result or acceptance.
