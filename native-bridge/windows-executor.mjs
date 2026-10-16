import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { readWindowsProcessTree } from './captured-process.mjs';

const SID = /^S-1-(?:\d+-)+\d+$/i;
const ATTEMPT = /^[a-f0-9-]{36}$/;
const REQUEST = /^[A-Z][A-Z0-9_-]{7,79}$/;
const SHA = /^[a-f0-9]{40}$/i;
const HASH = /^[a-f0-9]{64}$/i;
const RESERVED_SIDS = new Set(['S-1-5-18', 'S-1-5-32-544']);
const PROTECTED_NATIVE_BRIDGE_PATHS = new Set([
  'native-bridge/csg-trusted-pr-verifier.mjs',
  'native-bridge/csg-trusted-pr-verifier-cli.mjs',
  'native-bridge/install.ps1',
  'native-bridge/install-codex-executor.ps1',
  'native-bridge/hiddenworker.vbs',
  'native-bridge/hiddencodexexecutor.vbs',
  'native-bridge/windows-executor.mjs',
]);
const SENSITIVE_WORKSPACE_NAME = /(?:^|[._-])(?:secrets?|credentials?|tokens?|passwords?|auth)(?:$|[._-])/i;

export function workspacePathIdentity(path, windows = process.platform === 'win32') {
  const normalized = path.replaceAll('\\', '/');
  return windows ? normalized.toLowerCase() : normalized;
}

export function isInvalidWindowsPathSegment(segment) {
  return /[<>:"\/\\|?*\u0000-\u001f]/.test(segment) ||
    /[. ]$/.test(segment) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment) ||
    /^(?:conin\$|conout\$)$/i.test(segment);
}

export function parseWorkspaceWritePath(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') ||
      value.includes('\\') || value.includes(':'))
    return { error: 'INVALID', parts: null };
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..'))
    return { error: 'TRAVERSAL', parts: null };
  if (parts.some(isInvalidWindowsPathSegment))
    return { error: 'INVALID', parts: null };
  return { error: null, parts };
}

export function isProtectedNativeBridgePath(path) {
  return typeof path === 'string' &&
    PROTECTED_NATIVE_BRIDGE_PATHS.has(path.replaceAll('\\', '/').toLowerCase());
}

export function isSensitiveWorkspacePathSegment(value) {
  return typeof value === 'string' &&
    (/^\.env(?:\.|$)/i.test(value) || /^opencode\.jsonc?$/i.test(value) ||
      SENSITIVE_WORKSPACE_NAME.test(value));
}

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function sameJson(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right))
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => sameJson(value, right[index]));
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) =>
    key === rightKeys[index] && sameJson(left[key], right[key]));
}
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
  expectedPendingAttemptId = null,
  expectedRunningAttemptId = null,
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
  if (expectedPendingAttemptId !== null && expectedRunningAttemptId !== null)
    fail('EXECUTOR_EXPECTED_ATTEMPT_STATE_AMBIGUOUS');
  if (expectedPendingAttemptId === null && expectedRunningAttemptId === null) {
    if (!mailbox.empty) fail('EXECUTOR_ATTEMPT_UNRESOLVED');
    return { ...task, publisher_sid: actualPublisherSid, mailbox: 'EMPTY' };
  }
  const expectedAttemptId = expectedPendingAttemptId ?? expectedRunningAttemptId;
  const expectedSuffix = expectedPendingAttemptId === null ? 'running' : 'pending';
  if (!ATTEMPT.test(expectedAttemptId || '') || mailbox.active.length !== 1 ||
      mailbox.active[0] !== expectedAttemptId + `.${expectedSuffix}.json`)
    fail(expectedSuffix === 'running' ? 'EXECUTOR_ATTEMPT_NOT_EXPECTED_RUNNING' :
      'EXECUTOR_ATTEMPT_NOT_EXPECTED_PENDING');
  return { ...task, publisher_sid: actualPublisherSid,
    mailbox: expectedSuffix === 'running' ? 'EXPECTED_RUNNING' : 'EXPECTED_PENDING',
    attempt_id: expectedAttemptId };
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

