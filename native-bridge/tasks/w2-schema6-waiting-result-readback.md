# W2 schema-6 WAITING result readback regression

## Purpose

Add a focused synthetic regression for preserving and validating a schema-6 `antigravity_edit` WAITING receipt during executor result readback. The test must exercise the existing Windows executor contract without invoking Antigravity, a model, or any provider.

## Exact edit scope

Edit only:

- `tests/executor-terminal-readback.test.mjs`
- `native-bridge/tasks/w2-schema6-waiting-result-readback.md` (this specification)

Do not modify executor or Worker implementation, live configuration, credentials, runtime files, Task Scheduler, GitHub, or any provider state.

## Required test behavior

1. Construct a synthetic schema-6 `antigravity_edit` manifest with a pinned request ID, attempt ID, source SHA, Gemini model and variant, source PR, GOAL comment ID and body digest, and nonempty `edit_paths`.
2. Set only the fixture's existing W2 model-run flag to false so the executor produces its recoverable WAITING result before calling the injected execution callback. Do not create a source bundle or call a CLI.
3. Inject a readback-only tamper to a persisted receipt identity field. Require the fixed `EXECUTOR_WAITING_RESULT_IDENTITY_MISMATCH` refusal, zero execution-callback calls, and byte-for-byte preservation of the original result file.
4. Read the retained result and verify request and attempt identity, `kind=antigravity_edit`, source SHA, model and variant, source PR, GOAL comment and digest, the SHA-256 digest of the serialized `edit_paths`, `state=WAITING`, the exact disabled-lane outcome and exit code, empty evidence hash/bytes, `eligibility_state=WAITING`, and `model_invoked=false`.
5. Verify `task_acceptance=UNKNOWN` and `external_effects=UNKNOWN`; do not promote a WAITING receipt to acceptance or infer that effects occurred.
6. Keep the test Windows-only, matching `executePendingManifest()`'s existing platform contract. No test may launch Antigravity or make a network/provider call.

## Verification

Run the focused test by its exact name:

```powershell
node --test --test-name-pattern="executor preserves schema-6 Antigravity WAITING identity and rejects tampered readback without changing result bytes" tests/executor-terminal-readback.test.mjs
```

Then run `git diff --check`. Report any Windows-only skip explicitly; a skip is not a pass.
