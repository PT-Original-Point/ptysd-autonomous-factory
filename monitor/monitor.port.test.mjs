import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configuredListenPort, loadConfig, startupErrorCode } from './server.mjs';

test('monitor always uses the documented port when configuration is absent', () => {
  assert.equal(configuredListenPort({}), 2667);
  assert.equal(configuredListenPort(null), 2667);
  assert.equal(configuredListenPort({port: 2667}), 2667);
  assert.equal(configuredListenPort({port: 65535}), 65535);
});

test('invalid port fails explicitly rather than silently listening on port zero', () => {
  for (const port of [0, -1, 65536, NaN, Infinity, '2667', null, 1.5]) {
    assert.throws(() => configuredListenPort({ port }), /INVALID_MONITOR_PORT/);
  }
});

test('malformed local configuration is an explicit error and no secret is printed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptysd-monitor-config-'));
  try {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, '{ invalid json');
    assert.throws(() => loadConfig(file), e => e.message === 'INVALID_MONITOR_CONFIG_JSON');
    fs.writeFileSync(file, JSON.stringify({port:2667}));
    assert.equal(loadConfig(file).port,2667);
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('startup diagnostics use fixed codes and do not disclose provider secrets', () => {
  assert.equal(startupErrorCode(new Error('INVALID_MONITOR_CONFIG_JSON')),'INVALID_MONITOR_CONFIG_JSON');
  assert.equal(startupErrorCode(new Error('INVALID_MONITOR_PORT')),'INVALID_MONITOR_PORT');
  assert.equal(startupErrorCode(new Error('Bearer secret-token')),'UNKNOWN_MONITOR_STARTUP_ERROR');
});