export function makeExecutorManifest(job, spec, attemptId, sourceBundleSha256 = null) {
  if (job?.kind !== 'opencode_edit')
    fail(job?.kind === 'opencode_plan'
      ? 'EXECUTOR_READONLY_PLAN_RETIRED' : 'EXECUTOR_JOB_KIND_UNSUPPORTED');
  if (job.schema !== 6 || !Number.isSafeInteger(job.candidate_pr) || job.candidate_pr < 1 ||
      !job.goal_ref || Array.isArray(job.goal_ref) || typeof job.goal_ref !== 'object' ||
      JSON.stringify(Object.keys(job.goal_ref).sort()) !==
        JSON.stringify(['body_sha256', 'comment_id', 'issue', 'marker']) ||
      job.goal_ref?.marker !== 'PTYSD_V53R4_DELETE_FIRST_AUTONOMY_GOAL_20261015' ||
      !Number.isSafeInteger(job.goal_ref?.issue) || job.goal_ref.issue !== 310 ||
      !Number.isSafeInteger(job.goal_ref?.comment_id) || job.goal_ref.comment_id < 1 ||
      !/^[a-f0-9]{64}$/i.test(job.goal_ref?.body_sha256 || ''))
    fail('EXECUTOR_EDIT_JOB_HUMAN_GOAL_BINDING_REQUIRED');
  if (!REQUEST.test(job?.request_id || '') || !ATTEMPT.test(attemptId || '') ||
      typeof spec !== 'string' || !/^[a-f0-9]{64}$/i.test(job?.spec_sha256 || ''))
    fail('EXECUTOR_MANIFEST_INPUT_INVALID');
  if (!HASH.test(sourceBundleSha256 || ''))
    fail('EXECUTOR_EDIT_SOURCE_BUNDLE_REQUIRED');
  if (job?.candidate_pr !== undefined &&
      (job.schema !== 6 || job.kind !== 'opencode_edit' || !Number.isSafeInteger(job.candidate_pr) ||
        job.candidate_pr < 1 || !HASH.test(sourceBundleSha256 || '')))
    fail('EXECUTOR_CANDIDATE_BUNDLE_REQUIRED');
  return { schema: 1, kind: 'PTYSD_NATIVE_EXECUTOR_MANIFEST_V1',
    request_id: job.request_id, attempt_id: attemptId, source_sha: job.source_sha,
    spec_sha256: job.spec_sha256, job, spec,
    source_bundle_sha256: sourceBundleSha256.toLowerCase() };
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
  if (manifest?.job?.kind !== 'opencode_edit')
    fail(manifest?.job?.kind === 'opencode_plan'
      ? 'EXECUTOR_READONLY_PLAN_RETIRED' : 'EXECUTOR_JOB_KIND_UNSUPPORTED');
  assertExecutorTaskReady(descriptor, { currentSid, filesystemPath, readTaskXml });
  const payload = makeExecutorManifest(manifest.job, manifest.spec, manifest.attempt_id,
    manifest.source_bundle_sha256 ?? null);
  if (payload.request_id !== manifest.request_id || payload.source_sha !== manifest.source_sha)
    fail('EXECUTOR_MANIFEST_IDENTITY_MISMATCH');
  if (payload.job.kind === 'opencode_edit') {
    const bundle = candidateBundlePath(filesystemPath(descriptor.manifest_dir), payload.attempt_id);
    let stat;
    try { stat = lstatSync(bundle); } catch { fail('EXECUTOR_CANDIDATE_BUNDLE_UNAVAILABLE'); }
    if (!stat.isFile() || stat.isSymbolicLink() ||
        createHash('sha256').update(readFileSync(bundle)).digest('hex') !== payload.source_bundle_sha256)
      fail('EXECUTOR_CANDIDATE_BUNDLE_HASH_MISMATCH');
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
  currentSid = getCurrentWindowsSid,
  filesystemPath = value => value,
  readTaskXml = taskName => execFileSync('schtasks.exe', ['/Query', '/TN', taskName, '/XML'], {
    encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
  }),
  runTask = taskName => execFileSync('schtasks.exe', ['/Run', '/TN', taskName], {
    encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
  }),
  readProcessTree = readWindowsProcessTree,
  expectedJob,
} = {}) {
  if (!ATTEMPT.test(attemptId || '')) fail('EXECUTOR_ATTEMPT_NOT_EXPECTED_PENDING');
  if (!expectedJob || typeof expectedJob !== 'object' || Array.isArray(expectedJob))
    fail('EXECUTOR_EXPECTED_JOB_REQUIRED');
  const manifestDir = filesystemPath(descriptor.manifest_dir);
  const initial = executorMailboxState(manifestDir);
  const pendingName = `${attemptId}.pending.json`;
  const runningName = `${attemptId}.running.json`;
  const pending = initial.active.length === 1 && initial.active[0] === pendingName;
  const running = initial.active.length === 1 && initial.active[0] === runningName;
  if (!pending && !running) fail('EXECUTOR_ATTEMPT_NOT_EXPECTED_PENDING');
  const ready = assertExecutorTaskReady(descriptor, { currentSid, filesystemPath, readTaskXml,
    ...(pending ? { expectedPendingAttemptId: attemptId } : { expectedRunningAttemptId: attemptId }) });
  const manifestPath = join(manifestDir, pending ? pendingName : runningName);
  const resultDir = filesystemPath(descriptor.results_dir);
  const readManifest = () => {
    let stat;
    try { stat = lstatSync(manifestPath); } catch { fail('EXECUTOR_ATTEMPT_NOT_EXPECTED_PENDING'); }
    if (!stat.isFile() || stat.isSymbolicLink()) fail('EXECUTOR_PENDING_MANIFEST_NOT_REGULAR');
    let manifest;
    let bytes;
    try { bytes = readFileSync(manifestPath); manifest = JSON.parse(bytes.toString('utf8')); }
    catch { fail('EXECUTOR_PENDING_MANIFEST_INVALID'); }
    const { job, spec } = manifest || {};
    if (manifest.schema !== 1 || manifest.kind !== 'PTYSD_NATIVE_EXECUTOR_MANIFEST_V1' ||
        manifest.attempt_id !== attemptId || !REQUEST.test(manifest.request_id || '') ||
        typeof spec !== 'string' || !/^[a-f0-9]{64}$/i.test(manifest.spec_sha256 || '') ||
        !job || manifest.request_id !== job.request_id || manifest.source_sha !== job.source_sha ||
        String(manifest.spec_sha256).toLowerCase() !== String(job.spec_sha256).toLowerCase() ||
        createHash('sha256').update(spec, 'utf8').digest('hex') !== String(manifest.spec_sha256).toLowerCase() ||
        !SHA.test(manifest.source_sha || '') || (expectedJob && !sameJson(job, expectedJob)) ||
        existsSync(executorResultPath(resultDir, manifest.request_id, attemptId)))
      fail('EXECUTOR_PENDING_MANIFEST_IDENTITY_MISMATCH');
    return { bytes, manifest };
  };
  const original = readManifest();
  const current = executorMailboxState(manifestDir);
  const expectedName = pending ? pendingName : runningName;
  if (current.active.length !== 1 || current.active[0] !== expectedName)
    fail('EXECUTOR_ATTEMPT_NOT_EXPECTED_PENDING');
  const reread = readManifest();
  if (!reread.bytes.equals(original.bytes)) fail('EXECUTOR_PENDING_MANIFEST_CHANGED');
  let processEvidence = null;
  if (running) {
    processEvidence = readExecutorProcessEvidence(resultDir, original.manifest, original.bytes);
    const status = classifyExecutorProcessTree(processEvidence.record, readProcessTree);
    if (status.state !== 'DEAD') fail('EXECUTOR_PROCESS_TREE_UNRESOLVED');
    const latestEvidence = readExecutorProcessEvidence(resultDir, original.manifest, original.bytes);
    const latestMailbox = executorMailboxState(manifestDir);
    if (!latestEvidence.bytes.equals(processEvidence.bytes) || latestMailbox.active.length !== 1 ||
        latestMailbox.active[0] !== runningName || !readManifest().bytes.equals(original.bytes) ||
        existsSync(executorResultPath(resultDir, original.manifest.request_id, attemptId)))
      fail('EXECUTOR_RECOVERY_ATTEMPT_CHANGED');
  }
  try { runTask(descriptor.task_name); }
  catch { fail('EXECUTOR_TASK_START_UNKNOWN'); }
  return { outcome: pending ? 'EXECUTOR_PENDING_ATTEMPT_TRIGGERED_NOT_ACCEPTANCE' :
    'EXECUTOR_RUNNING_ATTEMPT_RECOVERY_TRIGGERED_NOT_ACCEPTANCE', exit_code: 0,
    attempt_id: attemptId, task_ready: ready.ready,
    process_id: processEvidence?.record.process_id ?? null };
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

export function executorProcessPath(resultsDir, attemptId) {
  if (typeof resultsDir !== 'string' || !ATTEMPT.test(attemptId || ''))
    fail('EXECUTOR_PROCESS_ID_INVALID');
  return join(resultsDir, `executor-process-${attemptId}.json`);
}

function processEvidenceDigest(value) { return createHash('sha256').update(value).digest('hex'); }

export function readExecutorProcessEvidence(resultsDir, manifest, manifestBytes) {
  const path = executorProcessPath(resultsDir, manifest?.attempt_id);
  let info;
  try { info = lstatSync(path); } catch { fail('EXECUTOR_PROCESS_EVIDENCE_UNAVAILABLE'); }
  if (!info.isFile() || info.isSymbolicLink()) fail('EXECUTOR_PROCESS_EVIDENCE_NOT_REGULAR');
  let record;
  let bytes;
  try { bytes = readFileSync(path); record = JSON.parse(bytes.toString('utf8')); }
  catch { fail('EXECUTOR_PROCESS_EVIDENCE_INVALID'); }
  const createdAt = record?.process_created_at;
  if (record?.schema !== 1 || record.kind !== 'PTYSD_NATIVE_EXECUTOR_PROCESS_V1' ||
      record.request_id !== manifest.request_id || record.attempt_id !== manifest.attempt_id ||
      record.source_sha !== manifest.source_sha || record.spec_sha256 !== manifest.spec_sha256 ||
      record.manifest_sha256 !== processEvidenceDigest(manifestBytes) ||
      record.job_sha256 !== processEvidenceDigest(JSON.stringify(manifest.job)) ||
      !Number.isSafeInteger(record.process_id) || record.process_id < 1 ||
      typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt)) ||
      new Date(createdAt).toISOString() !== createdAt ||
      typeof record.observed_at !== 'string' || Number.isNaN(Date.parse(record.observed_at)))
    fail('EXECUTOR_PROCESS_EVIDENCE_IDENTITY_MISMATCH');
  return { record, bytes };
}

