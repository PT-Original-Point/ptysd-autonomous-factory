import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { buildDashboardState } from './server.mjs';

const withPhase = fn => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w3-cc-'));
  try { return fn(dir); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
};

const getW3 = (dir, now = new Date('2026-10-10T10:00:00Z')) =>
  buildDashboardState({ config: { phase: dir, workspace: dir }, codexData: { threads: [] }, winData: {}, vmData: {}, now })
    .workers.find(w => w.id === 'worker-w3');

const setup = (dir, overrideRcp = {}, overrideRev = {}) => {
  const rcpPath = path.join(dir, 'W3-R3-HOST-VM-READONLY-20261010.json');
  const rcpObj = {
    task_id: 'W3-R3-HOST-VM-READONLY-20261010', worker: 'W3', agent_id: '01a1232c-8460-7492-ae41-130e4e689576',
    T15: { status: 'UNKNOWN' }, T23: { status: 'UNKNOWN' }, T24: { status: 'NOT_PASSED' },
    ...overrideRcp
  };
  const rcpContent = JSON.stringify(rcpObj);
  fs.writeFileSync(rcpPath, rcpContent);
  const sha = crypto.createHash('sha256').update(rcpContent).digest('hex');

  const revObj = {
    task_id: 'W3-R3-HOST-VM-READONLY-20261010', worker: 'W3', agent_id: '01a1232c-8460-7492-ae41-130e4e689576',
    outcome: 'ACCEPTED_BOUNDED_READONLY_EVIDENCE',
    acceptance: { T15: 'UNKNOWN', T23: 'UNKNOWN', T24: 'NOT_PASSED' },
    files: [{ path: rcpPath, size: rcpContent.length, sha256: sha }],
    ...overrideRev
  };
  fs.writeFileSync(path.join(dir, 'w3-host-vm-readonly.controller-review.json'), JSON.stringify(revObj));

  const d = {
    worker: 'W3', route: 'chatgpt-web/zero-risk', agent_id: '01a1232c-8460-7492-ae41-130e4e689576',
    task_id: 'W3-R3-HOST-VM-READONLY-20261010', at_utc: '2026-10-10T10:00:00Z',
    execution: 'TERMINAL_SOURCE_EVIDENCE_RETURNED', outcome: 'COMPLETED',
    next: 'W2監控修復;Controller既有SSH收據讀回;Human權限受阻',
    result: {
      task_id: 'W3-R3-HOST-VM-READONLY-20261010', receipt_path: rcpPath, receipt_sha256: sha,
      controller_review: 'w3-host-vm-readonly.controller-review.json',
      controller_verdict: 'ACCEPTED_BOUNDED_READONLY_EVIDENCE',
      acceptance: { T15: 'UNKNOWN', T23: 'UNKNOWN', T24: 'NOT_PASSED' }
    }
  };
  fs.writeFileSync(path.join(dir, 'w3-host-vm-readonly.dispatch.json'), JSON.stringify(d));
  return { d, rcpPath, sha };
};

test('goodaccepted', () => withPhase(dir => {
  const { d } = setup(dir);
  const w = getW3(dir);
  assert.strictEqual(w.status, 'COMPLETED');
  assert.strictEqual(w.blocker, null);
  assert.strictEqual(w.next, d.next);
  assert.ok(/bounded readonly/i.test(w.task));
  assert.ok(/T15\/T23 UNKNOWN/i.test(w.task) || (/T15/i.test(w.task) && /T23/i.test(w.task) && /UNKNOWN/i.test(w.task)));
  assert.ok(/T24 NOT_PASSED/i.test(w.task));
}));

test('missingresult', () => withPhase(dir => {
  const { d } = setup(dir);
  delete d.result;
  fs.writeFileSync(path.join(dir, 'w3-host-vm-readonly.dispatch.json'), JSON.stringify(d));
  assert.strictEqual(getW3(dir).status, 'UNKNOWN');
}));

test('wrongtaskreview', () => withPhase(dir => {
  setup(dir, {}, { task_id: 'WRONG-TASK-ID' });
  assert.strictEqual(getW3(dir).status, 'UNKNOWN');
}));

test('outsidephase', () => withPhase(dir => {
  const { d } = setup(dir);
  d.result.receipt_path = path.resolve(dir, '../escaped.json');
  fs.writeFileSync(path.join(dir, 'w3-host-vm-readonly.dispatch.json'), JSON.stringify(d));
  assert.strictEqual(getW3(dir).status, 'UNKNOWN');
}));

test('tamperedhash', () => withPhase(dir => {
  const { d } = setup(dir);
  d.result.receipt_sha256 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  fs.writeFileSync(path.join(dir, 'w3-host-vm-readonly.dispatch.json'), JSON.stringify(d));
  assert.strictEqual(getW3(dir).status, 'UNKNOWN');
}));

test('tamperedreceiptacceptance', () => withPhase(dir => {
  setup(dir, { T15: { status: 'PASSED' } });
  assert.strictEqual(getW3(dir).status, 'UNKNOWN');
}));

test('tamperedreviewacceptance', () => withPhase(dir => {
  setup(dir, {}, { acceptance: { T15: 'PASSED', T23: 'UNKNOWN', T24: 'NOT_PASSED' } });
  assert.strictEqual(getW3(dir).status, 'UNKNOWN');
}));

test('frozenPreserved', () => withPhase(dir => {
  assert.strictEqual(getW3(dir).status, 'UNKNOWN');
  fs.writeFileSync(path.join(dir, 'w3-host-vm-readonly.dispatch.json'), JSON.stringify({
    worker: 'W3', route: 'chatgpt-web/zero-risk', agent_id: 'a1', task_id: 'W3-R3-HOST-VM-READONLY-20261010',
    at_utc: '2026-10-10T10:00:00Z', handoff: 'HUMAN_SENT_ZERO_RISK_CONNECTED', execution: 'CONNECTED', actual_tool_calls_observed: 0
  }));
  const w = getW3(dir);
  assert.notStrictEqual(w.status, 'RUNNING');
  assert.strictEqual(w.kind, 'human');
  assert.strictEqual(w.pid, null);
}));
