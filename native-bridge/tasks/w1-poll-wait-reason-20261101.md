# W1 Task: expose a safe native L0 wait reason in existing operator evidence

Project ID: CHATGPT_GLOBAL_SKILL_GOVERNANCE
Repository: PT-Original-Point/ptysd-autonomous-factory
Human authorization: Issue #310 comment 6188322050
Observed base main before dispatch: 7483120e256428b235ed074cbff4c18372699c49

## Verified gap

The merged L0 poll disposition distinguishes a waiting gate from an empty queue, but the canonical Issue #407 observation and panel do not show which safe, machine-readable gate code caused the wait. The native publisher already has the current poll's eligibility and preflight reason codes in memory. This leaves operators unable to distinguish a model-eligibility wait from a source/task preflight wait without reading private local logs. PR #556 is an independent W4 read-only draft and is not a prerequisite; do not implement W4 or change its state.

## Required implementation

1. Add an additive `poll_wait_code` field to the existing `native_worker` observation, derived from the same poll inputs used for `poll_disposition`. Preserve the existing disposition semantics and publish within the existing single Issue #407 observation.
2. For `WAITING_GATE_NO_MODEL_DISPATCH`, emit the specific safe internal code that explains the selected wait reason when it can be proven. Use a finite exact allowlist/mapping shared by the producer and parser. Do not accept prefix-only arbitrary values, raw error/provider messages, request text, file paths, environment values, or credentials. An absent, unsupported, conflicting, or unsafe reason must become `UNKNOWN`; non-waiting dispositions must use `NOT_APPLICABLE`.
3. Extend the observation parser and panel using the same exact enum. Historical observations without `poll_wait_code` remain valid and display `UNKNOWN` when the disposition is waiting, otherwise `NOT_APPLICABLE`. A present invalid value fails closed.
4. Render the code as a separate native L0 diagnostic in the existing dashboard. It must not imply task acceptance, model invocation, Worker success, delivery, or a Human decision.
5. Keep Worker status, task identity, model/session, diff, source acceptance, CI, external effects, and next-owner semantics unchanged. Keep all historical W1/W2 task_acceptance and external_effects values UNKNOWN.
6. Add focused tests for each supported reason source, deterministic precedence when more than one reason exists, unsupported/sensitive/path-like input mapping to UNKNOWN, malformed field rejection, historical compatibility, and panel rendering. Existing poll-disposition and zero-call tests must continue to pass.

## Exact edit scope

- native-bridge/worker.mjs
- native-bridge/operator-observation.mjs
- operator-panel/index.html
- tests/native-bridge.test.mjs
- tests/operator-observation.test.mjs
- tests/operator-panel-api.test.mjs

## Boundaries

- Do not change Task Scheduler, Worker/Executor flags, model/provider settings, credentials, account identity, OAuth/MFA, fees, Production, W2 routing, or any other service/control layer.
- Do not alter or close PR #556. Its W4 scope is not a Gate for this task.
- Do not replay a prior request or edit another task's worktree. Preserve any unknown effects and publish only the task's exact scoped result through the existing Worker/Publisher path.
- If this reason cannot be derived safely, report UNKNOWN rather than guessing.

## Completion evidence

A valid result needs a new native W1 request and attempt, real OpenCode V2 Session/tool activity, nonzero diff limited to the six paths, focused tests, result PR, trusted checks on the exact result HEAD, and independent Codex source acceptance.