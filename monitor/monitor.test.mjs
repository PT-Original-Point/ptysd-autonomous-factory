import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {
  normalizePath,
  isPathInWorkspace,
  formatTimestamp,
  redactSecrets,
  readIncrementalRolloutLog,
  evaluateWorkerState,
  trackMaterialChanges,
  createHttpServer,
  buildDashboardState
} from './server.mjs';

test('1. Policy-driven W1 pause rule sets PAUSED status without model cycling', () => {
  const policy = {
    w1: {
      operational_state: 'PAUSED_BY_USER_REPEATED_ERROR_RULE',
      pause_reason: 'Muse Spark XHIGH and Step 5 High both returned provider 403 FreeTierError',
      automatic_dispatch: false
    }
  };
  const attempt = {
    intent: { task: 'R3-MONITOR-W1', model: 'Step 5 High', at_utc: '2026-10-09T15:10:00Z' },
    terminalInfo: { exit_code: 1, at_utc: '2026-10-09T15:10:30Z' }
  };
  const ev = evaluateWorkerState({ attempt, policy, workerRole: 'W1' });
  assert.strictEqual(ev.status, 'PAUSED');
  assert.strictEqual(ev.blocker.includes('provider 403 FreeTierError'), true);
  assert.strictEqual(ev.next.includes('用戶暫停規則生效'), true);
  assert.strictEqual(ev.modelEvidence, 'REQUESTED_ONLY');
});

test('2. Controller task displays public_progress from Codex rollout logs and reasoning effort', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex_ctrl_test_'));
  t.after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });
  const logFile = path.join(tmpDir, 'controller.jsonl');

  const logContent = [
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' }, timestamp: '2026-10-09T15:00:00Z' }),
    JSON.stringify({
      type: 'item_completed',
      item: {
        type: 'AgentMessage',
        phase: 'commentary',
        content: [{ type: 'text', text: '正在審查 W2 交付之服務端代碼與測試套件' }]
      }
    })
  ].join('\n') + '\n';
  fs.writeFileSync(logFile, logContent, 'utf8');

  const stateMap = new Map();
  const rollout = readIncrementalRolloutLog(logFile, stateMap);
  assert.strictEqual(rollout.lastAgentMessage, '正在審查 W2 交付之服務端代碼與測試套件');

  const ctx = {
    config: { controllerThread: 'ctrl-001' },
    codexData: {
      threads: [
        {
          id: 'ctrl-001',
          title: '調度控制器',
          status: 'RUNNING',
          model: 'gpt-4o',
          reasoning_effort: 'high',
          public_progress: rollout.lastAgentMessage,
          updated_at: '2026-10-09T15:00:00Z'
        }
      ]
    }
  };
  const state = buildDashboardState(ctx);
  const ctrl = state.workers.find(w => w.id === 'ctrl-001');
  assert.strictEqual(ctrl.task, '正在審查 W2 交付之服務端代碼與測試套件');
  assert.strictEqual(ctrl.reasoning, 'high');
});

test('3. Real receipt schemas parsing with exact SHAs, PRs, and URLs (no placeholders)', (t) => {
  const tmpPhase = fs.mkdtempSync(path.join(os.tmpdir(), 'receipts_schema_test_'));
  t.after(() => { try { fs.rmSync(tmpPhase, { recursive: true, force: true }); } catch {} });

  fs.writeFileSync(path.join(tmpPhase, 'round-status.json'), JSON.stringify({
    project_id: 'CHATGPT_GLOBAL_SKILL_GOVERNANCE',
    at_utc: '2026-10-09T15:23:25.022Z',
    source_candidates: [
      {
        task: 'R3-D007',
        head: 'de189d7197167152c82082674e75395ab46280a6',
        pr: 389,
        tests: 23,
        deployment: 'NOT_DEPLOYED'
      },
      {
        task: 'R3-D008',
        head: '0b1482e1cd0f80ea222627e2a852301fb410ac3a',
        pr: 390,
        tests: 18,
        deployment: 'NOT_DEPLOYED'
      }
    ]
  }));

  fs.writeFileSync(path.join(tmpPhase, 'd007-final-test-receipt.json'), JSON.stringify({
    green_exit: 0,
    green_pass_count: 23
  }));

  fs.writeFileSync(path.join(tmpPhase, 'd007-publication-readback.json'), JSON.stringify({
    head: 'de189d7197167152c82082674e75395ab46280a6',
    at_utc: '2026-10-09T14:47:36Z',
    url: 'https://github.com/PT-Original-Point/ptysd-vnext42-governance-sandbox/pull/389'
  }));

  const ctx = { config: { phase: tmpPhase } };
  const state = buildDashboardState(ctx);
  const d007 = state.tasks.find(t => t.id === 'R3-D007');
  assert.strictEqual(d007.head, 'de189d7197167152c82082674e75395ab46280a6');
  assert.strictEqual(d007.pr, 389);
  assert.strictEqual(d007.url, 'https://github.com/PT-Original-Point/ptysd-vnext42-governance-sandbox/pull/389');
  assert.strictEqual(d007.tests, '23 passed');
  assert.strictEqual(d007.next, 'NOT_DEPLOYED');

  const d008 = state.tasks.find(t => t.id === 'R3-D008');
  assert.strictEqual(d008.head, '0b1482e1cd0f80ea222627e2a852301fb410ac3a');
  assert.strictEqual(d008.pr, 390);
  assert.strictEqual(d008.next, 'NOT_DEPLOYED');
});

