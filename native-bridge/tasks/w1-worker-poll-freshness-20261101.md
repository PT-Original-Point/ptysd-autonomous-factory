# W1 Task: separate native observation time from last task event in Worker cards

Project ID: CHATGPT_GLOBAL_SKILL_GOVERNANCE
Repository: PT-Original-Point/ptysd-autonomous-factory
Human authorization: Issue #310 comment 6188322050
Base main observed before dispatch: 876183a2be928b8f296e7cace0a5076263716a82

## Verified gap

The W1 and W2 cards show a `最後任務事件` timestamp, while the page's Win11 observation timestamp is only in the factory-level summary. When no task is dispatched, the last task event correctly remains old, but the cards do not show the newer native observation beside it. This can make a healthy empty-queue poll look like missing Worker telemetry. The current source already distinguishes poll disposition from model activity; this task adds a clearly separate timestamp for the validated Win11 observation and preserves the task-event timestamp as historical task evidence.

## Required implementation

1. In the existing W1 and W2 cards, show two distinct fields: the existing `最後任務事件` and a new `最近 Win11 原生觀測（非派工／非模型活動）` field.
2. Derive the new field only from the already validated current operator snapshot's `windows.observed_at`. Use the existing freshness result to mark the observation `FRESH`, `STALE`, or `UNKNOWN`. An absent, invalid, or untrusted timestamp must display `UNKNOWN`; never fall back to an Issue updated time, task receipt time, model Session time, or another lane's activity time.
3. The timestamp means only that the native Win11 observation was collected. It must not imply a Worker task, model invocation, Session, active coding, acceptance, or healthy executor. Keep the existing task event, status classification, task acceptance, and external-effect semantics unchanged.
4. Keep W3 rendering unchanged. Use the existing HTML, rendering code, and test harness; add no service, API, endpoint, database, schedule, or receipt type.
5. Test fresh, stale, missing, malformed, and future-dated observation timestamps. Also verify that a historical task-event timestamp remains separately visible and is not overwritten by the observation timestamp, and that no model Session or acceptance is inferred from the poll observation.

## Exact Worker edit scope

- operator-panel/index.html
- tests/operator-panel-api.test.mjs

## Boundaries

- Do not modify native Worker/Executor code, Worker settings, model/provider configuration, credentials, task scheduling, Windows identity, OAuth/MFA, billing, Production, or W2 eligibility.
- Do not change or close unrelated pull requests. Return only the scoped diff and test evidence; Codex will inspect the result, verify exact-head CI, and manage source acceptance.
- Preserve historical Worker `task_acceptance=UNKNOWN` and `external_effects=UNKNOWN`; do not replay any previous attempt.

## Completion evidence

A valid result requires a real OpenCode V2 Session and observed tool activity, a nonzero scoped diff limited to the two files above, relevant tests, a result PR on an exact HEAD, trusted exact-head CI, and separate Codex source acceptance. A local test or model response alone is not completion.
