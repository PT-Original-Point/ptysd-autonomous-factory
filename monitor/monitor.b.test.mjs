import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildDashboardState, mergeCollectorReadback, scanPairedAttempts } from './server.mjs';

test('mergeCollectorReadback handles success, stale cache preservation, and initial unknown failure', () => {
  const okResult = { status: 'MONITORING', data: { cpu: 12 }, collected_at: 1000 };
  assert.deepEqual(mergeCollectorReadback(null, okResult), okResult);

  const failNoPrev = mergeCollectorReadback(null, { status: 'FAILED', error: 'connect ECONNREFUSED' });
  assert.equal(failNoPrev.status, 'UNKNOWN');
  assert.equal(failNoPrev.data, null);
  assert.match(failNoPrev.error, /ECONNREFUSED/);

  const staleWindows = mergeCollectorReadback(
    { status: 'MONITORING', data: { processes: [123] }, collected_at: 2000 },
    { status: 'FAILED', error: 'powershell timeout', data: null }
  );
  assert.equal(staleWindows.status, 'STALE');
  assert.deepEqual(staleWindows.data, { processes: [123] });
  assert.equal(staleWindows.collected_at, 2000);
  assert.match(staleWindows.error, /timeout/);

  const staleGh = mergeCollectorReadback(
    { status: 'MONITORING', runs: [{ id: 456 }], collected_at: 3000 },
    { status: 'FAILED', error: 'gh rate limit' }
  );
  assert.equal(staleGh.status, 'STALE');
  assert.deepEqual(staleGh.runs, [{ id: 456 }]);
  assert.equal(staleGh.collected_at, 3000);
});

test('buildDashboardState controller unknown fallback, model_evidence, and excludes archived threads', () => {
  const ctx = {
    codexData: {
      threads: [
        { id: 't-archived-1', title: 'Archived 1', status: 'archived' },
        { id: 't-archived-2', title: 'Archived 2', status: 'idle', archived: true },
        { id: 't-active', title: 'Active Agent', status: 'RUNNING', cwd: '/work' },
        { id: 't-historical', title: 'Historical Agent', status: 'idle', cwd: '/work' }
      ]
    },
    config: {
      controllerThread: 'ctrl-missing',
      workspace: '/workspace'
    }
  };

  const state = buildDashboardState(ctx);
  const ctrl = state.workers.find(w => w.kind === 'controller');
  assert.ok(ctrl);
  assert.equal(ctrl.status, 'UNKNOWN');
  assert.equal(ctrl.model_evidence, 'HISTORICAL');

  assert.equal(state.workers.some(w => w.id === 't-archived-1'), false);
  assert.equal(state.workers.some(w => w.id === 't-archived-2'), false);

  const activeWorker = state.workers.find(w => w.id === 't-active');
  assert.ok(activeWorker);
  assert.equal(activeWorker.model_evidence, 'OBSERVED_NATIVE_INIT');

  const histWorker = state.workers.find(w => w.id === 't-historical');
  assert.ok(histWorker);
  assert.equal(histWorker.model_evidence, 'HISTORICAL');

  const w3 = state.workers.find(w => w.id === 'worker-w3');
  assert.ok(w3);
  assert.equal(w3.next, '等待日間人類操作者在場確認');

  const w2 = state.workers.find(w => w.id === 'worker-w2');
  assert.ok(w2);
  assert.match(w2.name, /Antigravity/);
});

test('nonworkerintentexcluded filters non-worker operational intents and avoids misattribution', () => {
  const ctx = {
    phaseAttempts: [
      {
        base: 'agy-update',
        intent: { action: 'update-environment' }
      },
      {
        base: 'audit-log',
        intent: { op: 'rotate' }
      },
      {
        base: 'round3-w1-repair',
        intent: {
          task: 'w1-construction',
          model: 'Step-2',
          effort: 'high'
        }
      }
    ],
    config: {
      workspace: '/workspace'
    }
  };

  const state = buildDashboardState(ctx);
  const w1 = state.workers.find(w => w.id === 'worker-w1');
  assert.ok(w1);
  assert.equal(w1.source, 'round3-w1-repair.intent.json');
  assert.equal(w1.reasoning, 'high');
});

