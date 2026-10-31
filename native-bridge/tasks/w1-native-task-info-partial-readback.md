# W1: Preserve Native Task State When Scheduler History Lookup Fails

## Authority and bounded objective

This is one bounded, reversible pre-Production W1 schema-6 task under Human GOAL #310 comment 6188322050. Harden the existing Windows observer so a transient failure to read the primary task's last-run metadata does not discard otherwise successful reads of the exact registered task and its current state. This task does not authorize Production, additional fees, identity or credential changes, model changes, scheduler changes, runtime deployment, or any change to prior attempts.

## Verified source gap

At the pinned source SHA, `native-bridge/operator-observation.mjs` handles `Get-ScheduledTaskInfo` failures for executor tasks locally, but the corresponding lookup for `PTYSD-Native-OpenCode` is outside a local `try/catch`. A single history lookup failure therefore reaches the collector's outer catch and returns `WINDOWS_READBACK_FAILED`, even after the exact task object and its current state were read. The normalized schema already accepts null `last_run` and `last_result` values.

## Exact edit scope

Only these files may change:

- `native-bridge/operator-observation.mjs`
- `tests/operator-observation.test.mjs`

Do not change `worker.mjs`, `operator-panel/index.html`, schemas, task selection, receipts, runtime manifests, configuration, Task Scheduler, provider login, or any other file. Do not modify or depend on Draft PR #556; it is a separate W4 read-only monitor candidate.

## Required behavior

1. Keep the existing exact task discovery and identity checks unchanged. Failure, ambiguity, or an unhandled error while obtaining the task itself must continue to fail closed through the existing `WINDOWS_READBACK_FAILED` path.
2. Initialize only the primary task's `last_run` and `last_result` values as unknown (`$null`) before querying `Get-ScheduledTaskInfo`.
3. Catch failure of that history query locally. If it fails or returns no usable object, preserve the successfully read task registration, enabled state, scheduler state, action, identity, and trigger fields; leave `last_run` and `last_result` null. Never coerce missing history to `0x00000000` or another success value.
4. On a successful history query, preserve the existing date validation and result formatting.
5. Do not publish exception text or widen the OS query scope. Keep the observation freshness rules and all Worker/source acceptance semantics unchanged.

## Regression tests

- Add a focused failure-path regression showing that a failed/missing history result is represented as null for both `last_run` and `last_result`, while the exact task's already-read state and other allowlisted fields survive.
- Assert that the primary `Get-ScheduledTaskInfo` call is locally guarded and that a missing value cannot be formatted as a zero result.
- Keep a success-path regression for the existing formatted history result.
- Keep the outer fail-closed behavior for task discovery/collection errors; do not convert those errors into a fresh observation.

## Verification

Run:

```text
node --test tests/operator-observation.test.mjs
git diff --check
```

Report the exact changed paths, diff digest, test totals, result PR/HEAD and exact-head trusted CI. A schema-6 task source PR is a pinned dispatch source, not a Worker delivery or acceptance.