import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExecutorTaskXml, validateExecutorTaskXml } from '../native-bridge/windows-executor.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const registrationScript = join(repoRoot, 'native-bridge', 'register-opencode-executor.ps1');
const xmlBuilder = join(repoRoot, 'native-bridge', 'build-executor-task-xml.mjs');

function descriptor() {
  return {
    task_name: '\\PTYSD-OpenCode-Executor',
    user_sid: 'S-1-5-21-101-202-303-1001',
    publisher_sid: 'S-1-5-21-101-202-303-1000',
    wscript_path: 'C:\\Windows\\System32\\wscript.exe',
    launcher_path: 'C:\\ProgramData\\PTYSD\\HiddenCodexExecutor.vbs',
    node_bin: 'C:\\Program Files\\nodejs\\node.exe',
    script_path: 'C:\\ProgramData\\PTYSD\\executor.mjs',
    config_path: 'C:\\Users\\PTYSD-Executor\\PTYSD\\executor-config.json',
    manifest_dir: 'C:\\ProgramData\\PTYSD\\requests',
    results_dir: 'C:\\Users\\PTYSD-Executor\\PTYSD\\results',
    working_directory: 'C:\\ProgramData\\PTYSD\\requests',
  };
}

test('OpenCode registration XML builder delegates to the shared validated task template', () => {
  const root = mkdtempSync(join(tmpdir(), 'pty-opencode-task-xml-'));
  try {
    const configPath = join(root, 'publisher-config.json');
    const config = { executor: descriptor() };
    writeFileSync(configPath, JSON.stringify(config), 'utf8');
    const result = spawnSync(process.execPath, [xmlBuilder, configPath], { encoding: 'utf8' });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const expected = buildExecutorTaskXml(config.executor);
    assert.equal(result.stdout, expected);
    assert.deepEqual(validateExecutorTaskXml(result.stdout, config.executor), {
      ready: true, user_sid: config.executor.user_sid, logon_type: 'Password',
      run_level: 'LeastPrivilege', execution_time_limit: 'PT0S', multiple_instances: 'IgnoreNew',
    });
    assert.match(result.stdout, /<Hidden>true<\/Hidden>/);
    assert.doesNotMatch(result.stdout, /<Triggers>/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('OpenCode XML builder rejects missing or invalid descriptors without emitting a task', () => {
  const root = mkdtempSync(join(tmpdir(), 'pty-opencode-invalid-task-'));
  try {
    const configPath = join(root, 'publisher-config.json');
    writeFileSync(configPath, JSON.stringify({ executor: { ...descriptor(), user_sid: 'S-1-5-18' } }), 'utf8');
    const result = spawnSync(process.execPath, [xmlBuilder, configPath], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /EXECUTOR_USER_SID_INVALID/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('OpenCode descriptor accepts the root Task Scheduler namespace used by the existing Codex Executor', () => {
  const rootTask = { ...descriptor(), task_name: '\\PTYSD-OpenCode-Executor' };
  const xml = buildExecutorTaskXml(rootTask);
  assert.deepEqual(validateExecutorTaskXml(xml, rootTask), {
    ready: true, user_sid: rootTask.user_sid, logon_type: 'Password',
    run_level: 'LeastPrivilege', execution_time_limit: 'PT0S', multiple_instances: 'IgnoreNew',
  });
  assert.match(xml, /<URI>\\PTYSD-OpenCode-Executor<\/URI>/);
  assert.doesNotMatch(xml, /<Triggers>/);
  const existingNamespaceTask = { ...rootTask, task_name: '\\PTYSD\\OpenCodeExecutor' };
  assert.doesNotThrow(() => buildExecutorTaskXml(existingNamespaceTask));
  assert.throws(() => buildExecutorTaskXml({ ...rootTask, task_name: '\\OpenCodeExecutor' }),
    /EXECUTOR_TASK_NAME_INVALID/);
});

test('OpenCode installer audit is read-only and reports an absent publisher descriptor', {
  skip: process.platform !== 'win32',
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'pty-opencode-audit-'));
  try {
    const missingConfig = join(root, 'not-installed.json');
    const result = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', registrationScript,
      '-Mode', 'Audit', '-PublisherConfigPath', missingConfig, '-NodeExecutable', join(root, 'missing-node.exe'),
    ], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    assert.equal(result.error, undefined, `PowerShell harness failed to start: ${result.error}`);
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /OPENCODE_EXECUTOR_DESCRIPTOR=NOT_CONFIGURED/);
    assert.match(result.stdout, /TASK_REGISTRATION=NOT_ATTEMPTED/);
    assert.match(result.stdout, /MODEL_EXECUTION=NOT_TESTED/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('OpenCode registration source never starts, removes, or installs host components', () => {
  const source = readFileSync(registrationScript, 'utf8');
  assert.match(source, /Register-ScheduledTask/);
  assert.match(source, /Get-ScheduledTask/);
  assert.doesNotMatch(source, /\b(?:Start-ScheduledTask|Unregister-ScheduledTask|Set-Acl|New-LocalUser|Move-Item)\b/);
  assert.match(source, /EXECUTOR_TASK_EXISTS_REVIEW_REQUIRED_NO_OVERWRITE/);
  assert.match(source, /EXECUTOR_TASK_REGISTRATION_OUTCOME_UNKNOWN_READBACK_REQUIRED/);
  assert.match(source, /MODEL_EXECUTION_MUST_REMAIN_DISABLED_FOR_REGISTRATION/);
  assert.match(source, /EXECUTOR_ACL_BROAD_WRITE_PRINCIPAL/);
  assert.match(source, /EXECUTOR_RUNTIME_MUST_BE_READ_ONLY/);
  assert.match(source, /EXECUTOR_TASK_FOLDER_NOT_FOUND_NO_CREATE/);
  assert.match(source, /if \(\$separator -eq 0\)/);
  assert.match(source, /\$taskPath = '\\'/);
  assert.match(source, /\(\$taskPath -eq '\\'\) -or \(Test-TaskFolder \$taskPath\)/);
  assert.match(source, /S-1-5-19/);
  assert.match(source, /S-1-5-20/);
});
