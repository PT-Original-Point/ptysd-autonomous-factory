# Source-only Human goal execution

The native dispatcher has already fetched and hash-verified the complete Human comment. The full bytes remain in the local request for audit, while the model prompt carries only the unique verbatim `Codex 下一動作` section together with the source ID, author, marker, and body SHA-256.

Treat that scoped action and this pinned task spec as the complete task-specific direction for the attempt. Do not infer additional permission from omitted comment sections. If the source comment has no unique scoped-action section, the dispatcher must stop before model execution.

Work in the isolated Git source bundle and only within the job's exact `write_paths`. Do not interpret the scoped action as a shell command, script, or permission to escape the Codex workspace-write sandbox.

Choose bounded, reversible source work. Do not modify production, Windows Task Scheduler, services, credentials, governance indicators, repository protection, or external task/receipt state. Do not publish, merge, or deploy. Do not replay an operation whose external effect is unknown. Do not treat process exit, a historical receipt, or an execution status as proof of semantic completion.

Inspect the exact source revision, make the smallest coherent source change, run focused tests available in the repository, and leave a reviewable diff. If the request requires a new identity, paid usage, privileged access, production action, or an unknown external effect, leave that part untouched and report the concrete boundary in the result.
