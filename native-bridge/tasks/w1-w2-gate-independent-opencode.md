# W1 regression: a disabled W2 lane must not starve OpenCode work

PROJECT_ID: CHATGPT_GLOBAL_SKILL_GOVERNANCE
HOST: DESKTOP-1B6PD2P
TASK_KIND: opencode_edit
MODEL: opencode/deepseek-v4.1-flash-free

## Objective

Prove that the native Worker continues to an independently eligible schema-6 W1 `opencode_edit` when an earlier schema-6 W2 `antigravity_edit` request is still queued but the global W2 model-run switch is false. Existing coverage demonstrates that a W2 wait does not starve a generic ping; it does not exercise the independent W1 model-executor route.

Add a focused regression test using the existing native Worker fixtures. Present a valid, Human-GOAL-bound W2 request before a valid W1 OpenCode request, with W2 disabled and W1 eligible. Assert that the same Worker tick leaves W2 unclaimed and without a STARTED receipt, makes no Antigravity readiness/model call, and dispatches the W1 request exactly once through the OpenCode Executor using its pinned source and scope. Preserve W2 as eligible for later reevaluation; do not synthesize model execution or a W2 completion.

If the regression test demonstrates that the current Worker returns or stops at the W2 gate instead of reaching W1, add the smallest code fix in `native-bridge/worker.mjs` while retaining the W2 gate. If current code already continues correctly, add only the missing regression test; do not restructure selection or add another controller.

## Scope

Only edit:
- `native-bridge/worker.mjs` (only if the negative regression exposes a real failure)
- `tests/native-bridge.test.mjs`

Use unique W1 and W2 request IDs and the exact current Human GOAL fixture. Keep source PR/head, GOAL identity, executor identity, model allowlist, scope, lease, and receipt checks intact. No live provider invocation belongs in the synthetic test.

## Exclusions

Do not change W2 enablement, model/provider choice, cost or auth policy, Task Scheduler, runtime deployment, Human GOAL, credentials, external identity, or unrelated paths. Do not replay any historical task or effect.

## Verification

Run `node --test tests/native-bridge.test.mjs` and `git diff --check`. Report the focused test result, exact changed files, diff SHA-256, and whether the regression reproduced before any code fix. Keep external effects `UNKNOWN` unless independently proven.
