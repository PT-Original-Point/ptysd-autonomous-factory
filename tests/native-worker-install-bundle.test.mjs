import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assertExecutorTaskReady, buildExecutorTaskXml } from '../native-bridge/windows-executor.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDir = join(root, 'native-bridge');
const installer = readFileSync(join(sourceDir, 'install.ps1'), 'utf8');
const executorInstaller = readFileSync(join(sourceDir, 'install-codex-executor.ps1'), 'utf8');
const pinDriftFunctionStart = executorInstaller.indexOf('function Test-CodexExecutorConfigPinOnlyDifference');
const pinDriftFunctionEnd = executorInstaller.indexOf('\nfunction Find-CodexExecutorConfigPinDriftBaseline', pinDriftFunctionStart);
assert.notEqual(pinDriftFunctionStart, -1, 'CLI config drift comparator is present');
assert.notEqual(pinDriftFunctionEnd, -1, 'CLI config drift comparator is independently testable');
const pinDriftFunction = executorInstaller.slice(pinDriftFunctionStart, pinDriftFunctionEnd);
const installIndex = installer.indexOf("if ($Mode -eq 'Install')");
assert.notEqual(installIndex, -1, 'installer has an explicit install mode');
const installBlock = installer.slice(installIndex);

test('Codex CLI pin refresh reconciles only a proven stale pin', { skip: process.platform !== 'win32' }, () => {
  const baseline = {
    project_id: 'CHATGPT_GLOBAL_SKILL_GOVERNANCE',
    repo: 'PT-Original-Point/ptysd-autonomous-factory',
    codex_executable: 'C:\\Users\\worker\\AppData\\Local\\OpenAI\\Codex\\bin\\old\\codex.exe',
    codex_executable_sha256: 'a'.repeat(64),
    codex_cli_qualified: false,
    codex_login_verified: false,
    enable_codex_model_runs: false,
    codex_usage_authorized: false,
    codex_sandbox_boundary: 'UNKNOWN',
    allowed_codex_models: {},
  };
  const invoke = (current, expected) => {
    const baselineB64 = Buffer.from(JSON.stringify(baseline), 'utf8').toString('base64');
    const currentB64 = Buffer.from(JSON.stringify(current), 'utf8').toString('base64');
    const script = `${pinDriftFunction}\n` +
      `$baseline = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${baselineB64}')) | ConvertFrom-Json\n` +
      `$current = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${currentB64}')) | ConvertFrom-Json\n` +
      `if (Test-CodexExecutorConfigPinOnlyDifference $current $baseline) { 'ACCEPT' } else { 'REJECT' }`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive',
      '-EncodedCommand', encoded], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.error?.message || 'PowerShell helper failed');
    assert.equal(result.stdout.trim().split(/\r?\n/).at(-1), expected);
  };

  const pinOnly = { ...baseline,
    codex_executable: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\resources\\codex.exe',
    codex_executable_sha256: 'b'.repeat(64) };
  invoke(pinOnly, 'ACCEPT');
  invoke({ ...pinOnly, codex_usage_authorized: true }, 'REJECT');
  invoke({ ...pinOnly, allowed_codex_models: { 'gpt-6-luna': ['max'] } }, 'REJECT');
  invoke({ ...baseline, codex_executable: pinOnly.codex_executable }, 'REJECT');
});

