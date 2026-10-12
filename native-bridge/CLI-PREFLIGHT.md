# PTYSD native bridge | CLI qualification and model-pinned readonly work

Project: `CHATGPT_GLOBAL_SKILL_GOVERNANCE`, repository `PT-Original-Point/ptysd-autonomous-factory`, Windows host `DESKTOP-1B6PD2P`.

## Existing production evidence and current boundary

Issue #407 has real Win11 GitHub `STARTED` and `FINISHED` receipts for two native `ping` jobs. These prove the issue transport and scheduled poll worked, **not** that the OpenCode CLI, selected model, coding workers, canonical acceptance or 24/7 after logout work. The accepted original Task Scheduler is `PTYSD-Native-OpenCode`, Interactive, Limited. Its installed `worker.mjs` does **not** self-update when GitHub `main` changes.

This code change adds two **candidate** capabilities to that existing single worker, without introducing a new MCP, service, job database or OS privilege.

## Exact supported GitHub Issue envelope

Use the existing exact Issue #407 title and line-one marker `PTYSD_NATIVE_JOB_V1`.

A zero-token preflight continues with the original eight keys:
```json
{"schema":1,"project_id":"CHATGPT_GLOBAL_SKILL_GOVERNANCE","host":"DESKTOP-1B6PD2P","request_id":"PTYSD_NATIVE_PREFLIGHT_20261012","kind":"native_preflight","source_sha":"<ACCEPTED_MAIN_40_HEX_SHA>","spec_path":null,"spec_sha256":null}
```
Preflight reads Node version, OS/architecture, and whether a native `opencode.exe` or a `.cmd` shim is discoverable in PATH. It does not execute OpenCode or access any model/credentials. Local evidence is hashed; only a bounded outcome and evidence hash/byte count are posted on GitHub.

A readonly AI plan now requires **schema 2** with the additional exact fields `model` and `variant`; the old unpinned schema-1 plan is intentionally rejected:
```json
{"schema":2,"project_id":"CHATGPT_GLOBAL_SKILL_GOVERNANCE","host":"DESKTOP-1B6PD2P","request_id":"PTYSD_NATIVE_PLAN_20261012","kind":"opencode_plan","source_sha":"<ACCEPTED_MAIN_40_HEX_SHA>","spec_path":"native-bridge/tasks/readonly-host-inventory.md","spec_sha256":"<ACTUAL_SPEC_SHA256>","model":"<VERIFIED_PROVIDER/ID>","variant":"high"}
```
In the user-owned existing `%LOCALAPPDATA%\\PTYSDNativeBridge\\config.json`, `allowed_models` must independently allow the exact `model` and `variant` pair, e.g. `{"verified-provider/verified-model":["high"]}`. **Default: no approved models; no silent fallback to a paid/default model.** Get actual identifiers from the real host's official `opencode models` and authenticated provider, not desktop menu labels. Model/variant costs and provider quota must be verified before adding an allowlist entry. OpenCode has reports that an unsupported `--variant` can be silently ignored: a CLI exit 0 is not proof of actual reasoning effort.

## Windows execution and deployment

OpenCode desktop ≠ installed headless CLI. The official Windows CLI can be installed with the documented `npm install -g opencode-ai`, but only with a user-approved, version-pinned, non-admin install step and official source. Do not silently install third-party agents or expose provider tokens in the public Issue.

For now the worker invokes only directly executable `opencode.exe` (Windows) with `shell:false`. A lone `opencode.cmd` shim is reported as wrapper-only and is **not** passed through `cmd.exe` with arbitrary prompt text. The readonly plan uses `--pure run --agent plan --model ... --variant ... --format json`, restricted permission configuration, 10-minute bound, no autoshares or auto-upgrade. Output remains on the user OS disk, not public GitHub comments.

**Source-only acceptance must not be conflated with Windows installation.** A trusted on-host operator must replace the old exact worker under its **existing** Limited Task identity with prestate hash checking, no running worker attempt, SHA-256 readback, and task reenable. Until that separate readback, status is `WINDOWS_WORKER_UPDATE_PENDING`. A fresh GitHub Issue `native_preflight` must be queued only after accepted-main SHA and actual local worker version have been reconciled; otherwise the old worker will ignore it.

The new `selectNext` skips an unstarted stale-source job instead of starving later fresh jobs. It does **not** resend tasks with `STARTED` or unknown external effects. A matching live `STARTED` + terminal receipt is the next acceptance gate.

## Out of scope and preserved invariants

No AI code editing, automatic CI red/green or rework is enabled by this change. Implement these only after headless model/auth/cost proof, independent protected CI and safe Git worktree ownership. Do not treat this readonly task as production promotion.

Preserve `PTYSD-Factory-Monitor` at 2667, WinRM, separate `.codex-chatgpt-web` tunnel, unrelated projects and immutable `governance/**` / `runs/**` evidence. Retiring `v47`, FactoryMCP/HostGuard/JEA/secrets and the old self-hosted Runner is handled only in independently approved OS/provider lanes. Trust-root PR #405 remains unresolved. No Windows administrator capability is exposed via GitHub Issue comments.
