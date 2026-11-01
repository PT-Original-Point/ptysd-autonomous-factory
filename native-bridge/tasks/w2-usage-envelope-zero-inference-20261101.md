# W2 task: prove Antigravity /usage is zero-inference

## Purpose

Close a concrete fail-open gap in the existing Antigravity readiness probe. At `9b2108e224cae7ecaf541fa4a7559f1ff67a5d5a`, `runAntigravityV2Readiness()` initializes `inference_executed: false`, while `summarizeAntigravityUsage()` extracts quota data without validating the CLI JSON wrapper's turn and token-usage fields. The current positive fixture also omits those wrapper fields. A quota-shaped response therefore does not itself prove that the preflight used zero inference.

## Exact edit scope

Only edit:

- `native-bridge/v2-readiness.mjs`
- `tests/v2-readiness.test.mjs`

Do not change Worker or Executor dispatch logic, task selection, scheduler, runtime deployment, model flags, model allowlist, durable attestation, CLI settings, account/authentication, permissions, credentials, project binding, GitHub publisher, or any other path.

## Required behavior

1. Accept a positive no-inference usage read only when the structured CLI response proves all of the following: outer `status === "SUCCESS"`; `command.name === "usage"`; `num_turns === 0`; and every required usage counter is present as a finite number equal to zero: `input_tokens`, `output_tokens`, `thinking_tokens`, `cache_read_tokens`, and `total_tokens`.
2. A positive turn count or any nonzero counter must never be reported as zero-inference. Missing, malformed, non-finite, negative, inconsistent, wrong-command, or failed-status evidence must fail closed. Do not establish authenticated quota readiness from such an envelope. Preserve safe existing refusal semantics; do not leak raw CLI output or account/credential fields.
3. Set `inference_executed` to `false` only after the complete zero-inference envelope has been validated. Represent positive activity as true and insufficient evidence as unknown/fail-closed so the existing readiness gate cannot pass.
4. Parse Gemini aggregate quota only from a validated successful `usage` command response. Preserve the separation between aggregate quota/auth metadata and per-model entitlement or cost; model entitlement and cost remain unknown in this helper.
5. Keep the existing CLI invocation and project-scoped workspace checks unchanged. The implementation must not call a model or add a network/authentication operation.

## Tests

Add positive coverage using the complete zero-turn, all-zero-counter envelope. Add negative cases for each missing counter; nonzero input/output/thinking/cache/total usage; positive turns; wrong command; failed outer status; malformed types; and quota-shaped payloads with invalid inference metadata. Assert the readiness execution gate refuses every invalid/unknown case and that no account or credential values escape into the result.

## W2 session restrictions

Use the existing Antigravity CLI Worker session only; do not open or use a GUI. This is a file-edit-only task: do not run shell commands, tests, builds, or other non-file tools. Codex will run the focused tests and `git diff --check` after receiving and reviewing the captured diff. Do not request broader permissions.

## Delivery evidence

Return only the scoped file changes. Worker task acceptance and external effects retain their native receipt semantics and remain unknown until separately verified. Codex will record the exact diff, test results, result PR/head, trusted exact-head CI, and independent source acceptance.
