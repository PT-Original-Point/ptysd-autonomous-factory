import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildDashboardState } from './server.mjs';

function createTempPhaseDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'w3-test-'));
}

function getW3Worker(dir, now, policy = { w3: 'HOST_VM_READONLY' }) {
  const state = buildDashboardState({
    config: { phase: dir, workspace: '/test/workspace' },
    policy,
    codexData: { threads: [], error: null },
    winData: {},
    vmData: {},
    now
  });
  return state.workers.find(w => w.id === 'worker-w3');
}

test('MissingUNKNOWN', () => {
  const dir = createTempPhaseDir();
  const w3 = getW3Worker(dir, new Date('2026-10-10T10:00:00.000Z'));
  assert.ok(w3);
  assert.strictEqual(w3.status, 'UNKNOWN');
});

test('goodRUNNING', () => {
  const dir = createTempPhaseDir();
  const receipt = {
    task_id: 'W3-R3-HOST-VM-READONLY-20261010',
    worker: 'W3',
    route: 'chatgpt-web/zero-risk',
    agent_id: 'agent-001',
    handoff: 'HUMAN_SENT_ZERO_RISK_CONNECTED',
    execution: 'RUNNING_NATIVE_TOOLS_OBSERVED',
    actual_tool_calls_observed: 4,
    at_utc: '2026-10-10T10:00:00.000Z',
    outcome: 'UNASSESSED'
  };
  fs.writeFileSync(path.join(dir, 'w3-host-vm-readonly.dispatch.json'), JSON.stringify(receipt));
  const w3 = getW3Worker(dir, new Date('2026-10-10T10:02:00.000Z'));
  assert.strictEqual(w3.status, 'RUNNING');
  assert.strictEqual(w3.model, 'chatgpt-web/zero-risk; Web model UNKNOWN');
  assert.strictEqual(w3.reasoning, null);
});

test('oldSTALE', () => {
  const dir = createTempPhaseDir();
  const receipt = {
    task_id: 'W3-R3-HOST-VM-READONLY-20261010',
    worker: 'W3',
    route: 'chatgpt-web/zero-risk',
    agent_id: 'agent-001',
    handoff: 'HUMAN_SENT_ZERO_RISK_CONNECTED',
    execution: 'RUNNING_NATIVE_TOOLS_OBSERVED',
    actual_tool_calls_observed: 4,
    at_utc: '2026-10-10T10:00:00.000Z',
    outcome: 'UNASSESSED'
  };
  fs.writeFileSync(path.join(dir, 'w3-host-vm-readonly.dispatch.json'), JSON.stringify(receipt));
  const w3 = getW3Worker(dir, new Date('2026-10-10T10:06:00.000Z'));
  assert.strictEqual(w3.status, 'STALE');
});

test('crossworkerUNKNOWN', () => {
  const dir = createTempPhaseDir();
  const receipt = {
    task_id: 'W3-R3-HOST-VM-READONLY-20261010',
    worker: 'W1',
    route: 'chatgpt-web/zero-risk',
    agent_id: 'agent-001',
    handoff: 'HUMAN_SENT_ZERO_RISK_CONNECTED',
    execution: 'RUNNING_NATIVE_TOOLS_OBSERVED',
    actual_tool_calls_observed: 4,
    at_utc: '2026-10-10T10:00:00.000Z',
    outcome: 'UNASSESSED'
  };
  fs.writeFileSync(path.join(dir, 'w3-host-vm-readonly.dispatch.json'), JSON.stringify(receipt));
  const w3 = getW3Worker(dir, new Date('2026-10-10T10:01:00.000Z'));
  assert.strictEqual(w3.status, 'UNKNOWN');
});

test('malformedUNKNOWN', () => {
  const dir = createTempPhaseDir();
  fs.writeFileSync(path.join(dir, 'w3-host-vm-readonly.dispatch.json'), '{ bad json');
  assert.strictEqual(getW3Worker(dir, new Date()).status, 'UNKNOWN');
});

test('timeoutBLOCKED', () => {
  const dir = createTempPhaseDir();
  const receipt = {
    task_id: 'W3-R3-HOST-VM-READONLY-20261010',
    worker: 'W3',
    route: 'chatgpt-web/zero-risk',
    agent_id: 'agent-001',
    handoff: 'TIMEOUT',
    execution: 'CONNECTED',
    actual_tool_calls_observed: 0,
    at_utc: '2026-10-10T10:00:00.000Z',
    outcome: 'UNASSESSED'
  };
  fs.writeFileSync(path.join(dir, 'w3-host-vm-readonly.dispatch.json'), JSON.stringify(receipt));
  const w3 = getW3Worker(dir, new Date('2026-10-10T10:01:00.000Z'));
  assert.strictEqual(w3.status, 'BLOCKED');
  assert.ok(w3.next.includes('貼上') || w3.next.toLowerCase().includes('paste'));
});

test('connectedonlynotRUNNING', () => {
  const dir = createTempPhaseDir();
  const receipt = {
    task_id: 'W3-R3-HOST-VM-READONLY-20261010',
    worker: 'W3',
    route: 'chatgpt-web/zero-risk',
    agent_id: 'agent-001',
    handoff: 'HUMAN_SENT_ZERO_RISK_CONNECTED',
    execution: 'CONNECTED',
    actual_tool_calls_observed: 0,
    at_utc: '2026-10-10T10:00:00.000Z',
    outcome: 'UNASSESSED'
  };
  fs.writeFileSync(path.join(dir, 'w3-host-vm-readonly.dispatch.json'), JSON.stringify(receipt));
  const w3 = getW3Worker(dir, new Date('2026-10-10T10:01:00.000Z'));
  assert.notStrictEqual(w3.status, 'RUNNING');
});
