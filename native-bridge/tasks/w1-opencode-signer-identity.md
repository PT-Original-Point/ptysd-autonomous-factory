# W1 task: verify the OpenCode executable's exact signer identity

## Objective

The Windows OpenCode V2 executable preflight currently accepts a valid Authenticode signature when the certificate Subject merely contains `Anomaly Innovations, Inc` anywhere. A valid certificate for an unrelated signer can contain those characters in another Subject field or as part of a longer name. That substring does not establish the intended publisher. Qualification must reject such a lookalike before running the executable, including its `--version` probe.

This is a new, independent, reversible source task under the existing V5.3-R4 Human goal. It is not a replay of any previous Worker attempt.

## Exact edit scope

- `native-bridge/opencode-v2.mjs`
- `tests/opencode-v2.test.mjs`

Change only what is needed to check the exact, structured signer identity and exercise it. Do not change model selection, version policy, provider authorization, task routing, cost rules, execution permissions, or any live runtime configuration.

## Requirements

1. Retain a valid Authenticode signature as a prerequisite. Parse or obtain the certificate's relevant signer identity from a structured certificate API; do not search arbitrary Subject text for a publisher substring. Reject missing, ambiguous, malformed, unrelated, and lookalike identities.
2. Preserve support for the actual official executable installed on this host. Its independently observed, valid-signature certificate has SimpleName `Anomaly Innovations, Inc https://anoma.ly/`; its Subject has the same CN and O. Treat this as current evidence, not proof that future certificates or arbitrary names are authorized. Avoid pinning a short-lived certificate thumbprint or silently accepting a broader name on rotation.
3. Keep the existing version and signature checks ahead of executing a discovered CLI. An invalid or unrecognized publisher must never trigger `--version`.
4. Add behavioral regression coverage for the real identity-check path: the observed official identity is accepted; a valid signature with the target text only in an unrelated field or embedded in a longer/misleading signer name is rejected; missing or malformed identity fails closed; and rejected candidates are not executed. Include escaped punctuation or comma handling where relevant. The tests must exercise the actual decision used by qualification, not just a separate string literal.
5. Preserve all existing qualification and signed-binary behavior outside this scoped identity check. Do not broaden trusted identities or weaken execution policy.

## Delivery

Edit only the two paths above in the attempt workspace. Preserve the exact session and tool evidence. Do not edit credentials, access other worktrees, change the host, commit, push, or publish a PR. Codex will independently review the diff, run tests, and handle source/CI acceptance. If the precise identity cannot be checked safely with the available tools, stop and report the blocker instead of making a permissive change.
