# R3-16 isolated CI and ProviderGuard candidate

Classification: `LOCAL_NONCANONICAL_PREPRODUCTION_CANDIDATE`.

This candidate adds a pure, read-only evidence evaluator. It contains no provider client, credentials, network calls, publisher, Host dispatch, canonical ref update, or Production path. Its synthetic fixtures exercise protocol decisions only.

The candidate binds one integration tree to an exact direct-parent commit, one exact required-check identity and run, the exact branch-protection profile digest, target repository/resource/ref, a single-sender fence, one idempotent attempt, and exact pre/post target readbacks. Acknowledgement loss never enables retry. An unchanged or conflicting target after acknowledgement loss stays unresolved.

`evaluateProviderGuardEvidence` only validates bytes supplied by its caller. It does not authenticate provider responses, prove that readbacks came from GitHub, prove that a fence is exclusive, or establish that a workflow is protected. Its result always reports `dispatch_allowed=false`, `retry_allowed=false`, and `canonical_acceptance=false`. The fixture identities are synthetic and are not current check, branch-protection, or provider readbacks.

## Trusted isolated-CI recipe requirements

Any later isolated verifier must come from an independently protected source and pin its own source, recipe, and expected set outside candidate control. It must use an ephemeral credential-free runner with read-only repository access, check out the exact candidate head by immutable SHA, verify the exact direct parent and integration tree, and bind the completed run ID/attempt, workflow digest, job identity, base/head SHA, and conclusion to that exact head. Candidate-owned workflow or tests are data under review and cannot define their own trusted check or acceptance threshold.

No provider publication is attempted here. A future authorized publication would separately require same-source prestate and poststate provider readbacks, the exact protected check identity, a current single-sender fence, and same-key reconciliation after acknowledgement loss. The present task has no authenticated provider readback route, so those live gates remain open.

## Local verification

Run `node --test tools/csg/cell-kernel/tests/provider-guard-candidate.test.mjs` from the repository root. This local candidate suite is not the official R3 reference suite and cannot qualify a protected check or canonical transition.
