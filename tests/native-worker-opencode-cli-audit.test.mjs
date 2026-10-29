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

test('RefreshRuntimeModules preserves lane authorization, config, task definition, and W2 claims/receipts without model invocation', () => {
  const refreshModeStart = installer.indexOf("if ($Mode -eq 'RefreshRuntimeModules')");
  assert.notEqual(refreshModeStart, -1, 'RefreshRuntimeModules mode is declared');
  assert.ok(runOnceStart < refreshModeStart && refreshModeStart < installStart,
    'RefreshRuntimeModules mode is declared between RunOnce and Install');
  const refreshModeBlock = installer.slice(refreshModeStart, installStart);

  // 1. Refresh mode delegates to Invoke-WorkerRuntimeRefresh and returns without falling through to Install or RunOnce
  assert.match(refreshModeBlock, /Invoke-WorkerRuntimeRefresh/,
    'RefreshRuntimeModules mode delegates to Invoke-WorkerRuntimeRefresh');
  assert.match(refreshModeBlock, /Invoke-WorkerRuntimeRefresh\s*\r?\n\s*return\b/,
    'RefreshRuntimeModules mode returns immediately without falling through');
  assert.doesNotMatch(refreshModeBlock, /\b(?:Install|RunOnce)\b/i,
    'RefreshRuntimeModules mode does not fall through to Install or RunOnce');

  const refreshFnStart = installer.indexOf('function Invoke-WorkerRuntimeRefresh');
  const refreshFnEnd = installer.indexOf('function Require-Command', refreshFnStart);
  assert.notEqual(refreshFnStart, -1, 'Invoke-WorkerRuntimeRefresh function is defined');
  assert.notEqual(refreshFnEnd, -1, 'Invoke-WorkerRuntimeRefresh boundary is defined');
  const refreshFn = installer.slice(refreshFnStart, refreshFnEnd);

  // 2. Runtime replacement is limited to the pinned runtime module list;
  // does not publish config.json, change model-execution flags, register/unregister tasks,
  // or write/delete W2 manifests, claims, results, or receipts.
  assert.match(refreshFn, /foreach\s*\(\$file\s+in\s+\$runtimeFiles\)[\s\S]*?\$changedNames\.Add\(\$file\)/,
    'replacements are strictly collected from the pinned runtimeFiles list');
  assert.match(refreshFn, /foreach\s*\(\$file\s+in\s+\$changedNames\)[\s\S]*?Write-WorkerRuntimeAtomicReplacement\s+\$module\.SourceBytes\s+\$module\.TargetPath/i,
    'atomic replacement is limited to changed modules from the pinned runtimeFiles list');
  assert.doesNotMatch(refreshFn, /Copy-Item\b/i,
    'refresh does not perform raw file copies');
  assert.doesNotMatch(refreshFn, /Write-WorkerConfigAtomically/i,
    'refresh does not publish config.json via the atomic config writer');
  assert.doesNotMatch(refreshFn, /Merge-WorkerConfig/i,
    'refresh does not rewrite or merge worker config');
  assert.doesNotMatch(refreshFn, /\[IO\.File\]::Write/i,
    'refresh does not perform ad-hoc file writes');
  assert.doesNotMatch(refreshFn, /enable_(?:v2|antigravity|codex)_model_runs\s*=/i,
    'refresh does not set model execution flags');
  assert.doesNotMatch(refreshFn, /\bmodel_runs\b/i,
    'refresh does not manipulate model run settings');
  assert.doesNotMatch(refreshFn, /\b(?:Register|Unregister)-ScheduledTask\b/i,
    'refresh does not register or unregister the scheduled task');
  assert.match(refreshFn, /Disable-ScheduledTask\s+-TaskName\s+\$taskName/i,
    'refresh temporarily pauses dispatcher via Disable-ScheduledTask');
  assert.match(refreshFn, /Enable-ScheduledTask\s+-TaskName\s+\$taskName/i,
    'refresh re-enables dispatcher via Enable-ScheduledTask');
  assert.doesNotMatch(refreshFn, /(?:claims|receipts|results)[\/\\]/i,
    'refresh does not access claims, receipts, or results directories');
  assert.doesNotMatch(refreshFn, /Remove-Item[\s\S]*?(?:manifest|claim|result|receipt)/i,
    'refresh does not delete manifests, claims, results, or receipts');
  assert.doesNotMatch(refreshFn, /writeReceipt|PTYSD_NATIVE_RECEIPT/i,
    'refresh does not emit W2 receipts');

  // 3. Reads and verifies pre-refresh config hash and Task Scheduler definition, and checks unchanged state on success or during rollback
  assert.match(refreshFn, /\$initialTaskDefinitionSha256\s*=\s*\$taskReadback\.DefinitionSha256/,
    'refresh reads and captures pre-refresh Task Scheduler definition hash');
  assert.match(refreshFn, /\$initialConfigSha256\s*=\s*Get-WorkerRuntimeFileSha256\s+\$configPath/,
    'refresh reads and captures pre-refresh config.json hash');
  assert.match(refreshFn, /task_definition_sha256\s*=\s*\$initialTaskDefinitionSha256/,
    'refresh records pre-refresh task definition hash into prestate.json');
  assert.match(refreshFn, /config_sha256\s*=\s*\$initialConfigSha256/,
    'refresh records pre-refresh config hash into prestate.json');

  // Success path invariant checks
  assert.match(refreshFn, /Get-WorkerRuntimeFileSha256\s+\$configPath\)\s+-cne\s+\$initialConfigSha256[\s\S]*?'WORKER_RUNTIME_CONFIG_CHANGED_BEFORE_DISABLE'/,
    'refresh verifies config hash unchanged before disabling task');
  assert.match(refreshFn, /Get-WorkerRuntimeFileSha256\s+\$configPath\)\s+-cne\s+\$initialConfigSha256[\s\S]*?'WORKER_RUNTIME_CONFIG_CHANGED_BEFORE_WRITE'/,
    'refresh verifies config hash unchanged before writing replacement bytes');
  assert.match(refreshFn, /Get-WorkerRuntimeFileSha256\s+\$configPath\)\s+-cne\s+\$initialConfigSha256[\s\S]*?'WORKER_RUNTIME_CONFIG_CHANGED_DURING_REFRESH'/,
    'refresh verifies config hash unchanged after replacement');
  assert.match(refreshFn, /Get-WorkerRuntimeTaskReadback[\s\S]*?-ExpectedDefinitionSha256\s+\$initialTaskDefinitionSha256/,
    'refresh verifies task definition hash matches initial definition across guarded task readbacks');

  // Rollback invariant checks
  assert.match(refreshFn, /\(Get-WorkerRuntimeTaskDefinitionSha256\)\s+-cne\s+\$initialTaskDefinitionSha256[\s\S]*?'WORKER_RUNTIME_TASK_IDENTITY_CHANGED'/,
    'rollback verifies task definition unchanged before performing rollback actions');
  assert.match(refreshFn, /Get-WorkerRuntimeFileSha256\s+\$configPath\)\s+-cne\s+\$initialConfigSha256\s+-or\s+\(Get-WorkerRuntimeTaskDefinitionSha256\)\s+-cne\s+\$initialTaskDefinitionSha256[\s\S]*?'config-or-task-definition'/,
    'rollback verifies config and task definition unchanged before re-enabling task');

  // 4. Both no-diff and successful refresh paths explicitly report model execution not invoked and W2 claims/receipts unchanged
  const noDiffIndex = refreshFn.indexOf("if ($changedNames.Count -eq 0)");
  const disableTaskIndex = refreshFn.indexOf("Disable-ScheduledTask");
  assert.ok(noDiffIndex !== -1 && disableTaskIndex !== -1 && noDiffIndex < disableTaskIndex,
    'no-diff branch exits cleanly before disabling the scheduled task');
  const noDiffBlock = refreshFn.slice(noDiffIndex, refreshFn.indexOf('return', noDiffIndex) + 'return'.length);
  assert.match(noDiffBlock, /Write-Output\s+'WORKER_RUNTIME_REFRESH=NOT_REQUIRED'/,
    'no-diff path reports refresh not required');
  assert.match(noDiffBlock, /Write-Output\s+'MODEL_EXECUTION=NOT_INVOKED_BY_REFRESH;\s*W2_CLAIMS_AND_RECEIPTS=UNCHANGED'/,
    'no-diff path explicitly reports model execution not invoked and W2 claims/receipts unchanged');

  const enableTaskIndex = refreshFn.indexOf("Enable-ScheduledTask -TaskName $taskName -TaskPath '\\'", disableTaskIndex);
  const postEnableReadbackIndex = refreshFn.indexOf('Get-WorkerRuntimeTaskReadback', enableTaskIndex);
  const successOutputIndex = refreshFn.indexOf("Write-Output ('WORKER_RUNTIME_REFRESH=SUCCESS;updated='");
  assert.ok(enableTaskIndex !== -1, 'task is re-enabled on success');
  assert.ok(postEnableReadbackIndex !== -1 && postEnableReadbackIndex > enableTaskIndex,
    'guarded task readback runs after re-enabling');
  assert.ok(successOutputIndex !== -1 && successOutputIndex > postEnableReadbackIndex,
    'success output occurs strictly after post-enable guarded task readback passes');

  const successBlock = refreshFn.slice(successOutputIndex, refreshFn.indexOf('} finally {', successOutputIndex));
  assert.match(successBlock, /Write-Output\s+'TASK_DEFINITION=UNCHANGED;CONFIG=UNCHANGED;W2_CLAIMS_AND_RECEIPTS=UNCHANGED'/,
    'successful refresh explicitly reports task definition, config, and W2 claims/receipts unchanged');
  assert.match(successBlock, /Write-Output\s+'MODEL_EXECUTION=NOT_INVOKED_BY_REFRESH'/,
    'successful refresh explicitly reports model execution not invoked');

  // Guard against any model invocation throughout refresh
  assert.doesNotMatch(refreshFn, /Get-QualifiedOpenCodeV2/i,
    'refresh never probes or executes OpenCode CLI');
  assert.doesNotMatch(refreshFn, /&\s+\$node\s+(?!--check\b)/,
    'Node execution in refresh is restricted strictly to module syntax verification');
  assert.doesNotMatch(refreshFn, /\bopencode\b/i,
    'refresh never references opencode binary');
  assert.doesNotMatch(refreshFn, /\bantigravity\b/i,
    'refresh never invokes antigravity');
});
