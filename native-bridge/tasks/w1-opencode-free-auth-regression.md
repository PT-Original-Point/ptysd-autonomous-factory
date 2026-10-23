# W1 regression: OpenCode V2 built-in free model without auth records

## Authorized purpose
This task is a bounded source-only follow-up to the Human-authorized W1 OpenCode V2 free-model execution request and the V5.3-R4 Human goal in Issue #310 comment 6188322050. It must prove that an absent saved-provider record is not treated as a login failure when, and only when, the exact built-in free model is explicitly allowlisted.

## Exact write scope
Modify only:
- `tests/opencode-desktop-cli-discovery.test.mjs`

Do not change production modules, `package.json`, other tests, credentials, provider configuration, Task Scheduler, or any external state.

## Required test behavior
Add focused regression coverage against the existing worker/readiness path, not a new authorization helper or auth system.

1. Use the real `readV2ProviderAuth` parser with mocked CLI output `[]` (and `{}` if that parser supports both) and confirm it reports `AUTH_PROVIDER_RECORD_ABSENT`; do not invoke `auth login`.
2. Exercise the real exported `runPlan` OpenCode edit path with dependency-injected CLI qualification, provider-auth read, and captured-process execution. The test doubles must never launch OpenCode or a model. Use a temporary clean Git workspace and temporary state directory, and clean both in `finally`.
3. With model `opencode/deepseek-v4.1-flash-free`, variant `null`, and the exact model present in both `unauthenticated_free_models` and `allowed_models`, prove the auth gate permits reaching the injected captured-process boundary exactly once. Assert the exact model remains pinned and there is no provider/model fallback.
4. With the model omitted or mismatched in either allowlist, prove the process boundary is never reached and the result is the existing waiting outcome for absent provider auth. Do not weaken or bypass the guard.
5. The tests must not make network calls or consume inference tokens. Keep all writes inside the temporary test workspace plus the single permitted test source file.

The test file is already part of the repository's `npm test` command. After W1 returns its diff, Codex will run:
```
node --test tests/opencode-desktop-cli-discovery.test.mjs
```
A process exit, mock invocation, or receipt alone is not semantic acceptance. Report the actual test/diff outcome without adding files outside the exact write scope.
