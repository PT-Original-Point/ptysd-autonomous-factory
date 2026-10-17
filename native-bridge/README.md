# PTYSD native GitHub Issue bridge — OpenCode V2 only

This is a **native, non-privileged candidate** for replacing manual ChatGPT↔OpenCode
copy/paste. It is not a second governance database, MCP gateway, supervisor or
background model poller. GitHub Issue #<configured> is the sole durable task and
receipt source. The Windows Task Scheduler is only a 5-minute native trigger;
no new process stays resident between polls.

## Trust and side effects

* The account connected to `gh` must be authenticated to GitHub and have permission
  to read and comment on the exact repository issue. Never write a token to a task,
  command line, source code, public issue, or evidence report.
* The worker accepts only the configured exact project ID, repository, host name,
  Issue title, and an allowlisted dispatch comment author. Job schema is fixed.
* Every OpenCode task references a restricted `native-bridge/tasks/*.md` file
  from the **exact current main commit** and carries SHA-256 of its contents.
  Neither an Issue body nor a free-form comment becomes a shell instruction.
* `ping` is native, zero-token, and verifies round-trip GitHub comments.
* `opencode_plan` is **OpenCode V2 ONLY**. A native binary must return version
  2.x. V1 executables are rejected, regardless of file name. Jobs pin exact
  `provider/model` plus `variant`; V2 receives `provider/model#variant`.
  The worker installs only a reviewed V2 project-local `opencode.json` with
  ordered `permissions` rules, denying edit/shell/subagent/external access.
  It refuses unknown workspace configuration rather than overriding it.
  V2 model invocation is **disabled by default** until local
  `enable_v2_model_runs=true` and an exact `allowed_models` entry are set
  after version, config and provider authorization qualification. OpenCode
  exit code 0 alone is **not** accepted verifier or reasoning-strength evidence.
* `opencode_edit` uses a separate exact-path schema and the existing disposable
  Executor workspace. OpenCode V2 receives only the task's explicit edit paths;
  the executor records the resulting Git diff and SHA-256. A captured diff is
  `UNVERIFIED` until Codex inspects it and runs the required tests. CLI exit 0
  and `FINISHED` describe only that attempt, never code acceptance.
* Neither job type can request elevated privilege, delete archive/MCP/Runner,
  modify branch protection, or approve a change to trusted verifier sources.
* Output stays in `%LOCALAPPDATA%\PTYSDNativeBridge`; only machine-readable
  outcome, exit status and local evidence hash are posted publicly. Never post
  raw prompts, stdout/stderr, credential material or private paths.
* `STARTED` followed by a crash is **ambiguous**, never automatically reissued.
  A saved exact-attempt terminal receipt may be replayed, without rerunning work.
* This is single-host by contract. Task Scheduler `IgnoreNew` keeps one local
  scheduled run; do not install a second host worker on the same queue.

## Native Windows installer (one-time, NOT executed by ChatGPT Web)

Prerequisites for ping/preflight: Windows user workspace under `%USERPROFILE%`,
Node 24+, official `gh` authenticated for the current OS user, and a user
already logged in. OpenCode V2 CLI is **not** required for GitHub transport.
AI model work additionally needs an official V2 native binary, verified
`--version` 2.x, matching authenticated provider, and explicit local enablement.
`Install` runs at *Limited* privilege; it never requests UAC.

Within an actual Win11 OpenCode/Codex session (not in a ChatGPT browser sandbox):

```
& .\native-bridge\install.ps1 -Mode Audit
& .\native-bridge\install.ps1 -Mode Install -IssueNumber <ISSUE> -Workspace "$HOME\repos\ptysd-autonomous-factory"
& .\native-bridge\install.ps1 -Mode RunOnce
```

The installer refuses to overwrite an unknown existing task. Do not create the
Task Scheduler task under SYSTEM/Administrator. Its Interactive logon token needs
the `x` account to remain logged in: running before the first logon after a reboot
is **not** guaranteed. Qualification for full 24/7 service would require a
separately reviewed native OS identity/authentication model, not an admin backdoor.

The `RunOnce` end-to-end qualification passes only when the matching GitHub
`STARTED` and terminal receipt appear and the same-source readback matches.
Source-only ZIP, GitHub PR, or `Install` readback does not count as live dispatch.

## Queue messages

Issue title must be exactly `[PTYSD-NATIVE] OpenCode dispatch and receipts`.
One comment per job, with the marker **on the first line**:

```
PTYSD_NATIVE_JOB_V1
{"schema":1,"project_id":"CHATGPT_GLOBAL_SKILL_GOVERNANCE","host":"DESKTOP-1B6PD2P","request_id":"PTYSD_NATIVE_PING_20261012","kind":"ping","source_sha":"<EXACT_MAIN_SHA>","spec_path":null,"spec_sha256":null}
```

Receipts are new comments starting with `PTYSD_NATIVE_RECEIPT_V1`. No other source
is authorized to change accepted tasks, production approvals, or canonical refs.

Candidate builds also accept a schema-6 structured edit job posted by a trusted
dispatcher on Issue #310. The same exact job marker, latest-GOAL binding, source
PR/head checks, claim, and executor path apply; arbitrary GOAL prose is never
converted to a command. All receipts and retry/deduplication readbacks remain on
Issue #407.

Candidate PR edit jobs use schema 6 and add `goal_comment_id` plus the SHA-256 of
the exact comment body. The Worker reads that comment from Issue #310, verifies
the trusted author, issue identity, and V5.3-R4 GOAL marker, and requires it to
be the latest trusted V5.3-R4 GOAL comment at both selection and final dispatch
readback. A newer trusted GOAL makes older queued candidate jobs stale. The
task itself remains the exact
`spec_path`/`spec_sha256`, edit-path list, and open same-repository PR head in the
job. GOAL prose is provenance only and is never interpreted as shell or task
instructions. Older schema-5 candidate jobs remain readable for history but
are not dispatched without this byte-pinned GOAL reference.

## Evidence / disabled scopes

* Retired: legacy `PTYSD-Factory-Monitor` / `127.0.0.1:2667`. Win11 readback on 2026-10-15 found no registered monitor task or listener; do not reinstall it.
* Protected: WinRM; `.codex-chatgpt-web`; unrelated projects; immutable `governance/**`/`runs/**`.
* Separate human-gated lanes: exact elevated v47 delete, 22 legacy task
  classifications, Factory MCP/HostGuard/JEA/secrets, self-hosted Runner #405.
* `main` source merge, a `ping` result or an OpenCode plan result is **not** a
  canonical CP promotion or Windows retirement PASS.

## V2-only support boundary

The existing Windows Task Scheduler has already returned real native `ping` and
`native_preflight` receipts. Source changes in a GitHub PR are **not** deployed
until the old on-disk Worker is replaced under the original Limited Task and
read back by SHA-256. No OpenCode 1 npm package, legacy `--pure`, legacy
`permission`/ `bash` / `task` rules, or default paid model fallback is allowed.
Use official `@opencode/cli` V2 only after a pinned version and native Windows
binary are independently qualified. The user must not need an additional MCP,
port listener, or administrative service for this step.

The relevant model/version qualification is detailed in
`native-bridge/CLI-PREFLIGHT.md`.
