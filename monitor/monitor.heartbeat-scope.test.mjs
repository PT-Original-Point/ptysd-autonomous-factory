import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanAutomations } from './server.mjs';

const PREFIX = 'mon-hb-test-';

function safeCleanup(target) {
  if (!target) return;
  const realTarget = fs.realpathSync(target);
  const realTmp = fs.realpathSync(os.tmpdir());
  if (path.dirname(realTarget) === realTmp && path.basename(realTarget).startsWith(PREFIX)) {
    fs.rmSync(realTarget, { recursive: true, force: true });
  }
}

test('scanAutomations: heartbeat thread scoping and cwd coexistence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  const ws = path.join(root, 'workspace');
  const foreign = path.join(root, 'foreign');
  const auto = path.join(root, 'automations');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(foreign, { recursive: true });
  fs.mkdirSync(auto, { recursive: true });

  const mk = (name, toml) => {
    const d = path.join(auto, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'automation.toml'), toml, 'utf8');
  };

  try {
    mk('hb-match', 'kind = "heartbeat"\ntarget_thread_id = "thread-123"\nstatus = "ACTIVE"');
    mk('hb-wrong', 'kind = "heartbeat"\ntarget_thread_id = "thread-other"\nstatus = "ACTIVE"');
    mk('hb-foreign-cwd', `kind = "heartbeat"\ntarget_thread_id = "thread-123"\ncwd = "${foreign}"\nstatus = "ACTIVE"`);
    mk('cron-cwd', `cwd = "${ws}"\nstatus = "ACTIVE"`);

    const resMatch = scanAutomations(auto, ws, 'thread-123');
    const namesMatch = resMatch.automations.map(a => a.name).sort();
    assert.deepEqual(namesMatch, ['cron-cwd', 'hb-match']);
    assert.equal(resMatch.status, 'MONITORING');

    const hbItem = resMatch.automations.find(a => a.name === 'hb-match');
    assert.equal(hbItem.status, 'MONITORING');

    const resNoExpected = scanAutomations(auto, ws);
    assert.deepEqual(resNoExpected.automations.map(a => a.name), ['cron-cwd']);

    const resEmptyThread = scanAutomations(auto, ws, '');
    assert.deepEqual(resEmptyThread.automations.map(a => a.name), ['cron-cwd']);

    const resWrong = scanAutomations(auto, ws, 'thread-unknown');
    assert.deepEqual(resWrong.automations.map(a => a.name), ['cron-cwd']);
  } finally {
    safeCleanup(root);
  }
});
