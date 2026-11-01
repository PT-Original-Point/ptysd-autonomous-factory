// V5.3-R4: exact official OpenCode V2 provider policy negative canary.
// CLI metadata only; no inference, no login, no authenticated model calls.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const prefix = process.env.PTYSD_CI_V2_PREFIX;
assert.ok(prefix, 'V2_PREFIX_REQUIRED');
const exe = join(prefix, 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe');
assert.ok(statSync(exe).isFile(), 'V2_NATIVE_EXE_MISSING');
const root = mkdtempSync(join(tmpdir(), 'ptysd-v2-provider-deny-'));
const control = join(root, 'control'), blocked = join(root, 'blocked');
mkdirSync(control); mkdirSync(blocked);
const env = { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: 'true' };
for (const key of ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT',
  'OPENCODE_PERMISSION', 'OPENCODE_AUTO_SHARE']) delete env[key];
function run(dir, args) {
  const result = spawnSync(exe, args, {
    cwd: dir, env, timeout: 20000, encoding: 'utf8', maxBuffer: 1024 * 1024,
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw new Error('V2_CLI_TIMEOUT_OR_SPAWN_ERROR');
  if (result.status !== 0) throw new Error('V2_CLI_UNEXPECTED_EXIT_' + result.status);
  return result.stdout.replace(/\x1b\[[0-9;]*m/g, '').trim();
}
function confirmSource(dir) {
  const docs = JSON.parse(run(dir, ['debug', 'config']));
  assert.ok(Array.isArray(docs), 'DEBUG_CONFIG_IS_NOT_SOURCES');
  const expected = resolve(join(dir, 'opencode.json')).replaceAll('\\', '/').toLowerCase();
  assert.ok(docs.some(d => typeof d?.path === 'string' &&
    resolve(d.path).replaceAll('\\', '/').toLowerCase() === expected),
  'EXACT_PROJECT_CONFIG_NOT_DISCOVERED');
}
function modelCount(stdout) {
  const list = new Set();
  for (const line of stdout.split(/\r?\n/)) {
    const name = line.trim();
    if (/^[a-z][a-z0-9_-]{1,39}\/[A-Za-z0-9_.:/-]+$/.test(name)) list.add(name);
  }
  return list.size;
}
try {
  writeFileSync(join(control, 'opencode.json'), '{}\n');
  writeFileSync(join(blocked, 'opencode.json'), JSON.stringify({
    experimental: { policies: [{ action: 'provider.use', resource: '*', effect: 'deny' }] },
  }) + '\n');
  const ver = run(control, ['--version']);
  assert.match(ver, /^(?:opencode\s+)?v?2\.2\.5$/, 'WRONG_V2_VERSION');
  confirmSource(control); confirmSource(blocked);
  const normalCount = modelCount(run(control, ['models']));
  const deniedCount = modelCount(run(blocked, ['models']));
  // Output counts only; no provider/account names, API keys or catalog details.
  console.log('V2_POLICY_CATALOG_CONTROL_COUNT=' + normalCount);
  console.log('V2_POLICY_CATALOG_DENY_COUNT=' + deniedCount);
  assert.ok(normalCount > 0, 'CATALOG_BASELINE_NOT_TESTABLE');
  assert.equal(deniedCount, 0, 'PROVIDER_DENY_POLICY_NOT_ENFORCED_BY_MODELS');
  console.log('V2_PROVIDER_POLICY_DENY_ALL_APPLIED_ZERO_INFERENCE');
} finally {
  rmSync(root, { recursive: true, force: true });
}
