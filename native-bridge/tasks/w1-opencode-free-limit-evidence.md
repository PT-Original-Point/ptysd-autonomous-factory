# W1: Classify OpenCode Free Usage Errors in Captured JSONL

## Authorized scope

Implement one bounded, pre-Production W1 source change under Human GOAL #310 comment 6188322050. The exact model, variant, source PR SHA, and editable files are pinned in the schema-6 job. This task changes only the OpenCode V2 JSONL evidence parser and its focused tests.

## Evidence and defect

On current main, native-bridge/opencode-v2.mjs recognizes an abuse phrase in event.error.message and a direct event.error.type of FreeTierError. The existing test uses that simplified shape.

OpenCode issue anomalyco/opencode#52907 includes a captured CLI JSON event whose outer error is provider.auth with status 403 and whose response.body is a JSON string containing FreeTierError. OpenCode issues #59387 and #59502 report free-usage 429 / FreeUsageLimitError failures; these are user reports about the hosted service, not proof of its quota formula or root cause. The current parser can therefore retain only the generic provider-error reason for common wrapped errors.

## Required change

1. Add bounded, defensive decoding of structured error fields and a JSON response.body when it is a string. Do not throw on malformed or oversized nested bodies.
2. Preserve the existing abuse-block classification and its precedence.
3. Emit stable allowlisted reasons for a structured FreeUsageLimitError or provider.free-limit as OPEN_CODE_FREE_USAGE_LIMIT_REACHED, and for a direct or nested FreeTierError as OPEN_CODE_FREE_TIER_REJECTED. Keep unrelated provider errors on the generic reason path; do not classify every HTTP 429 as exhausted free quota.
4. Store no provider message, raw body, response headers, account identifiers, request identifiers from the provider, or secret-bearing data in returned evidence.
5. Preserve existing session, model-activity, usage, tool, and invocation uncertainty semantics. A provider error alone must not be used to claim that inference did or did not start.
6. Do not retry the provider request, query quota, make network calls, change provider/model allowlists, or alter Worker configuration, scheduler state, CLI version, credentials, or runtime installation.

## Exact edit scope

- native-bridge/opencode-v2.mjs
- tests/opencode-v2.test.mjs

Do not edit this task specification.

## Required focused regression coverage

- The provider.auth / status 403 / JSON response.body wrapper from issue #52907 produces the sanitized FreeTierError reason.
- A representative structured 429 provider.free-limit / nested FreeUsageLimitError event produces OPEN_CODE_FREE_USAGE_LIMIT_REACHED.
- A generic unrelated 429 remains generic.
- Sensitive strings placed in messages and nested bodies do not appear in serialized evidence.
- In all rejection cases, preserve model_invoked as null unless independent usage or model-output events establish otherwise.
- Existing abuse-block and direct FreeTierError cases continue to pass.

Run node --test tests/opencode-v2.test.mjs. Report the model session, exact changed files, diff, and test result. A blocked quota attempt is terminal for that attempt and must not be replayed.