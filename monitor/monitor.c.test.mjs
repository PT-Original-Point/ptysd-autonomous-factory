import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import childProcess from 'node:child_process';
import { executeVmSsh, scanAutomations } from './server.mjs';

test('executeVmSsh: processes, timers, exit code reporting', async () => {
  const orig = childProcess.spawn;
  const fakeOut = ['Linux 6.1.0 x86_64 host','===PROCESSES===',' 101 dev agy-worker','===TIMERS===','Fri 2026-10-09 20:00:00 UTC 10m left test.timer test.service','===TIMERS_EXIT:0==='].join('\n');
  childProcess.spawn = () => {
    let closeCb, dataCb;
    return {
      stdout: { on: (ev, cb) => { if (ev === 'data') dataCb = cb; } },
      on: (ev, cb) => {
        if (ev === 'close') {
          closeCb = cb;
          setImmediate(() => { if (dataCb) dataCb(Buffer.from(fakeOut)); if (closeCb) closeCb(0); });
        }
      }
    };
  };
  try {
    const res = await executeVmSsh({ ssh: 'ssh', vmHost: '127.0.0.1', vmUser: 'dev', vmKey: '/k', vmKnownHosts: '/h' });
    assert.equal(res.status, 'MONITORING');
    assert.equal(res.data.timer_status, 'OK');
    assert.equal(res.data.timers.length, 1);
  } finally {
    childProcess.spawn = orig;
  }
});

test('scanAutomations: parses quoted cwds, maps status and bounded task', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mon-c-'));
  const ws = path.join(tmp, 'ws');
  const root = path.join(tmp, '.codex', 'automations');
  fs.mkdirSync(ws, { recursive: true });
  const d = path.join(root, 'job1');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'automation.toml'), `cwd = "${ws.replace(/\\/g, '/')}"\nstatus = "active"\nprompt = "sync task"`);
  try {
    const r = scanAutomations(root, ws);
    assert.equal(r.status, 'MONITORING');
    assert.equal(r.automations.length, 1);
    assert.equal(r.automations[0].status, 'MONITORING');
    assert.equal(r.automations[0].task, 'sync task');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
