// Windows-hosted acceptance of the exact OpenCode V2 binary CLI surface.
// No provider login, no model requests, no shell interpolation, no secrets in logs.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { runV2Readiness } from '../native-bridge/v2-readiness.mjs';
import { safeErrorCode } from '../native-bridge/safe-error-code.mjs';

const prefix = process.env.PTYSD_CI_V2_PREFIX;
assert.ok(prefix, 'CI_PREFIX_REQUIRED');
const manifestPath = join(prefix, 'node_modules', '@opencode', 'cli', 'package.json');
assert.ok(existsSync(manifestPath), 'V2_MANIFEST_MISSING');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
assert.equal(manifest.name, '@opencode/cli');
assert.equal(manifest.version, '2.2.5');
const exe = join(prefix, 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe');
assert.ok(existsSync(exe), 'V2_NATIVE_EXE_MISSING');
const run = (args, timeout = 12000) => execFileSync(exe, args, {
  encoding: 'utf8', timeout, maxBuffer: 512 * 1024, windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
}).replace(/\x1B\[[0-9;]*m/g, '').trim();
const diagnosticCode = error => typeof error?.status === 'number'
  ? String(error.status) : safeErrorCode(error, 'UNKNOWN');
const version = run(['--version']);
assert.match(version, /^(?:opencode\s+)?v?2\.2\.5$/);
console.log('OPEN_CODE_V2_VERSION_AND_PACKAGE_PASS');
const probes = [
  ['auth-list-help', ['auth', 'list', '--help']],
  ['models-help', ['models', '--help']],
  ['agent-list-help', ['agent', 'list', '--help']],
  ['auth-list-json', ['auth', 'list', '--format', 'json']],
];
for (const [name, args] of probes) {
  try {
    const stdout = run(args);
    if (name === 'auth-list-json') {
      const parsed = JSON.parse(stdout);
      assert.ok(Array.isArray(parsed) || (parsed !== null && typeof parsed === 'object'));
      console.log(name + ':OK_VALID_JSON');
    } else {
      assert.ok(stdout.length > 10 && /usage|options|list|command/i.test(stdout), name + '_HELP_SHAPE');
      console.log(name + ':OK');
    }
  } catch (e) {
    console.log(name + ':FAILED_' + diagnosticCode(e));
    if (name !== 'auth-list-json') throw new Error(name + '_REQUIRED_FAILED');
  }
}
const optionalProbes = [
  ['models-list', ['models']],
  ['agent-list', ['agent', 'list']],
  ['debug-help', ['debug', '--help']],
];
for (const [name, args] of optionalProbes) {
  try {
    const stdout = run(args, 18000);
    // Never log raw provider credentials, model ownership or config content.
    console.log(name + ':EXIT_0_BYTES_' + Buffer.byteLength(stdout, 'utf8'));
  } catch (e) {
    console.log(name + ':BLOCKED_' + diagnosticCode(e));
  }
}
const metadata = runV2Readiness(exe, process.cwd());
assert.equal(metadata.inference_executed, false);
assert.equal(metadata.credential_values_collected, false);
assert.ok(metadata.auth && metadata.models);
console.log('ZERO_MODEL_READINESS_METADATA_ONLY_' + metadata.auth.status + '_' + metadata.models.status);
console.log('V2_CLI_ZERO_LLM_CONTRACT_SMOKE_FINISHED');
