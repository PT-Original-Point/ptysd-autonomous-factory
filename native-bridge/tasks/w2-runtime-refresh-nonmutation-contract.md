# W2: Protect Runtime Refresh from Changing Lane Authorization

## Authority and objective

This is one bounded, reversible, pre-Production W2 schema-6 coding task under Human GOAL #310 comment 6188322050 and the current bounded W2 authorization. Add a focused regression test for the existing native runtime refresh path. Refresh may replace only the pinned Worker runtime modules; it must preserve the W1/W2/Codex model gates, the scheduled task definition, and W2 claims and receipts, and it must never launch a model.

This is test-only coverage for an observed operational boundary. Do not change the installer, Worker, Executor, runtime configuration, model selection, task schedule, credentials, claims, receipts, or any existing attempt.

## Exact edit scope

- `tests/native-worker-opencode-cli-audit.test.mjs`

Do not edit any other file. Do not rewrite or remove existing tests. The task spec is not an additional model edit path.

## Required implementation

Add one focused Node test that reads the current `native-bridge/install.ps1` and binds assertions to the actual `RefreshRuntimeModules` mode and `Invoke-WorkerRuntimeRefresh` implementation. It must verify that:

1. The refresh mode delegates to `Invoke-WorkerRuntimeRefresh` and returns without falling through to `Install` or `RunOnce`.
2. Runtime replacement is limited to the pinned runtime module list; the refresh implementation does not publish `config.json`, change model-execution flags, register or unregister a task, or write/delete W2 manifests, claims, results, or receipts.
3. The implementation reads and verifies the pre-refresh config hash and Task Scheduler definition, and checks their unchanged state on success or during rollback.
4. Both the no-diff and successful refresh paths explicitly report that model execution was not invoked and W2 claims/receipts are unchanged. Do not treat those strings alone as proof; bind them to the exact refresh function and its guarded readback path.

Keep the assertions focused on the runtime refresh contract, not unrelated installer modes. The test must pass on the current source. If the assertions reveal an implementation defect, stop within this test-only scope and report the exact failing invariant; do not widen the model edit paths.

## Verification

The commands below are for Codex/controller verification after it reviews the candidate diff. The W2 Antigravity session is file-edit-only: do not run or attempt tests, builds, shell commands, or other commands, even when a task spec lists verification commands. Codex owns verification and must report the actual results separately.

Codex performs these checks after the candidate diff is returned:

```text
node --test tests/native-worker-opencode-cli-audit.test.mjs
 git diff --check
```

Report the exact changed path and diff hash/bytes, test totals, result PR/head, and exact-head trusted CI. The model attempt must retain its native `FINISHED_NOT_ACCEPTANCE`/UNKNOWN semantics until Codex independently reviews and accepts the exact diff.