export function classifyExecutorProcessTree(record, readProcessTree = readWindowsProcessTree) {
  let tree;
  try { tree = readProcessTree(record.process_id); }
  catch { return { state: 'UNKNOWN', tree: null }; }
  const exactIds = Array.isArray(tree?.process_ids) &&
    tree.process_ids.every(pid => Number.isSafeInteger(pid) && pid > 0);
  if (tree?.root_pid !== record.process_id || !exactIds || tree.error !== null)
    return { state: 'UNKNOWN', tree };
  if (tree.state === 'DEAD' && tree.process_ids.length === 0)
    return { state: 'DEAD', tree };
  if (tree.state !== 'ALIVE' || tree.process_ids.length === 0)
    return { state: 'UNKNOWN', tree };
  if (!tree.process_ids.includes(record.process_id))
    return { state: 'ALIVE', tree };
  if (tree.root_created_at === record.process_created_at)
    return { state: 'ALIVE', tree };
  if (typeof tree.root_created_at === 'string' && !Number.isNaN(Date.parse(tree.root_created_at)) &&
      tree.process_ids.length === 1)
    return { state: 'DEAD', tree, reason: 'ROOT_PID_REUSED_WITHOUT_DESCENDANTS' };
  return { state: 'UNKNOWN', tree, reason: 'ROOT_PROCESS_IDENTITY_CHANGED' };
}

export function cleanupExecutorAttempt(descriptor, attemptId, {
  preserveCandidateWorkspace = false, remove = rmSync,
} = {}) {
  validateExecutorDescriptor(descriptor);
  if (!ATTEMPT.test(attemptId || '')) fail('EXECUTOR_RESULT_ID_INVALID');
  for (const suffix of ['pending', 'running']) {
    remove(join(descriptor.manifest_dir, `${attemptId}.${suffix}.json`), { force: true });
  }
  remove(candidateBundlePath(descriptor.manifest_dir, attemptId), { force: true });
  remove(executorProcessPath(descriptor.results_dir, attemptId), { force: true });
  if (!preserveCandidateWorkspace)
    remove(candidateWorkspacePath(descriptor.results_dir, attemptId), { force: true, recursive: true });
}
