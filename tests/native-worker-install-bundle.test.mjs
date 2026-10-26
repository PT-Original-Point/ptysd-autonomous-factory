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
assert.match(installBlock, /Merge-WorkerConfig\s+/i,
  'the worker installer preserves executor-owned config fields across a worker refresh');
assert.match(installer, /New-ScheduledTaskAction\s+-Execute\s+\$wscript\s+-Argument\s+\$argsLine/i,
  'scheduled action invokes the validated hidden Windows Script Host wrapper');
assert.doesNotMatch(installer, /New-ScheduledTaskAction\s+-Execute\s+\$node\b/i,
  'installer never registers a visible Node console action');
assert.match(installer, /Arguments\s+-ne\s+\$argsLine/i,
  'task readback verifies the exact wrapper arguments');

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
