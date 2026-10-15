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
* Every `opencode_plan` job references a restricted `native-bridge/tasks/*.md`
  file from the **exact current main commit** and carries SHA-256 of its contents.
  Neither an Issue body nor a free-form comment becomes a shell instruction.
* `ping` is native, zero-token, and verifies round-trip GitHub comments.
* `opencode_plan` is **OpenCode V2 ONLY** and read-only. A native binary must return version
  2.x. V1 executables are rejected, regardless of file name. Jobs pin exact
  `provider/model` plus `variant`; V2 receives `provider/model#variant`.
  The worker installs only a reviewed V2 project-local `opencode.json` with
  ordered `permissions` rules, denying edit/shell/subagent/external access.
* `opencode_edit` is a separate schema-3 candidate using the same Executor, with an exact
  `write_paths` allowlist. It creates a detached local clone at the pinned source SHA and
  captures an allowlisted Git diff plus SHA-256 as local attempt evidence. It does not
  commit, push, run tests, or imply acceptance. Runs fail closed unless the user-local
  config explicitly enables coding and the Executor returns a request/source-bound
  Windows isolation readback. A config string is not proof; the current native readiness
  path reports `NOT_VERIFIED`, and the current Executor does not wire an ACL verifier, so
  this candidate cannot invoke a coding model.
  It refuses unknown workspace configuration rather than overriding it.
  V2 model invocation is **disabled by default** until local
  `enable_v2_model_runs=true` and an exact `allowed_models` entry are set
  after version, config and provider authorization qualification. OpenCode
  exit code 0 alone is **not** accepted verifier or reasoning-strength evidence.
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
