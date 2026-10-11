# PTYSD Governance Repository — V5.3-R4 source-only cleanup candidate

Project ID: `CHATGPT_GLOBAL_SKILL_GOVERNANCE`. GitHub repository ID: `1352411536`.

This PR is a **candidate** for removing the pre-V5.3 parallel runtime/control layers; it is **not a canonical cutover or Win11/VM uninstall**. The accepted governance pointer on `v45/factory-control` remains **CP200 (V5.1-R2)** pending authorized rebase, `SPEC_CONTROL_PLANE_REBASE_REQUIRED`.

## Intended V5.3 execution path

- Official GitHub Issues/PR/CI as the one durable coordination and acceptance source.
- Native Git/gh, Windows Task Scheduler and VM systemd for zero-model scheduling, processes, and exact readback.
- Qualified native Codex, OpenCode W1 and Antigravity W2 using isolated OS principals; W3 only for Human-reserved actions.
- OS-enforced secret and project isolation, provider-effect idempotency/readback, and trusted acceptance remain mandatory.
- Do not create a second Supervisor/Task DB, Factory MCP gateway, tunnel, worklog authority, or seven new factory CLI services.

## Historical and transition records remain authoritative for their own periods

`governance/**`, `runs/**`, current CSG checkpoint/pointer, schemas/csg, the retained CSG schema reader, exact pointer integrity checks, and provider-effect readback regression remain in source. Prior accepted evidence is not deleted or rewritten. Historical `governance/csg/v49/scripts/` is **evidence, not an active runtime entrypoint**. A stale historical `RUNNING` or lease does not prove a living worker.

The root package scripts now run only retained CSG integrity checks; the obsolete B0 SQLite and V4.5/V4.6 drivers are not auto-invoked. Tests of retired runtime should not be resurrected to make a red legacy check appear green.

## Retirement boundary

The removed HostGuard/JEA/Factory MCP and obsolete V4.5 synthetic workflow sources are a **proposed source deletion** only. Until same-source Win11/VM readback confirms zero live consumers, native replacement parity, and reconciled external effects, do not merge these OS-dependent deletions or claim their installed services stopped. OS retirement is `stop -> disable -> readback -> revoke obsolete credential when confirmed -> remove -> reboot negative test`.

The accepted `factory-bounded.yml` remains in this candidate as a protected trust-root workflow; the main branch also retains its trusted `pull_request_target` verifier. Neither trust-root file nor its verification source is removed by this candidate. A passing ordinary source test is not protected acceptance, and no checks/unknown effects must never be recorded as PASS.
