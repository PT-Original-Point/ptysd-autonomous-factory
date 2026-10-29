# W1: select a distinct request after a finished W1 attempt

Project: `CHATGPT_GLOBAL_SKILL_GOVERNANCE`
Repository: `PT-Original-Point/ptysd-autonomous-factory`
Authorization source: Human GOAL comment `6188322050`

## Purpose

The latest accepted W1 work has a terminal receipt. The formal queue must continue with a different READY request without replaying the finished request or its attempt. Existing tests cover unrelated-lane progress and W2 waits, but do not directly lock this sequential W1 case.

## Bounded task

Add a regression test in `tests/native-bridge.test.mjs` for the existing schema-6 queue-selection path. Provide two distinct, valid W1 `opencode_edit` requests with exact source PR/head bindings. Give the older request a terminal `FINISHED` receipt and any source-acceptance evidence needed by the fixture. Assert that the selector skips the old request and returns the newer distinct READY request exactly once. Assert that the old request and attempt remain unchanged and are not replayed. Keep any active same-path lease behavior precise in the fixture; a terminal prior attempt must not hold a stale lease.

Only change the implementation in `native-bridge/worker.mjs` if the new test first reproduces a concrete selection defect; keep any fix minimal and covered by the regression. Do not turn `task_acceptance=UNKNOWN` or `external_effects=UNKNOWN` into accepted delivery.

## Allowed edit paths

- `native-bridge/worker.mjs`
- `tests/native-bridge.test.mjs`

## Limits

- Do not edit the Human GOAL, task receipts, prior request/attempt, Windows settings, runtime config, or scheduler.
- Do not replay any prior attempt or invoke a second provider session for the same request.
- Do not add a database, controller, service, schedule, or new authority.
- Run the focused existing native-bridge test file and report exact counts. Codex will independently review the diff and delivery evidence.
