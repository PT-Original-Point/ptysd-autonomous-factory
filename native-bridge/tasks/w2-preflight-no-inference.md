# W2 fail-closed Antigravity preflight evidence

## Purpose

Harden the existing Antigravity schema-6 no-inference preflight so the Worker can proceed only when the same readback explicitly proves the pinned Gemini 3.8 Flash High model is cataloged and the preflight itself performed no inference and collected no credential values. Keep live metadata evidence separate from durable entitlement and cost attestation.

## Exact scope

Only edit `native-bridge/v2-readiness.mjs` and `tests/v2-readiness.test.mjs`. Do not change the Worker, executor, configuration, model flags, durable attestation, CLI settings, permissions, scheduler, GitHub credentials, or any runtime service.

## Required behavior

1. `antigravityV2ReadinessExecutionFailure()` returns `ANTIGRAVITY_CLI_NOT_QUALIFIED` when `model_catalog` is absent, malformed, not `PINNED_MODEL_CATALOGED_NOT_ENTITLEMENT`, or does not have `pinned_model_cataloged: true`.
2. It returns the same safe refusal when `inference_executed` is not exactly `false` or `credential_values_collected` is not exactly `false`.
3. A complete positive no-inference readback still passes the preflight while preserving the existing project, signature, authentication, tool-policy, aggregate-quota, and no-G1 checks.
4. Do not infer per-model quota, subscription entitlement, or cost from the catalog or aggregate `/usage` result. `entitlement` and `cost` remain `UNKNOWN` in this metadata helper; the Worker continues to check the existing durable attestation separately.
5. Return only existing safe reason codes. Do not expose raw CLI output, credentials, command arguments, account identifiers, or provider errors.

## Verification

Add positive and negative unit coverage for missing, malformed, mismatched, and false no-inference/catalog fields. Codex will run the focused test suite after recovering the patch. The model session must not run shell commands, tests, network requests, or other non-file tools; make only the scoped file edits and leave verification to Codex.
