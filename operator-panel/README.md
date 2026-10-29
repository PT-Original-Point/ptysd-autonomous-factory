# PTYSD V5.3-R4 operator panel

This folder contains a static, read-only Traditional Chinese page with a
dark-first layout. Open index.html directly in Edge or Brave; it does not start
Node, PowerShell, Windows Terminal, a local listener, or a database. It reads
the single PTYSD_OPERATOR_OBSERVATION_V1 comment and native Issue #407 receipts.
It selects current task source PRs from the fresh Issue #407 native Worker
observation and validates them against the Issue #310 schema-6 dispatch and its
pinned source SHA.
The runtime deployment PR and module hashes remain observation provenance and
are displayed separately from the task source PR. The page also reads current
main and check-runs attached to each exact task PR head from the public GitHub
API; the task PR number is not hard-coded. The one-time W2 direct CLI lineage
retains its separately verified historical PR identities. W2 native schema-6
work and direct CLI lineage remain separate, and historical attempts keep their
historical/unknown status.

The page checks the publisher account, exact project/repository/Issue identity,
snapshot schema, source comment ID, time bounds, and expiry. Missing, duplicate, mismatched,
expired, or unreadable observations show UNKNOWN or STALE. W1/W2/W3/W4 have
separate cards; a Worker only becomes RUNNING_VERIFIED when the observation
binds a task and attempt to recent role-specific activity. Historical sessions,
Tunnel status, receipts, process presence, task exit codes, and Runner service
state do not by themselves prove coding or acceptance. CI queued, in-progress,
completed, failed, cancelled, skipped, and neutral outcomes remain distinct;
skipped/neutral checks are not passes and success is not formal acceptance.
W4's card reads only a bounded Pi version/profile, DPAPI vault-presence,
conditional-ready marker, and exact Task Scheduler state. Provider paid-hardstop
and zero-charge canary remain UNKNOWN until their own receipts are verified;
the card cannot mark W4 as running from installation or process presence.
The active OpenCode session endpoint is intentionally not started by the
observer; without a passively available API, active sessions remain UNKNOWN.

The Native Worker source has a bounded updater for an already seeded comment.
It uses the existing gh identity and Issue #407 only. It updates exactly one
comment authored by that identity after a read-before-write check and exact
readback. A missing or duplicate comment, an author mismatch, or a failed
readback does not create another comment and does not stop task dispatch. The
Windows collector uses short, hidden, read-only PowerShell queries and publishes
only allowlisted task/process fields. It never invokes OpenCode or a model.

## Local use

Open operator-panel/index.html. The page needs network access to
api.github.com; without it the page reports the bounded HTTP, timeout, or
network/CORS error and marks stale data accordingly. It reads the Issue #407 and
#310 comment feeds every 5 minutes, current main at least every 60 minutes,
and each distinct task-source PR plus its exact-head checks every 15 minutes.
Pagination and separate per-worker source PR reads add requests when needed, so
the actual count varies; the panel shows the observed rate-limit headers and
last successful read. Requests use same-URL ETags and a bounded public-response cache. When
browser Web Locks and local storage both work, tabs
serialize GitHub reads and reuse the same fresh public response. If either
cross-tab capability is missing or fails, the page completes its startup read
then disables automatic polling; manual reads still honor source freshness,
rate-limit cooldowns, and the 60-second minimum interval. This coordination is
limited to this browser origin and does not imply a shared quota with other
applications. Rate-limit headers and the last successful source time are shown
in the technical details. No local HTTP server is required.

## Public status and Pages

The public status lives in the same Issue #407 comment linked by the panel. On
2026-10-13 the repository Pages endpoint returned HTTP 404, so this change does
not claim a public hosted HTML URL or enable Pages.

If the repository owner later enables Pages, the exact minimal setting for this
file is **Repository Settings → Pages → Build and deployment → Deploy from a
branch → main → /(root) → Save**. The page would then be available under
https://pt-original-point.github.io/ptysd-autonomous-factory/operator-panel/.
This is a human-controlled repository setting; the PR and current implementation
do not change it.

## Validation

The observation parser, duplicate/author rejection, TTL behavior, hidden
Windows collection contract, Worker identity/evidence thresholds, exact-SHA CI
classification, ETag reads, three-tab lock/cache/cooldown behavior,
duplicate-request coalescing, and HTTP/timeout/CORS failure handling are covered
by tests/operator-observation.test.mjs and tests/operator-panel-api.test.mjs. Source
tests do not prove desktop-browser visual acceptance, Task Scheduler launch
behavior, six popup-free cycles, Pages hosting, or a live OpenCode coding task.