test('source candidates strip R3- prefix, read actual receipts from phaseDir round-status.json, and detect head mismatch', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-test-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'round-status.json'), JSON.stringify({
      current_task: { controller: '優先調度控制器確認' },
      next_responsibility: [{ item: '次要責任' }],
      source_candidates: [
        { task: 'R3-D007', pr: 7, head: 'full-sha-d007' },
        { task: 'R3-D008', pr: 8, head: 'full-sha-d008' }
      ]
    }));

    fs.writeFileSync(path.join(tmpDir, 'd007-final-test-receipt.json'), JSON.stringify({
      green_exit: 0,
      green_test_count: 14
    }));
    fs.writeFileSync(path.join(tmpDir, 'd007-publication-readback.json'), JSON.stringify({
      url: 'https://example.com/pr/7',
      head: 'full-sha-d007',
      at_utc: '2026-10-09T14:47:36Z'
    }));

    fs.writeFileSync(path.join(tmpDir, 'd008-final-test-receipt.json'), JSON.stringify({
      green_exit: 0,
      green_pass_count: 8
    }));
    fs.writeFileSync(path.join(tmpDir, 'd008-publication-readback.json'), JSON.stringify({
      url: 'https://example.com/pr/8',
      head: 'mismatch-sha',
      at_utc: '2026-10-09T14:55:35Z'
    }));

    const ctx = {
      config: { phase: tmpDir }
    };

    const state = buildDashboardState(ctx);
    const ctrl = state.workers.find(w => w.kind === 'controller');
    assert.equal(ctrl.next, '優先調度控制器確認');

    const t7 = state.tasks.find(t => t.id === 'R3-D007');
    assert.ok(t7);
    assert.equal(t7.url, 'https://example.com/pr/7');
    assert.equal(t7.head, 'full-sha-d007');
    assert.equal(t7.tests, '14 passed');
    assert.equal(t7.updated_at, '2026-10-09T14:47:36Z');

    const t8 = state.tasks.find(t => t.id === 'R3-D008');
    assert.ok(t8);
    assert.equal(t8.url, 'https://example.com/pr/8');
    assert.equal(t8.head, 'UNKNOWN');
    assert.equal(t8.tests, '8 passed');
    assert.equal(t8.updated_at, '2026-10-09T14:55:35Z');
    assert.ok(state.alerts.some(a => a.includes('head mismatch')));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('scanPairedAttempts FS_MTIME fallback on timestamp-less events and separate active W2 cards', async () => {
  const tmpPhase = fs.mkdtempSync(path.join(os.tmpdir(), 'paired_attempts_test_'));
  try {
    const cache = new Map();
    const now = Date.now();

    fs.writeFileSync(path.join(tmpPhase, 'w2-job-1.intent.json'), JSON.stringify({
      task: '快取修復任務',
      model: 'Gemini 3.8 Flash High',
      effort: 'high',
      at_utc: new Date(now - 120000).toISOString()
    }));
    fs.writeFileSync(path.join(tmpPhase, 'w2-job-1.process.json'), JSON.stringify({
      pid: 1001,
      at_utc: new Date(now - 120000).toISOString()
    }));
    const evPath1 = path.join(tmpPhase, 'w2-job-1.events.jsonl');
    fs.writeFileSync(evPath1, '{"event":"init","init":{"model":"gemini-3.8-flash-high"}}\n{"event":"step_update","data":"in_progress"}\n');

    fs.writeFileSync(path.join(tmpPhase, 'w2-job-2.intent.json'), JSON.stringify({
      task: '架構重構任務',
      model: 'Gemini 3.8 Flash High',
      effort: 'medium',
      at_utc: new Date(now - 60000).toISOString()
    }));
    fs.writeFileSync(path.join(tmpPhase, 'w2-job-2.process.json'), JSON.stringify({
      pid: 1002,
      at_utc: new Date(now - 60000).toISOString()
    }));
    const evPath2 = path.join(tmpPhase, 'w2-job-2.events.jsonl');
    fs.writeFileSync(evPath2, '{"event":"init","init":{"model":"gemini-3.8-flash-high"}}\n{"event":"step_update","data":"compiling"}\n');

    const attempts1 = scanPairedAttempts(tmpPhase, cache);
    assert.equal(attempts1.length, 2);
    const att1 = attempts1.find(a => a.base === 'w2-job-1');
    assert.equal(att1.eventsSummary.eventTimeBasis, 'FS_MTIME');
    const initialMtime = att1.eventsSummary.lastEventAt;
    assert.ok(initialMtime);

    await new Promise(r => setTimeout(r, 20));
    fs.appendFileSync(evPath1, '{"event":"step_update","data":"more_progress"}\n');
    const attempts2 = scanPairedAttempts(tmpPhase, cache);
    const att1Updated = attempts2.find(a => a.base === 'w2-job-1');
    assert.equal(att1Updated.eventsSummary.eventTimeBasis, 'FS_MTIME');
    assert.notEqual(att1Updated.eventsSummary.lastEventAt, initialMtime);

    const ctx = {
      config: { phase: tmpPhase },
      phaseAttempts: attempts2,
      windowsData: {
        status: 'MONITORING',
        collected_at: new Date(now).toISOString(),
        processes: [
          { pid: 1001, name: 'agy.exe', exe: 'agy.exe', command: 'agy.exe', created_at: new Date(now - 120000).toISOString() },
          { pid: 1002, name: 'agy.exe', exe: 'agy.exe', command: 'agy.exe', created_at: new Date(now - 60000).toISOString() }
        ]
      },
      now
    };
    const state = buildDashboardState(ctx);

    const card1 = state.workers.find(w => w.id === 'worker-w2-w2-job-1');
    assert.ok(card1);
    assert.equal(card1.name, 'W2｜快取修復任務');
    assert.equal(card1.source, 'w2-job-1.events.jsonl (filesystem mtime)');
    assert.equal(card1.reasoning, 'high');

    const card2 = state.workers.find(w => w.id === 'worker-w2-w2-job-2');
    assert.ok(card2);
    assert.equal(card2.name, 'W2｜架構重構任務');
    assert.equal(card2.source, 'w2-job-2.events.jsonl (filesystem mtime)');
    assert.equal(card2.reasoning, 'medium');

    const aggregate = state.workers.find(w => w.id === 'worker-w2');
    assert.ok(aggregate);
    assert.match(aggregate.name, /Antigravity/);
  } finally {
    fs.rmSync(tmpPhase, { recursive: true, force: true });
  }
});
