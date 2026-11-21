# VNEXT5.1-R1 Canonical Recovery / Cross-Session Alignment Spec

Status: NONCANONICAL REVIEW CANDIDATE  
Project: CHATGPT_GLOBAL_SKILL_GOVERNANCE / 全自動軟體工廠  
Date: 2026-09-29  
Human current construction spec: VNEXT5.1  
Supersedes as CURRENT construction intent: VNEXT5.0-R3 and earlier R4-era continuation state  
Production authorization: NOT GRANTED

## 0. Problem statement

The Human has established VNEXT5.1 as the current construction specification, but the durable canonical control plane still resolves to:

- Mission: 20260926T220900+0800
- Execution Policy: 20260926T220900+0800-EP72
- Phase: VNEXT5_0_R3_MCP_CONTINUITY_FIRST
- Checkpoint: 192
- Active unit: R3-P0-03-FACTORY-ORPHAN-RECONCILIATION
- execution_fence: null

A VNEXT5.1 autonomy-unlock candidate already exists on noncanonical source, but it is not the canonical Mission/Policy/spec identity. Therefore a fresh Session that correctly follows Project Directory -> canonical control -> checkpoint -> Mission/Policy can truthfully return old V5.0-R3 state even though the Human has moved the project to V5.1.

This is a control-plane publication failure, not a memory problem.

Primary defect class:

SPEC_CONTROL_PLANE_REBASE_REQUIRED
CANONICAL_SPEC_LAG=true
HUMAN_DIRECTIVE_TO_CANONICAL_PUBLICATION_GAP=true

## 1. R1 objective

VNEXT5.1-R1 makes the current Human specification, Mission, Policy, active run identity, and live Factory MCP behavior converge so every fresh Session/AI obtains the same current state from the canonical backend without relying on Memory, chat history, recent files, or handoff summaries.

Execution routing is changed by Human authority in this revision: ChatGPT Web is no longer the primary long-running construction executor. Substantial, multi-step, stateful, or long-running construction SHOULD be delegated to Codex as the primary executor. ChatGPT Web is the short-lived control/review surface for Mission interpretation, bounded readback, auditing, exception handling, and Human interaction.

## 2. Required authority model

Cold start for this Project MUST resolve in this order:

Project Directory exact project identity
-> active_run_ref / canonical control pointer
-> current checkpoint
-> current Mission revision
-> current Execution Policy revision
-> immutable current construction-spec ref/digest
-> active run/task/attempt identity
-> provider/live runtime readback when required

The current construction-spec identity MUST be provider-addressable and immutable. A fresh Session MUST NOT infer the current spec from the newest filename, recent chat, Memory, Library recency, or a noncanonical PR title.

The Human's latest explicit Mission-level instruction remains superior to an older persisted Mission. If persisted state lags, the system MUST surface SPEC_CONTROL_PLANE_REBASE_REQUIRED and prioritize publication/rebase instead of silently treating the old persisted phase as current intent.

## 3. Single synchronized execution state

There MUST be one current operational identity for the Project.

Checkpoint, run record, active task, attempt ID/epoch, and current policy MUST agree on the same active unit.

The existing condition where checkpoint 192 identifies P0-03 while runs/V50-R3-001/run.json retains older P0-01/P0-02 state is not acceptable as a steady state.

Acceptance:

- one canonical active task identity;
- one current attempt identity;
- one current policy revision;
- no stale run record may override a newer canonical checkpoint;
- no human-readable worklog becomes a second authority;
- worklogs/reports are projections from canonical/provider evidence only.

## 4. Factory MCP guard decomposition

Do not treat every SYSTEM-capable operation as the same authorization problem.

### 4.1 Fixed read-only diagnostics

Read-only operational observation MUST be available without a Host-mutation fence through constrained, fixed-purpose probes.

Preferred implementation: extend the existing read-only factory_status surface rather than creating a fifth public MCP tool.

Required bounded read-only probe classes include at minimum:

- capability_status;
- orphan_records with per-record identity sufficient for same-source classification;
- FactoryMCP installed-runtime prestate metadata/hashes needed for repair planning;
- service/process/scheduled-task identity relevant to Factory MCP;
- current broker/receipt state;
- current trusted-caller identity metadata.

