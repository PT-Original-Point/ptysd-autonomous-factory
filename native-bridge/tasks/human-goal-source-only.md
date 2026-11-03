# Source-only Human goal execution

The native dispatcher has already fetched and hash-verified the complete Human comment. The full bytes remain in the local request for audit, while the model prompt carries only a validated `scoped_action` together with the source ID, author, marker, and body SHA-256. The action may come from one unique nonempty `Codex 下一動作` section, or from the fixed bounded R4 continuation action when the exact `PTYSD_V53R4_DELETE_FIRST_AUTONOMY_GOAL_20261015` marker and the required authorization clauses in sections 6.6, 9.3, and 10.2 all match. No generic goal body or partial set of clauses gets this fallback.

Treat that validated scoped action and this pinned task spec as the complete task-specific direction for the attempt. Do not infer additional permission from omitted comment sections. If neither the explicit section nor the exact R4 continuation contract validates, the dispatcher must stop before model execution.

Work in the isolated Git source bundle and only within the job's exact `write_paths`. Do not interpret the scoped action as a shell command, script, or permission to escape the Codex workspace-write sandbox.

Choose bounded, reversible source work. Do not modify production, Windows Task Scheduler, services, credentials, governance indicators, repository protection, or external task/receipt state. Do not publish, merge, or deploy. Do not replay an operation whose external effect is unknown. Do not treat process exit, a historical receipt, or an execution status as proof of semantic completion.

Inspect the exact source revision, make the smallest coherent source change, run focused tests available in the repository, and leave a reviewable diff. If the request requires a new identity, paid usage, privileged access, production action, or an unknown external effect, leave that part untouched and report the concrete boundary in the result.
