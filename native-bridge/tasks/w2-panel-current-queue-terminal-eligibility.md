# W2 panel: current request, last terminal attempt, and model eligibility

## Goal

Update the existing W2 card so an operator can distinguish the latest formal W2 request, its exact Worker attempt, the most recent terminal W2 result, the current observed queue state, and the latest observed model eligibility. This is one reversible, pre-Production schema-6 task under Human GOAL #310 comment `6188322050` and its bounded W2 authorization.

## Exact writable scope

Only edit:

- `operator-panel/index.html`
- `tests/operator-panel-api.test.mjs`

Reuse the existing static panel, GitHub Issue #310/#407 reads, Win11 observation snapshot, resource freshness rules, DOM, and test harness. Do not add an endpoint, service, database, scheduler, API, receipt store, browser automation, or a second controller. Do not change Worker/Executor code, configuration, credentials, other lanes, or Production.

## Required behavior

1. Keep the latest trusted schema-6 `antigravity_edit` request bound to its exact Issue #310 comment, Human GOAL identity/hash, source PR/head, request ID, kind, and edit scope. Match only #407 receipts for that exact request and source identity.
2. Present the **latest formal W2 request observation**, **current W2 queue/activity observation**, and **most recent terminal W2 attempt** as separate facts:
   - incomplete or stale sources, mismatched request/source identity, or unbound multiple attempts => `UNKNOWN`;
   - a complete #310 read with no formal schema-6 W2 request means only “no formal W2 request observed”; it does not prove the native queue is empty or that no READY Goal work exists;
   - a trusted latest request without a matching receipt means “request observed; Worker receipt not observed,” never `STARTED`, active execution, or an empty queue;
   - current queue/idle may be reported only from the exact W2 row in a fresh, trusted #407 Win11 observation. An idle/empty claim requires a supported `IDLE` classification with its explicit no-work evidence kind; absence of a task row or receipt is not enough;
   - `STARTED`, `WAITING`, `FINISHED`, and `BLOCKED` reflect only the exact matching native receipt. `FINISHED` is terminal lifecycle state, not task acceptance.
3. Show the most recent exact terminal receipt as a labeled last result, not as currently queued or in progress. Bind it to a formal #310 job and preserve its `task_acceptance` and `external_effects` values, defaulting absent values to `UNKNOWN`. Do not promote Worker `FINISHED`, a result PR, CI, or Codex source acceptance into Worker acceptance or live execution.
4. Show W2 model eligibility separately from the model-execution switch. Read only the explicit `model_eligibility` value from the same fresh, trusted W2 Worker observation, with its task/request and source identity matched where present. `WAITING` is a waiting state, never eligibility approval; `UNKNOWN`, missing, stale, incomplete, malformed, or unsupported values remain `UNKNOWN`. The existing observation contract does not establish `READY` from an enabled switch, Task Scheduler `Ready`, model catalog, quota, prior attestation, PR, CI, or terminal attempt alone.
5. Keep the existing W1, W3, direct-CLI, and historical-attempt displays and their provenance unchanged. A direct CLI Session is never a native Worker task. Preserve historical W2 `UNKNOWN` effects and never imply replay.
6. Add regression coverage for: a new queued W2 request alongside a previous FINISHED attempt; a FINISHED latest request with UNKNOWN acceptance/effects; fresh explicit W2 idle evidence versus missing/absent idle evidence; request without a receipt; a fresh explicit `WAITING` eligibility value with both switch states; missing/stale/unknown/unsupported eligibility; incomplete #310/#407 sources; wrong request/source/attempt identity; unbound multiple attempts; and no cross-lane changes.

## Completion

The panel and API tests clearly distinguish request observation, current queue/activity, last terminal Worker result, and current observed eligibility while preserving conservative `UNKNOWN` semantics. Run the focused existing operator-panel tests and report the exact source diff, test results, exact-head CI, and any visual status as `VISUAL_NOT_TESTED` if no authorized ChatGPT in-app browser evidence is available. Do not claim a new W2 model execution from this panel task.