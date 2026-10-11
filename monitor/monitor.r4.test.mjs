import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  evaluateWorkerState,
  mergeCollectorReadback,
  buildDashboardState,
  evaluateFreshness,
  deriveHomeOverview
} from './server.mjs';

describe('R4 Monitor Candidate Suite', () => {
  it('1. Independent TTL: one fresh source does not rejuvenate others', () => {
    const now = 100000;
    const freshLocal = evaluateFreshness({ observed_at: new Date(now).toISOString(), ttl_seconds: 10, now });
    const staleWin = evaluateFreshness({ observed_at: new Date(now - 70000).toISOString(), ttl_seconds: 60, now });
    const staleVm = evaluateFreshness({ observed_at: new Date(now - 150000).toISOString(), ttl_seconds: 120, now });
    assert.equal(freshLocal, 'FRESH');
    assert.equal(staleWin, 'STALE');
    assert.equal(staleVm, 'STALE');
  });

  it('2. Repeated API build cache freshness transitions over time without faking', () => {
    const t0 = 100000;
    const ctx = {
      now: t0,
      localLastRun: t0,
      winLastRun: t0,
      config: { sourceTtls: { local: 10, windows: 60 } },
      windowsData: { collected_at: new Date(t0).toISOString(), data: { processes: [] } }
    };
    const s1 = buildDashboardState(ctx);
    assert.equal(s1.sources.local.freshness, 'FRESH');
    assert.equal(s1.sources.windows.freshness, 'FRESH');

    ctx.now = t0 + 20000;
    const s2 = buildDashboardState(ctx);
    assert.equal(s2.sources.local.freshness, 'STALE');
    assert.equal(s2.sources.windows.freshness, 'FRESH');

    ctx.now = t0 + 70000;
    const s3 = buildDashboardState(ctx);
    assert.equal(s3.sources.local.freshness, 'STALE');
    assert.equal(s3.sources.windows.freshness, 'STALE');
  });

  it('3. Windows partial errors and LastTaskResult 2147946720 / 267009 raw decimal values preserved', () => {
    const prev = { status: 'OK', data: { scheduled_tasks: [{ name: 'MonitorJob', last_result: 2147946720, state: 'Ready' }] } };
    const runningTask = { name: 'WorkerJob', last_result: 267009, state: 'Running' };
    const res = mergeCollectorReadback(prev, { status: 'OK', error: 'HyperV: Access denied', data: { scheduled_tasks: [runningTask] } });
    assert.equal(res.status, 'OK');
    assert.equal(res.data.scheduled_tasks[0].last_result, 267009);
  });

  it('4. Broken JSON in policy reports error without fake empty zero', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r4-test-'));
    fs.writeFileSync(path.join(tmpDir, 'controller-dispatch-policy.json'), '{ broken json', 'utf8');
    const state = buildDashboardState({ config: { phase: tmpDir } });
    assert.ok(state.alerts.some(a => a.includes('controller-dispatch-policy.json 解析錯誤')));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('5. Disconnected collector retains old payload with cached=true and STALE status', () => {
    const previous = { collected_at: '2026-10-11T00:00:00.000Z', data: { processes: [{ pid: 100 }] } };
    const failed = mergeCollectorReadback(previous, { status: 'FAILED', error: 'ECONNREFUSED' });
    assert.equal(failed.status, 'STALE');
    assert.equal(failed.cached, true);
    assert.equal(failed.data.processes.length, 1);
  });

  it('6. PID reuse detection with mismatch creation timestamp outside tolerance', () => {
    const attempt = {
      intent: { task: 'T1' },
      processInfo: { pid: 9999, created_at: '2026-10-11T00:00:00.000Z' }
    };
    const osProcesses = [{ pid: 9999, name: 'agy.exe', created_at: '2026-10-11T00:05:00.000Z' }];
    const res = evaluateWorkerState({ attempt, osProcesses, workerRole: 'W2' });
    assert.equal(res.status, 'UNKNOWN');
    assert.ok(res.blocker.includes('PID 重複使用'));
  });

  it('7. Invalid or missing creation timestamp returns UNKNOWN', () => {
    const attempt = { intent: { task: 'T1' }, processInfo: { pid: 9999 } };
    const osProcesses = [{ pid: 9999, name: 'agy.exe', created_at: 'invalid-date' }];
    const res = evaluateWorkerState({ attempt, osProcesses, workerRole: 'W2' });
    assert.equal(res.status, 'UNKNOWN');
    assert.ok(res.blocker.includes('進程創建時間無效'));
  });

  it('8. Expired OS query prevents live RUNNING classification', () => {
    const now = 100000;
    const attempt = { intent: { task: 'T1', at_utc: new Date(now).toISOString() }, processInfo: { pid: 9999 } };
    const osProcesses = [{ pid: 9999, name: 'agy.exe', created_at: new Date(now).toISOString() }];
    const res = evaluateWorkerState({ attempt, osProcesses, workerRole: 'W2', policy: { osFresh: false, osFreshness: 'STALE' }, now });
    assert.equal(res.status, 'UNKNOWN');
    assert.ok(res.blocker.includes('OS query expired/stale'));
  });

  it('9. Native success with missing or broken artifact JSON returns UNKNOWN with receipt inspection next', () => {
    const attempt = {
      intent: { task: 'T1' },
      hasArtifact: false,
      terminalInfo: { exit_code: 0, result: { status: 'SUCCESS' } }
    };
    const res = evaluateWorkerState({ attempt, workerRole: 'W2' });
    assert.equal(res.status, 'UNKNOWN');
    assert.ok(res.blocker.includes('工件缺失'));
    assert.equal(res.next, '檢查原生交件與交件收據');
  });

  it('10. Terminal missing exit_code returns UNKNOWN not FAILED or 0', () => {
    const attempt = { intent: { task: 'T1' }, terminalInfo: { error: null } };
    const res = evaluateWorkerState({ attempt, workerRole: 'W2' });
    assert.equal(res.status, 'UNKNOWN');
    assert.ok(res.blocker.includes('終端退出碼缺失'));
  });

  it('11. Old RUNNING worker with stale event > 90s is STALE, missing event is UNKNOWN', () => {
    const now = 200000;
    const attemptStale = {
      intent: { task: 'T1', at_utc: new Date(now - 120000).toISOString() },
      processInfo: { pid: 1111 },
      eventsSummary: { lastEventAt: new Date(now - 120000).toISOString() }
    };
    const osProcesses = [{ pid: 1111, name: 'agy.exe', created_at: new Date(now - 120000).toISOString() }];
    const resStale = evaluateWorkerState({ attempt: attemptStale, osProcesses, workerRole: 'W2', now });
    assert.equal(resStale.status, 'STALE');

    const attemptNoEvent = {
      intent: { task: 'T1', at_utc: null },
      processInfo: { pid: 1111 },
      eventsSummary: { lastEventAt: null }
    };
    const resNoEvent = evaluateWorkerState({ attempt: attemptNoEvent, osProcesses, workerRole: 'W2', now });
    assert.equal(resNoEvent.status, 'UNKNOWN');
  });

  it('12. Thread activity without OS proof marked as activity signal and excluded from active summary', () => {
    const home = deriveHomeOverview({
      config: { controllerThread: '01a1293a-a19d-7d00-a7da-f3241b63865e' },
      sources: { windows: { freshness: 'FRESH' } },
      workers: [{ id: 'thread-1', status: 'PENDING', model_evidence: 'REQUESTED_ONLY' }]
    });
    assert.equal(home.factoryOverview.activeWorkersCount, 0);
    assert.equal(home.factoryOverview.controller.activity, '活動訊號待OS核實');
  });

  it('13. Exact SHA CI PASSED does not grant canonical ACCEPTED status', () => {
    const home = deriveHomeOverview({
      tasks: [{ worker: 'GitHub Actions', status: 'COMPLETED', tests: 'SUCCESS', head: 'd3948660' }]
    });
    assert.equal(home.factoryOverview.canonical.status, 'NOT_ACCEPTED');
    assert.equal(home.factoryOverview.canonical.accepted, false);
  });

  it('14. W1 Human pause overrides policy automatic_dispatch=true in view', () => {
    const policy = { automatic_dispatch: true, humanW1Paused: true };
    const res = evaluateWorkerState({ attempt: {}, workerRole: 'W1', policy });
    assert.equal(res.status, 'PAUSED');
    assert.ok(res.blocker.includes('人類指令暫停'));
  });

  it('15. Summary excludes historical threads and failed attempts from genuinely active', () => {
    const workers = [
      { id: 'w-historical', status: 'COMPLETED', pid: null, model_evidence: 'HISTORICAL' },
      { id: 'w-failed', status: 'FAILED', pid: 555, model_evidence: 'HISTORICAL' },
      { id: 'w-live', status: 'RUNNING', pid: 777, model_evidence: 'OBSERVED_NATIVE_INIT' }
    ];
    const home = deriveHomeOverview({
      sources: { windows: { freshness: 'FRESH' } },
      workers
    });
    assert.equal(home.genuinelyActive.length, 1);
    assert.equal(home.genuinelyActive[0].id, 'w-live');
  });

  it('16. Homepage HTML contains five required Traditional Chinese headings and engineering details', () => {
    const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
    assert.ok(html.includes('工廠概況'));
    assert.ok(html.includes('真正在做'));
    assert.ok(html.includes('最近收到的交件')); // R4 boss label clarifies pending acceptance
    assert.ok(html.includes('需要您處理')); // no invented approval gate
    assert.ok(html.includes('資料是否最新')); // short boss label
    assert.ok(html.includes('工程明細'));
  });
});

describe('Actual Build Fault Fixtures & Strict Evidence Suite', () => {
  const now = new Date('2026-10-11T04:00:00Z').getTime();
  const iso = new Date(now).toISOString();
  const baseAttempt = {
    base: 'w2-fixture',
    at_utc: iso,
    intent: { task: 'w2-fixture', model: 'gemini-3.8-flash-high', at_utc: iso },
    processInfo: { pid: 9999, created_at: iso },
    eventsSummary: { lastEventAt: iso, nativeInitModel: 'gemini-3.8-flash-high' }
  };
  const osProc = { pid: 9999, name: 'agy.exe', created_at: iso };

  it('F1. Actual build with stale collected_at (now - 120s): worker-w2 and tasks cannot be RUNNING', () => {
    const staleIso = new Date(now - 120000).toISOString();
    const ctx = {
      now,
      config: { humanW1Paused: true, sourceTtls: { windows: 60 } },
      phaseAttempts: [baseAttempt],
      localLastRun: now,
      windowsData: {
        status: 'MONITORING',
        collected_at: staleIso,
        data: { collected_at: staleIso, processes: [osProc], scheduled_tasks: [], services: [], vms: [] }
      }
    };
    const state = buildDashboardState(ctx);
    const w2 = state.workers.find(w => w.id === 'worker-w2');
    assert.notEqual(w2?.status, 'RUNNING');
    const task = state.tasks.find(t => t.id.includes('w2-fixture'));
    if (task) assert.notEqual(task.status, 'RUNNING');
  });

  it('F2. Actual build with cached=true and error: worker and tasks cannot be RUNNING even with fresh timestamp', () => {
    const ctx = {
      now,
      config: { humanW1Paused: true, sourceTtls: { windows: 60 } },
      phaseAttempts: [baseAttempt],
      localLastRun: now,
      windowsData: {
        status: 'STALE',
        cached: true,
        error: 'query failed',
        collected_at: iso,
        data: { collected_at: iso, processes: [osProc], scheduled_tasks: [], services: [], vms: [] }
      }
    };
    const state = buildDashboardState(ctx);
    const w2 = state.workers.find(w => w.id === 'worker-w2');
    assert.notEqual(w2?.status, 'RUNNING');
  });

  it('F3. Freshness with error, non-cached, observed_at is NOT FRESH', () => {
    const res = evaluateFreshness({ error: 'denied', cached: false, observed_at: iso, ttl_seconds: 60, now });
    assert.notEqual(res, 'FRESH');
  });

  it('F4. Freshness with cached=true and no error is NOT FRESH', () => {
    const res = evaluateFreshness({ cached: true, observed_at: iso, ttl_seconds: 60, now });
    assert.notEqual(res, 'FRESH');
  });

  it('F5. Actual build with processes=[] and errors=["processes: denied"]: count is 未知 and source error contains denied and not FRESH', () => {
    const ctx = {
      now,
      config: { humanW1Paused: true, sourceTtls: { windows: 60 } },
      phaseAttempts: [baseAttempt],
      localLastRun: now,
      windowsData: {
        status: 'ERROR',
        collected_at: iso,
        data: {
          collected_at: iso,
          processes: [],
          errors: ['processes: denied'],
          scheduled_tasks: [],
          services: [],
          vms: []
        }
      }
    };
    const state = buildDashboardState(ctx);
    assert.equal(state.home.factoryOverview.activeWorkersCount, '未知');
    assert.ok(state.sources.windows.error && state.sources.windows.error.includes('denied'));
    assert.notEqual(state.sources.windows.freshness, 'FRESH');
  });

  it('F6. Invalid processInfo.created_at returns UNKNOWN', () => {
    const attempt = {
      intent: { task: 'T1' },
      processInfo: { pid: 9999, created_at: 'invalid-date' }
    };
    const res = evaluateWorkerState({ attempt, osProcesses: [osProc], now, workerRole: 'W2' });
    assert.equal(res.status, 'UNKNOWN');
  });

  it('F7. Missing processInfo.created_at and missing intent.at_utc returns UNKNOWN', () => {
    const attempt = {
      intent: { task: 'T1' },
      processInfo: { pid: 9999 }
    };
    const res = evaluateWorkerState({ attempt, osProcesses: [osProc], now, workerRole: 'W2' });
    assert.equal(res.status, 'UNKNOWN');
  });

  it('F8. Missing processInfo.created_at and invalid intent.at_utc returns UNKNOWN', () => {
    const attempt = {
      intent: { task: 'T1', at_utc: 'invalid-date' },
      processInfo: { pid: 9999 }
    };
    const res = evaluateWorkerState({ attempt, osProcesses: [osProc], now, workerRole: 'W2' });
    assert.equal(res.status, 'UNKNOWN');
  });

  it('F9. Invalid eventsSummary.lastEventAt returns UNKNOWN', () => {
    const attempt = {
      intent: { task: 'T1', at_utc: iso },
      processInfo: { pid: 9999, created_at: iso },
      eventsSummary: { lastEventAt: 'invalid-date' }
    };
    const res = evaluateWorkerState({ attempt, osProcesses: [osProc], now, workerRole: 'W2' });
    assert.equal(res.status, 'UNKNOWN');
  });

  it('F10. CI with STALE github source and mismatched candidateSha is not CI_PASSED_NON_CANONICAL', () => {
    const home = deriveHomeOverview({
      config: { candidateSha: 'a'.repeat(40) },
      sources: { github: { freshness: 'STALE' } },
      tasks: [{ worker: 'GitHub Actions', status: 'COMPLETED', tests: 'SUCCESS', head: 'b'.repeat(40) }]
    });
    assert.notEqual(home.factoryOverview.ciQualification.status, 'CI_PASSED_NON_CANONICAL');
  });

  it('F11. Canonical overview with no canonical readback has no R4 PR395 claim and references 快照', () => {
    const home = deriveHomeOverview({ config: {} });
    assert.ok(!home.factoryOverview.canonical.candidate.includes('PR395'));
    assert.ok(home.factoryOverview.canonical.reference.includes('快照'));
  });

  it('F12. deriveHomeOverview with humanW1Paused=true and attempt deniedActions yields humanTodos length 0', () => {
    const home = deriveHomeOverview({
      config: { humanW1Paused: true },
      attempts: [{ eventsSummary: { deniedActions: ['old denial'] } }]
    });
    assert.equal(home.humanTodos.length, 0);
  });

  it('F13. Actual build with malformed policy, round-status, handoffs JSON reports at least 3 distinct source errors not FRESH', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r4-allfail-'));
    fs.writeFileSync(path.join(tmpDir, 'controller-dispatch-policy.json'), '{ broken policy', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'round-status.json'), '{ broken round', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'monitor-ownership-and-handoffs.json'), '{ broken handoffs', 'utf8');

    const state = buildDashboardState({ config: { phase: tmpDir } });
    const errors = [
      state.sources.policy?.error,
      state.sources.roundStatus?.error,
      state.sources.handoffs?.error
    ].filter(Boolean);

    assert.ok(errors.length >= 3);
    assert.notEqual(state.sources.policy?.freshness, 'FRESH');
    assert.notEqual(state.sources.roundStatus?.freshness, 'FRESH');
    assert.notEqual(state.sources.handoffs?.freshness, 'FRESH');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});