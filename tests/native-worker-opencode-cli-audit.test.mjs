import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const installer = readFileSync(join(root, 'native-bridge', 'install.ps1'), 'utf8');
const auditStart = installer.indexOf("if ($Mode -eq 'Audit')");
const runOnceStart = installer.indexOf("if ($Mode -eq 'RunOnce')", auditStart);
const installStart = installer.indexOf("if ($Mode -eq 'Install')");
assert.notEqual(auditStart, -1);
assert.notEqual(runOnceStart, -1);
assert.notEqual(installStart, -1);
const auditBlock = installer.slice(auditStart, runOnceStart);
const installBlock = installer.slice(installStart);

test('Audit qualifies installed Desktop V2 through the shared Authenticode-aware resolver', () => {
  assert.match(installer, /function\s+Get-QualifiedOpenCodeV2\b/i);
  const helper = installer.slice(installer.indexOf('function Get-QualifiedOpenCodeV2'), auditStart);
  assert.match(helper, /qualifyOpenCodeV2\(process\.env,\s*true\)/);
  assert.match(helper, /--input-type=module/);
  assert.match(helper, /ConvertFrom-Json/);
  assert.match(auditBlock, /Get-QualifiedOpenCodeV2/);
  assert.match(auditBlock, /OPENCODE_V2_CLI_QUALIFIED/);
  assert.doesNotMatch(auditBlock, /opencode\.cmd=/i,
    'PATH aliases are not the qualification authority for a Desktop V2 installation');
});

test('Install probes the CLI with its pinned wrapper Node and never enables model execution', () => {
  const pinnedNode = installBlock.indexOf('$node = $nodeMatch.Groups[1].Value');
  const qualification = installBlock.indexOf('Get-QualifiedOpenCodeV2');
  assert.notEqual(pinnedNode, -1, 'Install extracts Node from the verified hidden wrapper');
  assert.ok(qualification > pinnedNode,
    'the shared resolver runs only after the wrapper Node path is verified');
  assert.doesNotMatch(installBlock, /Get-Command\s+\$candidate/i,
    'Install does not rely on PATH-only OpenCode aliases');
  assert.match(installBlock, /OPENCODE_V2_CLI_QUALIFIED/);
  assert.doesNotMatch(installBlock, /enable_(?:v2|antigravity|codex)_model_runs\s*=/i);
});
