# W2 R7 trusted direct-parent candidate regression

## Goal
Add a focused regression test for the current trusted verifier rule that an accepted candidate commit must be the single direct child of the exact `main` base SHA. This supports the source review and merge checks used for the W2 delivery.

## Exact writable scope
Only edit `tests/csg/csg-trusted-pr-verifier-cli.test.mjs`. Do not edit the trusted verifier implementation, package scripts, workflows, Worker files, operator panel, runtime configuration, or any other path.

## Required test
Replace the clearly marked placeholder with a deterministic `node:test` regression that imports the existing exported `verifyDirectParent` function from `governance/csg/trust-root/csg-trusted-pr-verifier.mjs` and uses a temporary local Git repository.

- Create a base commit, then one commit whose sole parent is exactly the base SHA and whose changed path is allowed for `main`; assert `verifyDirectParent` accepts it and returns the exact base/head SHAs and changed path count.
- Create a second candidate with two commits after that same base; assert it fails with `DIRECT_PARENT_MISMATCH`.
- Keep the fixture Windows-compatible, use child-process argument arrays without a shell, and remove only the temporary directory created by the test in a `finally` block.
- Do not use GitHub, credentials, network, Antigravity, model calls, Task Scheduler, or production state.

The task changes test coverage only. Do not weaken or modify the trusted verifier. A passing test is regression coverage, not source acceptance of any PR.