test('Codex CLI pin drift requires the manifest-pinned runtime backup and preserves all model authorization gates', () => {
  assert.match(executorInstaller,
    /\$backupHash\s+-ne\s+\$expectedConfigHash/i,
    'the retained config must match the current installer manifest byte hash');
  assert.ok(executorInstaller.includes('executor-config\\.json\\.pre-cli-path-\\d{8}-\\d+\\.bak'),
    'runtime layout admits only the exact versioned pre-pin config backup');
  assert.match(executorInstaller,
    /KnownConfigBackupHash[\s\S]*?CODEX_CLI_REFRESH_CONFIG_BACKUP_HASH_MISMATCH/i,
    'the retained runtime backup must match the old manifest-pinned config bytes');
  assert.match(executorInstaller,
    /Find-CodexExecutorConfigPinDriftBaseline[\s\S]*?Test-CodexExecutorConfigPinOnlyDifference[\s\S]*?runtimeBaselines\.Count\s+-gt\s+1/i,
    'pin-only recovery must be unique and match every non-pin config property');
  assert.match(executorInstaller,
    /if \(Test-Path -LiteralPath \(\[string\]\$config\.codex_executable\) -PathType Leaf\)[\s\S]*?Find-CodexExecutorConfigPinDriftBaseline/i,
    'reconciliation is limited to a missing prior CLI executable');
  assert.match(executorInstaller,
    /\$runtimeHashes\['executor-config\.json'\]\s*=\s*\$currentConfigHash/i,
    'the regular atomic refresh transaction adopts the exact current config hash');
  assert.match(executorInstaller,
    /if \(\$RefreshRuntimeModules\) \{ throw 'CODEX_CLI_REFRESH_CONFIG_HASH_MISMATCH' \}/i,
    'runtime-module refresh cannot consume a CLI pin drift reconciliation');
  assert.match(executorInstaller,
    /CODEX_CLI_PIN_DRIFT=KNOWN_PIN_ONLY_RECONCILED/,
    'the successful recovery leaves an explicit native receipt');
});

function staticLocalImportClosure(entry) {
  const found = new Set();
  const pending = [entry];
  while (pending.length) {
    const name = pending.pop();
    if (found.has(name)) continue;
    found.add(name);
    const source = readFileSync(join(sourceDir, name), 'utf8');
    for (const match of source.matchAll(/\bfrom\s+['"]\.\/([^'"]+\.mjs)['"]/g))
      pending.push(match[1]);
  }
  return [...found].sort();
}

const required = new Set([
  ...staticLocalImportClosure('worker.mjs'),
  ...staticLocalImportClosure('executor.mjs'),
]);
const bundleBlock = installer.match(/\$runtimeFiles\s*=\s*@\(([\s\S]*?)\)/i);
assert.ok(bundleBlock, 'installer declares its complete worker runtime file bundle');
const bundled = [...bundleBlock[1].matchAll(/['"]([^'"]+\.mjs)['"]/g)]
  .map(match => match[1]).sort();
assert.deepEqual(bundled, [...required].sort(),
  'installed runtime contains the exact recursive import closures of Worker and shared Executor');
assert.match(installer, /Copy-Item\s+-LiteralPath\s+\$sourcePath\s+-Destination\s+\$targetPath/i,
  'installer copies each declared module to the runtime directory');
assert.match(installer, /Get-FileHash[\s\S]*?\$sourcePath[\s\S]*?Get-FileHash[\s\S]*?\$targetPath/i,
  'installer verifies source and destination hashes for each module');
assert.match(installer, /--check\s+\$targetPath/i,
  'installer syntax-checks each copied module before task registration');
assert.match(installer, /\$hiddenWorkerSha256\s*=\s*'BEB20341D759C4F6380A62197AB0FAD79B2F0D0B52798BFBF734346A05B82A89'/i,
  'installer pins the already validated HiddenWorker.vbs bytes');
