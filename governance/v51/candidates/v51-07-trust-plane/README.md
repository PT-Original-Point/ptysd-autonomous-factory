# V51-07 privileged CI trust-plane closure candidate

This package is review-only data under `governance/v51/candidates`. None of the proposed workflow or verifier assets are active because they are not stored at active workflow/trust-root paths.

## Exact proposed assets

- `proposed-factory-bounded.yml` is derived from PR #322's r4-08 factory workflow candidate. Its bounded `workflow_dispatch` test job runs on GitHub-hosted `ubuntu-24.04`; the `pull_request_target` job checks out immutable trusted verifier source and executes only that verifier on the restricted runner. This candidate adds the exact `trusted` checkout root and immutable `github.workflow_sha` to the verifier invocation.
- `proposed-trusted-verifier.mjs` is derived from PR #322's candidate verifier. It denies the complete workflow and action namespaces, current control/checkpoint paths, project-directory records, and versioned current Mission/Policy files by default. A protected-path exception requires an exact base, direct parent, head, tree, path/status set, and every resulting blob OID to match an expected set read from the clean checkout at `github.workflow_sha`.
- `proposed-trusted-verifier-paths.test.mjs` is candidate-owned design regression input, not trusted acceptance evidence.

## Expected-set custody

The expected-set path is fixed in the proposed verifier as `governance/csg/trust-root/trusted-transition-expected-set.json`. The expected-set document is read only from the immutable trusted checkout whose HEAD equals `github.workflow_sha`; candidate files cannot supply or override it. It must pin the exact base ref/OID, one direct parent, resulting head/tree OIDs, exact changed path/status set, and blob OID for every addition or modification (a deletion carries no resulting blob). A missing file, unclean trusted checkout, wrong workflow SHA, unknown schema, extra field, or any identity mismatch fails closed.

The expected set must be installed by a separately reviewed trusted-root transition before the later exact activation transition. This avoids asking a transition to authenticate its own verifier or expected set. This candidate does not include that trusted expected-set file because its exact target head/tree and external promotion route are not established.

## Required additional active delta

The current `.github/workflows/v45-bounded-self-hosted.yml` runs event-ref repository scripts and tests on a self-hosted runner. It is not covered by the current active verifier's exact-name workflow deny-list. The eventual independently qualified transition must retire that workflow and replace the factory-bounded workflow and trusted verifier only after the expected set is independently pinned. This package does not contain a live deletion or modify an active file.

## Promotion prerequisites

The repository rulesets endpoint returned an empty list; main branch protection returned HTTP 403; runner-groups and v45 control-branch protection remain NOT ESTABLISHED. Obtain same-source authorized admin readback before any active trust-root transition. Also independently review the expected-set source, runner-group policy, and exact target transition before trusting any protected-path exception.

Local candidate-owned self-tests passed 11/11 with Node v24.19.0 on the updated verifier/test bytes; the manifest binds their SHA-256 values. These tests are regression evidence only, not independent acceptance.

This package is not trusted verifier qualification, semantic acceptance, a runner-group policy readback, canonical acceptance, or live qualification. A structural check on this PR can qualify only these candidate data files.
