# W1 schema-6 independent-lane regression

Add one focused regression test that makes the schema-4 and schema-6 execution boundary explicit. This source-only task is authorized by Human GOAL comment 6188322050 (body SHA-256 `2f1829da0e1f5105a384be03904b2289c57c05e8a44215c4824fb6b8631d8f7b`).

## Exact edit scope

Edit only `tests/codex-continuation.test.mjs`.

Do not change Worker or executor implementation, the Human GOAL, task schedules, model configuration, credentials, W2 artifacts, package scripts, or external systems.

## Required regression

- Use a synthetic current-GOAL body with the trusted R4 marker and no unique `Codex 下一動作` section. Assert the schema-4 scoped-action preflight remains blocked with `HUMAN_GOAL_SCOPED_ACTION_MISSING`.
- Create a valid historical schema-4 `codex_plan` fixture with its own scoped directive and an existing local attempt claim. Keep that claim intact; do not replay or release it.
- In the same selection input, create one independently authorized schema-6 `opencode_edit` W1 fixture bound to an exact candidate PR/head, task-spec digest, allowed edit path, model/variant, and current Human GOAL comment ID/body digest.
- Call the existing selector with the historical Codex claim present. Assert the Codex request remains unresolved while the exact W1 request is selected. Verify the Codex claim bytes are unchanged and no W1 claim is created.
- Keep all state under a temporary test directory and remove it in a `finally` block. The test must not access GitHub, invoke a model, or touch Windows state.

## Verification

Run `node --test tests/codex-continuation.test.mjs` and `git diff --check`. Report exact results and changed paths. A passing test proves only source behavior; it does not prove a live model session or delivery acceptance.
