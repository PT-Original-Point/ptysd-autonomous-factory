# Native OpenCode executor isolation (candidate)

This candidate keeps the five-minute issue poller as the Publisher and starts long model work through a separate on-demand Task Scheduler task. It does not install or register that task.

## Required host contract

- Create or designate a standard Windows account whose SID differs from the Publisher SID. Do not use `SYSTEM`, Administrators, or the Codex Publisher account.
- Run the Executor task with `LogonType=Password`, `LeastPrivilege`, `IgnoreNew`, `ExecutionTimeLimit=PT0S`, hidden task metadata, and the exact `node.exe executor.mjs --config ... --manifest-dir ...` action. The password must be supplied through a secure Task Scheduler registration flow and must never be stored in this XML, source, or command logs. S4U is unsuitable because Windows gives S4U tasks no network access, which prevents OpenCode from reaching a model provider. The task name is `\PTYSD\OpenCodeExecutor` by default.
- Keep the Executor's provider authentication in that account's own profile. The OpenCode child receives only the allowlisted OS/runtime environment; provider/API credentials must be read from the Executor's own saved account profile. Do not pass environment-injected provider keys, proxy credentials, config overrides, the Publisher's `gh` authentication, Codex `auth.json`, or any Publisher token to the child.
- Set NTFS ACLs so the Executor can modify only its authorized workspace, one-slot manifest directory, and its own result directory. The Publisher can create/remove manifests and read terminal results. The Executor must not read the Publisher profile, other project credentials, canonical control, trusted verifier, or the Task Scheduler definition.
- Validate the physical paths and ACLs under both actual Windows identities. A separate Git worktree is not an OS security boundary.
- The task definition is a template. `buildExecutorTaskXml()` emits a Password/least-privilege/PT0S/IgnoreNew definition without credentials; secure registration must provide the account password and be read back from Task Scheduler. The source does not create accounts, grant rights, register tasks, or change the existing five-minute task.

## Attempt protocol

1. Publisher checks the exact Task Scheduler XML, publisher SID, distinct Executor SID, and empty manifest slot.
2. Publisher writes one exclusive-create `<attempt_id>.pending.json`, posts and reads back the STARTED receipt, then calls `schtasks /Run` once.
3. Executor atomically renames that manifest to `.running.json`, checks request/source/spec hashes and its own SID, runs the pinned OpenCode task, streams stdout/stderr to local files, and writes one terminal result. At child spawn it durably records the exact request/attempt/manifest hashes, PID, and OS process creation time in the private result directory.
4. A later Publisher poll re-hashes both output files and the combined evidence, reads the exact result, posts and reads back the terminal receipt, then removes only that attempt's manifest marker.
5. A failed or ambiguous `schtasks /Run`, missing/mismatched process evidence, a result-write failure, or an ALIVE/UNKNOWN process-tree readback leaves the exact attempt unresolved; the Publisher does not post a misleading terminal receipt or remove its marker. After restart, the Publisher may trigger reconciliation of the same `.running.json` attempt only when fresh OS readback confirms the recorded process tree is DEAD. The Executor then records an explicitly BLOCKED interrupted result and preserves any verifiable partial output and scoped diff; it never starts OpenCode again for that attempt. Independent non-model work may continue.

## Scoped edit candidate

- A schema-4 `opencode_edit` request carries one exact model/variant and a bounded list of existing tracked source files. Writes have a separate `enable_v2_edit_runs` switch and `allowed_edit_models` list; read-only plan authorization cannot enable edits.
- Every writable request must include a SHA-256-verified Git bundle for its exact source commit. The Executor clones that bundle into a unique detached workspace for the attempt; it never edits the Publisher's configured workspace. Main-based schema-4 work re-reads main and the unchanged task comment before STARTED. Schema-5 PR rework additionally re-reads the same-repository PR head and main base.
- The Executor checks that the isolated Git workspace HEAD equals the request source SHA and is clean before execution. It captures the resulting Git patch, rejects out-of-scope and untracked changes, and the Publisher re-hashes the patch and checks its paths against the original allowlist.
- The first source route intentionally does not accept newly created files. A blocked or ambiguous edit is not automatically replayed. A captured diff or `FINISHED` receipt is still not a test pass, commit, PR, or semantic acceptance.

`FINISHED` remains an attempt lifecycle state. `OPENCODE_V2_EXIT_0_UNTRUSTED` is not semantic acceptance, a code change, a Commit, or a PR.

## Current host status

The live config has no Executor descriptor; no dedicated Executor account, task, NTFS ACL, provider profile, or model authorization has been verified. Therefore the candidate deliberately leaves authorized model jobs undispatched. This file and the synthetic tests do not constitute host isolation, a live Task Scheduler run, a real OpenCode edit, or a production deployment.
