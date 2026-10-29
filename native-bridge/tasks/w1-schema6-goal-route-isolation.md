# W1 schema-6 Human GOAL route-isolation regression

PROJECT_ID: CHATGPT_GLOBAL_SKILL_GOVERNANCE
HOST: DESKTOP-1B6PD2P
TASK_KIND: opencode_edit
MODEL: opencode/deepseek-v4.1-flash-free

## Objective

Add one explicit regression test proving that the schema-4 `codex_plan` requirement for a unique **Codex 下一動作** section does not gate a trusted schema-6 W1 `opencode_edit` task. Keep the schema-4 guard intact.

## Scope

Only edit `tests/native-bridge.test.mjs`.

Use the existing Human GOAL fixture, whose body has no scoped Codex action section. The test must demonstrate both:
- `codexScopedActionStatus` still rejects that body with `HUMAN_GOAL_SCOPED_ACTION_MISSING` for the schema-4-only path.
- A schema-6 `opencode_edit` job remains eligible through the exact trusted GOAL and same-repository, open PR-head pinning path.

Do not change Worker, Goal, authorization, model selection, provider settings, task scheduling, or any runtime file. If the observed implementation contradicts the invariant, return the failing negative test evidence without expanding the file scope.

## Verification

Run the focused native bridge test file and `git diff --check`. Report the exact test command, result, changed path, diff hash, and any tool or process evidence. Keep external effects `UNKNOWN` unless independently proven.