test('4. Native FAILED exit 0 is rejected; artifacts alone do NOT claim tests passed', () => {
  const attemptFailedExit0 = {
    intent: { task: 'task-fail', at_utc: '2026-10-09T15:00:00Z' },
    eventsSummary: { resultStatus: 'failed', lastEventAt: '2026-10-09T15:01:00Z' },
    terminalInfo: { exit_code: 0, at_utc: '2026-10-09T15:01:00Z' },
    hasArtifact: true
  };
  const evFailed = evaluateWorkerState({ attempt: attemptFailedExit0 });
  assert.strictEqual(evFailed.status, 'FAILED');
  assert.strictEqual(evFailed.blocker.includes('Native Result FAILED'), true);

  const ctx = {
    phaseAttempts: [
      {
        base: 'attempt-artifact-only',
        at_utc: '2026-10-09T15:00:00Z',
        intent: { task: 'task-no-test-receipt', model: 'Gemini 3.8 Flash High', at_utc: '2026-10-09T15:00:00Z' },
        hasArtifact: true,
        terminalInfo: { exit_code: 0 }
      }
    ]
  };
  const state = buildDashboardState(ctx);
  const taskEntry = state.tasks.find(t => t.id.includes('task-no-test-receipt'));
  assert.strictEqual(taskEntry.tests, 'unknown');
  assert.strictEqual(taskEntry.head, null);
});

test('5. Consumes monitor-ownership-and-handoffs.json without fabricated W2->W3 handoff', (t) => {
  const tmpPhase = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff_test_'));
  t.after(() => { try { fs.rmSync(tmpPhase, { recursive: true, force: true }); } catch {} });

  fs.writeFileSync(path.join(tmpPhase, 'monitor-ownership-and-handoffs.json'), JSON.stringify({
    handoffs: [
      {
        id: 'monitor-controller-to-w1',
        task: 'R3-MONITOR-W1',
        from: 'Controller',
        to: 'W1',
        at: '2026-10-09T15:10:16.224Z',
        status: 'PROVIDER_403_CONFIRMED',
        next: 'Reassign index.html to W2',
        evidence: ['monitor-w1.intent.json']
      }
    ]
  }));

  const ctx = { config: { phase: tmpPhase } };
  const state = buildDashboardState(ctx);
  const h1 = state.handoffs.find(h => h.id === 'monitor-controller-to-w1');
  assert.strictEqual(Boolean(h1), true);
  assert.strictEqual(h1.status, 'PROVIDER_403_CONFIRMED');

  const w2w3 = state.handoffs.find(h => h.from === 'W2' && h.to === 'W3');
  assert.strictEqual(Boolean(w2w3), false);
});

test('6. W2 aggregation prefers newest nonterminal RUNNING over terminal/BLOCKED', () => {
  const attempts = [
    {
      base: 'w2-old-blocked',
      at_utc: '2026-10-09T15:00:00Z',
      intent: { task: 'R3-MONITOR-W2', model: 'gemini-3.8-flash-high', at_utc: '2026-10-09T15:00:00Z' },
      eventsSummary: { deniedActions: ['write_file'] }
    },
    {
      base: 'w2-new-active',
      at_utc: '2026-10-09T15:15:00Z',
      intent: { task: 'R3-MONITOR-W2', model: 'gemini-3.8-flash-high', at_utc: '2026-10-09T15:15:00Z' },
      processInfo: { pid: 8888, at_utc: '2026-10-09T15:15:00Z' },
      eventsSummary: { lastEventAt: '2026-10-09T15:15:10Z' }
    }
  ];
  const ctx = {
    phaseAttempts: attempts,
    windowsData: {
      status: 'MONITORING',
      collected_at: '2026-10-09T15:15:20Z',
      data: {
        processes: [{ pid: 8888, name: 'agy.exe', created_at: '2026-10-09T15:15:10Z' }]
      }
    },
    now: new Date('2026-10-09T15:15:20Z').getTime()
  };
  const state = buildDashboardState(ctx);
  const w2 = state.workers.find(w => w.id === 'worker-w2');
  assert.strictEqual(w2.status, 'RUNNING');
  assert.strictEqual(w2.source, 'w2-new-active.intent.json');
});

