import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, rmSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, resolve, win32 } from 'node:path';

const SID = /^S-1-(?:\d+-)+\d+$/i;
const ATTEMPT = /^[a-f0-9-]{36}$/;
const REQUEST = /^[A-Z][A-Z0-9_-]{7,79}$/;
const SHA = /^[a-f0-9]{40}$/i;
const HASH = /^[a-f0-9]{64}$/i;
const RESERVED_SIDS = new Set(['S-1-5-18', 'S-1-5-19', 'S-1-5-20', 'S-1-5-32-544']);
const NATIVE_REPOSITORY = 'PT-Original-Point/ptysd-autonomous-factory';

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function xmlEscape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
function xmlDecode(value) {
  return value.replaceAll('&quot;', '"').replaceAll('&apos;', "'")
    .replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&');
}
function tagValues(xml, name) {
  const expression = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'gi');
  return [...xml.matchAll(expression)].map(match => xmlDecode(match[1].trim()));
}
function oneTag(xml, name, prefix = 'EXECUTOR_TASK') {
  const values = tagValues(xml, name);
  if (values.length !== 1) fail(`${prefix}_${name.toUpperCase()}_AMBIGUOUS`);
  return values[0];
}
function quoteWindowsArg(value) {
  if (typeof value !== 'string' || !value || /[\r\n"]/.test(value)) fail('EXECUTOR_PATH_INVALID');
  return `"${value}"`;
}
export function buildHiddenWscriptArguments({ launcher_path, node_bin, script_path, config_path,
  manifest_dir } = {}) {
  const paths = [launcher_path, node_bin, script_path, config_path];
  if (manifest_dir !== undefined && manifest_dir !== null) paths.push(manifest_dir);
  if (!paths.every(absoluteWindowsPath)) fail('EXECUTOR_LAUNCH_ARGUMENT_PATH_INVALID');
  return `//B //NoLogo ${paths.map(quoteWindowsArg).join(' ')}`;
}
function normalizedWindowsPath(value) {
  return win32.resolve(value).replaceAll('/', '\\').toLocaleLowerCase('en-US');
}
function absoluteWindowsPath(value) {
  return typeof value === 'string' && win32.isAbsolute(value) && !/[\r\n"]/.test(value);
}

export function validateWindowsTaskAction(xml, {
  taskName, userIds, command, argumentsText, workingDirectory, errorPrefix = 'TASK',
  expectedLogonType = 'Password', nativeRunLevel, nativeEnabled,
} = {}) {
  const reject = code => fail(`${errorPrefix}_${code}`);
  if (!['Password', 'InteractiveToken'].includes(expectedLogonType))
    reject('EXPECTED_LOGON_TYPE_UNSAFE');
  if (!Array.isArray(userIds) || userIds.length === 0 || userIds.some(id => typeof id !== 'string' || !id) ||
      typeof taskName !== 'string' || !taskName || !absoluteWindowsPath(command) ||
      typeof argumentsText !== 'string' || /[\r\n]/.test(argumentsText) || !absoluteWindowsPath(workingDirectory))
    reject('DESCRIPTOR_INVALID');
  if (typeof xml !== 'string') reject('XML_INVALID');
  const source = xml.replace(/<!--[\s\S]*?-->/g, '');
  if (!source.includes('<Task ') || !source.includes('schemas.microsoft.com/windows/2004/02/mit/task'))
    reject('XML_INVALID');
  const actualName = oneTag(source, 'URI', errorPrefix).toLowerCase();
  const expectedName = taskName.toLowerCase();
  const rootAlias = (expectedName.startsWith('\\') && actualName === expectedName.slice(1)) ||
    (actualName.startsWith('\\') && actualName.slice(1) === expectedName);
  if (actualName !== expectedName && !rootAlias) reject('NAME_MISMATCH');
  const actualUser = oneTag(source, 'UserId', errorPrefix);
  if (!userIds.some(id => actualUser.toUpperCase() === id.toUpperCase())) reject('IDENTITY_MISMATCH');
  const logonType = oneTag(source, 'LogonType', errorPrefix);
  if (logonType !== expectedLogonType) reject('LOGON_TYPE_UNSAFE');
  const runLevels = tagValues(source, 'RunLevel');
  if (runLevels.length > 1) reject('RUNLEVEL_AMBIGUOUS');
  let runLevel;
  if (runLevels.length === 1) {
    runLevel = runLevels[0];
    if (runLevel !== 'LeastPrivilege') reject('RUNLEVEL_UNSAFE');
    if (nativeRunLevel !== undefined && nativeRunLevel !== 'LeastPrivilege')
      reject('RUNLEVEL_READBACK_MISMATCH');
  } else {
    // Task Scheduler omits the schema-default LeastPrivilege value when it
    // exports a task. Accept that omission only when Get-ScheduledTask readback
    // independently confirms the same task's principal is Limited.
    if (nativeRunLevel === undefined) reject('RUNLEVEL_AMBIGUOUS');
    if (nativeRunLevel !== 'LeastPrivilege') reject('RUNLEVEL_UNSAFE');
    runLevel = 'LeastPrivilege';
  }
  const multipleInstances = oneTag(source, 'MultipleInstancesPolicy', errorPrefix);
  if (multipleInstances !== 'IgnoreNew') reject('MULTIPLE_INSTANCE_POLICY_UNSAFE');
  const executionTimeLimit = oneTag(source, 'ExecutionTimeLimit', errorPrefix);
  if (executionTimeLimit !== 'PT0S') reject('TIME_LIMIT_NOT_UNBOUNDED');
  if (oneTag(source, 'AllowHardTerminate', errorPrefix).toLowerCase() !== 'false')
    reject('HARD_TERMINATE_ENABLED');
  const enabledValues = tagValues(source, 'Enabled');
  if (enabledValues.length > 1) reject('ENABLED_AMBIGUOUS');
  if (enabledValues.length === 1) {
    if (enabledValues[0].toLowerCase() !== 'true') reject('DISABLED');
    if (nativeEnabled !== undefined && nativeEnabled !== true) reject('ENABLED_READBACK_MISMATCH');
  } else {
    // Task Scheduler may omit the schema-default Enabled=true on export.
    if (nativeEnabled === undefined) reject('ENABLED_AMBIGUOUS');
    if (nativeEnabled !== true) reject('DISABLED');
  }
  if (oneTag(source, 'Hidden', errorPrefix).toLowerCase() !== 'true') reject('NOT_HIDDEN');
  if (/<(?:[A-Za-z0-9_-]+:)?[A-Za-z0-9_-]*Trigger\b/i.test(source)) reject('TRIGGERS_NOT_ALLOWED');
  const execActions = [...source.matchAll(/<(?:[A-Za-z0-9_-]+:)?Exec(?:\s[^>]*)?>/gi)];
  if (execActions.length !== 1) reject('ACTION_COUNT_MISMATCH');
  if (normalizedWindowsPath(oneTag(source, 'Command', errorPrefix)) !== normalizedWindowsPath(command))
    reject('COMMAND_MISMATCH');
  if (oneTag(source, 'Arguments', errorPrefix) !== argumentsText) reject('ARGUMENTS_MISMATCH');
  if (normalizedWindowsPath(oneTag(source, 'WorkingDirectory', errorPrefix)) !== normalizedWindowsPath(workingDirectory))
    reject('WORKING_DIRECTORY_MISMATCH');
  return { ready: true, task_name: taskName, user_id: actualUser, logon_type: logonType,
    run_level: runLevel, execution_time_limit: executionTimeLimit, allow_hard_terminate: false,
    multiple_instances: multipleInstances };
}

export function validateExecutorDescriptor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('EXECUTOR_DESCRIPTOR_INVALID');
  // Root-level names match the existing Codex Executor registration and do
  // not depend on provisioning a separate Task Scheduler folder. Keep the
  // nested form valid for hosts that already have the namespace folder.
  if (typeof value.task_name !== 'string' ||
      !/^\\PTYSD(?:\\[A-Za-z0-9_-]{1,64}|-[A-Za-z0-9_-]{1,64})$/.test(value.task_name))
    fail('EXECUTOR_TASK_NAME_INVALID');
  if (!SID.test(value.user_sid || '') || RESERVED_SIDS.has(value.user_sid.toUpperCase()) ||
      /^S-1-5-80-/i.test(value.user_sid))
    fail('EXECUTOR_USER_SID_INVALID');
  if (!SID.test(value.publisher_sid || '') || RESERVED_SIDS.has(value.publisher_sid.toUpperCase()) ||
      /^S-1-5-80-/i.test(value.publisher_sid))
    fail('PUBLISHER_USER_SID_INVALID');
  const executionPhase = value.execution_phase ?? 'VM_ISOLATED';
  if (!['WIN11_TRANSITION', 'VM_ISOLATED'].includes(executionPhase))
    fail('EXECUTOR_EXECUTION_PHASE_INVALID');
  const sameIdentity = value.user_sid.toUpperCase() === value.publisher_sid.toUpperCase();
  if (executionPhase === 'WIN11_TRANSITION' && !sameIdentity)
    fail('EXECUTOR_TRANSITION_IDENTITY_MISMATCH');
  if (executionPhase === 'VM_ISOLATED' && sameIdentity)
    fail('EXECUTOR_IDENTITY_NOT_SEPARATE');
  if (value.source_bundle_per_attempt !== undefined && typeof value.source_bundle_per_attempt !== 'boolean')
    fail('EXECUTOR_SOURCE_BUNDLE_MODE_INVALID');
  for (const key of ['wscript_path', 'launcher_path', 'node_bin', 'script_path', 'config_path',
    'manifest_dir', 'results_dir', 'working_directory']) {
    if (!absoluteWindowsPath(value[key])) fail(`EXECUTOR_${key.toUpperCase()}_INVALID`);
  }
  if (executorPathsOverlap(value.manifest_dir, value.results_dir))
    fail('EXECUTOR_MANIFEST_RESULT_DIR_COLLISION');
  const executorWritableDirectories = [value.manifest_dir, value.results_dir];
  const protectedFiles = ['wscript_path', 'launcher_path', 'node_bin', 'script_path', 'config_path'];
  for (const key of protectedFiles) {
    if (executorWritableDirectories.some(directory => windowsPathIsWithin(directory, value[key])))
      fail('EXECUTOR_PROTECTED_FILE_IN_WRITABLE_DIRECTORY');
  }
  return value;
}

function executorPathsOverlap(left, right) {
  const a = normalizedWindowsPath(left);
  const b = normalizedWindowsPath(right);
  const contains = (parent, child) => child.startsWith(parent.endsWith('\\') ? parent : `${parent}\\`);
  return a === b || contains(a, b) || contains(b, a);
}

function windowsPathIsWithin(directory, path) {
  const root = normalizedWindowsPath(directory);
  const candidate = normalizedWindowsPath(path);
  return candidate === root || candidate.startsWith(root.endsWith('\\') ? root : `${root}\\`);
}

export function validateExecutorRoutingMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('EXECUTOR_LANE_CONFIG_INVALID');
  const entries = Object.entries(value);
  if (!entries.length || entries.some(([lane]) => !['opencode', 'antigravity'].includes(lane)))
    fail('EXECUTOR_LANE_CONFIG_INVALID');
  const userSids = new Set();
  const taskNames = new Set();
  const isolatedPaths = [];
  let publisherSid = null;
  let executionPhase = null;
  for (const [lane, descriptor] of entries) {
    validateExecutorDescriptor(descriptor);
    const userSid = descriptor.user_sid.toUpperCase();
    const taskName = descriptor.task_name.toLocaleLowerCase('en-US');
    const descriptorPhase = descriptor.execution_phase ?? 'VM_ISOLATED';
    if (executionPhase && executionPhase !== descriptorPhase)
      fail('EXECUTOR_LANE_EXECUTION_PHASE_MISMATCH');
    executionPhase = descriptorPhase;
    if (userSids.has(userSid) && descriptorPhase !== 'WIN11_TRANSITION')
      fail('EXECUTOR_LANE_IDENTITY_COLLISION');
    if (taskNames.has(taskName)) fail('EXECUTOR_LANE_TASK_COLLISION');
    if (publisherSid && publisherSid !== descriptor.publisher_sid.toUpperCase())
      fail('EXECUTOR_LANE_PUBLISHER_MISMATCH');
    userSids.add(userSid);
    taskNames.add(taskName);
    publisherSid = descriptor.publisher_sid.toUpperCase();
    for (const key of ['config_path', 'manifest_dir', 'results_dir', 'working_directory']) {
      const path = { lane, value: descriptor[key] };
      if (isolatedPaths.some(other => other.lane !== lane && executorPathsOverlap(path.value, other.value)))
        fail('EXECUTOR_LANE_PATH_COLLISION');
      isolatedPaths.push(path);
    }
  }
  return value;
}

export function executorTaskArguments(descriptor) {
  validateExecutorDescriptor(descriptor);
  return buildHiddenWscriptArguments(descriptor);
}

// This is a reviewable template only. VM_ISOLATED requires a separate standard
// identity; WIN11_TRANSITION explicitly uses the current interactive identity.
export function buildExecutorTaskXml(descriptor) {
  validateExecutorDescriptor(descriptor);
  const args = executorTaskArguments(descriptor);
  const logonType = descriptor.execution_phase === 'WIN11_TRANSITION'
    ? 'InteractiveToken' : 'Password';
  // Register-ScheduledTask's -Xml parameter receives a .NET string, not UTF-8
  // bytes. An encoding declaration here makes Task Scheduler reject the XML
  // with ERROR_XML_ENCODING_SWITCH; the XML declaration is optional.
  return `<?xml version="1.0"?>\n` +
    `<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">` +
    `<RegistrationInfo><URI>${xmlEscape(descriptor.task_name)}</URI></RegistrationInfo>` +
    `<Principals><Principal id="Author"><UserId>${xmlEscape(descriptor.user_sid)}</UserId>` +
    // Password logon keeps network access in VM_ISOLATED; transition uses the
    // current interactive token. Credentials are never embedded in this XML.
    '<LogonType>' + logonType +
    '</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>' +
    `<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>` +
    `<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>` +
    `<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>false</AllowHardTerminate>` +
    `<StartWhenAvailable>false</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit>` +
    `<Enabled>true</Enabled><Hidden>true</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle>` +
    `<WakeToRun>false</WakeToRun><AllowStartOnDemand>true</AllowStartOnDemand></Settings>` +
    `<Actions Context="Author"><Exec><Command>${xmlEscape(descriptor.wscript_path)}</Command>` +
    `<Arguments>${xmlEscape(args)}</Arguments><WorkingDirectory>${xmlEscape(descriptor.working_directory)}</WorkingDirectory>` +
    `</Exec></Actions></Task>`;
}

export function validateExecutorTaskXml(xml, descriptor, { nativeRunLevel, nativeEnabled } = {}) {
  validateExecutorDescriptor(descriptor);
  const expectedLogonType = descriptor.execution_phase === 'WIN11_TRANSITION'
    ? 'InteractiveToken' : 'Password';
  const result = validateWindowsTaskAction(xml, { taskName: descriptor.task_name,
    userIds: [descriptor.user_sid], command: descriptor.wscript_path,
    argumentsText: executorTaskArguments(descriptor), workingDirectory: descriptor.working_directory,
    errorPrefix: 'EXECUTOR_TASK', expectedLogonType, nativeRunLevel, nativeEnabled });
  return { ready: true, user_sid: descriptor.user_sid, logon_type: result.logon_type,
    run_level: result.run_level, execution_time_limit: result.execution_time_limit,
    multiple_instances: result.multiple_instances };
}
export function getCurrentWindowsSid({ execFile = execFileSync, systemRoot = process.env.SystemRoot } = {}) {
  if (process.platform !== 'win32' || !systemRoot) fail('EXECUTOR_WINDOWS_IDENTITY_UNAVAILABLE');
  const whoami = win32.join(systemRoot, 'System32', 'whoami.exe');
  const output = execFile(whoami, ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const match = output.match(/S-1-(?:\d+-)+\d+/i);
  if (!match || !SID.test(match[0])) fail('EXECUTOR_WINDOWS_IDENTITY_UNAVAILABLE');
  return match[0].toUpperCase();
}

function readNativeTaskState(taskName, {
  execFile = execFileSync, systemRoot = process.env.SystemRoot,
} = {}) {
  if (process.platform !== 'win32' || !systemRoot) fail('EXECUTOR_TASK_NATIVE_READBACK_UNAVAILABLE');
  const powershell = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const separator = taskName.lastIndexOf('\\');
  const taskPathLiteral = `'${taskName.slice(0, separator + 1).replaceAll("'", "''") || '\\'}'`;
  const taskNameLiteral = `'${taskName.slice(separator + 1).replaceAll("'", "''")}'`;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$task = Get-ScheduledTask -TaskPath ${taskPathLiteral} -TaskName ${taskNameLiteral} -ErrorAction Stop`,
    'if ($null -eq $task) { throw \'Task Scheduler returned no task\' }',
    '$sid = [string]$task.Principal.UserId',
    "if ($sid -notmatch '^S-1-') { $sid = ([System.Security.Principal.NTAccount]::new($sid)).Translate([System.Security.Principal.SecurityIdentifier]).Value }",
    '[pscustomobject]@{ task_name=[string]$task.TaskName; task_path=[string]$task.TaskPath; user_sid=$sid; logon_type=[string]$task.Principal.LogonType; run_level=[string]$task.Principal.RunLevel; enabled=[bool]$task.Settings.Enabled } | ConvertTo-Json -Compress -Depth 3',
  ].join('; ');
  let output;
  try {
    output = execFile(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    fail('EXECUTOR_TASK_NATIVE_READBACK_UNAVAILABLE');
  }
  try {
    const value = JSON.parse(String(output).trim());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid readback');
    return value;
  } catch {
    fail('EXECUTOR_TASK_NATIVE_READBACK_INVALID');
  }
}

function verifiedNativeTaskState(readback, descriptor) {
  if (!readback || typeof readback !== 'object' || Array.isArray(readback))
    fail('EXECUTOR_TASK_NATIVE_READBACK_INVALID');
  const expectedName = descriptor.task_name.toLowerCase();
  const actualName = `${readback.task_path || ''}${readback.task_name || ''}`.toLowerCase();
  if (actualName !== expectedName ||
      String(readback.user_sid || '').toUpperCase() !== descriptor.user_sid.toUpperCase())
    fail('EXECUTOR_TASK_NATIVE_IDENTITY_MISMATCH');
  const expectedLogonType = descriptor.execution_phase === 'WIN11_TRANSITION'
    ? 'InteractiveToken' : 'Password';
  const actualLogonType = readback.logon_type === 'Interactive'
    ? 'InteractiveToken' : readback.logon_type;
  if (actualLogonType !== expectedLogonType) fail('EXECUTOR_TASK_NATIVE_LOGON_TYPE_MISMATCH');
  let runLevel;
  if (readback.run_level === 'Limited' || readback.run_level === 'LeastPrivilege') runLevel = 'LeastPrivilege';
  else if (readback.run_level === 'Highest' || readback.run_level === 'HighestAvailable') runLevel = 'HighestAvailable';
  else fail('EXECUTOR_TASK_RUNLEVEL_READBACK_AMBIGUOUS');
  if (typeof readback.enabled !== 'boolean') fail('EXECUTOR_TASK_ENABLED_READBACK_AMBIGUOUS');
  return { run_level: runLevel, enabled: readback.enabled };
}

function validateExecutorTaskReadback(xml, descriptor, readTaskState) {
  if (typeof xml !== 'string') fail('EXECUTOR_TASK_XML_INVALID');
  const source = xml.replace(/<!--[\s\S]*?-->/g, '');
  const runLevels = tagValues(source, 'RunLevel');
  const enabledValues = tagValues(source, 'Enabled');
  let nativeState;
  if (runLevels.length === 0 || enabledValues.length === 0)
    nativeState = verifiedNativeTaskState(readTaskState(descriptor.task_name), descriptor);
  return validateExecutorTaskXml(xml, descriptor, {
    nativeRunLevel: nativeState?.run_level, nativeEnabled: nativeState?.enabled,
  });
}

export function assertPhysicalDirectory(path, code) {
  let stat;
  try { stat = lstatSync(path); } catch { fail(code); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(code);
}

// Resolve the repository checkout owned by this Executor lane. The Worker
// config's workspace may belong to another lane, so it must not be used as a
// source object store for an OpenCode or Antigravity attempt.
export function readExecutorWorkspace(descriptor, { projectId, host,
  read = readFileSync } = {}) {
  validateExecutorDescriptor(descriptor);
  const usesWindowsRoot = /^[a-z]:[\\/]/i.test(descriptor.manifest_dir) ||
    descriptor.manifest_dir.startsWith('\\\\');
  const pathApi = usesWindowsRoot ? win32 : posix;
  const laneRoot = pathApi.dirname(descriptor.manifest_dir);
  if (pathApi.basename(descriptor.manifest_dir).toLowerCase() !== 'manifests' ||
      normalizedWindowsPath(descriptor.results_dir) !== normalizedWindowsPath(pathApi.join(laneRoot, 'results')) ||
      normalizedWindowsPath(descriptor.config_path) !== normalizedWindowsPath(
        pathApi.join(laneRoot, 'executor-config.json')))
    fail('EXECUTOR_LANE_DIRECTORY_BINDING_INVALID');
  let configInfo;
  try { configInfo = lstatSync(descriptor.config_path); }
  catch { fail('EXECUTOR_CONFIG_READBACK_UNAVAILABLE'); }
  if (!configInfo.isFile() || configInfo.isSymbolicLink())
    fail('EXECUTOR_CONFIG_NOT_REGULAR_FILE');
  let executorConfig;
  try { executorConfig = JSON.parse(read(descriptor.config_path, 'utf8')); }
  catch { fail('EXECUTOR_CONFIG_READBACK_INVALID'); }
  if (!executorConfig || executorConfig.repo !== NATIVE_REPOSITORY ||
      executorConfig.project_id !== projectId ||
      typeof executorConfig.host !== 'string' || executorConfig.host.toUpperCase() !== host.toUpperCase())
    fail('EXECUTOR_CONFIG_IDENTITY_MISMATCH');
  const expectedWorkspace = pathApi.join(laneRoot, 'workspace');
  if (typeof executorConfig.workspace !== 'string' ||
      !pathApi.isAbsolute(executorConfig.workspace) ||
      normalizedWindowsPath(executorConfig.workspace) !== normalizedWindowsPath(expectedWorkspace))
    fail('EXECUTOR_WORKSPACE_PATH_MISMATCH');
  assertPhysicalDirectory(expectedWorkspace, 'EXECUTOR_SOURCE_WORKSPACE_UNAVAILABLE');
  try { return realpathSync.native(expectedWorkspace); }
  catch { fail('EXECUTOR_SOURCE_WORKSPACE_READBACK_FAILED'); }
}

function executorMailboxState(manifestDir) {
  assertPhysicalDirectory(manifestDir, 'EXECUTOR_MANIFEST_DIRECTORY_UNAVAILABLE');
  const active = readdirSync(manifestDir).filter(name =>
    /^[a-f0-9-]{36}\.(?:pending|running)\.json$/i.test(name));
  return { active: active.sort(), empty: active.length === 0 };
}

export function candidateBundlePath(manifestDir, attemptId) {
  if (typeof manifestDir !== 'string' || !ATTEMPT.test(attemptId || ''))
    fail('EXECUTOR_CANDIDATE_BUNDLE_ID_INVALID');
  return join(manifestDir, 'candidate-bundles', `${attemptId}.bundle`);
}

export function candidateWorkspacePath(resultsDir, attemptId) {
  if (typeof resultsDir !== 'string' || !ATTEMPT.test(attemptId || ''))
    fail('EXECUTOR_CANDIDATE_WORKSPACE_ID_INVALID');
  return join(resultsDir, 'candidate-workspaces', attemptId);
}

// Pin one exact source commit in a uniquely named bundle before an attempt can
// be published. Both native executors use this verifier while retaining their
// own mailbox paths and ACLs.
export function createPinnedSourceBundle({ workspace, bundlePath, sourceSha, attemptId,
  filesystemPath = value => value, refNamespace = 'source-bundles', execFile = execFileSync } = {}) {
  if (!SHA.test(sourceSha || '') || !ATTEMPT.test(attemptId || '') ||
      typeof workspace !== 'string' || !workspace || typeof bundlePath !== 'string' || !bundlePath ||
      !/^[a-z0-9-]{1,48}$/.test(refNamespace))
    fail('EXECUTOR_SOURCE_BUNDLE_IDENTITY_INVALID');
  const sourceWorkspace = resolve(workspace);
  assertPhysicalDirectory(sourceWorkspace, 'EXECUTOR_SOURCE_WORKSPACE_UNAVAILABLE');
  const mappedBundlePath = filesystemPath(bundlePath);
  if (typeof mappedBundlePath !== 'string' || !isAbsolute(mappedBundlePath))
    fail('EXECUTOR_SOURCE_BUNDLE_PATH_INVALID');
  const outputPath = resolve(mappedBundlePath);
  const bundleDir = dirname(outputPath);
  mkdirSync(bundleDir, { recursive: true });
  assertPhysicalDirectory(bundleDir, 'EXECUTOR_SOURCE_BUNDLE_DIRECTORY_INVALID');
  try {
    lstatSync(outputPath);
    fail('EXECUTOR_SOURCE_BUNDLE_ALREADY_EXISTS_NO_OVERWRITE');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const options = { encoding: 'utf8', windowsHide: true, shell: false, timeout: 120000,
    maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] };
  const runGit = (args, code) => {
    try { return execFile('git', ['-C', sourceWorkspace, ...args], options); }
    catch { fail(code); }
  };
  const temporaryRef = `refs/pty-native/${refNamespace}/${attemptId}`;
  const expectedMissingRef = '0'.repeat(40);
  let temporaryRefCreated = false;
  try {
    const available = runGit(['rev-parse', '--verify', `${sourceSha}^{commit}`],
      'EXECUTOR_SOURCE_COMMIT_UNAVAILABLE').trim();
    if (available.toLowerCase() !== sourceSha.toLowerCase())
      fail('EXECUTOR_SOURCE_COMMIT_UNAVAILABLE');
    const shallow = runGit(['rev-parse', '--is-shallow-repository'],
      'EXECUTOR_SOURCE_SHALLOW_STATE_READ_FAILED').trim();
    if (shallow === 'true') {
      runGit(['fetch', '--unshallow', '--no-tags', 'origin'],
        'EXECUTOR_SOURCE_HISTORY_UNSHALLOW_FAILED');
      if (runGit(['rev-parse', '--is-shallow-repository'],
        'EXECUTOR_SOURCE_SHALLOW_STATE_READ_FAILED').trim() !== 'false')
        fail('EXECUTOR_SOURCE_HISTORY_REMAINS_SHALLOW');
    } else if (shallow !== 'false') {
      fail('EXECUTOR_SOURCE_SHALLOW_STATE_INVALID');
    }
    runGit(['update-ref', temporaryRef, sourceSha, expectedMissingRef],
      'EXECUTOR_SOURCE_REF_CREATE_FAILED');
    temporaryRefCreated = true;
    runGit(['bundle', 'create', outputPath, temporaryRef], 'EXECUTOR_SOURCE_BUNDLE_CREATE_FAILED');
    runGit(['bundle', 'verify', outputPath], 'EXECUTOR_SOURCE_BUNDLE_VERIFY_FAILED');
    const listed = runGit(['bundle', 'list-heads', outputPath], 'EXECUTOR_SOURCE_BUNDLE_READBACK_FAILED');
    if (!listed.split(/\r?\n/).some(line => {
      const [sha, ref] = line.trim().split(/\s+/);
      return sha?.toLowerCase() === sourceSha.toLowerCase() && ref === temporaryRef;
    })) fail('EXECUTOR_SOURCE_BUNDLE_REF_MISMATCH');
    const stat = lstatSync(outputPath);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('EXECUTOR_SOURCE_BUNDLE_NOT_REGULAR');
    const sha256 = createHash('sha256').update(readFileSync(outputPath)).digest('hex');
    return { attempt_id: attemptId, source_sha: sourceSha, sha256, bundle_path: outputPath };
  } catch (error) {
    try { rmSync(outputPath, { force: true }); } catch { /* no manifest references this bundle */ }
    throw error;
  } finally {
    if (temporaryRefCreated) {
      try {
        runGit(['update-ref', '-d', temporaryRef, sourceSha],
          'EXECUTOR_SOURCE_TEMP_REF_CLEANUP_FAILED');
      } catch {
        try { rmSync(outputPath, { force: true }); } catch { /* fail closed */ }
        fail('EXECUTOR_SOURCE_TEMP_REF_CLEANUP_FAILED');
      }
    }
  }
}

// Pin the exact OpenCode job commit in its attempt-scoped bundle before the
// Task Scheduler manifest is published.
export function createExecutorSourceBundle({ workspace, descriptor, job, attemptId,
  filesystemPath = value => value, execFile = execFileSync } = {}) {
  validateExecutorDescriptor(descriptor);
  if (!['opencode_plan', 'opencode_edit', 'antigravity_edit'].includes(job?.kind) || !SHA.test(job?.source_sha || '') ||
      !ATTEMPT.test(attemptId || '') || typeof workspace !== 'string' || !workspace)
    fail('EXECUTOR_SOURCE_BUNDLE_IDENTITY_INVALID');
  const manifestDir = filesystemPath(descriptor.manifest_dir);
  assertPhysicalDirectory(manifestDir, 'EXECUTOR_MANIFEST_DIRECTORY_UNAVAILABLE');
  const sourceWorkspace = resolve(workspace);
  assertPhysicalDirectory(sourceWorkspace, 'EXECUTOR_SOURCE_WORKSPACE_UNAVAILABLE');
  const options = { encoding: 'utf8', windowsHide: true, shell: false, timeout: 120000,
    maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] };
  const runGit = (args, code) => {
    try { return String(execFile('git', ['-C', sourceWorkspace, ...args], options)).trim(); }
    catch { fail(code); }
  };
  let sourceAvailable = false;
  try {
    sourceAvailable = runGit(['rev-parse', '--verify', `${job.source_sha}^{commit}`],
      'EXECUTOR_SOURCE_COMMIT_UNAVAILABLE').toLowerCase() === job.source_sha.toLowerCase();
  } catch { /* A pinned PR ref may supply this exact commit below. */ }

  let fetchRef = null;
  let fetchedSha = null;
  const bundlePath = candidateBundlePath(manifestDir, attemptId);
  try {
    if (!sourceAvailable) {
      if (!Number.isSafeInteger(job.source_pr) || job.source_pr < 1)
        fail('EXECUTOR_SOURCE_COMMIT_UNAVAILABLE');
      const remote = runGit(['remote', 'get-url', 'origin'], 'EXECUTOR_SOURCE_REMOTE_READ_FAILED');
      const allowedRemotes = new Set([
        'https://github.com/pt-original-point/ptysd-autonomous-factory.git',
        'https://github.com/pt-original-point/ptysd-autonomous-factory',
        'git@github.com:pt-original-point/ptysd-autonomous-factory.git',
        'git@github.com:pt-original-point/ptysd-autonomous-factory',
        'ssh://git@github.com/pt-original-point/ptysd-autonomous-factory.git',
        'ssh://git@github.com/pt-original-point/ptysd-autonomous-factory',
      ]);
      if (!allowedRemotes.has(remote.toLowerCase())) fail('EXECUTOR_SOURCE_REMOTE_NOT_TRUSTED');
      fetchRef = `refs/pty-native/fetched-candidates/${attemptId}`;
      if (runGit(['for-each-ref', '--format=%(refname)', fetchRef],
        'EXECUTOR_SOURCE_FETCH_REF_READ_FAILED'))
        fail('EXECUTOR_SOURCE_FETCH_REF_ALREADY_EXISTS');
      runGit(['fetch', '--no-tags', '--no-write-fetch-head', 'origin',
        `refs/pull/${job.source_pr}/head:${fetchRef}`], 'EXECUTOR_SOURCE_PULL_REF_FETCH_FAILED');
      fetchedSha = runGit(['rev-parse', '--verify', `${fetchRef}^{commit}`],
        'EXECUTOR_SOURCE_PULL_REF_READBACK_FAILED');
      if (fetchedSha.toLowerCase() !== job.source_sha.toLowerCase())
        fail('EXECUTOR_SOURCE_PULL_REF_SHA_MISMATCH');
    }
    return createPinnedSourceBundle({ workspace: sourceWorkspace, bundlePath,
      sourceSha: job.source_sha, attemptId, filesystemPath: value => value,
      refNamespace: 'executor-bundles', execFile });
  } catch (error) {
    try { rmSync(bundlePath, { force: true }); } catch { /* no attempt may reference a partial bundle */ }
    throw error;
  } finally {
    if (fetchRef) {
      try {
        const cleanupArgs = ['update-ref', '-d', fetchRef];
        if (fetchedSha) cleanupArgs.push(fetchedSha);
        runGit(cleanupArgs, 'EXECUTOR_SOURCE_FETCH_REF_CLEANUP_FAILED');
      } catch {
        try { rmSync(bundlePath, { force: true }); } catch { /* fail closed */ }
        fail('EXECUTOR_SOURCE_FETCH_REF_CLEANUP_FAILED');
      }
    }
  }
}

export function assertExecutorTaskReady(descriptor, {
  currentSid = getCurrentWindowsSid,
  filesystemPath = value => value,
  readTaskXml = taskName => execFileSync('schtasks.exe', ['/Query', '/TN', taskName, '/XML'], {
    encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
  }),
  readTaskState = taskName => readNativeTaskState(taskName),
} = {}) {
  validateExecutorDescriptor(descriptor);
  const actualPublisherSid = currentSid().toUpperCase();
  if (actualPublisherSid !== descriptor.publisher_sid.toUpperCase()) fail('PUBLISHER_IDENTITY_READBACK_MISMATCH');
  assertPhysicalDirectory(filesystemPath(descriptor.manifest_dir), 'EXECUTOR_MANIFEST_DIRECTORY_UNAVAILABLE');
  assertPhysicalDirectory(filesystemPath(descriptor.results_dir), 'EXECUTOR_RESULT_DIRECTORY_UNAVAILABLE');
  const xml = readTaskXml(descriptor.task_name);
  const task = validateExecutorTaskReadback(xml, descriptor, readTaskState);
  const mailbox = executorMailboxState(filesystemPath(descriptor.manifest_dir));
  if (!mailbox.empty) fail('EXECUTOR_ATTEMPT_UNRESOLVED');
  return { ...task, publisher_sid: actualPublisherSid, mailbox: 'EMPTY' };
}

export function makeExecutorManifest(job, spec, attemptId, sourceBundleSha256 = null) {
  if (!REQUEST.test(job?.request_id || '') || !ATTEMPT.test(attemptId || '') ||
      typeof spec !== 'string' || !/^[a-f0-9]{64}$/i.test(job?.spec_sha256 || ''))
    fail('EXECUTOR_MANIFEST_INPUT_INVALID');
  if (sourceBundleSha256 !== null && !HASH.test(sourceBundleSha256 || ''))
    fail('EXECUTOR_SOURCE_BUNDLE_HASH_INVALID');
  if (sourceBundleSha256 !== null && !['opencode_plan', 'opencode_edit', 'antigravity_edit'].includes(job?.kind))
    fail('EXECUTOR_SOURCE_BUNDLE_JOB_KIND_INVALID');
  return { schema: 1, kind: 'PTYSD_NATIVE_EXECUTOR_MANIFEST_V1',
    request_id: job.request_id, attempt_id: attemptId, source_sha: job.source_sha,
    spec_sha256: job.spec_sha256, job, spec,
    ...(sourceBundleSha256 === null ? {} : { source_bundle_sha256: sourceBundleSha256.toLowerCase() }) };
}

export function dispatchToExecutor(descriptor, manifest, {
  currentSid,
  filesystemPath = value => value,
  writeFile = writeFileSync,
  readTaskXml,
  readTaskState,
  runTask = taskName => execFileSync('schtasks.exe', ['/Run', '/TN', taskName], {
    encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
  }),
} = {}) {
  assertExecutorTaskReady(descriptor, { currentSid, filesystemPath, readTaskXml, readTaskState });
  const payload = makeExecutorManifest(manifest.job, manifest.spec, manifest.attempt_id,
    manifest.source_bundle_sha256 ?? null);
  if (payload.request_id !== manifest.request_id || payload.source_sha !== manifest.source_sha)
    fail('EXECUTOR_MANIFEST_IDENTITY_MISMATCH');
  if (payload.source_bundle_sha256) {
    const bundle = candidateBundlePath(filesystemPath(descriptor.manifest_dir), payload.attempt_id);
    let stat;
    try { stat = lstatSync(bundle); } catch { fail('EXECUTOR_SOURCE_BUNDLE_UNAVAILABLE'); }
    if (!stat.isFile() || stat.isSymbolicLink() ||
        createHash('sha256').update(readFileSync(bundle)).digest('hex') !== payload.source_bundle_sha256)
      fail('EXECUTOR_SOURCE_BUNDLE_HASH_MISMATCH');
  }
  const pending = join(filesystemPath(descriptor.manifest_dir), `${payload.attempt_id}.pending.json`);
  writeFile(pending, JSON.stringify(payload), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try {
    runTask(descriptor.task_name);
  } catch {
    // Task Scheduler start is an external effect. Preserve the exact manifest;
    // the next poll must reconcile it and must never create another attempt.
    const error = new Error('EXECUTOR_TASK_START_UNKNOWN');
    error.code = 'EXECUTOR_TASK_START_UNKNOWN';
    throw error;
  }
  return { outcome: 'EXECUTOR_TASK_DISPATCHED_NOT_ACCEPTANCE', exit_code: 0,
    evidence_sha256: null, evidence_bytes: 0, attempt_id: payload.attempt_id };
}

export function triggerPendingExecutorAttempt(descriptor, attemptId, {
  expectedJob, currentSid = getCurrentWindowsSid, filesystemPath = value => value,
  readTaskXml = taskName => execFileSync('schtasks.exe', ['/Query', '/TN', taskName, '/XML'], {
    encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
  }),
  readTaskState = taskName => readNativeTaskState(taskName),
  runTask = taskName => execFileSync('schtasks.exe', ['/Run', '/TN', taskName], {
    encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
  }),
} = {}) {
  validateExecutorDescriptor(descriptor);
  if (!ATTEMPT.test(attemptId || '') || !expectedJob || typeof expectedJob !== 'object' ||
      Array.isArray(expectedJob) || !['opencode_edit', 'antigravity_edit'].includes(expectedJob.kind))
    fail('EXECUTOR_EXPECTED_PENDING_ATTEMPT_IDENTITY_INVALID');
  const actualPublisherSid = currentSid().toUpperCase();
  if (actualPublisherSid !== descriptor.publisher_sid.toUpperCase())
    fail('PUBLISHER_IDENTITY_READBACK_MISMATCH');
  const manifestDir = filesystemPath(descriptor.manifest_dir);
  const resultsDir = filesystemPath(descriptor.results_dir);
  assertPhysicalDirectory(manifestDir, 'EXECUTOR_MANIFEST_DIRECTORY_UNAVAILABLE');
  assertPhysicalDirectory(resultsDir, 'EXECUTOR_RESULT_DIRECTORY_UNAVAILABLE');
  validateExecutorTaskReadback(readTaskXml(descriptor.task_name), descriptor, readTaskState);

  const name = `${attemptId}.pending.json`;
  const manifestPath = join(manifestDir, name);
  const mailbox = executorMailboxState(manifestDir);
  if (mailbox.active.length !== 1 || mailbox.active[0] !== name)
    fail('EXECUTOR_ATTEMPT_NOT_EXACT_PENDING');
  let originalBytes;
  let manifest;
  try {
    const stat = lstatSync(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('EXECUTOR_PENDING_MANIFEST_NOT_REGULAR');
    originalBytes = readFileSync(manifestPath);
    manifest = JSON.parse(originalBytes.toString('utf8'));
  } catch (error) {
    if (/^EXECUTOR_/.test(error?.code || '')) throw error;
    fail('EXECUTOR_PENDING_MANIFEST_INVALID');
  }
  if (manifest.attempt_id !== attemptId ||
      JSON.stringify(manifest.job) !== JSON.stringify(expectedJob) ||
      !HASH.test(manifest.source_bundle_sha256 || '') && manifest.source_bundle_sha256 !== undefined)
    fail('EXECUTOR_PENDING_MANIFEST_IDENTITY_MISMATCH');
  const payload = makeExecutorManifest(manifest.job, manifest.spec, attemptId,
    manifest.source_bundle_sha256 ?? null);
  if (!Buffer.from(JSON.stringify(payload)).equals(originalBytes))
    fail('EXECUTOR_PENDING_MANIFEST_BYTES_MISMATCH');
  if (payload.source_bundle_sha256) {
    const bundlePath = candidateBundlePath(manifestDir, attemptId);
    let bundleStat;
    try { bundleStat = lstatSync(bundlePath); } catch { fail('EXECUTOR_SOURCE_BUNDLE_UNAVAILABLE'); }
    if (!bundleStat.isFile() || bundleStat.isSymbolicLink() ||
        createHash('sha256').update(readFileSync(bundlePath)).digest('hex') !== payload.source_bundle_sha256)
      fail('EXECUTOR_SOURCE_BUNDLE_HASH_MISMATCH');
  }
  const resultPath = executorResultPath(resultsDir, expectedJob.request_id, attemptId);
  if (existsSync(resultPath)) fail('EXECUTOR_PENDING_ATTEMPT_ALREADY_HAS_RESULT');
  const finalMailbox = executorMailboxState(manifestDir);
  if (finalMailbox.active.length !== 1 || finalMailbox.active[0] !== name ||
      !readFileSync(manifestPath).equals(originalBytes) || existsSync(resultPath))
    fail('EXECUTOR_PENDING_ATTEMPT_CHANGED_DURING_RECOVERY');
  try { runTask(descriptor.task_name); } catch { fail('EXECUTOR_TASK_START_UNKNOWN'); }
  return { outcome: 'EXECUTOR_PENDING_ATTEMPT_TRIGGERED_NOT_ACCEPTANCE',
    exit_code: 0, attempt_id: attemptId };
}

export function claimPendingManifest(manifestDir, rename = renameSync,
  isVerifiedCompletedRunningAttempt = () => false) {
  if (typeof isVerifiedCompletedRunningAttempt !== 'function')
    fail('EXECUTOR_COMPLETED_ATTEMPT_CHECK_INVALID');
  const state = executorMailboxState(manifestDir);
  const running = state.active.filter(name => /\.running\.json$/i.test(name));
  const pending = state.active.filter(name => name.endsWith('.pending.json'));
  if (running.length > 0 && running.some(name =>
    isVerifiedCompletedRunningAttempt(name) !== true)) fail('EXECUTOR_ATTEMPT_ALREADY_RUNNING');
  if (pending.length === 0) return null;
  if (pending.length !== 1) fail('EXECUTOR_MANIFEST_MULTIPLE_PENDING');
  const source = join(manifestDir, pending[0]);
  const target = source.replace(/\.pending\.json$/i, '.running.json');
  rename(source, target);
  return target;
}

export function executorResultPath(resultsDir, requestId, attemptId) {
  if (!REQUEST.test(requestId || '') || !ATTEMPT.test(attemptId || '')) fail('EXECUTOR_RESULT_ID_INVALID');
  return join(resultsDir, `result-${requestId}-${attemptId}.json`);
}

export function cleanupExecutorAttempt(descriptor, attemptId, remove = rmSync, { candidateWorkspaceRoot } = {}) {
  validateExecutorDescriptor(descriptor);
  if (!ATTEMPT.test(attemptId || '')) fail('EXECUTOR_RESULT_ID_INVALID');
  let workspaceBase = descriptor.results_dir;
  if (candidateWorkspaceRoot !== undefined) {
    if (!absoluteWindowsPath(candidateWorkspaceRoot)) fail('EXECUTOR_PROJECT_WORKSPACE_PATH_INVALID');
    assertPhysicalDirectory(candidateWorkspaceRoot, 'EXECUTOR_PROJECT_WORKSPACE_UNAVAILABLE');
    workspaceBase = join(candidateWorkspaceRoot, '.pty-native-executor');
    if (existsSync(workspaceBase))
      assertPhysicalDirectory(workspaceBase, 'EXECUTOR_PROJECT_WORKSPACE_BASE_NOT_PHYSICAL');
    const candidateRoot = join(workspaceBase, 'candidate-workspaces');
    if (existsSync(candidateRoot))
      assertPhysicalDirectory(candidateRoot, 'EXECUTOR_PROJECT_CANDIDATE_ROOT_NOT_PHYSICAL');
  }
  for (const suffix of ['pending', 'running']) {
    remove(join(descriptor.manifest_dir, `${attemptId}.${suffix}.json`), { force: true });
  }
  const removeExact = (path, kind) => {
    if (!existsSync(path)) return;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (kind === 'file' && !stat.isFile()) ||
        (kind === 'directory' && !stat.isDirectory()))
      fail('EXECUTOR_ATTEMPT_ARTIFACT_TYPE_UNKNOWN');
    remove(path, { force: true, ...(kind === 'directory' ? { recursive: true } : {}) });
    if (existsSync(path)) fail('EXECUTOR_ATTEMPT_ARTIFACT_CLEANUP_UNCONFIRMED');
  };
  removeExact(candidateBundlePath(descriptor.manifest_dir, attemptId), 'file');
  removeExact(candidateWorkspacePath(workspaceBase, attemptId), 'directory');
}
