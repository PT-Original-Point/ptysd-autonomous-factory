# W2 R7 operator panel provenance and native evidence

## Goal

Update the existing static `operator-panel/index.html` so the W2 card distinguishes three evidence records:

1. The latest formal schema-6 `antigravity_edit` job from GitHub Issue #310 and its matching native Worker receipt from Issue #407.
2. The one-time direct Antigravity CLI result in Issue #407 comment `6438594849`, which is explicitly not a native Worker job.
3. The historical 2026-10-22 W2 attempt `24331e45-62db-4f55-ad40-87776a799c5d`, which remains BLOCKED / PARTIAL_OR_AMBIGUOUS with `external_effects=UNKNOWN` and must never be presented as the current result.

## Exact writable scope

Only edit `operator-panel/index.html`. Do not modify tests, task definitions, runtime configuration, other Worker lanes, Task Scheduler, or Production.

The panel is a static local HTML file. Reuse its existing GitHub API client, resource store, polling loop, DOM, and CSS. It is acceptable to read the existing public GitHub REST comments for Issue #310 through that client so formal schema-6 jobs are visible before a #407 receipt appears. Do not create a custom API, server, database, schedule, or second receipt authority.

## Required behavior

- Accept the exact Worker schema-6 job key set for `antigravity_edit`; validate project, host, request ID, source SHA, pinned task-spec path/hash, exact Gemini model/variant, nonempty repository-relative `edit_paths`, source PR, Goal comment ID, and Goal body hash. Reject extra keys, invalid paths, and malformed values. Do not let a schema-6 W2 job replace the W1 task view.
- Select the newest trusted dispatcher job and match only #407 native receipts with the same request ID, source SHA, and kind. Present the job comment, source PR/SHA, attempt, Session, Worker state/outcome, `task_acceptance`, and `external_effects` from the receipt. `FINISHED` is a lifecycle state and is not acceptance.
- A matching additive controller readback marked `PTYSD_V53R4_W2_PANEL_ACCEPTANCE_V1` may report Codex source acceptance, exact-head CI, and test counts separately from Worker `task_acceptance`. Bind it to the exact request, attempt, PR, and source SHA. Never upgrade `external_effects=UNKNOWN`.
- Parse the exact direct-CLI evidence in #407 comment `6438594849`: model/session, changed file and diff SHA, PR #576, focused/full test counts, and its explicit non-native provenance. It must remain visible even when there is no schema-6 native W2 job. Never use it as a Worker receipt or attempt.
- Show the 2026-10-22 attempt in a separate historical field, with its attempt ID, BLOCKED state, PARTIAL_OR_AMBIGUOUS classification, and UNKNOWN external effects. Do not show it as active or as the latest direct-CLI result.
- Render clear empty/unknown states when a job, receipt, session, acceptance note, or direct-CLI record is absent. Do not infer acceptance, model activity, cost, or external effects from PR/CI, Task Scheduler, a successful exit, or the direct CLI session.
- Implement the tested helpers `w2EvidenceData(goalComments, issueComments, mainSha)` and `renderW2Evidence(evidence)` used by `tests/operator-panel-api.test.mjs`. Keep the requested DOM IDs in that regression test.
- Keep Issue #407 freshness/TTL, API cooldown, ETag, and cross-tab coordination behavior intact. If the existing Issue #310 read changes the documented API-read budget, update the page's stated budget accurately in the same existing flow.

## Completion

The panel's native W2, direct CLI, and historical sections must remain visibly distinct and pass the scoped regression tests. Do not claim the new W2 model session exists until a real native receipt records it.
