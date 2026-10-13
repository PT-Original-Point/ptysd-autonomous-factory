# PTYSD V5.3-R4 — Monitor source-only repair candidate

Scope: `CHATGPT_GLOBAL_SKILL_GOVERNANCE` local, read-only Win11 monitor.

## Source / authority boundary

- This is **CANDIDATE/SOURCE_ONLY_NOT_DEPLOYED**, NOT a canonical control-plane promotion and not a Win11 installed version.
- Only the already deployed `monitor/` under the operator's local project directory is live; it remains unchanged by this patch.
- Public repository (renamed 2026-10-11, same GitHub repository ID `1352411536`): `PT-Original-Point/ptysd-autonomous-factory`. Canonical prestate on branch `v45/factory-control` was CP200 when the handoff was read. The runtime **must fetch fresh** provider data and cannot treat that snapshot as current or as R4 accepted.
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

## 2026-10-11 additional integrity hardening (candidate v2)

- GitHub canonical pointer is read a third time after the checkpoint and must match the initial pointer by Git blob SHA and exact raw bytes. This prevents an old coherent pointer/checkpoint pair from being described as the latest when the pointer changes during the two-file lookup; later changes remain possible and require a new readback.
- A generic successful GitHub Actions run at the candidate SHA is classified as `GITHUB_RUN_SUCCESS_UNVERIFIED`. A source success cannot establish the protected verifier/acceptance contract unless that workflow identity and contract have actually been verified.
- Local offline tests: `node --test ./*.test.mjs` = 98 pass / 0 fail; independent build probes 13 pass / 0 fail; offline UI probes 5 pass / 0 fail. No Windows live deployment, OS reboot or trusted GitHub CI claim.

## Reliable local startup (candidate hardening)

- Missing config defaults to the documented fixed loopback port 2667; invalid explicit ports and malformed JSON fail with bounded error codes instead of silently binding a random port.
- `monitor/.gitignore` excludes local credentials/config and generated startup receipts.
- Exact tests: `monitor.port.test.mjs` checks both normal startup configuration and invalid cases. No Win11 deployment or reboot acceptance is implied.

## 2026-10-13｜OpenCode V2 同一個 2667 面板觀測（候選，非部署）

- 延用 `monitor/server.mjs` 的現役設計與 `/api/state`；**沒有新增 listener、daemon、MCP、DB、排程器或 GitHub 任務寫入**。
- 加入 `monitor/native-v2.mjs` 從**現有 Issue #407** 的公開原生任務與收據唯讀讀取（現有 GitHub 輪詢內，每約 6 分鐘）；僅匹配 exact project、host、task ID、kind、source SHA 與同 attempt STARTED/terminal。Github 發言本身不證明 Windows PID、模型推理或編碼成果。
- 從原本 `collect.ps1` 對 Windows 程序與原有 `PTYSD-Native-OpenCode` Task Scheduler 的每 30 秒觀測單獨呈現。見到 `opencode.exe` 仍標為**未綁定任務的程序**，不得顯示「正在寫碼」。OS 讀取失敗或逾期不得補作零。
- 首頁中文列出「程序／接單排程／最新 GitHub 工作／真正寫碼及 Git 提交」。最後一欄需要同任務 git diff、PR 及可信 CI 再判定；本候選沒有證據時一律「尚未確認」。
- 當前 Win11 2667 的舊畫面仍然是歷史版本；只有**主機 exact-file 備份、僅原監控服務替換、Node 測試、Task Scheduler 與 2667 PID/HTTP readback** 過關才能宣稱部署。不能用合併 GitHub 來源冒充安裝。
