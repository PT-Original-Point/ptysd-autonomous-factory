# W2 Antigravity quota snapshot parser canary

## Purpose

Implement a small pure JavaScript parser for saved, machine-readable JSON fixtures shaped like the read-only outputs of the official Antigravity CLI commands agy -p "/usage" --output-format json and agy -p "/credits" --output-format json. The parser and its tests must not invoke those commands or query an account. The schema-6 job itself authorizes exactly one Antigravity model session, using the model and variant bound in that job, to perform this source edit; this is not permission for the task code to call a model or provider API.

## Exact write scope

Only these repository-relative paths may change:

- native-bridge/antigravity-quota.mjs
- tests/antigravity-quota.test.mjs
- package.json

Do not edit this task specification or any other path.

## Required behavior

1. Export a pure function named parseAntigravityQuotaSnapshot(usageEnvelope, creditsEnvelope).
2. Accept the successful JSON envelope shape returned by the two read-only CLI slash commands. Relevant usage data is under usageEnvelope.command.data.groups; the Gemini group is named Gemini Models and contains buckets gemini-weekly and gemini-5h, each with remaining_fraction and reset_time. Relevant credit data is creditsEnvelope.command.data.remaining_credits.
3. Return a new minimal object containing schema version 1, the two Gemini remaining fractions and normalized UTC reset timestamps, and g1_credits_remaining. Do not copy or return conversation_id, response, token usage, account identity, unknown groups, or arbitrary provider fields.
4. Reject non-success envelopes, missing or duplicate required buckets, non-finite or out-of-range fractions, invalid timestamps, and negative or non-safe-integer credit values. Use stable short error codes; never include raw input or credential-bearing values in errors.
5. Add focused positive and negative tests, including extra unrelated groups/fields and proof that the returned object contains only the documented normalized fields.
6. Append the new test file to the existing npm test script without removing or weakening any existing test entries.

## Execution limits

- The single Antigravity model session explicitly authorized by the schema-6 job is the only permitted inference. Do not invoke nested or additional models, provider APIs, shell commands, browsers, MCP tools, or task-generated subprocesses. The native executor's launch of that one authorized Antigravity session is expected.
- Do not read credentials or modify Antigravity settings.
- Do not change worker.mjs, v2-readiness.mjs, Task Scheduler, or the deployed Worker configuration.
- No task-side network access other than the provider connection required for the one authorized model session. No automatic retries.

## Completion report expected from the executor

List the exact changed paths and summarize implementation. Do not claim tests passed, a commit was made, a PR was updated, or a task was accepted; Codex performs those checks after recovering the diff.