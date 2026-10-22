# Native Windows on-demand executors (candidate)

The five-minute issue poller remains the Publisher. Long W1/W2 model work is handled by on-demand Task Scheduler executors. This source candidate does not register or start host tasks.

## Execution phases

Each lane descriptor and `executor_runtime` explicitly carries the same `execution_phase`:

- `VM_ISOLATED` is the default. It requires a separate standard Windows SID from the Publisher, a password logon for network access, profile-contained writable workspace/state, and the existing role-separated ACL checks. Missing phase fields retain this strict behavior.
- `WIN11_TRANSITION` is the Human-authorized temporary Win11 phase. It requires the Publisher and Executor SID to be the same current user and emits `LogonType=InteractiveToken`. Registration does not ask for or copy another account's password, and it does not change the W1/W2 model-run flags. It requires the current user profile to be loaded, all configured paths to exist as physical paths without reparse points, exact task/action/working-directory readback, and no broad-principal write or parent-replacement rights. Identity-specific Publisher-versus-Executor ACL checks cannot provide separation when both roles share one SID and are therefore deferred to `VM_ISOLATED`.

The transition explicitly does not qualify VM isolation. `RunLevel=LeastPrivilege`, `IgnoreNew`, hidden task metadata, `ExecutionTimeLimit=PT0S`, no triggers, exact lane paths, attempt-pinned source bundles, and no automatic replay remain required in both phases. A phase mismatch between lane descriptor and runtime config fails closed.

## Registration source path

`register-opencode-executor.ps1 -Mode Audit` is read-only. `-Mode Register` refuses an existing task or missing pre-provisioned task folder and never starts the task. In `WIN11_TRANSITION`, it registers the XML principal using the current interactive token with no credential parameter. In `VM_ISOLATED`, it retains secure password registration for the separate standard account. Both paths read back the actual task identity SID, logon type, RunLevel, action, working directory, hidden setting, `IgnoreNew`, `PT0S`, and zero triggers. Ambiguous registration is left for OS readback and is never retried automatically.

The Codex continuation executor follows the same phase contract through `install-codex-executor.ps1`. Its transition runtime is under the current user's LocalAppData, uses the already-installed signed Codex CLI by absolute path and SHA-256, and does not copy the CLI bundle or accept a second-account password. It registers only an on-demand `Interactive`/Limited task, preserves the existing five-minute Publisher task, and leaves model execution and cost authorization disabled. Its phase-specific install record prevents an audit or uninstall operation from confusing a VM registration with a transition registration. This source path is not evidence that the Codex task is installed or that CLI/model/cost gates pass on the host.

Registration itself does not invoke a model or mutate model authorization settings. Actual model execution remains controlled by the accepted task, exact lane configuration, pinned model and no-cost eligibility checks. The source registration tests do not count as a real Task Scheduler registration or a live model call.

The registration script does not create accounts, install runtime files, grant ACLs, edit Publisher configuration, or alter the existing `PTYSD-Native-OpenCode` poller. A candidate phase descriptor must be installed and independently read back before any executor task can run.

## Attempt protocol

1. Publisher checks the exact Task Scheduler XML, current Publisher SID, phase-specific identity contract, and empty manifest slot.
2. Publisher writes one exclusive-create `<attempt_id>.pending.json`, posts and reads back the STARTED receipt, then calls `schtasks /Run` once.
3. Executor atomically renames that manifest to `.running.json`, checks request/source/spec hashes and its configured SID, runs only the pinned attempt workspace, streams stdout/stderr to local files, and writes one terminal result.
4. A later Publisher poll re-hashes both output files and combined evidence, reads the exact result, posts and reads back the terminal receipt, then removes only that attempt's manifest marker.
5. A failed or ambiguous `schtasks /Run`, leftover pending/running marker, missing result, result-write failure, or unconfirmed process-tree termination leaves the attempt unresolved and blocks another overlapping task. The Publisher does not post a misleading terminal receipt or remove the marker. Independent non-model work may continue. The attempt is never replayed automatically.

`FINISHED` remains an attempt lifecycle state. `OPENCODE_V2_EXIT_0_UNTRUSTED` is not semantic acceptance, a code change, a Commit, or a PR.

## Acceptance boundary

Source tests can validate phase-specific descriptors, XML, no-start registration logic, and synthetic manifest handling. They do not prove live Task Scheduler registration, profile/OAuth readiness, model entitlement, zero additional charge, a real model session, file changes, VM isolation, or Production deployment. Those require separate same-host readback and accepted-source deployment.
