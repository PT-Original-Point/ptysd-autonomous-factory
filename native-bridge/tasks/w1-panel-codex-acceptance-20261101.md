# W1 Task: show exact Codex source acceptance for both Worker lanes

Project ID: CHATGPT_GLOBAL_SKILL_GOVERNANCE
Repository: PT-Original-Point/ptysd-autonomous-factory
Human authorization: Issue #310 comment 6188322050 (body SHA-256 2f1829da0e1f5105a384be03904b2289c57c05e8a44215c4824fb6b8631d8f7b)
Base main: f990b11120f697cec00cd9954cd5da82869c0e84

## Verified panel defect

The dashboard's W2 parser in `operator-panel/index.html` recognizes only `PTYSD_V53R4_W2_SOURCE_ACCEPTANCE_V1`. The canonical Codex acceptance format already written to Issue #407 is `PTYSD_V53R4_CODEX_SOURCE_ACCEPTANCE_V1` with `record_type=ADDITIVE_CODEX_SOURCE_ACCEPTANCE_NOT_NATIVE_WORKER_RECEIPT`. It is used by W2 acceptance comment 6546908379 (task W2 attempt 9855fb47-d48b-4c53-8a8b-81c4d3f90155, result PR #667) and by W1 acceptance comment 6553137916 (attempt 94fbdc22-ab56-4a9e-b4f1-cf24bf73aa5e, result PR #685). The current panel silently omits these accepted source results.

## Exact edit scope

Only edit:

- `operator-panel/index.html`
- `tests/operator-panel-api.test.mjs`

Do not change Worker/Executor runtime, job selection, issue authority, schedules, settings, or other files.

## Required behavior

1. Reuse the existing #310 jobs, #407 receipts and acceptance comments, result PR reads, and exact-head check reads. Add no service, API, database, or scheduler.
2. Parse the canonical `PTYSD_V53R4_CODEX_SOURCE_ACCEPTANCE_V1` record only for the exact matching schema-6 job and terminal attempt. Bind project/repository, current Human GOAL id and body SHA, request id, attempt id, STARTED/terminal comment ids, task source PR/head/spec path/spec SHA, model/session, worker diff SHA/bytes, changed paths, result PR/head/base, merge commit/main readback where declared, and the required trusted check names/conclusions at the exact result HEAD.
3. Keep the existing strict W2 head-only and blocked-terminal record formats working. A merged PR alone, a generic comment with `ACCEPTED` text, or a Worker FINISHED receipt must never become Codex source acceptance.
4. Display Codex source acceptance separately from native Worker state. Preserve `task_acceptance=UNKNOWN`, `external_effects=UNKNOWN`, and `live_acceptance=NOT_CLAIMED`; do not display Worker PASS or claim runtime deployment.
5. Handle W1 and W2 independently so an acceptance for one request or lane cannot be attached to the other lane's task.

## Tests

Extend the existing operator-panel API/parser tests with positive fixtures for the canonical W1 and W2 records, plus negative cases for mismatched request, attempt, goal/body SHA, source PR/head/spec, model/session, diff SHA/bytes, changed path, result PR/head, merge/main SHA, missing or wrong required check, duplicate/conflicting fields, unauthorized author, rejected/unknown acceptance, and a merged PR without a matching acceptance. Assert Worker acceptance and external effects remain UNKNOWN in accepted cases. Keep all tests using the existing mocked GitHub sources.

Run `node --test tests/operator-panel-api.test.mjs`; inspect the final diff and preserve exact scope. A valid result needs a real W1 OpenCode V2 Session and tool activity, nonzero diff only in the two permitted paths, passing focused tests, result PR, trusted checks on its exact HEAD, and Codex source acceptance. Never infer model activity from a test or dashboard state.