These probes MUST NOT accept arbitrary PowerShell and MUST NOT mutate Host state.

### 4.2 Arbitrary host_powershell

host_powershell remains a four-tool-surface capability and may execute arbitrary PowerShell as SYSTEM.

Mission/checkpoint/run/task rollover, per-Session reauthorization, stale historical wake payloads, and local governance generation values MUST NOT independently disable transport after the Human has persistently authorized reversible pre-Production construction.

Retain real safety controls:

- exact Project/Host target;
- STOP;
- stale active attempt when a real backend fence exists;
- unresolved ambiguous external effect;
- provider/backend CAS/revision conflict;
- Production/Human-reserved gate;
- bounded timeout/output;
- durable receipt;
- same-source readback;
- operation-owned rollback;
- no blind replay.

## 5. Trusted caller boundary is a real security gate

Do not solve autonomy by turning arbitrary local NETWORK SERVICE processes into SYSTEM PowerShell callers.

A shared principal such as NT AUTHORITY\NETWORK SERVICE is insufficient by itself when multiple local processes can share that SID.

Before unrestricted live host_powershell promotion, establish an OS-enforced caller boundary that uniquely identifies the intended Factory MCP caller. Acceptable designs include a dedicated service account/service SID or an equivalently unique ACL-protected IPC/request boundary.

This security condition is distinct from the self-imposed Mission/checkpoint/run/task transport locks that R1 removes.

## 6. Cross-project read-only decoupling

Business projects MUST NOT depend on arbitrary SYSTEM execution for provider read-only operations when the provider offers a bounded native read API.

For HANYAO Ads/LINE observability, Cloudflare D1 read-only reconciliation is architecturally separable from Factory MCP and SHOULD use a least-privilege provider read lane when credentials can be bound safely.

Factory MCP remains appropriate for the privileged Windows/gcloud/SYSTEM execution path that genuinely requires the Host.

This prevents a Factory MCP host-transport incident from making independent read-only observability blind.

## 7. R1 construction order

R1-00 CANONICAL SPEC IDENTITY
- Publish this exact V5.1-R1 spec as an immutable provider-addressable artifact.
- Bind the current Mission/control plane to the exact ref/digest.
- Fresh cold start must report CURRENT_SPEC=VNEXT5.1-R1.

R1-01 MISSION/POLICY REBASE
- Publish a new Human-authorized Mission revision superseding V5.0-R3 persisted intent.
- Publish a matching Execution Policy revision.
- Preserve Production=false, paid fallback=false, business auto-admission=false.
- Encode persistent authorization for ordinary reversible pre-Production work.
- Remove Mission/checkpoint/run/task/per-Session rollover as transport authorization gates.

R1-02 RUN/CHECKPOINT COHERENCE
- Reconcile canonical checkpoint and run record to one active task/attempt identity.
- Retire stale P0-01/P0-02 wait projection as current execution truth.
- Same-source readback must prove identity coherence.

R1-03 READ-ONLY BOOTSTRAP SURFACE
- Add bounded factory_status probes needed to inspect orphan identities and live install prestate without arbitrary Host mutation.
- Prove zero Host mutation.

R1-04 TRUSTED CALLER
- Replace shared-SID-only caller trust with a unique OS-enforced caller boundary.
- Negative test: another local process with a shared generic service principal cannot inject SYSTEM requests.

R1-05 TRANSPORT GUARD SIMPLIFICATION
- Remove duplicated Mission/checkpoint/run/task/generation transport gates.
- Retain real mechanical/safety gates from sections 4 and 5.
- Regression must prove a new Session/Mission/checkpoint rollover does not recreate SYSTEM_CAPABILITY_RUN_DENY for otherwise authorized pre-Production execution.

R1-06 LIVE FACTORY MCP INSTALL
- Exact source blobs, immutable hashes, exact target prestate, operation-owned backup, bounded install, restart, same-source readback.
- Codex is the primary long-running executor for this and other substantial implementation units. ChatGPT Web remains the control/review surface and performs only bounded actions that are materially faster or necessary for supervision.

