# Runtime limit audit

Updated 2026-10-28 against repository main `f1c9a84d4bd3e764f7b8a60c556c947673b313af`.

This inventory separates application caps from platform limits and security/data boundaries. It describes source behavior only; current Windows task registration, runtime hashes, provider readiness, and model execution must be read from a fresh Issue #407 observation. Historical R10 deployment findings are labeled below and are not current-state assertions.

| LIMIT_ID | Source / target | Actual reason | Class | Safe to remove now? | Replacement / test |
| --- | --- | --- | --- | --- | --- |
| MODEL_WALL_CLOCK_600S | Worker-to-executor model process | An application-imposed ten-minute deadline killed normal work | A | Already absent from current source | The executor does not impose a model wall-clock timer. Preserve explicit cancellation, process-tree termination evidence, and unresolved-attempt handling. |
| MODEL_OUTPUT_2MIB | Executor stdout + stderr | An application-imposed combined output ceiling killed normal work | A | Already absent from current source | Stream stdout/stderr to separate private evidence files, hash persisted bytes, and fail explicitly if evidence cannot be recorded. Regression coverage exercises output beyond the old ceiling. |
| AGENT_STEPS_8_12 | `opencode-v2.mjs` | An agent-step limit forced text-only output before work completed | A | Already absent from current source | Do not pass `steps`; keep exact task/model authorization, path allowlist, and tool permissions. |
| SCHEDULER_15M | `install.ps1` and `PTYSD-Native-OpenCode` | Bounds the five-minute dispatcher process | A | No | Keep the dispatcher bounded. Long model work runs in a separate Executor task with the `PT0S` contract, so the dispatcher's 15-minute limit does not cap that process. |
| GITHUB_COMMAND_TIMEOUT | `worker.mjs` `gh()` | Stops a broken GitHub/API call from occupying the dispatcher | B | No | Retain bounded network I/O and never replay after an ambiguous external effect. |
| OPENCODE_VERSION_PROBE_TIMEOUT | `opencode-v2.mjs` CLI qualification | Bounds a local metadata/version probe, not model inference | B | No | Retain the probe timeout and verify the exact executable/version/hash. |
| GITHUB_RATE_LIMIT / PROVIDER_LIMITS | GitHub and model providers | External service quotas and service-defined limits | B | No | Respect provider responses and expose precise failures; never switch to a paid model. |
| TASK_IDENTITY / MODEL_ALLOWLIST | `worker.mjs` task contract/config | Prevents unauthorized sender, host, model, and variant execution | C | No | Keep exact project/host/source/model/variant checks and the low-privilege task contract. |
| RECEIPT_NO_REPLAY | `worker.mjs` reconciliation | Prevents duplicate external work after an ambiguous STARTED effect | C | No | Keep local terminal readback and same-attempt receipt reconciliation. |
| GITHUB_CREDENTIAL_SEPARATION | Dispatcher vs. model worker | Publisher credentials must not be exposed to an untrusted model process | C | No | `WIN11_TRANSITION` explicitly permits the same user SID; `VM_ISOLATED` requires different SIDs. Same-SID execution does not establish credential isolation. Record the actual phase and identity from fresh OS readback; do not claim the VM-isolated boundary on a transition host. |
| DISPATCHER_EXECUTOR_LIFECYCLE | `worker.mjs` -> Task Scheduler -> `executor.mjs` | The five-minute dispatcher must not await long model work | C | Implemented in current source | Worker validates the exact Executor task, records one attempt, exclusive-creates its manifest, and triggers the task. Executor claims that manifest, runs the pinned job, and persists terminal evidence for a later poll to reconcile. Ambiguous start/result or unconfirmed process-tree termination stays unresolved and is never replayed. |
| JOB_SCHEMA / SOURCE_PIN / SPEC_HASH | `worker.mjs` | Rejects malformed, stale, changed, or untrusted tasks | D | No | Keep strict parsing and exact source/spec digest validation. |
| SPEC_SIZE_20K / COMMENT_LIMIT | `opencode-v2.mjs`, `worker.mjs` | Bounds untrusted job input and GitHub receipt parsing | D | No | Keep input validation; these are not model-runtime caps. |

## Current source acceptance boundary

Current source includes the Worker dispatcher-to-Executor handoff and the executor-side manifest claim, pinned-workspace validation, model invocation, and terminal-result readback. The dispatcher integration test verifies that model execution is not awaited in the poller; executor tests cover task-contract validation, manifest idempotency, identity mismatch, and terminal evidence semantics.

These source tests do not prove that a model ran, that a registered task is configured correctly, or that a delivery was accepted. Fresh Windows task/runtime evidence, provider/session evidence, and external-effect reconciliation remain separate Issue #407 facts. In particular, an enabled Executor task or scheduler result `0` is not proof of a model call or delivery. The Worker-level W2 model switch remains an independent authorization/configuration gate.

## Historical R10 baseline (not current state)

R10 isolated earlier `0x8007010B` / `0x00000001` startup failures to `CODEX_MSIX_APPDATA_ALIAS_PATH_MISMATCH`. A disposable task using the physical Documents path passed a PT15M baseline, a single-variable PT0S experiment, and a 967-second / 150-sample synthetic run with zero target windows. Disposable test tasks were removed. This established PT0S capability and the path root cause at that time.

The original R10 note that the installed Worker lacked an Executor descriptor and that no Executor task was registered predates the current source lifecycle. It must not be reused as a present-day W2 or factory-wide blocker. Read current registration, task identity/limits, runtime hashes, and W2 enablement from the latest native observation in Issue #407.
