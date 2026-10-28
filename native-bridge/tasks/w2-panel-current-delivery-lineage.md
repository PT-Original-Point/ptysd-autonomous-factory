# W2 R7 panel: current direct-CLI delivery lineage

## Goal

Update the existing operator panel so its W2 card shows the current delivery disposition of the one-time direct Antigravity CLI result while keeping that session separate from schema-6 Worker evidence. The supplied regression fixture uses the latest accepted native Worker result and the verified direct-CLI-to-PR lineage.

## Exact writable scope

The Antigravity model may edit only `operator-panel/index.html`. Do not edit tests, task specs, runtime configuration, Worker/Executor code, schedules, credentials, or any other path.

## Required behavior

- Read the existing Issue #407 comments feed. Do not add an endpoint, API, service, database, scheduler, or a second receipt source.
- Parse `PTYSD_W2_DIRECT_CLI_DELIVERY_V1` only from a trusted dispatcher comment. Bind it to direct-CLI comment `6438594849`, session `be190416-e85f-4f68-b33a-5d05f54d7072`, and original PR #576. Reject or show UNKNOWN when identity fields do not match.
- Display PR #576 as `CLOSED_UNMERGED`, and show its combined successor PR #578 as `MERGED` at merge commit `737fa98390549c12bda2e42466311b42c2198ef6`, with the readback main SHA `1268cdbf5cc56bb7ac3b7fe7fdb9d74adb039e49`. Do not imply that the direct CLI session itself was a native Worker attempt or that PR #576 was merged.
- Show the latest schema-6 W2 Worker job and its matching FINISHED receipt separately. A FINISHED attempt is lifecycle evidence only; preserve `task_acceptance=UNKNOWN` and `external_effects=UNKNOWN`, even when the linked Codex source acceptance and exact-head CI are successful.
- Keep the 2026-10-22 attempt `24331e45-62db-4f55-ad40-87776a799c5d` in the historical field, not as the current W2 result.
- Preserve the existing direct-CLI session, diff, PR, and test fields. If the lineage readback is absent or invalid, render its disposition UNKNOWN without changing the direct-CLI provenance.

## Validation

Run `node --test tests/operator-panel-api.test.mjs`. The regression test is included in the pinned source candidate and binds the actual current Issue #310/#407 identities and evidence fields.
