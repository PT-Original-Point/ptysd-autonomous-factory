import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join, win32 } from 'node:path';

const SID = /^S-1-(?:\d+-)+\d+$/i;
const ATTEMPT = /^[a-f0-9-]{36}$/;
const REQUEST = /^[A-Z][A-Z0-9_-]{7,79}$/;
const RESERVED_SIDS = new Set(['S-1-5-18', 'S-1-5-32-544']);

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
function normalizedWindowsPath(value) {
  return win32.normalize(value).replaceAll('/', '\\').toLocaleLowerCase('en-US');
}
function absoluteWindowsPath(value) {
  return typeof value === 'string' && win32.isAbsolute(value) && !/[\r\n"]/.test(value);
}

export function validateWindowsTaskAction(xml, {
  taskName, userIds, command, argumentsText, workingDirectory, errorPrefix = 'TASK',
} = {}) {
  const reject = code => fail(`${errorPrefix}_${code}`);
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
  if (logonType !== 'Password') reject('LOGON_TYPE_UNSAFE');
  const runLevel = oneTag(source, 'RunLevel', errorPrefix);
  if (runLevel !== 'LeastPrivilege') reject('RUNLEVEL_UNSAFE');
  const multipleInstances = oneTag(source, 'MultipleInstancesPolicy', errorPrefix);
  if (multipleInstances !== 'IgnoreNew') reject('MULTIPLE_INSTANCE_POLICY_UNSAFE');
  const executionTimeLimit = oneTag(source, 'ExecutionTimeLimit', errorPrefix);
  if (executionTimeLimit !== 'PT0S') reject('TIME_LIMIT_NOT_UNBOUNDED');
  if (oneTag(source, 'AllowHardTerminate', errorPrefix).toLowerCase() !== 'false')
    reject('HARD_TERMINATE_ENABLED');
  if (oneTag(source, 'Enabled', errorPrefix).toLowerCase() !== 'true') reject('DISABLED');
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
  if (typeof value.task_name !== 'string' || !/^\\PTYSD\\[A-Za-z0-9_-]{1,64}$/.test(value.task_name))
    fail('EXECUTOR_TASK_NAME_INVALID');
  if (!SID.test(value.user_sid || '') || RESERVED_SIDS.has(value.user_sid.toUpperCase()))
    fail('EXECUTOR_USER_SID_INVALID');
  if (!SID.test(value.publisher_sid || '') || RESERVED_SIDS.has(value.publisher_sid.toUpperCase()))
    fail('PUBLISHER_USER_SID_INVALID');
  if (value.user_sid.toUpperCase() === value.publisher_sid.toUpperCase())
    fail('EXECUTOR_IDENTITY_NOT_SEPARATE');
  for (const key of ['node_bin', 'script_path', 'config_path', 'manifest_dir', 'results_dir', 'working_directory']) {
    if (!absoluteWindowsPath(value[key])) fail(`EXECUTOR_${key.toUpperCase()}_INVALID`);
  }
  if (normalizedWindowsPath(value.manifest_dir) === normalizedWindowsPath(value.results_dir))
    fail('EXECUTOR_MANIFEST_RESULT_DIR_COLLISION');
  return value;
}

export function executorTaskArguments(descriptor) {
  validateExecutorDescriptor(descriptor);
  return `${quoteWindowsArg(descriptor.script_path)} --config ${quoteWindowsArg(descriptor.config_path)} ` +
    `--manifest-dir ${quoteWindowsArg(descriptor.manifest_dir)}`;
}

// This is a reviewable template only. Production registration requires the
// dedicated standard account and its ACLs to be provisioned and read back.
export function buildExecutorTaskXml(descriptor) {
  validateExecutorDescriptor(descriptor);
  const args = executorTaskArguments(descriptor);
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">` +
    `<RegistrationInfo><URI>${xmlEscape(descriptor.task_name)}</URI></RegistrationInfo>` +
    `<Principals><Principal id="Author"><UserId>${xmlEscape(descriptor.user_sid)}</UserId>` +
    // OpenCode requires network access; S4U tasks have no network credentials.
    // The account password is supplied only during secure task registration,
    // never embedded in this XML template.
    `<LogonType>Password</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>` +
    `<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>` +
    `<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>` +
    `<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>false</AllowHardTerminate>` +
    `<StartWhenAvailable>false</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit>` +
    `<Enabled>true</Enabled><Hidden>true</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle>` +
    `<WakeToRun>false</WakeToRun><AllowStartOnDemand>true</AllowStartOnDemand></Settings>` +
    `<Actions Context="Author"><Exec><Command>${xmlEscape(descriptor.node_bin)}</Command>` +
    `<Arguments>${xmlEscape(args)}</Arguments><WorkingDirectory>${xmlEscape(descriptor.working_directory)}</WorkingDirectory>` +
    `</Exec></Actions></Task>`;
}

export function validateExecutorTaskXml(xml, descriptor) {
  validateExecutorDescriptor(descriptor);
  const result = validateWindowsTaskAction(xml, { taskName: descriptor.task_name,
    userIds: [descriptor.user_sid], command: descriptor.node_bin,
    argumentsText: executorTaskArguments(descriptor), workingDirectory: descriptor.working_directory,
    errorPrefix: 'EXECUTOR_TASK' });
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

export function assertPhysicalDirectory(path, code) {
  let stat;
  try { stat = lstatSync(path); } catch { fail(code); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(code);
}

export function executorMailboxState(manifestDir) {
  assertPhysicalDirectory(manifestDir, 'EXECUTOR_MANIFEST_DIRECTORY_UNAVAILABLE');
  const active = readdirSync(manifestDir).filter(name =>
    /^[a-f0-9-]{36}\.(?:pending|running)\.json$/i.test(name));
  return { active: active.sort(), empty: active.length === 0 };
}

export function assertExecutorTaskReady(descriptor, {
  currentSid = getCurrentWindowsSid,
  filesystemPath = value => value,
  readTaskXml = taskName => execFileSync('schtasks.exe', ['/Query', '/TN', taskName, '/XML'], {
    encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
  }),
} = {}) {
  validateExecutorDescriptor(descriptor);
  const actualPublisherSid = currentSid().toUpperCase();
  if (actualPublisherSid !== descriptor.publisher_sid.toUpperCase()) fail('PUBLISHER_IDENTITY_READBACK_MISMATCH');
  if (actualPublisherSid === descriptor.user_sid.toUpperCase()) fail('EXECUTOR_IDENTITY_NOT_SEPARATE');
  assertPhysicalDirectory(filesystemPath(descriptor.manifest_dir), 'EXECUTOR_MANIFEST_DIRECTORY_UNAVAILABLE');
  assertPhysicalDirectory(filesystemPath(descriptor.results_dir), 'EXECUTOR_RESULT_DIRECTORY_UNAVAILABLE');
  const xml = readTaskXml(descriptor.task_name);
  const task = validateExecutorTaskXml(xml, descriptor);
  const mailbox = executorMailboxState(filesystemPath(descriptor.manifest_dir));
  if (!mailbox.empty) fail('EXECUTOR_ATTEMPT_UNRESOLVED');
  return { ...task, publisher_sid: actualPublisherSid, mailbox: 'EMPTY' };
}

export function makeExecutorManifest(job, spec, attemptId) {
  if (!REQUEST.test(job?.request_id || '') || !ATTEMPT.test(attemptId || '') ||
      typeof spec !== 'string' || !/^[a-f0-9]{64}$/i.test(job?.spec_sha256 || ''))
    fail('EXECUTOR_MANIFEST_INPUT_INVALID');
  return { schema: 1, kind: 'PTYSD_NATIVE_EXECUTOR_MANIFEST_V1',
    request_id: job.request_id, attempt_id: attemptId, source_sha: job.source_sha,
    spec_sha256: job.spec_sha256, job, spec };
}

export function dispatchToExecutor(descriptor, manifest, {
  currentSid,
  filesystemPath = value => value,
  writeFile = writeFileSync,
  readTaskXml,
  runTask = taskName => execFileSync('schtasks.exe', ['/Run', '/TN', taskName], {
    encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
  }),
} = {}) {
  assertExecutorTaskReady(descriptor, { currentSid, filesystemPath, readTaskXml });
  const payload = makeExecutorManifest(manifest.job, manifest.spec, manifest.attempt_id);
  if (payload.request_id !== manifest.request_id || payload.source_sha !== manifest.source_sha)
    fail('EXECUTOR_MANIFEST_IDENTITY_MISMATCH');
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

export function claimPendingManifest(manifestDir, rename = renameSync) {
  const state = executorMailboxState(manifestDir);
  if (state.active.some(name => name.endsWith('.running.json'))) fail('EXECUTOR_ATTEMPT_ALREADY_RUNNING');
  const pending = state.active.filter(name => name.endsWith('.pending.json'));
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

export function cleanupExecutorAttempt(descriptor, attemptId, remove = rmSync) {
  validateExecutorDescriptor(descriptor);
  if (!ATTEMPT.test(attemptId || '')) fail('EXECUTOR_RESULT_ID_INVALID');
  for (const suffix of ['pending', 'running']) {
    remove(join(descriptor.manifest_dir, `${attemptId}.${suffix}.json`), { force: true });
  }
}
