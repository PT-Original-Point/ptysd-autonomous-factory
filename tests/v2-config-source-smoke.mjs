// OpenCode V2 Windows CLI source-discovery canary. Zero model calls.
// Confirms only that the scoped-writer project configuration is DISCOVERED;
// it does NOT claim a merged effective policy, permission enforcement or OS isolation.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { buildV2ScopedEditConfig, parseOpenCodeV2Version } from '../native-bridge/opencode-v2.mjs';

const configuredExe = process.env.PTYSD_CI_V2_EXE;
let exe = configuredExe;
if (!exe) {
  const prefix = process.env.PTYSD_CI_V2_PREFIX;
  assert.ok(typeof prefix === 'string' && prefix.length > 0, 'V2_PREFIX_REQUIRED');
  exe = join(prefix, 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe');
}
assert.ok(isAbsolute(exe), 'V2_EXE_MUST_BE_ABSOLUTE');
assert.ok(statSync(exe).isFile(), 'V2_EXE_MISSING');
const version = execFileSync(exe, ['--version'], {
  encoding: 'utf8', timeout: 5000, maxBuffer: 8192, windowsHide: true, shell: false,
});
assert.ok(parseOpenCodeV2Version(version), 'V2_EXE_VERSION_NOT_QUALIFIED');
const policies = [
  { action: 'tool.use', resource: 'shell:*', effect: 'deny' },
  { action: 'tool.use', resource: 'edit:*', effect: 'deny' },
  { action: 'tool.use', resource: 'subagent:*', effect: 'deny' },
  { action: 'tool.use', resource: 'external_directory:*', effect: 'deny' },
  { action: 'tool.use', resource: 'read:*.env', effect: 'deny' },
  { action: 'provider.use', resource: '*', effect: 'deny' },
];
const directory = mkdtempSync(join(tmpdir(), 'ptysd-v2-policy-'));
mkdirSync(join(directory, 'src'));
const cfg = buildV2ScopedEditConfig(directory, ['src/output.mjs']);
cfg.experimental = { policies };
try {
  writeFileSync(join(directory, 'opencode.json'), JSON.stringify(cfg));
  const childEnv = { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: 'true' };
  for (const key of ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_PERMISSION'])
    delete childEnv[key];
  const stdout = execFileSync(exe, ['debug', 'config'], {
    cwd: directory, env: childEnv, encoding: 'utf8', timeout: 18000, maxBuffer: 2 * 1024 * 1024,
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let sources;
  try { sources = JSON.parse(stdout.trim()); }
  catch { throw new Error('V2_DEBUG_CONFIG_SOURCE_LIST_NOT_JSON'); }
  // V2 'debug config' lists configuration SOURCES, not merged effective policy.
  assert.ok(Array.isArray(sources), 'V2_DEBUG_CONFIG_SOURCE_LIST_NOT_ARRAY');
  const wanted = join(directory, 'opencode.json').replaceAll('\\','/').toLowerCase();
  const containsProjectConfig = sources.some(entry =>
    typeof entry?.path === 'string' &&
    entry.path.replaceAll('\\','/').toLowerCase() === wanted);
  console.log('V2_DEBUG_CONFIG_SOURCE_COUNT=' + sources.length);
  console.log('V2_CLI_VERSION=' + parseOpenCodeV2Version(version));
  console.log('V2_DEBUG_CONFIG_SCOPED_WRITER_CONFIG_DISCOVERED=' + containsProjectConfig);
  assert.ok(containsProjectConfig, 'V2_PROJECT_CONFIG_SOURCE_NOT_DISCOVERED');
  // This does not inspect resolved policy, runtime permission hooks or OS sandbox.
  console.log('V2_PROJECT_CONFIG_SOURCE_DISCOVERY_PASS_NOT_EFFECTIVE_PERMISSION_PROOF');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
