import assert from 'node:assert/strict';
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
const installIndex = installer.indexOf("if ($Mode -eq 'Install')");
assert.notEqual(installIndex, -1, 'installer has an explicit install mode');
const installBlock = installer.slice(installIndex);

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

const required = staticLocalImportClosure('worker.mjs');
const bundleBlock = installer.match(/\$runtimeFiles\s*=\s*@\(([\s\S]*?)\)/i);
assert.ok(bundleBlock, 'installer declares its complete worker runtime file bundle');
const bundled = [...bundleBlock[1].matchAll(/['"]([^'"]+\.mjs)['"]/g)]
  .map(match => match[1]).sort();
assert.deepEqual(bundled, required,
  'installed worker runtime contains the exact recursive static import closure');
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
assert.ok(mergeAncestryBlock.includes('merge-base') && mergeAncestryBlock.includes("^{tree}") &&
  mergeAncestryBlock.includes('WORKER_RUNTIME_ACCEPTED_PR_MERGE_TREE_MISMATCH') &&
  refreshSourceBlock.includes('Assert-WorkerRuntimeAcceptedPrAncestry'),
  'refresh requires the merge commit on main and exact tree equivalence when GitHub rewrites the accepted PR head');
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
    logon_type: 'Interactive', run_level: 'Limited', enabled: true };
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

    let nativeReads = 0;
    assert.equal(assertExecutorTaskReady(descriptor, {
      currentSid: () => sid, filesystemPath, readTaskXml: () => xml,
      readTaskState: () => { nativeReads++; return nativeTask; },
    }).run_level, 'LeastPrivilege');
    assert.equal(nativeReads, 0, 'explicit XML RunLevel remains sufficient without a fallback read');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
