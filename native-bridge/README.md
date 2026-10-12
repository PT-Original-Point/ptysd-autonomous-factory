# PTYSD native OpenCode Issue bridge (version-neutral)

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
* `opencode_plan` uses `opencode --pure run --agent plan` with inline denied
  mutation, shell, external-directory, task delegation, web and sharing. OpenCode
  exit code 0 is **not** trusted verifier acceptance or deployment evidence.
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

Prerequisites: Windows user workspace under `%USERPROFILE%`, Node 24+, official
`gh` authenticated for the current OS user, `opencode` CLI, and a user already
logged in. `Install` runs at *Limited* privilege; it never requests UAC.

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

* Protected: `PTYSD-Factory-Monitor` and 2667 listener; WinRM;
  `.codex-chatgpt-web`; unrelated projects; immutable `governance/**`/`runs/**`.
* Separate human-gated lanes: exact elevated v47 delete, 22 legacy task
  classifications, Factory MCP/HostGuard/JEA/secrets, self-hosted Runner #405.
* `main` source merge, a `ping` result or an OpenCode plan result is **not** a
  canonical CP promotion or Windows retirement PASS.
