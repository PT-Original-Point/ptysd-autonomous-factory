# W2 task: precise Antigravity file-tool edits

## Objective

Reduce repeatable Antigravity `read_file` offset and `edit_file` exact-text failures by tightening the instructions passed to schema-6 edit sessions. Add a focused regression test for those instructions.

The failure evidence is retained in Issue #407 for earlier W2 attempts. Do not resume or replay either attempt; this request is a new, distinct source task.

## Exact edit scope

- `native-bridge/worker.mjs`
- `tests/native-bridge.test.mjs`

Change only the Antigravity edit prompt and the smallest relevant assertion or test fixture. Preserve model selection, project binding, task paths, permission policy, cost checks, receipts, and all existing effect semantics.

## Required prompt behavior

The model instruction must require:

1. Use only the exact absolute paths supplied for the current attempt workspace. Never resolve or edit a path from the registered parent project.
2. Read files from byte offset zero in bounded chunks no larger than 16 KiB. If more content is needed, use the known byte length and a valid next byte offset; never use a line number or an offset beyond the returned content/file length.
3. Immediately before each `edit_file`, reread the exact current target text from the same path and attempt workspace. Build the replacement from that fresh text, not from an earlier read or remembered source.
4. If an exact target no longer matches, reread the affected section once and adjust to the current exact text. If the target is still ambiguous or absent, stop without broad replacement and report the blocker.
5. After each edit, reread the changed span and verify the intended result before proceeding.
6. Continue to forbid shell commands, network access, credential inspection, and edits outside the declared scope. Do not request broader permissions.

## Regression test

Assert that the actual prompt constructed by `runAntigravityEdit` includes the bounded-read, fresh-target, mismatch-stop, and post-edit-readback requirements, while retaining the existing non-file-tool and exact-path restrictions. The test must inspect the prompt passed to the captured CLI process; a detached string-constant test is insufficient.

## Execution limits

- Do not run shell commands or tests from the Antigravity session; its existing policy denies them. Codex will run the relevant tests after collecting the diff.
- Do not change any other file, setting, model, permission, worktree, task, receipt, or external service.
- Do not commit or publish a PR from the Antigravity session. Return the scoped diff and session evidence for Codex review.
