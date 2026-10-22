import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExecutorTaskXml, validateExecutorDescriptor, validateExecutorTaskXml }
  from '../native-bridge/windows-executor.mjs';

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
test('lane-aware XML builder selects only the requested Antigravity descriptor', () => {
  const root = mkdtempSync(join(tmpdir(), 'pty-antigravity-task-xml-'));
  try {
    const configPath = join(root, 'publisher-config.json');
    const opencode = descriptor();
    const antigravity = { ...descriptor(), task_name: '\\PTYSD\\AntigravityExecutor',
      user_sid: 'S-1-5-21-101-202-303-1003',
      script_path: 'C:\\ProgramData\\PTYSD\\antigravity-executor.mjs',
      config_path: 'C:\\Users\\PTYSD-Antigravity\\PTYSD\\executor-config.json',
      manifest_dir: 'C:\\ProgramData\\PTYSD\\antigravity-requests',
      results_dir: 'C:\\Users\\PTYSD-Antigravity\\PTYSD\\results',
      working_directory: 'C:\\ProgramData\\PTYSD\\antigravity-requests' };
    writeFileSync(configPath, JSON.stringify({ executors: { opencode, antigravity } }), 'utf8');
    const result = spawnSync(process.execPath, [xmlBuilder, configPath, 'antigravity'], { encoding: 'utf8' });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, buildExecutorTaskXml(antigravity));
    assert.deepEqual(validateExecutorTaskXml(result.stdout, antigravity), {
      ready: true, user_sid: antigravity.user_sid, logon_type: 'Password',
      run_level: 'LeastPrivilege', execution_time_limit: 'PT0S', multiple_instances: 'IgnoreNew',
    });
    assert.doesNotMatch(result.stdout, /OpenCodeExecutor/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('single-descriptor executor_lane is honored by the XML builder and cannot register under another lane', () => {
  const root = mkdtempSync(join(tmpdir(), 'pty-single-executor-lane-'));
  try {
    const configPath = join(root, 'publisher-config.json');
    const antigravity = { ...descriptor(), task_name: '\\PTYSD-AgilityLaneTest',
      user_sid: 'S-1-5-21-101-202-303-1003',
      script_path: 'C:\\ProgramData\\PTYSD\\antigravity-executor.mjs',
      config_path: 'C:\\Users\\PTYSD-Antigravity\\PTYSD\\executor-config.json',
      manifest_dir: 'C:\\ProgramData\\PTYSD\\antigravity-requests',
      results_dir: 'C:\\Users\\PTYSD-Antigravity\\PTYSD\\results',
      working_directory: 'C:\\ProgramData\\PTYSD\\antigravity-requests' };
    writeFileSync(configPath, JSON.stringify({ executor_lane: 'antigravity', executor: antigravity }), 'utf8');

    const selected = spawnSync(process.execPath, [xmlBuilder, configPath, 'antigravity'], { encoding: 'utf8' });
    assert.equal(selected.error, undefined);
    assert.equal(selected.status, 0, selected.stderr);
    assert.equal(selected.stdout, buildExecutorTaskXml(antigravity));

    const wrongLane = spawnSync(process.execPath, [xmlBuilder, configPath, 'opencode'], { encoding: 'utf8' });
    assert.notEqual(wrongLane.status, 0);
    assert.match(wrongLane.stderr, /EXECUTOR_NOT_CONFIGURED_FOR_OPENCODE/);
    assert.equal(wrongLane.stdout, '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('lane-aware XML builder fails closed for absent W2 mapping, invalid lane, and ambiguous config', () => {
  const root = mkdtempSync(join(tmpdir(), 'pty-invalid-executor-lane-'));
  try {
    const configPath = join(root, 'publisher-config.json');
    const opencode = descriptor();
    for (const [config, lane, code] of [
      [{ executors: { opencode } }, 'antigravity', 'EXECUTOR_NOT_CONFIGURED_FOR_ANTIGRAVITY'],
      [{ executors: { opencode }, executor: opencode }, 'opencode', 'EXECUTOR_ROUTING_CONFIG_AMBIGUOUS'],
      [{ executor_lane: 'Antigravity', executor: opencode }, 'antigravity', 'EXECUTOR_LANE_CONFIG_INVALID'],
      [{ executor_lane: ['antigravity'], executor: opencode }, 'antigravity', 'EXECUTOR_LANE_CONFIG_INVALID'],
      [{ executor_lane: null, executor: opencode }, 'antigravity', 'EXECUTOR_LANE_CONFIG_INVALID'],
      [{ executors: { opencode, antigravity: { ...opencode,
        task_name: '\\PTYSD\\AntigravityExecutor' } } }, 'antigravity', 'EXECUTOR_LANE_IDENTITY_COLLISION'],
      [{ executors: { opencode } }, 'codex', 'EXECUTOR_LANE_INVALID'],
    ]) {
      writeFileSync(configPath, JSON.stringify(config), 'utf8');
      const result = spawnSync(process.execPath, [xmlBuilder, configPath, lane], { encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(code));
      assert.equal(result.stdout, '');
    }
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

test('executor descriptors reject nested mailboxes and protected files below executor-writable mailboxes', () => {
  const base = descriptor();
  assert.throws(() => validateExecutorDescriptor({ ...base,
    results_dir: `${base.manifest_dir}\\results` }), /EXECUTOR_MANIFEST_RESULT_DIR_COLLISION/);
  assert.throws(() => validateExecutorDescriptor({ ...base,
    results_dir: `${base.manifest_dir}\\..\\requests\\results` }),
  /EXECUTOR_MANIFEST_RESULT_DIR_COLLISION/);

  for (const key of ['wscript_path', 'launcher_path', 'node_bin', 'script_path', 'config_path']) {
    const unsafeManifest = { ...base, [key]: `${base.manifest_dir}\\${key.replaceAll('_', '-')}` };
    assert.throws(() => validateExecutorDescriptor(unsafeManifest),
      /EXECUTOR_PROTECTED_FILE_IN_WRITABLE_DIRECTORY/, `${key} was placed below manifest_dir`);
    const unsafeResults = { ...base, [key]: `${base.results_dir}\\${key.replaceAll('_', '-')}` };
    assert.throws(() => validateExecutorDescriptor(unsafeResults),
      /EXECUTOR_PROTECTED_FILE_IN_WRITABLE_DIRECTORY/, `${key} was placed below results_dir`);
  }
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

test('PowerShell audit honors a single explicit Antigravity lane without registering or starting a task', {
  skip: process.platform !== 'win32',
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'pty-antigravity-executor-audit-'));
  try {
    const configPath = join(root, 'publisher-config.json');
    const identity = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' });
    assert.equal(identity.status, 0, identity.stderr);
    const publisherSid = identity.stdout.match(/S-\d+(?:-\d+)+/)?.[0];
    assert.ok(publisherSid, `current Windows SID not returned: ${identity.stdout}`);
    const antigravity = { ...descriptor(), task_name: '\\PTYSD-AgilityLaneAudit',
      user_sid: 'S-1-5-21-101-202-303-1003',
      publisher_sid: publisherSid,
      script_path: 'C:\\ProgramData\\PTYSD\\antigravity-executor.mjs',
      config_path: 'C:\\Users\\PTYSD-Antigravity\\PTYSD\\executor-config.json',
      manifest_dir: 'C:\\ProgramData\\PTYSD\\antigravity-requests',
      results_dir: 'C:\\Users\\PTYSD-Antigravity\\PTYSD\\results',
      working_directory: 'C:\\ProgramData\\PTYSD\\antigravity-requests' };
    writeFileSync(configPath, JSON.stringify({ executor_lane: 'antigravity', executor: antigravity }), 'utf8');
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', registrationScript,
      '-Mode', 'Audit', '-ExecutorLane', 'antigravity', '-PublisherConfigPath', configPath,
      '-NodeExecutable', process.execPath];
    const selected = spawnSync('powershell.exe', args, { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    assert.equal(selected.error, undefined, `PowerShell harness failed to start: ${selected.error}`);
    assert.equal(selected.status, 0, `stdout:\n${selected.stdout}\nstderr:\n${selected.stderr}`);
    assert.match(selected.stdout, /ANTIGRAVITY_EXECUTOR_TASK=ABSENT;DESCRIPTOR=\\PTYSD-AgilityLaneAudit/);
    assert.match(selected.stdout, /MODEL_EXECUTION=NOT_TESTED/);

    for (const executorLane of ['Antigravity', ['antigravity'], null]) {
      writeFileSync(configPath, JSON.stringify({ executor_lane: executorLane, executor: antigravity }), 'utf8');
      const invalidConfig = spawnSync('powershell.exe', args, { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
      assert.notEqual(invalidConfig.status, 0,
        `accepted invalid executor_lane ${JSON.stringify(executorLane)}; stdout:\n${invalidConfig.stdout}`);
      assert.match(invalidConfig.stderr, /EXECUTOR_LANE_CONFIG_INVALID/);
    }

    writeFileSync(configPath, JSON.stringify({ executor_lane: 'antigravity', executor: antigravity }), 'utf8');

    const wrongLaneArgs = [...args];
    wrongLaneArgs[wrongLaneArgs.indexOf('-ExecutorLane') + 1] = 'opencode';
    const wrongLane = spawnSync('powershell.exe', wrongLaneArgs,
      { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    assert.equal(wrongLane.status, 0, `stdout:\n${wrongLane.stdout}\nstderr:\n${wrongLane.stderr}`);
    assert.match(wrongLane.stdout, /OPENCODE_EXECUTOR_DESCRIPTOR=NOT_CONFIGURED/);
    assert.doesNotMatch(wrongLane.stdout, /AGILITYLANEAUDIT/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('PowerShell registration preserves model flags and applies the explicit execution phase', {
  skip: process.platform !== 'win32',
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'pty-executor-registration-phase-'));
  const harness = join(root, 'phase-audit.ps1');
  writeFileSync(harness, String.raw`
param([string]$RegistrationScript, [string]$Root)
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($RegistrationScript, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw 'PHASE_TEST_SOURCE_PARSE_FAILED' }
$wanted = @('Fail', 'Get-Field', 'Assert-ExecutorConfig')
$functions = @($ast.FindAll({ param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in $wanted
}, $true))
if ($functions.Count -ne $wanted.Count) { throw 'PHASE_TEST_FUNCTIONS_MISSING' }
$source = ($functions | Sort-Object { [array]::IndexOf($wanted, $_.Name) } |
    ForEach-Object { $_.Extent.Text }) -join [Environment]::NewLine
$expectedRepo = 'PT-Original-Point/ptysd-autonomous-factory'
$expectedProject = 'CHATGPT_GLOBAL_SKILL_GOVERNANCE'
Invoke-Expression $source
function Assert-Failure([string]$Expected, [scriptblock]$Action) {
    try { & $Action; throw "PHASE_TEST_EXPECTED_$Expected" }
    catch { if ($_.Exception.Message -ne $Expected) { throw } }
}
$publisherSid = 'S-1-5-21-101-202-303-1004'
$manifestDir = Join-Path $Root 'manifests'
$resultsDir = Join-Path $Root 'results'
$descriptor = [pscustomobject]@{
    user_sid = $publisherSid
    publisher_sid = $publisherSid
    execution_phase = 'WIN11_TRANSITION'
    manifest_dir = $manifestDir
    results_dir = $resultsDir
}
$config = [pscustomobject]@{
    repo = $expectedRepo
    project_id = $expectedProject
    host = $env:COMPUTERNAME
    issue = '407'
    dispatchers = @('codex', 'opencode')
    enable_v2_model_runs = $true
    enable_antigravity_model_runs = $true
    state_dir = $resultsDir
    executor_runtime = [pscustomobject]@{
        user_sid = $publisherSid
        publisher_sid = $publisherSid
        execution_phase = 'WIN11_TRANSITION'
        manifest_dir = $manifestDir
        results_dir = $resultsDir
    }
}
Assert-ExecutorConfig $config $descriptor $publisherSid $publisherSid 'opencode'
if (-not $config.enable_v2_model_runs -or -not $config.enable_antigravity_model_runs) {
    throw 'PHASE_TEST_MODEL_FLAGS_CHANGED'
}
$vmSid = 'S-1-5-21-101-202-303-1005'
$vmDescriptor = [pscustomobject]@{
    user_sid = $vmSid
    publisher_sid = $publisherSid
    execution_phase = 'VM_ISOLATED'
    manifest_dir = $manifestDir
    results_dir = $resultsDir
}
$vmConfig = [pscustomobject]@{
    repo = $expectedRepo
    project_id = $expectedProject
    host = $env:COMPUTERNAME
    issue = '407'
    dispatchers = @('codex', 'opencode')
    enable_v2_model_runs = $true
    enable_antigravity_model_runs = $true
    state_dir = $resultsDir
    executor_runtime = [pscustomobject]@{
        user_sid = $vmSid
        publisher_sid = $publisherSid
        execution_phase = 'VM_ISOLATED'
        manifest_dir = $manifestDir
        results_dir = $resultsDir
    }
}
Assert-ExecutorConfig $vmConfig $vmDescriptor $vmSid $publisherSid 'antigravity'
$phaseMismatch = $vmConfig | Select-Object *
$phaseMismatch.executor_runtime = $vmConfig.executor_runtime | Select-Object *
$phaseMismatch.executor_runtime.execution_phase = 'WIN11_TRANSITION'
Assert-Failure 'EXECUTOR_EXECUTION_PHASE_MISMATCH' {
    Assert-ExecutorConfig $phaseMismatch $vmDescriptor $vmSid $publisherSid 'antigravity'
}
$sameSidVmConfig = $vmConfig | Select-Object *
$sameSidVmConfig.executor_runtime = $vmConfig.executor_runtime | Select-Object *
$sameSidVmConfig.executor_runtime.user_sid = $publisherSid
$sameSidVmDescriptor = $vmDescriptor | Select-Object *
$sameSidVmDescriptor.user_sid = $publisherSid
Assert-Failure 'EXECUTOR_IDENTITY_NOT_SEPARATE' {
    Assert-ExecutorConfig $sameSidVmConfig $sameSidVmDescriptor $publisherSid $publisherSid 'opencode'
}
Assert-Failure 'EXECUTOR_DESCRIPTOR_IDENTITY_MISMATCH' {
    Assert-ExecutorConfig $config $descriptor $vmSid $publisherSid 'opencode'
}
Write-Output 'EXECUTOR_REGISTRATION_PHASE_AND_FLAGS_PASS'
`, 'utf8');
  try {
    const result = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness,
      registrationScript, root,
    ], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    assert.equal(result.error, undefined, `PowerShell harness failed to start: ${result.error}`);
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /EXECUTOR_REGISTRATION_PHASE_AND_FLAGS_PASS/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('PowerShell ACL checks distinguish protected leaf writes from ancestor replacement rights', {
  skip: process.platform !== 'win32',
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'pty-executor-acl-mask-'));
  const target = join(root, 'protected-runtime');
  mkdirSync(target);
  const harness = join(root, 'acl-mask-audit.ps1');
  writeFileSync(harness, String.raw`
param([string]$RegistrationScript, [string]$Target)
$ErrorActionPreference = 'Stop'
$parseTokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($RegistrationScript, [ref]$parseTokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw 'ACL_TEST_SOURCE_PARSE_FAILED' }
$wanted = @('Fail', 'Get-ExecutorWriteRightsMask', 'Get-ExecutorParentReplacementRightsMask',
    'Assert-NoBroadWrite', 'Assert-NoBroadParentReplacement', 'Assert-RoleReadOnly')
$functions = @($ast.FindAll({ param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in $wanted
}, $true))
if ($functions.Count -ne $wanted.Count) { throw 'ACL_TEST_FUNCTIONS_MISSING' }
$source = ($functions | Sort-Object { [array]::IndexOf($wanted, $_.Name) } |
    ForEach-Object { $_.Extent.Text }) -join [Environment]::NewLine
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$adminsSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$usersSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
$inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
    [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
$propagation = [System.Security.AccessControl.PropagationFlags]::None
function Get-Acl([string]$LiteralPath) { return [System.IO.Directory]::GetAccessControl($LiteralPath) }
$acl = [System.IO.Directory]::GetAccessControl($Target)
$acl.SetAccessRuleProtection($true, $false)
$acl.SetOwner($currentSid)
foreach ($identity in @($currentSid, $adminsSid, $systemSid)) {
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
        $identity, [System.Security.AccessControl.FileSystemRights]::FullControl,
        $inherit, $propagation, [System.Security.AccessControl.AccessControlType]::Allow))
}
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
    $usersSid, [System.Security.AccessControl.FileSystemRights]::ReadAndExecute,
    $inherit, $propagation, [System.Security.AccessControl.AccessControlType]::Allow))
 [System.IO.Directory]::SetAccessControl($Target, $acl)
$ExecutorSid = $usersSid.Value
$noBroadWrite = [scriptblock]::Create($source + [Environment]::NewLine + 'Assert-NoBroadWrite -Path $Target')
$noBroadParentReplacement = [scriptblock]::Create($source + [Environment]::NewLine + 'Assert-NoBroadParentReplacement -Path $Target')
$roleReadOnly = [scriptblock]::Create($source + [Environment]::NewLine + 'Assert-RoleReadOnly -Path $Target -Sid $ExecutorSid')
& $noBroadWrite
& $noBroadParentReplacement
& $roleReadOnly

$acl = [System.IO.Directory]::GetAccessControl($Target)
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
    $usersSid, [System.Security.AccessControl.FileSystemRights]::Write,
    $inherit, $propagation, [System.Security.AccessControl.AccessControlType]::Allow))
 [System.IO.Directory]::SetAccessControl($Target, $acl)
foreach ($check in @(
    @{ Expected = 'EXECUTOR_ACL_BROAD_WRITE_PRINCIPAL'; Action = $noBroadWrite },
    @{ Expected = 'EXECUTOR_RUNTIME_MUST_BE_READ_ONLY'; Action = $roleReadOnly }
)) {
    try { $action = $check.Action; & $action; throw "ACL_TEST_EXPECTED_$($check.Expected)" }
    catch {
        if ($_.Exception.Message -ne $check.Expected) { throw }
    }
}
$acl = [System.IO.Directory]::GetAccessControl($Target)
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
    $usersSid, [System.Security.AccessControl.FileSystemRights]::Delete,
    [System.Security.AccessControl.InheritanceFlags]::None,
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow))
 [System.IO.Directory]::SetAccessControl($Target, $acl)
# DELETE on this parent applies to the parent itself; it does not grant DELETE_CHILD
# on the protected runtime below it. The parent guard must allow this ACE.
& $noBroadParentReplacement

$acl = [System.IO.Directory]::GetAccessControl($Target)
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
    $usersSid, [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles,
    $inherit, $propagation, [System.Security.AccessControl.AccessControlType]::Allow))
 [System.IO.Directory]::SetAccessControl($Target, $acl)
try { & $noBroadParentReplacement; throw 'ACL_TEST_EXPECTED_EXECUTOR_ACL_BROAD_PARENT_REPLACEMENT' }
catch {
    if ($_.Exception.Message -ne 'EXECUTOR_ACL_BROAD_PARENT_REPLACEMENT') { throw }
}
Write-Output 'ACL_LEAF_AND_PARENT_RIGHTS_PASS'
`, 'utf8');
  try {
    const result = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness,
      registrationScript, target,
    ], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    assert.equal(result.error, undefined, `PowerShell harness failed to start: ${result.error}`);
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /ACL_LEAF_AND_PARENT_RIGHTS_PASS/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('PowerShell required-role ACL check rejects an explicit deny despite a matching allow', {
  skip: process.platform !== 'win32',
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'pty-executor-acl-deny-'));
  const target = join(root, 'protected-runtime');
  mkdirSync(target);
  const harness = join(root, 'acl-deny-audit.ps1');
  writeFileSync(harness, String.raw`
param([string]$RegistrationScript, [string]$Target)
$ErrorActionPreference = 'Stop'
$parseTokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($RegistrationScript, [ref]$parseTokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw 'ACL_TEST_SOURCE_PARSE_FAILED' }
$wanted = @('Fail', 'Assert-ExplicitRole')
$functions = @($ast.FindAll({ param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in $wanted
}, $true))
if ($functions.Count -ne $wanted.Count) { throw 'ACL_TEST_FUNCTIONS_MISSING' }
$source = ($functions | Sort-Object { [array]::IndexOf($wanted, $_.Name) } |
    ForEach-Object { $_.Extent.Text }) -join [Environment]::NewLine
function Get-Acl([string]$LiteralPath) { return [System.IO.Directory]::GetAccessControl($LiteralPath) }
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$sid = [Security.Principal.SecurityIdentifier]::new('S-1-5-21-1223889059-1506639864-3409743389-9999')
$acl = [System.IO.Directory]::GetAccessControl($Target)
$acl.SetOwner($currentSid)
$acl.SetAccessRuleProtection($true, $false)
$inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
    [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
$propagation = [System.Security.AccessControl.PropagationFlags]::None
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
    $currentSid, [System.Security.AccessControl.FileSystemRights]::FullControl,
    $inherit, $propagation, [System.Security.AccessControl.AccessControlType]::Allow))
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
    $sid, [System.Security.AccessControl.FileSystemRights]::ReadAndExecute,
    [System.Security.AccessControl.AccessControlType]::Allow))
[System.IO.Directory]::SetAccessControl($Target, $acl)
$check = [scriptblock]::Create($source + [Environment]::NewLine +
    'Assert-ExplicitRole -Path $Target -Sid $sid.Value -RequiredRights ([System.Security.AccessControl.FileSystemRights]::ReadAndExecute)')
& $check
$acl = [System.IO.Directory]::GetAccessControl($Target)
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
    $sid, [System.Security.AccessControl.FileSystemRights]::ReadAndExecute,
    [System.Security.AccessControl.AccessControlType]::Deny))
[System.IO.Directory]::SetAccessControl($Target, $acl)
try { & $check; throw 'ACL_TEST_EXPECTED_EXECUTOR_ACL_REQUIRED_ROLE_DENIED' }
catch {
    if ($_.Exception.Message -ne 'EXECUTOR_ACL_REQUIRED_ROLE_DENIED') { throw }
}
Write-Output 'ACL_EXPLICIT_DENY_PASS'
`, 'utf8');
  try {
    const result = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness,
      registrationScript, target,
    ], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    assert.equal(result.error, undefined, `PowerShell harness failed to start: ${result.error}`);
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /ACL_EXPLICIT_DENY_PASS/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('OpenCode registration source preserves the no-start boundary and phase-specific logon contract', () => {
  const source = readFileSync(registrationScript, 'utf8');
  assert.match(source, /Register-ScheduledTask/);
  assert.match(source, /ValidateSet\('opencode','antigravity'\)\]\[string\]\$ExecutorLane = 'opencode'/);
  assert.match(source, /\$publisherConfig\.PSObject\.Properties\['executor_lane'\]/);
  assert.match(source, /\$configuredLane -cnotin @\('opencode', 'antigravity'\)/);
  assert.match(source, /\$configuredLane -ceq \$ExecutorLane/);
  assert.match(source, /Get-Field \$executorMap \$ExecutorLane/);
  assert.match(source, /\$executionPhase = \[string\]\(Get-Field \$descriptor 'execution_phase'\)/);
  assert.match(source, /\$expectedLogonType = if \(\$isTransition\) \{ 'InteractiveToken' \} else \{ 'Password' \}/);
  assert.match(source, /if \(\$isTransition\) \{\s*Register-ScheduledTask -TaskName \$taskName -TaskPath \$taskPath -Xml \$xmlText -ErrorAction Stop/s);
  assert.match(source, /-User \$ExecutorCredential\.UserName -Password \$password/);
  assert.doesNotMatch(source, /Assert-ModelExecutionDisabled|MODEL_EXECUTION_MUST_REMAIN_DISABLED_FOR_REGISTRATION/);
  assert.match(source, /MODEL_EXECUTION=UNCHANGED;NO_TASK_START_PERFORMED/);
  assert.match(source, /\$builderPath \$PublisherConfigPath \$ExecutorLane/);
  assert.match(source, /Get-ScheduledTask/);
  assert.doesNotMatch(source, /\b(?:Start-ScheduledTask|Unregister-ScheduledTask|Set-Acl|New-LocalUser|Move-Item)\b/);
  assert.match(source, /EXECUTOR_TASK_EXISTS_REVIEW_REQUIRED_NO_OVERWRITE/);
  assert.match(source, /EXECUTOR_TASK_REGISTRATION_OUTCOME_UNKNOWN_READBACK_REQUIRED/);
  assert.match(source, /EXECUTOR_ACL_BROAD_WRITE_PRINCIPAL/);
  assert.match(source, /EXECUTOR_ACL_BROAD_PARENT_REPLACEMENT/);
  assert.match(source, /EXECUTOR_CURRENT_PROFILE_NOT_LOADED/);
  assert.match(source, /EXECUTOR_TASK_FOLDER_NOT_FOUND_NO_CREATE/);
  assert.match(source, /if \(\$separator -eq 0\)/);
  assert.match(source, /\$taskPath = '\\'/);
});
test('executor same-SID path checks remain distinct from VM role ACL checks', () => {
  const source = readFileSync(registrationScript, 'utf8');
  assert.match(source, /if \(-not \$isTransition\) \{[\s\S]*?Assert-RoleReadOnly \$path \$executorSid/s,
    'VM_ISOLATED retains executor read-only checks; WIN11_TRANSITION cannot model two roles with one SID');
  assert.match(source, /'wscript_path','launcher_path','node_bin','script_path','config_path'/);
  assert.match(source, /Assert-NoBroadWrite \$path/,
    'transition still rejects broad-principal write access on every exact path');
});
test('scheduler parents retain broad replacement protection in both phases', () => {
  const source = readFileSync(registrationScript, 'utf8');
  const parentGuard = source.match(/if\s*\(\$entry\.Key\s+-in\s+@\(([^)]*)\)\)\s*\{\s*Assert-ExecutorPathParentsReadOnly\s+\$path\s+\$executorSid\s+-BroadOnly:\$isTransition/s);
  assert.ok(parentGuard, 'registration must validate exact protected path parents in both phases');
  const parentPaths = [...parentGuard[1].matchAll(/'([^']+)'/g)].map(result => result[1]);
  assert.ok(parentPaths.includes('working_directory'));
  assert.match(source, /if\s*\(\$entry\.Key\s+-eq\s+'working_directory'\)\s*\{[\s\S]*?Assert-ExecutorWorkingDirectoryReadOnlyOrMailbox/s,
    'VM path checks remain mailbox-aware');
});
test('working-directory ACL permits its exact writable mailbox but rejects an unrelated writable directory', {
  skip: process.platform !== 'win32',
}, () => {
  const source = readFileSync(registrationScript, 'utf8');
  const functionSource = name => {
    const start = source.indexOf('function ' + name);
    assert.notEqual(start, -1, 'registration must define ' + name);
    const end = source.indexOf('\n}', start) + 2;
    assert.ok(end > start, 'registration function must have a closing brace: ' + name);
    return source.slice(start, end);
  };
  const harness = [
    'function Fail([string]$Code) { throw $Code }',
    'function Get-Acl([string]$LiteralPath) { return [System.IO.Directory]::GetAccessControl($LiteralPath) }',
    'function Set-Acl([string]$LiteralPath, $AclObject) { [System.IO.Directory]::SetAccessControl($LiteralPath, $AclObject) }',
    functionSource('Get-ExecutorWriteRightsMask'),
    functionSource('Assert-RoleReadOnly'),
    functionSource('Test-ExecutorWritableMailboxAlias'),
    functionSource('Assert-ExecutorWorkingDirectoryReadOnlyOrMailbox'),
    '$root = Join-Path $env:TEMP ("pty-mailbox-acl-" + [Guid]::NewGuid().ToString("N"))',
    '$results = Join-Path $env:TEMP "pty-mailbox-acl-results"',
    '$otherMailbox = Join-Path $env:TEMP "pty-mailbox-acl-unrelated"',
    'try {',
    '  New-Item -ItemType Directory -Path $root | Out-Null',
    '  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    '  $acl = Get-Acl -LiteralPath $root',
    '  $acl.SetAccessRuleProtection($true, $true)',
    '  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),',
    '    [System.Security.AccessControl.FileSystemRights]::Modify,',
    '    [System.Security.AccessControl.InheritanceFlags]::None,',
    '    [System.Security.AccessControl.PropagationFlags]::None,',
    '    [System.Security.AccessControl.AccessControlType]::Allow)',
    '  $acl.AddAccessRule($rule)',
    '  Set-Acl -LiteralPath $root -AclObject $acl',
    '  $descriptor = @{ manifest_dir = $root; results_dir = $results }',
    '  Assert-ExecutorWorkingDirectoryReadOnlyOrMailbox $root $descriptor $sid',
    '  $rejected = $false',
    '  try {',
    '    $unrelated = @{ manifest_dir = $otherMailbox; results_dir = $results }',
    '    Assert-ExecutorWorkingDirectoryReadOnlyOrMailbox $root $unrelated $sid',
    '  } catch { $rejected = $_.Exception.Message -eq "EXECUTOR_RUNTIME_MUST_BE_READ_ONLY" }',
    '  if (-not $rejected) { throw "UNRELATED_WRITABLE_WORKDIR_WAS_NOT_REJECTED" }',
    '  if (Test-ExecutorWritableMailboxAlias (Join-Path $root "nested") $descriptor) {',
    '    throw "NESTED_MAILBOX_ALIAS_WAS_ACCEPTED"',
    '  }',
    '} finally {',
    '  if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }',
    '}',
  ].join('\n');
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', harness,
  ], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  assert.equal(result.error, undefined, `PowerShell harness failed to start: ${result.error}`);
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
});
