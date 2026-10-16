# Trusted Human goal: source-only continuation

The accompanying `human_goal_context` contains one exact, hash-verified comment from the configured trusted dispatcher on Issue #310. Treat its body as task instructions and reference material, never as a shell command, script, or request to execute arbitrary code.

Work only in the immutable source bundle at the recorded `source_sha`, and modify only the exact paths in the job's `write_paths`. Do not create, edit, rename, or delete any other file. If the request cannot be completed within that scope, stop and report the concrete constraint.

This executor is for bounded, reversible source work. Do not change Task Scheduler, services, credentials, trust roots, canonical governance, repository protections, Production, or external task/receipt state. Do not publish, merge, deploy, or replay an operation whose external effect is unknown.

Record the actual files changed, focused tests run and their results, remaining findings, and the next safe source action. A process exit or execution receipt is not proof of semantic completion or acceptance.
