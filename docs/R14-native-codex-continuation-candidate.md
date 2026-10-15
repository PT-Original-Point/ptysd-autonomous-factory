# R14 Native Codex Continuation Candidate

**Status:** noncanonical source candidate. This document and its code do not amend
CSG, Mission, Policy, production authorization, or the accepted factory state.

**Input specification:** the exact comment body at Issue #310 comment `6182823543`,
read from GitHub on 2026-10-15. That comment is itself explicitly noncanonical.

## Intent

Reuse the existing GitHub Issue #407 job and receipt stream, the current native
Publisher wake, Windows Task Scheduler, and Codex CLI. The Publisher remains a
short polling/dispatch process. A separate on-demand, limited Windows task owns
the long Codex process. Each natural Publisher wake can consume one ready task;
after its receipt is read back, a later existing wake can select the next task.
No second task database, service, GUI controller, or agent bus is introduced.

## Source flow

1. The Publisher reads the existing Issue, dispatcher identity, current `main`
   SHA, exact source-pinned task bytes, and same-Issue receipts.
2. Only a schema-3 `codex_plan` authored by an allowlisted dispatcher, pinned to
   current `main`, scoped to permitted paths, and not already started or terminal
   is eligible.
3. The Publisher creates and hashes an immutable Git bundle before taking its
   durable one-attempt claim. A bundle preparation failure therefore creates no
   claim or receipt. The request contains the task bytes, source identity, and
   bundle hash, never a GitHub credential.
4. The Publisher stores the request, writes a `STARTED` receipt, confirms exact
   remote readback, then invokes the separate Task Scheduler executor. An
   ambiguous write or trigger is never treated as permission to replay. A
   per-receipt local claim and exact Issue readback prevent a second post after
   an ambiguous transport result.
5. The Executor verifies its OS identity and disabled-by-default policy gates,
   validates the request and source bundle, checks out the exact SHA, then runs
   `codex exec --json --sandbox workspace-write` in a detached workspace. It
   streams stdout and stderr to local evidence, gives child `gh` a fresh empty
   per-attempt config directory and strips GitHub/API token environment values,
   records session/diff hashes and changed paths, and writes a local result.
   The Executor does not publish to GitHub and receives no Publisher token.
   NTFS ACLs keep Publisher-owned `requests/` and `bundles/` read-only to the
   Executor; it writes only to separate `claims/`, `results/`, `evidence/`,
   `workspaces/`, and `locks/` areas. Requests stay in place and a durable
   per-attempt claim prevents replay after a process or host interruption. An
   unreconciled local Codex claim blocks that Codex lane without starving an
   independent eligible native job.
6. A later Publisher wake validates the local result, writes the matching
   terminal receipt to the same Issue, and selects a different ready task on a
   subsequent wake. CLI exit 0 is an execution-attempt terminal only; the
   outcome remains `CODEX_CLI_EXIT_0_UNVERIFIED`, with tests and PR unset.

## Host gates and limits

The installer defaults to read-only `Audit`. Its `Install` path is inert until
explicitly invoked and requires a distinct standard-user credential, machine
accessible signed executables, exact Task Scheduler readback, and a backup of
the current Publisher configuration. It creates only an on-demand task with no
trigger, `IgnoreNew`, `Limited`, and `PT0S`; it does not alter
`PTYSD-Native-OpenCode`, `HiddenWorker.vbs`, or any existing trigger. The stored
configuration sets model execution and usage authorization to false, with the
sandbox boundary `UNKNOWN`.

The current Win11 evidence qualifies the installed Codex CLI binary, its
noninteractive help surface, current-user login status, and a no-model sandbox
probe. It does **not** qualify a separate Executor identity, a workspace-only
sandbox boundary, a no-additional-cost model authorization, or the executor
Task Scheduler task. A temporary-file probe was readable outside the configured
workspace, so that sandbox boundary is explicitly not accepted. No model was
called. The source candidate must remain disabled until each missing gate is
independently evidenced and the source is formally accepted.

OpenAI's official non-interactive mode documentation confirms `codex exec` is
designed for scripts and scheduled jobs, reuses saved CLI authentication by
default, and describes ChatGPT-managed authentication in CI as an advanced
path. Accordingly, this candidate does not copy or seed auth files and does not
assume the current GUI/CLI login has no-cost unattended entitlement. See
[Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode).

## Verification boundary

Unit/fault tests use synthetic GitHub adapters and a deliberately blocked
Executor configuration. They validate dispatch ordering, one-attempt claims,
receipt identity/readback behavior, no blind replay, local result validation,
and selection of the next task. They do not prove GitHub live publication, a
Task Scheduler trigger, model execution, a code change by Codex, a commit, PR,
CI, reboot behavior, or production automatic continuation.

`npm test` also has three existing worker integration tests skipped on Windows:
their fake `gh` executable is POSIX-only. These skips are not host acceptance.
The R14 candidate does not install a schedule or update the deployed Worker.

## Acceptance still required

- Independent review and formal source acceptance of the exact R14 PR head.
- A separately authorized standard-user Executor identity and cost/model scope.
- A verified sandbox boundary confined to the detached workspace.
- A controlled post-acceptance host canary with fresh source/receipt readback.
- Reboot and natural-cycle acceptance before any production automation is enabled.
