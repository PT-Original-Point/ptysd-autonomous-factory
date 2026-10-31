# W1 Task: expose the native L0 poll disposition in existing operator evidence

Project ID: CHATGPT_GLOBAL_SKILL_GOVERNANCE
Repository: PT-Original-Point/ptysd-autonomous-factory
Human authorization: Issue #310 comment 6188322050
Base main observed before dispatch: 2b0d0ebf1b67b0f0081c57e1b9a1a9f1a0709f62

## Verified gap

The existing Issue #407 observation reports the native scheduler state and current/latest task, but it does not say whether the current Worker poll found no dispatchable work, waited on an eligibility gate, or selected a job before dispatch. The existing ten-cycle zero-call unit test uses mocked adapters; it is not natural Windows polling evidence. Add this fact to the same existing observation and panel so later natural cycles can be read without creating another service, API, database, or receipt stream.

## Required implementation

1. Add one additive field named poll_disposition under the existing native_worker object in the existing Issue #407 observation.
2. Use only these values:
   - NO_READY_JOB_NO_MODEL_DISPATCH: selection returned no job and there is no eligibility or Human-gate wait reason. This means the Worker did not launch a model executor during this poll.
   - WAITING_GATE_NO_MODEL_DISPATCH: selection returned no job because a preflight, eligibility, or existing Human gate remains. This means the Worker did not launch a model executor during this poll.
   - READY_JOB_SELECTED_NOT_DISPATCHED: a job was selected before the observation was published. This must not claim STARTED, a model call, a Session, or acceptance.
   - UNKNOWN: the poll decision cannot be derived safely.
3. Derive the value from the existing selection/preflight result before publishing the existing observation. Do not publish a second observation or additional receipt for the same poll.
4. Keep native_worker.state, current_task, latest_task, W1/W2 task_acceptance, external_effects, model eligibility, Session, source acceptance, CI, and PR fields semantically unchanged. In particular, do not convert UNKNOWN into PASS.
5. Extend the existing observation parser. Historical observations without poll_disposition remain valid; if the field is present but has any other type/value, parsing must fail closed.
6. Show poll_disposition in the existing operator panel as a separate native L0 decision. Older observations without the field display UNKNOWN. Do not label it as Worker acceptance or actual model activity.
7. Add tests for the no-ready/no-model branch, waiting-gate/no-model branch, selected-job-before-dispatch semantics, malformed enum rejection, historical observation compatibility, and panel rendering. Preserve and run the existing zero-call tick regression.

## Exact Worker edit scope

- native-bridge/worker.mjs
- native-bridge/operator-observation.mjs
- operator-panel/index.html
- tests/native-bridge.test.mjs
- tests/operator-observation.test.mjs
- tests/operator-panel-api.test.mjs

## Boundaries

- Do not change Worker or Executor enable flags, model/provider configuration, credentials, Task Scheduler definitions, account identity, OAuth/MFA, billing, Production, or the W2 lane.
- Do not create a new service, API, database, schedule, receipt type, or model-call counter that claims provider activity.
- Do not change or close unrelated open PRs. Return only the scoped diff and test evidence; Codex will independently inspect it and handle the existing publisher/CI flow.
- Preserve exact request/attempt/source identity and all existing UNKNOWN semantics.

## Completion evidence

A valid result has a real OpenCode V2 session/tool activity, a nonzero scoped diff limited to the six paths above, relevant tests, a result PR on an exact HEAD, trusted exact-head CI, and separate Codex source acceptance. A local test or model response alone is not completion.
