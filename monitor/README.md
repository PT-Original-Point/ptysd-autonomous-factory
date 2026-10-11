# PTYSD V5.3-R4 — Monitor source-only repair candidate

Scope: `CHATGPT_GLOBAL_SKILL_GOVERNANCE` local, read-only Win11 monitor.

## Source / authority boundary

- This is **CANDIDATE/SOURCE_ONLY_NOT_DEPLOYED**, NOT a canonical control-plane promotion and not a Win11 installed version.
- Only the already deployed `monitor/` under the operator's local project directory is live; it remains unchanged by this patch.
- Public repository: `PT-Original-Point/ptysd-vnext42-governance-sandbox`. Canonical prestate on branch `v45/factory-control` was CP200 when the handoff was read. The runtime **must fetch fresh** provider data and cannot treat that snapshot as current or as R4 accepted.
- Real execution / reboot / automatic Windows Task Scheduler recovery / OS identity and source credentials cannot be validated by Linux source tests. Do not claim PASS for them.
- Never commit the local `config.json`: it contains workstation and identity paths. Start from `config.example.json`, or preserve the current installed `monitor/config.json` while staging only reviewed candidate source. Do not change the Windows account, services, scheduler, VM key, login credentials or production rights through this PR.

## Candidate repair

- Host data from Windows PowerShell is separated into the actual `processes`, `scheduled_tasks`, `services`, and `vms` observation segments. Failed process reads cannot prove zero workers or restore `RUNNING`, even when another section succeeds.
- OS PID must be accompanied by expected process identity and valid, recent time-binding. No RUNNING inferred from historic Codex threads alone.
- Pending / rejected / absent native delivery is not accepted work. Missing exit code or artifact stays UNKNOWN; `exit 0` is not acceptance.
- The GitHub formal control pointer is read from the **same branch**, with checkpoint exact digest verification. Branch movement or either failed read leaves the result UNKNOWN, not accepted.
- GitHub CI is qualified only for a configured exact 40-character candidate SHA and a fresh run. It never establishes canonical R4 acceptance.
- Boss home hides raw PID/UUID, archival worker counts, stale scheduler inventories and engineering source rows. The independent readback timestamps remain available under Engineering Details.
- Worker pause or stale historical denial does not create an invented Human gate; true user-reserved gates remain outside this display layer.
- Existing listener stays bound to `127.0.0.1`, with read-only GET endpoints and Host validation. This source patch does not introduce a new daemon, model heartbeat, third-party gateway, DB, or control plane.

## Reproducible tests (Node >= 22 with built-in SQLite)

```sh
cd monitor
node --check server.mjs
node --test ./*.test.mjs
```

The suite includes 12 original test files, the R4 suite, canonical negative fixtures,
loopback HTTP read-only tests, and executable 13 production fault / five offline DOM
probes. No externally installed npm dependencies are needed.

Historical fixture migrations (not weakened assertions):
- `monitor.b.test.mjs` and `monitor.test.mjs` add a positive OS `collected_at` value to cases that previously expected RUNNING while supplying **no actual OS observation time**.
- `monitor.r4.test.mjs` expects the approved Traditional Chinese boss headings rather than stale engineering titles.

## Native Windows acceptance required after Codex / controller access recovers

1. Re-read installed `server.mjs`, `index.html`, `collect.ps1`, `config.json`, the current Task Scheduler definition, PID/start time and singleton port 2667. Check another active writer and pending effects first.
2. Take an exact byte-level backup. Check staged candidate SHA and compare scope; do not overwrite `config.json` or unapproved local files.
3. Run Windows PowerShell collector fixture with real PS 5.1 AST syntax and isolated native captures. Unknown means unknown, not PASS.
4. Validate Windows task crash recovery, cold boot, Edge desktop shortcut, Codex UI closed, service process ownership, source freshness, missing artifacts and ten no-delta reads (zero model inference).
5. Preserve the existing host-native timer fallback until its replacement is **independently** qualified; do not install a second supervisor. On failure, restore exact original source and read back the port and PID. Never blindly replay unknown external work.
6. Only after real OS readback and the accepted project task / trusted provider CI can the corresponding result be promoted beyond SOURCE_ONLY.

Git SHA, PR and test results reported for this source snapshot only do not imply Host-live acceptance.
