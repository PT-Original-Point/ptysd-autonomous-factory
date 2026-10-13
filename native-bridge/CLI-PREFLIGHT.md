# PTYSD V5.3-R4 | OpenCode V2-only CLI qualification and rollout

**Project:** `CHATGPT_GLOBAL_SKILL_GOVERNANCE`. **GitHub:** `PT-Original-Point/ptysd-autonomous-factory`, Issue #407. **Windows:** `DESKTOP-1B6PD2P`.

## Human directive

Only the **official OpenCode V2** may be used as the OpenCode executor. No V1 installation, fallback, V1 prompt flags, V1 permissions, arbitrary downloaded mirror or additional intermediary control plane. This directive changes the OpenCode lane only; prior Windows native GitHub transport, Codex and unrelated providers are separate.

## Already verified, and what is not

The original low-privilege Windows `PTYSD-Native-OpenCode` Task Scheduler has live GitHub `ping` and `native_preflight` receipts. The previous Worker was successfully updated to SHA-256 `5b8b7e1194599bfe447753cfcafe22c7d45589c50e388d38e2af3c055bb30815`. The host preflight returned `CLI_NOT_FOUND`: this **does not** prove an OpenCode V2 executable or model provider is available in the background task's environment. Model inference, coding, automated red/green correction, privileged OS cleanup and reboot survival are not accepted.

## Accepted commands and sources

Use the official V2 installation page: <https://opencode.ai/v2/docs/>. The official npm package is **`@opencode/cli`**; do not install `opencode-ai` (V1). Exact candidate npm version must be verified at deployment time, pinned by version and checked after installation. Windows package managers are not supported as a substitute. Windows native executable naming changed during V2 beta (`opencode2.exe` versus `opencode.exe`); names alone are **not** version evidence.

The pure, no-model preflight executes a discovered native executable's `--version` with a five-second bound. Only an exact **2.x.y** output qualifies. A file returning V1, unverifiable text, or timeout is rejected. A configured local executable path (`PTYSD_OPENCODE_V2_EXE`) is accepted only when absolute and points to a real file; it is still version-qualified. Never use `cmd.exe` shell interpolation of a model prompt or an npm `.cmd` shim.

V2 noninteractive readonly form:
```text
<verified V2 native executable> run --agent ptysd-readonly --model provider/model#variant --format json --dir <private-workspace> --title <request_id> <pinned-task-spec>
```
The `provider/model` name may contain additional slashes after the first slash (OpenRouter), and `variant` must exist for that model. A successful CLI exit code does not independently prove the provider honored reasoning effort or that work was accepted. No model inference is allowed without host-local `enable_v2_model_runs:true` AND a matching `allowed_models: {"provider/model":["variant"]}` setting. Both are absent by default.

## Version 2 permissions and fail-closed policy

V2 uses ordered `permissions: [{action,resource,effect}]` rules, **not** V1 `permission: {bash,task,...}`. The V2-only custom primary `ptysd-readonly` agent explicitly denies `shell`, `edit`, `subagent`, `external_directory`, web, plugins/execute, and questions. Only local `read` / `glob` / `grep` are enabled. Session sharing and auto-upgrade are disabled.

Some historical V2 beta paths silently ignored environment-injected `OPENCODE_CONFIG` and `OPENCODE_CONFIG_CONTENT` permissions. Accordingly the worker uses the **project-local** `opencode.json` under its already isolated user-local `workspace`, checks exact byte readback, refuses unknown `opencode.json`, `opencode.jsonc` or `.opencode` overrides, and strips inherited config-injection variables. An actual host test must still prove that this exact installed V2 build loads the agent/permissions before model inference is enabled. GitHub source/mock CI alone is not sufficient.

## Durable dispatch and privacy

Only pinned jobs with exact project, Issue, trusted author, host, accepted main source SHA and pinned task spec SHA may be processed. Transport `ping` and zero-token `native_preflight` are retained. V2 `opencode_plan` uses schema 2 with `model` and `variant` in the task; both are locally allowlisted. STARTED/terminal receipts publish only bounded metadata and local evidence digests, never raw output or credentials. A STARTED without terminal is ambiguous; it must never reexecute the effect blindly.

## Acceptance phases

1. **Source candidate:** native Node V2-only unit and negative tests + trusted hosted CI.
2. **Host V2 CLI qualification:** official `@opencode/cli` exact version; native bin `--version` = 2.x, real Worker path/readback, no model usage.
3. **Host config/permissions qualification:** verify project config is consumed, malicious shell/edit/external attempts are denied, no paid fallback. Do not enable model until this proves true on that V2 build.
4. **Readonly model task:** verify provider, model ID, variant, costs/quotas; explicitly enable exact model pair; capture exact STARTED/terminal and local evidence hash; `exit 0` is not canonical acceptance.
5. **Coding/CI/rework:** independently gated future work. Never merge trusted-verifier edits with untrusted candidate proof.

No new MCP or supervisor; preserve 2667, WinRM, separate Codex tunnel, unrelated projects, `governance/**`, `runs/**`, and the draft #405 Runner trust-root boundary. Do not claim login-free 24/7 or OS retirement from this phase.