assert.match(installer, /\[regex\]::Match\(\$wrapperText/i,
  'installer reads the Node executable from the validated wrapper instead of resolving another PATH binary');
assert.match(installer, /\$node\s*=\s*\$nodeMatch\.Groups\[1\]\.Value/i,
  'syntax checks use the same Node executable that the scheduled wrapper launches');
assert.doesNotMatch(installBlock, /\$node\s*=\s*Require-Command\s+'node\.exe'/i,
  'a different PATH Node binary cannot be mistaken for the deployed runtime');
assert.match(installer, /\$configWriteLockPath\s*=\s*\$configPath\s*\+\s*'\.write\.lock'/i,
  'the worker installer derives the shared OS lock file from config.json');
assert.match(installBlock, /\[IO\.File\]::Open\(\$configWriteLockPath[\s\S]*?\[IO\.FileShare\]::None/i,
  'the worker installer acquires the shared exclusive config lock before writing');
assert.match(executorInstaller, /\$workerConfigPath\s*\+\s*'\.write\.lock'/i,
  'the Codex executor installer uses the same worker config lock file');
assert.match(installer, /function\s+Write-WorkerConfigAtomically/i,
  'worker config writes use a dedicated atomic publisher');
assert.match(installBlock, /Write-WorkerConfigAtomically\s+-Path\s+\$configPath/i,
  'worker config publication uses the atomic helper');
assert.match(installer, /\[IO\.File\]::Replace\(\$temporaryPath,\s*\$fullPath,\s*\$backupPath\)/i,
  'existing config is replaced atomically from a same-directory staged file with a recoverable backup');
assert.match(installer, /\[IO\.File\]::Move\(\$temporaryPath,\s*\$fullPath\)/i,
  'first config creation publishes staged bytes with a same-directory move');
assert.doesNotMatch(installBlock, /\[IO\.File\]::WriteAllText\(\$configPath/i,
  'installer never truncates the active config in place');
assert.match(installBlock, /Merge-WorkerConfig\s+/i,
  'the worker installer preserves executor-owned config fields across a worker refresh');
assert.match(installer, /New-ScheduledTaskAction\s+-Execute\s+\$wscript\s+-Argument\s+\$argsLine/i,
  'scheduled action invokes the validated hidden Windows Script Host wrapper');
assert.doesNotMatch(installer, /New-ScheduledTaskAction\s+-Execute\s+\$node\b/i,
  'installer never registers a visible Node console action');
assert.match(installer, /Arguments\s+-ne\s+\$argsLine/i,
  'task readback verifies the exact wrapper arguments');
assert.match(installBlock,
  /New-ScheduledTaskSettingsSet[\s\S]*?-AllowStartIfOnBatteries[\s\S]*?-DontStopIfGoingOnBatteries/i,
  'the native five-minute dispatcher remains runnable when the host switches to battery power');

const refreshBlock = installer.slice(installer.indexOf('function Invoke-WorkerRuntimeRefresh'),
  installer.indexOf('function Require-Command'));
const taskReadbackBlock = installer.slice(installer.indexOf('function Get-WorkerRuntimeTaskReadback'),
  installer.indexOf('function Assert-WorkerRuntimeNoActiveProcess'));
const mergeAncestryBlock = installer.slice(installer.indexOf('function Assert-WorkerRuntimeAcceptedPrAncestry'),
  installer.indexOf('function Assert-WorkerRuntimeSource'));
const refreshSourceBlock = installer.slice(installer.indexOf('function Assert-WorkerRuntimeSource'),
  installer.indexOf('function Write-WorkerRuntimeNewFile'));
assert.match(installer, /ValidateSet\([^)]*RefreshRuntimeModules/i,
  'Worker runtime refresh is an explicit installer mode');
assert.ok(refreshBlock.includes('Assert-WorkerRuntimeSource $git $gh'),
  'refresh requires a clean exact-main source tree and same-source provider readback');
assert.ok(mergeAncestryBlock.includes('merge-base') && mergeAncestryBlock.includes('$RuntimeFiles') &&
  mergeAncestryBlock.includes('Get-WorkerRuntimeGitPath $file') &&
  mergeAncestryBlock.includes('WORKER_RUNTIME_ACCEPTED_PR_RUNTIME_BUNDLE_MISMATCH') &&
  refreshSourceBlock.includes('Assert-WorkerRuntimeAcceptedPrAncestry'),
  'refresh requires the merge commit on main and exact runtime-module equivalence when GitHub rewrites the accepted PR head');
assert.ok(mergeAncestryBlock.includes("return ('native-bridge/' + $File)") &&
  refreshSourceBlock.includes('Get-WorkerRuntimeGitPath $file') &&
  refreshSourceBlock.includes("$SourceMainSha + ':' + $gitPath") &&
  refreshSourceBlock.includes("$AcceptedPrHead + ':' + $gitPath"),
  'refresh resolves runtime module blobs from their native-bridge repository paths');
assert.ok(refreshSourceBlock.includes("'--paginate','--slurp'") &&
  refreshSourceBlock.includes('Assert-WorkerRuntimeTrustedRuns $runsJson $AcceptedPrHead') &&
  !refreshSourceBlock.includes('--jq'),
  'refresh reads provider JSON without PowerShell 5.1 jq argument splitting and requires exact trusted workflow identity on the accepted PR head');
assert.ok(refreshBlock.includes('Get-WorkerRuntimeTaskDefinitionSha256'),
  'refresh pins the complete registered task definition across temporary disable and re-enable');
assert.ok(taskReadbackBlock.includes('Resolve-WorkerRuntimeIdentitySid') && taskReadbackBlock.includes("Properties['UserId']"),
  'refresh binds the registered task principal to the current Windows user SID');
assert.ok(refreshBlock.includes('Assert-WorkerRuntimeNoActiveProcess'),
  'refresh refuses to replace runtime modules while the exact worker process may be active');
assert.ok(refreshBlock.includes('Write-WorkerRuntimeAtomicReplacement'),
  'refresh atomically replaces only modules whose pinned source bytes differ');
assert.ok(refreshBlock.includes("'MODEL_EXECUTION=NOT_INVOKED_BY_REFRESH'"),
  'refresh mode itself never invokes a model');
assert.match(refreshBlock, /configWriteLockPath[\s\S]*?FileShare\]::None/i,
  'refresh reuses the existing exclusive Worker config lock instead of adding another coordination service');
assert.match(installer, /WORKER_RUNTIME_REFRESH_PARTIAL_STATE_REVIEW_REQUIRED/,
  'unreconciled failures are reported as partial state instead of success');

test('Worker installation preserves the five-minute and logon recovery triggers with safe catch-up settings', () => {
  const scheduleStart = installBlock.indexOf('$trigger = New-ScheduledTaskTrigger -Once');
  assert.notEqual(scheduleStart, -1, 'install mode defines the native recurring trigger');
  const registerStart = installBlock.indexOf('Register-ScheduledTask -TaskName $taskName', scheduleStart);
  assert.notEqual(registerStart, -1, 'install mode registers the native Worker task');
  const schedule = installBlock.slice(scheduleStart, registerStart);

  assert.match(schedule,
    /\$trigger\s*=\s*New-ScheduledTaskTrigger\s+-Once[\s\S]*?-RepetitionInterval\s+\(New-TimeSpan\s+-Minutes\s+5\)/i,
    'the Worker receives its five-minute recurring trigger');
  assert.doesNotMatch(schedule, /-RepetitionDuration\b/i,
    'the five-minute trigger has no finite repetition end');
  assert.doesNotMatch(installBlock, /P3650D|New-TimeSpan\s+-Days\s+3650/i,
    'the Worker schedule cannot expire after a fixed duration');
  assert.match(schedule,
    /\$logonTrigger\s*=\s*New-ScheduledTaskTrigger\s+-AtLogOn\s+-User\s+\$username/i,
    'recovery is triggered at logon for the already selected Windows user');
  assert.match(schedule,
    /\$settings\s*=\s*New-ScheduledTaskSettingsSet\s+-MultipleInstances\s+IgnoreNew\s+-ExecutionTimeLimit\s+\(New-TimeSpan\s+-Minutes\s+15\)[\s\S]*?-StartWhenAvailable\b[\s\S]*?-AllowStartIfOnBatteries\b[\s\S]*?-DontStopIfGoingOnBatteries\b/i,
    'missed runs catch up without overlap and remain eligible on battery power');
  assert.match(schedule,
    /\$principal\s*=\s*New-ScheduledTaskPrincipal\s+-UserId\s+\$username\s+-LogonType\s+Interactive\s+-RunLevel\s+Limited/i,
    'the task keeps its existing interactive, least-privilege identity');
  assert.match(installBlock,
    /Register-ScheduledTask\s+-TaskName\s+\$taskName\s+-Action\s+\$action\s+-Trigger\s+@\(\$trigger,\s*\$logonTrigger\)[\s\S]{0,180}-Settings\s+\$settings\s+-Principal\s+\$principal/i,
    'both recovery triggers and the guarded settings are registered together');
});

test('Windows executor accepts omitted default RunLevel only with exact native Limited readback', () => {
  const sid = 'S-1-5-21-101-202-303-1001';
  const root = mkdtempSync(join(tmpdir(), 'pty-w2-runlevel-'));
  const manifestDir = join(root, 'manifests');
  const resultsDir = join(root, 'results');
  mkdirSync(manifestDir);
  mkdirSync(resultsDir);
  const descriptor = {
    task_name: '\\PTYSD-Antigravity-Executor', user_sid: sid, publisher_sid: sid,
    execution_phase: 'WIN11_TRANSITION', wscript_path: 'C:\\Windows\\System32\\wscript.exe',
    launcher_path: 'C:\\ProgramData\\PTYSDNativeBridge\\HiddenCodexExecutor.vbs',
    node_bin: 'C:\\Program Files\\nodejs\\node.exe',
    script_path: 'C:\\Users\\x\\AppData\\Local\\PTYSDNativeBridge\\executor.mjs',
    config_path: 'C:\\Users\\x\\AppData\\Local\\PTYSDNativeBridge\\executors\\antigravity\\executor-config.json',
    manifest_dir: 'C:\\Users\\x\\AppData\\Local\\PTYSDNativeBridge\\executors\\antigravity\\manifests',
    results_dir: 'C:\\Users\\x\\AppData\\Local\\PTYSDNativeBridge\\executors\\antigravity\\results',
    working_directory: 'C:\\Users\\x\\AppData\\Local\\PTYSDNativeBridge\\executors\\antigravity\\working',
  };
  const filesystemPath = value => value.toLowerCase() === descriptor.manifest_dir.toLowerCase()
    ? manifestDir : value.toLowerCase() === descriptor.results_dir.toLowerCase() ? resultsDir : value;
  const xml = buildExecutorTaskXml(descriptor);
  const exportedXml = xml.replace('<RunLevel>LeastPrivilege</RunLevel>', '')
    .replace('<Enabled>true</Enabled>', '');
  const nativeTask = { task_name: 'PTYSD-Antigravity-Executor', task_path: '\\', user_sid: sid,
    logon_type: 'Interactive', run_level: 'Limited', enabled: true, state: 'Ready' };
  const ready = readTaskState => assertExecutorTaskReady(descriptor, {
    currentSid: () => sid, filesystemPath, readTaskXml: () => exportedXml, readTaskState,
  });

  try {
    assert.equal(ready(() => nativeTask).run_level, 'LeastPrivilege');
    assert.throws(() => ready(() => { throw Object.assign(new Error('unavailable'), {
      code: 'EXECUTOR_TASK_NATIVE_READBACK_UNAVAILABLE',
    }); }), { code: 'EXECUTOR_TASK_NATIVE_READBACK_UNAVAILABLE' });
    assert.throws(() => ready(() => ({ ...nativeTask, run_level: 'Highest' })),
      { code: 'EXECUTOR_TASK_RUNLEVEL_UNSAFE' });
    assert.throws(() => ready(() => ({ ...nativeTask, enabled: false })),
      { code: 'EXECUTOR_TASK_DISABLED' });
    assert.throws(() => ready(() => ({ ...nativeTask, user_sid: 'S-1-5-21-999-999-999-1001' })),
      { code: 'EXECUTOR_TASK_NATIVE_IDENTITY_MISMATCH' });
    assert.throws(() => ready(() => ({ ...nativeTask, state: 'Running' })),
      { code: 'EXECUTOR_TASK_STATE_RUNNING_NOT_READY' });

    let nativeReads = 0;
    assert.equal(assertExecutorTaskReady(descriptor, {
      currentSid: () => sid, filesystemPath, readTaskXml: () => xml,
      readTaskState: () => { nativeReads++; return nativeTask; },
    }).run_level, 'LeastPrivilege');
    assert.equal(nativeReads, 1, 'native Task Scheduler state is required even when XML has RunLevel');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
