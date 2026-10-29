# W2 schema-6 one-shot Executor restart recovery regression

## Purpose

Add one focused regression for a W2 `antigravity_edit` attempt after the existing Windows Executor task is relaunched. The test must prove that a completed one-shot W2 attempt is not executed again after a restart, while its request/attempt lineage and unaccepted/unknown fields remain intact.

## Allowed change

Normal edit scope is exactly `tests/executor.test.mjs`. Do not change runtime configuration, Task Scheduler, credentials, CLI settings, or services. If the focused negative case demonstrates a concrete Executor defect, stop and report the failing assertion instead of expanding scope; the Human has authorized this test-only task.

## Test requirements

Use the existing fixture, manifest, candidate source bundle, and receipt helpers. Make the regression Windows-only in the same way as the adjacent `executePendingManifest` tests; the test must never launch Antigravity or invoke a real model.

1. Create one exact schema-6 `antigravity_edit` manifest with a unique request and attempt, a pinned source commit, and the existing authorized Gemini model identity.
2. Invoke `executePendingManifest` once with a stubbed executor result that represents a completed W2 model session and scoped diff. Assert it consumes the exact attempt once and persists the terminal result on the configured results path.
3. Preserve `external_effects=UNKNOWN` and `task_acceptance=UNKNOWN`; a terminal Executor result is not semantic or source acceptance.
4. Simulate a new Task Scheduler process by invoking `executePendingManifest` a second time with the same manifest/results directories. Assert it reports no pending manifest, does not call the stub again, does not create a new attempt, and leaves the original `.running.json` and result bytes unchanged.
5. Ensure any cleanup uses the existing exact-attempt helper and does not modify the registered source checkout.

## Verification

Run the focused Executor suite on Windows and the repository's relevant native-only checks. Report the exact test counts and diff. Do not claim this simulated process restart is a full Windows reboot test.