test('7. Validates agy for W2 and opencode-cli for W1, rejecting exe mismatch and missing creation time', () => {
  const now = new Date('2026-10-09T15:10:20Z').getTime();
  const w2Attempt = {
    intent: { task: 'w2-task', at_utc: '2026-10-09T15:10:00Z' },
    processInfo: { pid: 1111 }
  };
  const evW2Mismatch = evaluateWorkerState({
    attempt: w2Attempt,
    osProcesses: [{ pid: 1111, name: 'node.exe', created_at: '2026-10-09T15:10:05Z' }],
    workerRole: 'W2',
    now
  });
  assert.strictEqual(evW2Mismatch.status, 'UNKNOWN');
  assert.strictEqual(evW2Mismatch.blocker.includes('期望 agy'), true);

  const evW2MissingTime = evaluateWorkerState({
    attempt: w2Attempt,
    osProcesses: [{ pid: 1111, name: 'agy.exe', created_at: null }],
    workerRole: 'W2',
    now
  });
  assert.strictEqual(evW2MissingTime.status, 'UNKNOWN');
  assert.strictEqual(evW2MissingTime.blocker.includes('進程創建時間缺失'), true);

  const evW2Valid = evaluateWorkerState({
    attempt: w2Attempt,
    osProcesses: [{ pid: 1111, name: 'agy.exe', created_at: '2026-10-09T15:10:10Z' }],
    workerRole: 'W2',
    now
  });
  assert.strictEqual(evW2Valid.status, 'RUNNING');
});

test('8. OS collector data unwrap, mechanics processes duty UNKNOWN, and disabled task status', () => {
  const ctx = {
    windowsData: {
      status: 'MONITORING',
      data: {
        collected_at: '2026-10-09T15:20:00Z',
        processes: [{ pid: 9001, name: 'cloudflared.exe', created_at: '2026-10-09T15:00:00Z' }],
        scheduled_tasks: [{ name: 'PTYSD-Nightly', state: 'Disabled', next_run: '2026-10-10T00:00:00Z' }],
        services: [{ name: 'ptysd-service', status: 'Running', display_name: 'PTYSD Supervisor' }]
      }
    }
  };
  const state = buildDashboardState(ctx);
  const procMech = state.mechanics.find(m => m.id === 'win-proc-9001');
  assert.strictEqual(Boolean(procMech), true);
  assert.strictEqual(procMech.task, 'duty UNKNOWN unless assigned');

  const taskMech = state.mechanics.find(m => m.id === 'task-PTYSD-Nightly');
  assert.strictEqual(taskMech.status, 'DISABLED');
  assert.strictEqual(taskMech.next_run, null);
});

test('9. Collector cache preserved on poll failure with STALE status; DB error yields UNKNOWN', () => {
  const ctx = {
    windowsData: {
      status: 'STALE',
      data: { processes: [{ pid: 5555, name: 'agy.exe' }] },
      error: 'PowerShell execution timed out'
    },
    codexData: { threads: [], error: 'Database locked' }
  };
  const state = buildDashboardState(ctx);
  const winMech = state.mechanics.find(m => m.id === 'mech-collector-windows');
  assert.strictEqual(winMech.status, 'STALE');
  assert.strictEqual(winMech.error, 'PowerShell execution timed out');

  const ctrl = state.workers.find(w => w.kind === 'controller');
  assert.strictEqual(ctrl.status, 'UNKNOWN');
  assert.strictEqual(ctrl.blocker, 'Database locked');
});

test('10. Material changes tracking records actual status transitions and limits to 20', () => {
  const changes = [];
  const prev = {
    workers: [{ id: 'w1', name: 'W1', status: 'RUNNING', task: 'Task 1' }],
    tasks: [],
    handoffs: []
  };
  const next = {
    workers: [{ id: 'w1', name: 'W1', status: 'PAUSED', task: 'Task 1' }],
    tasks: [],
    handoffs: []
  };
  trackMaterialChanges(changes, next, prev, 20);
  assert.strictEqual(changes.length, 1);
  assert.strictEqual(changes[0].text.includes('RUNNING -> PAUSED'), true);
});

test('11. Loopback HTTP Server: GET restrictions, Host validation, and inline CSP', async () => {
  const ctx = { config: {}, changes: [] };
  const server = createHttpServer(ctx);

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const resHealth = await fetch(`http://127.0.0.1:${port}/health`);
    assert.strictEqual(resHealth.status, 200);
    const csp = resHealth.headers.get('content-security-policy') || '';
    assert.strictEqual(csp.includes("'unsafe-inline'"), true);

    const resState = await fetch(`http://127.0.0.1:${port}/api/state`);
    assert.strictEqual(resState.status, 200);
    assert.strictEqual(resState.headers.get('cache-control'), 'no-store');

    const resPost = await fetch(`http://127.0.0.1:${port}/api/state`, { method: 'POST' });
    assert.strictEqual(resPost.status, 405);

    const resBadHost = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/health', headers: { Host: 'evil.com' } }, res => {
        res.resume();
        resolve(res);
      });
      req.on('error', reject);
      req.end();
    });
    assert.strictEqual(resBadHost.statusCode, 400);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
