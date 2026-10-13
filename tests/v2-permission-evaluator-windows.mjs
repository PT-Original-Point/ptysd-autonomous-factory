// One-shot GitHub Windows CI: use OpenCode V2 native API's PERMISSION EVALUATOR.
// This never sends model prompts, invokes tools, or reads credentials.
// It is NOT a test of experimental tool.use policy or an OS sandbox.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';

const prefix = process.env.PTYSD_CI_V2_PREFIX;
assert.ok(prefix, 'V2_PREFIX_REQUIRED');
const exe = join(prefix, 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe');
assert.ok(statSync(exe).isFile(), 'V2_NATIVE_EXE_NOT_FOUND');
const configDir = mkdtempSync(join(tmpdir(), 'ptysd-v2-permissions-'));
const config = {
  autoupdate: false, plugins: [], share: 'disabled',
  agents: {
    'ptysd-allow': { mode: 'primary', permissions: [
      { action: '*', resource: '*', effect: 'allow' },
    ] },
    'ptysd-deny': { mode: 'primary', permissions: [
      { action: '*', resource: '*', effect: 'allow' },
      { action: 'shell', resource: '*', effect: 'deny' },
      { action: 'edit', resource: '*', effect: 'deny' },
      { action: 'external_directory', resource: '*', effect: 'deny' },
    ] },
  },
};
writeFileSync(join(configDir, 'opencode.json'), JSON.stringify(config));
const env = { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: 'true' };
for (const key of ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT',
  'OPENCODE_PERMISSION', 'OPENCODE_AUTO_SHARE']) delete env[key];
// V2's native foreground API requires HTTP Basic Auth. Never use real credentials.
const ephemeralPassword = randomBytes(24).toString('hex');
env.OPENCODE_SERVER_PASSWORD = ephemeralPassword;
env.OPENCODE_SERVER_USERNAME = 'opencode';
const authHeader = 'Basic ' + Buffer.from('opencode:' + ephemeralPassword).toString('base64');

const port = await new Promise((resolvePort, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const p = server.address().port;
    server.close(() => resolvePort(p));
  });
});
const child = spawn(exe, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
  cwd: configDir, env, stdio: 'ignore', windowsHide: true,
});
const endpoint = 'http://127.0.0.1:' + port;

async function request(method, path, body) {
  const c = new AbortController();
  const timeout = setTimeout(() => c.abort(), 8000);
  try {
    const response = await fetch(endpoint + path, {
      method, headers: { 'content-type': 'application/json', authorization: authHeader },
      ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: c.signal,
    });
    let payload;
    try { payload = await response.json(); } catch { payload = null; }
    return { status: response.status, data: payload?.data ?? payload };
  } finally { clearTimeout(timeout); }
}
async function ready() {
  for (let i = 0; i < 65; i++) {
    if (child.exitCode !== null) throw new Error('V2_LOCAL_SERVER_EARLY_EXIT');
    try {
      const r = await request('GET', '/api/info');
      if (r.status === 200) return;
    } catch { /* process starting */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('V2_LOCAL_SERVER_NOT_READY');
}
async function effect(sessionID, agent, action, resource) {
  const response = await request('POST', '/api/session/' + encodeURIComponent(sessionID) + '/permission', {
    agent, action, resources: [resource], save: [], metadata: {},
  });
  if (response.status !== 200) throw new Error('V2_PERMISSION_API_HTTP_' + response.status);
  const effect = response.data?.effect;
  if (!['allow', 'deny', 'ask'].includes(effect)) throw new Error('V2_PERMISSION_INVALID_EFFECT');
  return effect;
}
try {
  await ready();
  const response = await request('POST', '/api/session', {
    agent: 'ptysd-allow', title: 'PTYSD ephemeral no-inference permission canary',
  });
  if (response.status !== 200) throw new Error('V2_SESSION_API_HTTP_' + response.status);
  const sessionID = response.data?.id;
  assert.ok(typeof sessionID === 'string' && sessionID.length > 0, 'V2_SESSION_ID_NOT_RETURNED');
  const cases = [
    ['shell', 'echo PTYSD_NO_EXECUTION'],
    ['edit', 'probe.txt'],
    ['external_directory', '../outside'],
  ];
  for (const [action, resource] of cases) {
    const yes = await effect(sessionID, 'ptysd-allow', action, resource);
    const no = await effect(sessionID, 'ptysd-deny', action, resource);
    console.log('V2_PERMISSION_' + action.toUpperCase() + '_CONTROL=' + yes + '_DENY=' + no);
    assert.equal(yes, 'allow', action + '_CONTROL_NOT_ALLOWED');
    assert.equal(no, 'deny', action + '_DENY_NOT_ENFORCED');
  }
  console.log('V2_NATIVE_PERMISSION_EVALUATOR_NEGATIVE_3_OF_3_PASS_ZERO_INFERENCE');
} finally {
  if (child.pid) {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      timeout: 5000, windowsHide: true, stdio: 'ignore',
    }); } catch { try { child.kill(); } catch { /* already exited */ } }
  }
  rmSync(configDir, { recursive: true, force: true });
}
