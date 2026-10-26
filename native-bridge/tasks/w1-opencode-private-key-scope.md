# W1 Task: Deny private-key files in OpenCode V2 scoped edits

## Objective

Close a fail-open in the OpenCode V2 scoped coding policy. The global and scoped agents allow workspace reads by default, but the current private-resource deny list does not cover conventional private-key filenames or common private-key extensions.

The current main reproduces the gap: reads of synthetic `id_rsa`, `id_ed25519`, `src/private.key`, and `src/private.ppk` resolve to `allow`; the edit-scope builder also accepts synthetic paths ending in `private.key` and `id_ed25519`.

## Required behavior

1. Deny reads of common private-key file forms, including conventional OpenSSH private-key names and private-key extensions. Apply the deny to both global and scoped-agent policies.
2. Reject matching private-key filenames in the exact edit-path allowlist, including nested paths and Windows case variants.
3. Keep public-key files such as `.pub` readable and eligible for an exact edit grant. Do not use a broad `*key*` rule that blocks unrelated filenames.
4. Preserve the existing shell, network-tool, subagent, external-directory, and exact-path restrictions.

## Tests

Add deterministic tests using synthetic paths or temporary files only. Assert that:

- private-key reads resolve to `deny` in both policies;
- private-key edit paths fail closed;
- a public `.pub` path remains permitted; and
- unrelated paths and existing policy behavior remain unchanged.

No real credential or key material may be created, read, copied, or included in test output.

## Exact edit scope

- `native-bridge/opencode-v2.mjs`
- `tests/opencode-v2.test.mjs`

Do not edit dispatch/routing code, worker configuration, model settings, credentials, Task Scheduler state, the Human GOAL, W2 artifacts, trusted-verifier files, or any path outside this list.