R1-07 CROSS-SESSION / COLD-START REGRESSION
With Memory/chat-history assumptions removed, a fresh controller must resolve:
- Project = CHATGPT_GLOBAL_SKILL_GOVERNANCE
- Current spec = VNEXT5.1-R1
- matching Mission/Policy
- matching checkpoint/run/task/attempt
- no stale R4/V5.0 state resurrected as current
- no Human reauthorization loop for ordinary reversible pre-Production work.

R1-08 LIVE MCP ACCEPTANCE
Required live probes:
- factory_status succeeds;
- fixed read-only probes succeed;
- host_powershell authorized-scope canary returns NT AUTHORITY\SYSTEM;
- SYSTEM_CAPABILITY_RUN_DENY absent for authorized scope;
- SYSTEM_CAPABILITY_TASK_DENY absent for authorized scope;
- Mission/checkpoint rollover alone does not disable transport;
- exactly four public Factory MCP tools remain;
- Production remains denied.

R1-09 CROSS-PROJECT RECOVERY
After Factory MCP R1 live acceptance:
- run HANYAO Production D1/Google Ads fresh read-only reconciliation;
- distinguish real no-lead state from attribution/outbox/provider/reporting loss;
- only then proceed to separate Production deployment/business gates.

## 8. Executor routing — Codex primary for substantial work

The legacy Chat-first executor policy is removed from the active routing contract.

New routing contract:

- `SUBSTANTIAL_OR_LONG_RUNNING_WORK => CODEX_PRIMARY`
- `CHATGPT_WEB => CONTROL_REVIEW_SHORT_READBACK_HUMAN_INTERFACE`
- ChatGPT Web MAY directly execute short, bounded, low-latency actions when doing so materially reduces coordination overhead, but it is not required to exhaust all connector capabilities before delegating.
- Codex is the preferred executor for multi-step coding, repository construction, test/repair loops, long local filesystem work, sustained research-to-implementation loops, and other work where ChatGPT Web session interruption or context loss would materially degrade reliability.
- A task MUST NOT be kept in ChatGPT Web merely because Chat technically has a connector that could execute it.
- The routing decision optimizes continuity, durability, long-run reliability, and executor suitability rather than native-tool precedence.
- Human authorization for the Project's already-authorized reversible pre-Production construction may be carried into Codex execution; routine executor routing does not require repeated per-Session Human opt-in.
- Human-reserved gates remain Human-reserved: Mission/major strategic change, Production final authorization, new cost, legal/contract/signature/identity, OAuth/MFA, major irreversible authority expansion, and unreconcilable ambiguous external effects.
- ChatGPT Web remains responsible for independent readback/audit of material Codex claims before promotion or closure.
- Codex does not gain Mission sovereignty; it executes the Human Mission and current canonical policy.

Routing anti-patterns that are now forbidden:

- mandatory Chat-first executor selection;
- requiring Chat to complete all technically possible work before Codex may start;
- restricting Codex to only a terminal local-only role;
- treating Codex delegation itself as an exceptional fallback;
- repeated Human approval solely because a new ChatGPT Web Session or Codex Session started.

## 9. R1 completion criteria

VNEXT5.1-R1 is complete only when all are true:

1. CURRENT_SPEC resolves canonically to VNEXT5.1-R1 from a fresh Session.
2. Mission/Policy/spec/run/checkpoint identities agree.
3. No stale V5.0/R4 state can become current solely because it is persisted in an older run/handoff.
4. Fixed read-only Factory MCP diagnostics do not require a Host-mutation fence.
5. Trusted caller boundary is unique and OS-enforced.
6. Authorized reversible pre-Production host_powershell no longer fails due to self-referential Mission/checkpoint/run/task/generation gates.
7. Production/Human-reserved gates remain enforced.
8. Live Factory MCP canary passes with same-source readback.
9. HANYAO can perform the required fresh read-only reconciliation without being blocked by obsolete Factory control state.
10. A new Session repeats the same result without Memory or manual Human relay.

## 10. Explicit non-goals

- no Production approval;
- no paid fallback;
- no fifth Factory MCP public tool;
- no second canonical store;
- no new general orchestration layer;
- no blind removal of trusted-caller or unknown-effect protections;
- no claim that candidate/local tests equal live acceptance.
