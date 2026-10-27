# W2 R7: Preserve Antigravity file-target multiplicity

## Objective

Correct `file_change_target_evidence` so `target_count` and its root-category counts represent file targets, not distinct root categories per tool step. The current summary undercounts a tool call that names multiple files in the same root.

## Exact edit scope

- `native-bridge/v2-readiness.mjs`
- `tests/v2-readiness.test.mjs`

Do not edit other paths. The historical W2 quota-canary files and `package.json` are outside this task.

## Required behavior

- Count each distinct recognized file target once per tool step, including array-valued target parameters and multiple recognized target keys.
- Deduplicate targets by normalized file-path identity within that step; root category alone is not a target identity. Preserve distinct target identities across repeated updates to the same step, then count each identity exactly once in its final root category.
- Do not double-count the same target when an `ACTIVE` event is followed by a `DONE` event for that step.
- Count target occurrences in the candidate, registered, outside-or-unknown, and relative-or-unknown root categories; `target_count` must equal the sum of those category counts.
- Keep mixed-root classification fail-closed. A write to any non-candidate root must remain distinguishable from a candidate-only write.
- Do not return or persist raw file paths, file contents, prompts, or tool payloads in evidence.
- Preserve existing behavior for single-target tools, missing targets, and receipt-compatible evidence shapes.

## Acceptance

Add focused tests for multiple same-root targets, mixed-root targets, and repeated `ACTIVE`/`DONE` updates. The tests must assert correct counts and status while confirming returned evidence contains no target paths. Keep the change limited to the exact edit scope above.

This is a pre-production source change. Do not run shell commands, use network/browser/MCP tools, access credentials, alter Windows state, post GitHub comments, create commits, or open a pull request from the model session. The Codex controller owns verification and any later source publication.
