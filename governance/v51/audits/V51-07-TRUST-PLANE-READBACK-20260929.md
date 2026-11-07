# V51-07 privileged CI trust-plane audit

**Classification:** noncanonical audit and closure candidate; no active workflow or trust-root file was changed.

**Exact baseline:** `main` `1dcec5ea8124e4d1b69b53652c657df8b65eb3ef`, tree `b12e07578ea83ee1d69799345ca5cdefbaae6a1a`. Project Directory, control, and accepted-source refs were fresh-read and are recorded in the JSON evidence beside this document.

## Findings

1. The active [factory-bounded workflow](https://github.com/PT-Original-Point/ptysd-vnext42-governance-sandbox/blob/1dcec5ea8124e4d1b69b53652c657df8b65eb3ef/.github/workflows/factory-bounded.yml) dispatches `bounded-driver-acceptance` on the privileged `PTYSD-V46-CONTROL-TRUSTED` runner. Its `control_sha` input is checked out and candidate tests are run from that checkout.
2. The active [v45 bounded self-hosted workflow](https://github.com/PT-Original-Point/ptysd-vnext42-governance-sandbox/blob/1dcec5ea8124e4d1b69b53652c657df8b65eb3ef/.github/workflows/v45-bounded-self-hosted.yml) runs on a self-hosted runner, checks out the event ref, then executes repository scripts and tests. The workflow has no immutable protected-ref guard.
3. The active [trusted verifier](https://github.com/PT-Original-Point/ptysd-vnext42-governance-sandbox/blob/1dcec5ea8124e4d1b69b53652c657df8b65eb3ef/governance/csg/trust-root/csg-trusted-pr-verifier.mjs) denies two named workflow files and trust-root/template paths, but not the full `.github/workflows/**` namespace. It does not deny the v45 workflow above or arbitrary new workflow paths.
4. PR #322 contains useful proposed trust assets under `governance/v50/trust-root-candidates/r4-08`, but that path is inert. Its exact-head `csg-trusted-verifier` result is FAIL. The candidate `factory-bounded.yml` moves candidate tests to GitHub-hosted `ubuntu-24.04` and leaves the immutable verifier job on the trusted runner, but does not close the active `v45-bounded-self-hosted.yml` path.
5. PR #327's `csg-trusted-verifier` PASS is bound to mirror head `8021cd29e26082ec4125a6ad0123cd5e15d20a7e` and qualifies three Factory MCP source blobs only. It does not qualify PR #322's workflow/trust-root candidate or establish live trust-plane acceptance.

## Required repair candidate

- Move all ordinary candidate functional tests to GitHub-hosted unprivileged runners.
- Ensure the privileged runner executes only verifier code checked out from an immutable trusted ref. Candidate bytes may be checked out as data, without credentials, but must not be executed.
- Default-deny the whole `.github/workflows/` namespace in the immutable verifier; allow only individually qualified exact workflow blob identities through a separate trusted-root procedure.
- Retire `.github/workflows/v45-bounded-self-hosted.yml` or redesign it so a candidate-selected ref cannot supply executable workflow or test code to the privileged runner.
- Provider readback: the repository rulesets endpoint returned an empty list; the main branch protection endpoint returned HTTP 403 (Resource not accessible by integration); the connector rejected the runner-groups endpoint; local `gh` is absent. The `v45/factory-control` protection query was rejected before a GitHub response. Thus runner-group allowlisting and branch-protection details remain **NOT ESTABLISHED**; an empty ruleset list does not prove branch protection.
- Obtain an authorized provider-admin readback of runner-group workflow restrictions and branch protections before V51-07 promotion.
- Bind protected qualification to the exact candidate head and complete path/blob set. Do not transfer a mirror result to a different head.

## Acceptance boundary

This audit confirms defects in the active source. It is not a repair, protected trust-root qualification, provider-admin readback, live runner test, or canonical acceptance. No active files, canonical refs, Host services, or runners were modified.