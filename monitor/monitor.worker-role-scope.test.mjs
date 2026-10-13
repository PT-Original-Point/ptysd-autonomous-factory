import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attemptOwner, buildDashboardState } from './server.mjs';

const PREFIX = 'mon-role-';

function safeCleanup(target) {
  if (!target) return;
  const realTarget = fs.realpathSync(target);
  const realTmp = fs.realpathSync(os.tmpdir());
  if (path.dirname(realTarget) === realTmp && path.basename(realTarget).startsWith(PREFIX)) {
    fs.rmSync(realTarget, { recursive: true, force: true });
  }
}

test('attemptOwner: pure unit tests for W1, W2, unknown and conflicting signals', () => {
  const w2Repair = {
    intent: { task: 'R3-W1-BOUNDED-API', model: 'gemini-2.5-flash' },
    eventsSummary: { nativeInitModel: 'gemini-2.5-flash' }
  };
  assert.equal(attemptOwner(w2Repair), 'W2');

  const museCanary = {
    intent: { task: 'MUSE-VERIFY', model: 'muse-xhigh' },
    eventsSummary: { nativeInitModel: 'muse-xhigh' }
  };
  assert.equal(attemptOwner(museCanary), 'W1');

  const conflict = {
    intent: { model: 'gemini-2.5-flash' },
    eventsSummary: { nativeInitModel: 'muse-xhigh' }
  };
  assert.equal(attemptOwner(conflict), 'UNKNOWN');

  const explicitW1 = {
    intent: { model: 'custom-unrecognized', to: 'W1' }
  };
  assert.equal(attemptOwner(explicitW1), 'W1');

  const unrec = { intent: { model: 'custom-unrecognized' } };
  assert.equal(attemptOwner(unrec), 'UNKNOWN');

  assert.equal(attemptOwner(null), 'UNKNOWN');
});

test('buildDashboardState: w1 pause and w2 repair worker role attribution', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  try {
    const policyPath = path.join(root, 'controller-dispatch-policy.json');
    fs.writeFileSync(policyPath, JSON.stringify({
      w1: { automatic_dispatch: false, pause_reason: 'humanpause', allowed_construction_models: ['OpenCode'] }
    }), 'utf8');

    const now = Date.now();
    const ctx = {
      config: { phase: root, workspace: root, controllerThread: 'test' },
      now,
      codexData: { threads: [] },
      windowsData: { processes: [] },
      vmData: { data: {} },
      githubData: { runs: [] },
      phaseAttempts: [
        {
          base: 'att-w1',
          intent: { task: 'T-W1', model: 'muse-xhigh', at_utc: new Date(now).toISOString() },
          eventsSummary: { nativeInitModel: 'muse-xhigh', resultStatus: 'SUCCESS' },
          processInfo: null,
          terminalInfo: { exit_code: 0 },
          hasArtifact: true
        },
        {
          base: 'att-w2',
          intent: { task: 'R3-W1-BOUNDED-API', model: 'gemini-2.5-flash', at_utc: new Date(now).toISOString() },
          eventsSummary: { nativeInitModel: 'gemini-2.5-flash', resultStatus: 'SUCCESS' },
          processInfo: null,
          terminalInfo: { exit_code: 0 },
          hasArtifact: true
        }
      ]
    };

    const state = buildDashboardState(ctx);
    const w1Worker = state.workers?.find(w => w.id === 'worker-w1');
    const w2Worker = state.workers?.find(w => w.id === 'worker-w2');
    assert.ok(w1Worker, 'worker-w1 must exist');
    assert.ok(w2Worker, 'worker-w2 must exist');
    assert.equal(w1Worker.name, '施工工作者 W1 (OpenCode)');

    const taskW1 = state.tasks?.find(t => t.id.startsWith('att-w1-'));
    const taskW2 = state.tasks?.find(t => t.id.startsWith('att-w2-'));
    assert.equal(taskW1?.worker, 'worker-w1');
    assert.equal(taskW2?.worker, 'worker-w2');
  } finally {
    safeCleanup(root);
  }
});
