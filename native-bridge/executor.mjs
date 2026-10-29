#!/usr/bin/env node
// Dedicated Task Scheduler entrypoint. It has no GitHub publisher API calls.
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync,
  renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { guardConfig, isRecoverableModelPreflightWait, JOB_MARKER, parseJob,
  parseReceipt, RECEIPT_MARKER, receipt, runPlan, terminalStateForResult } from './worker.mjs';
import { safeErrorCode } from './safe-error-code.mjs';
import { assertPhysicalDirectory, candidateBundlePath, candidateWorkspacePath,
  claimPendingManifest, executorResultPath, getCurrentWindowsSid } from './windows-executor.mjs';

const SID = /^S-1-(?:\d+-)+\d+$/i;
const RESERVED_SIDS = new Set(['S-1-5-18', 'S-1-5-32-544']);
const HASH = /^[a-f0-9]{64}$/i;
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function runGit(args, code, options) {
  try { return execFileSync('git', args, options); }
  catch (cause) { const error = new Error(code, { cause }); error.code = code; throw error; }
}

function hashFile(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const input = createReadStream(path);
    input.on('data', chunk => hash.update(chunk));
    input.once('error', reject);
    input.once('end', () => resolveHash(hash.digest('hex')));
  });
}

function physicalDirectoryIdentity(path) {
  if (typeof path !== 'string' || !path) fail('EXECUTOR_EDIT_ROOT_PATH_UNAVAILABLE');
  assertPhysicalDirectory(path, 'EXECUTOR_EDIT_ROOT_NOT_PHYSICAL_DIRECTORY');
  let physicalPath;
  let info;
  try {
    physicalPath = realpathSync.native(path);
    info = statSync(physicalPath, { bigint: true });
  } catch { fail('EXECUTOR_EDIT_ROOT_IDENTITY_UNAVAILABLE'); }
  if (!info.isDirectory()) fail('EXECUTOR_EDIT_ROOT_NOT_DIRECTORY');
  const identity = { physical_path: physicalPath.replaceAll('\\', '/'),
    volume_id: info.dev.toString(), file_id: info.ino.toString() };
  return { ...identity, sha256: digest(Buffer.from(JSON.stringify(identity), 'utf8')) };
}

function statusRecords(statusBytes) {
  return statusBytes.toString('utf8').split('\0').filter(Boolean).map(record => {
    if (record.length < 4 || record[2] !== ' ')
      fail('EXECUTOR_EDIT_ROOT_STATUS_FORMAT_INVALID');
    return { status: record.slice(0, 2), path: record.slice(3).replaceAll('\\', '/') };
  });
}

function isInsidePhysicalRoot(root, path) {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function captureWorkspaceSnapshot(workspace) {
  const identity = physicalDirectoryIdentity(workspace);
  const head = runGit(['-C', workspace, 'rev-parse', 'HEAD'],
    'EXECUTOR_EDIT_ROOT_HEAD_READBACK_FAILED', {
      encoding: 'utf8', windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const statusBytes = runGit(['-C', workspace, 'status', '--porcelain=v1', '-z',
    '--untracked-files=all', '--no-renames'], 'EXECUTOR_EDIT_ROOT_STATUS_READBACK_FAILED', {
    windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const records = statusRecords(statusBytes);
  const ignoredBytes = runGit(['-C', workspace, 'ls-files', '--others', '--ignored',
    '--exclude-standard', '-z'], 'EXECUTOR_EDIT_ROOT_IGNORED_READBACK_FAILED', {
    windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const seenPaths = new Set(records.map(record => process.platform === 'win32'
    ? record.path.toLowerCase() : record.path));
  for (const rawPath of ignoredBytes.toString('utf8').split('\0').filter(Boolean)) {
    const path = rawPath.replaceAll('\\', '/');
    const key = process.platform === 'win32' ? path.toLowerCase() : path;
    if (!seenPaths.has(key)) records.push({ status: '!!', path });
  }
  const changedFiles = [];
  for (const record of records) {
    const path = resolve(workspace, record.path);
    if (!isInsidePhysicalRoot(identity.physical_path, path))
      fail('EXECUTOR_EDIT_ROOT_STATUS_PATH_ESCAPED');
    let info;
    try { info = lstatSync(path); }
    catch (error) {
      if (error?.code === 'ENOENT') {
        changedFiles.push({ status: record.status, path: record.path, state: 'MISSING' });
        continue;
      }
      fail('EXECUTOR_EDIT_ROOT_FILE_READBACK_FAILED');
    }
    if (info.isSymbolicLink() || !info.isFile())
      fail('EXECUTOR_EDIT_ROOT_REPARSE_OR_NONFILE_UNVERIFIED');
    let physicalFile;
    try { physicalFile = realpathSync.native(path); }
    catch { fail('EXECUTOR_EDIT_ROOT_FILE_REALPATH_UNAVAILABLE'); }
    if (!isInsidePhysicalRoot(identity.physical_path, physicalFile))
      fail('EXECUTOR_EDIT_ROOT_FILE_ESCAPED');
    changedFiles.push({ status: record.status, path: record.path, bytes: info.size,
      sha256: await hashFile(physicalFile) });
  }
  const stagedBytes = runGit(['-C', workspace, 'diff', '--cached', '--raw',
    '--no-abbrev', 'HEAD', '--'], 'EXECUTOR_EDIT_ROOT_INDEX_READBACK_FAILED', {
    windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { identity_sha256: identity.sha256, head,
    status_b64: statusBytes.toString('base64'), staged_b64: stagedBytes.toString('base64'),
    changed_files: changedFiles };
  return { identity, identity_sha256: identity.sha256,
    state_sha256: digest(Buffer.from(JSON.stringify(state), 'utf8')),
    changed_paths: changedFiles.map(file => file.path).sort(), changed: records.length > 0,
    changed_files: changedFiles };
}

function samePhysicalDirectory(left, right) {
  const normalizePath = value => process.platform === 'win32' ? value.toLowerCase() : value;
  if (normalizePath(left.physical_path) === normalizePath(right.physical_path)) return true;
  const reliableFileIds = left.volume_id !== '0' && left.file_id !== '0' &&
    right.volume_id !== '0' && right.file_id !== '0';
  return reliableFileIds && left.volume_id === right.volume_id && left.file_id === right.file_id;
}

function editScopesOverlap(left, right) {
  const normalize = value => (process.platform === 'win32' ? value.toLowerCase() : value)
    .replaceAll('\\', '/').replace(/\/+$/, '');
  return left.some(a => right.some(b => {
    const x = normalize(a), y = normalize(b);
    return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
  }));
}

function guardedResult(result, outcome, evidence) {
  return { ...result, outcome, exit_code: 46, scope_valid: false,
    cli_exit_code: result?.cli_exit_code ?? result?.exit_code ?? null,
    external_effects: 'UNKNOWN', source_diff_evidence: 'NOT_INSPECTED',
    task_acceptance: 'UNKNOWN', coding_state: 'SCOPE_VIOLATION_OR_ROOT_MISMATCH',
    diff_sha256: null, diff_bytes: null, changed_files: null,
    local_evidence: { ...result?.local_evidence, executor_workspace_guard: evidence } };
}

async function reconcileEditWorkspace(result, job, guard) {
  const before = {
    registered_root_identity_sha256: guard.registered_before.identity_sha256,
    registered_root_state_sha256: guard.registered_before.state_sha256,
    candidate_root_identity_sha256: guard.candidate_before.identity_sha256,
    candidate_root_state_sha256: guard.candidate_before.state_sha256,
  };
  const terminationState = result?.local_evidence?.termination_state;
  if (['ORPHAN_POSSIBLE', 'TERMINATION_UNCONFIRMED', 'TERMINATION_REQUESTED']
    .includes(terminationState))
    return guardedResult(result, 'EXECUTOR_EDIT_WORKSPACE_READBACK_SKIPPED_PROCESS_UNCONFIRMED',
      { ...before, readback: 'UNKNOWN_PROCESS_MAY_STILL_WRITE' });

  let registeredAfter;
  let candidateAfter;
  try {
    registeredAfter = await captureWorkspaceSnapshot(guard.registered_path);
    candidateAfter = await captureWorkspaceSnapshot(guard.candidate_path);
  } catch (error) {
    return guardedResult(result, 'EXECUTOR_EDIT_WORKSPACE_READBACK_UNKNOWN',
      { ...before, readback: 'FAILED', readback_error: safeErrorCode(error) });
  }
  const evidence = { ...before,
    registered_root_after_sha256: registeredAfter.state_sha256,
    candidate_root_after_sha256: candidateAfter.state_sha256,
    readback: 'COMPLETE',
    registered_root_changed_paths: registeredAfter.changed_paths.length,
    candidate_root_changed_paths: candidateAfter.changed_paths.length };
  if (registeredAfter.identity_sha256 !== guard.registered_before.identity_sha256 ||
      registeredAfter.state_sha256 !== guard.registered_before.state_sha256)
    return guardedResult(result, 'EXECUTOR_EDIT_REGISTERED_ROOT_CHANGED', evidence);

  const allowed = new Set((job.edit_paths ?? []).map(path =>
    process.platform === 'win32' ? path.toLowerCase() : path));
  const candidatePaths = candidateAfter.changed_paths.map(path =>
    process.platform === 'win32' ? path.toLowerCase() : path);
  if (candidatePaths.some(path => !allowed.has(path)))
    return guardedResult(result, 'EXECUTOR_EDIT_CANDIDATE_SCOPE_MISMATCH', evidence);

  const reportedPaths = Array.isArray(result?.changed_files)
    ? result.changed_files.map(path => process.platform === 'win32'
      ? String(path).replaceAll('\\', '/').toLowerCase() : String(path).replaceAll('\\', '/')).sort()
    : null;
  const actualPaths = candidatePaths.slice().sort();
  const reportedDiffBytes = result?.diff_bytes;
  const reportedDiffHash = result?.diff_sha256;
  const candidateDiffConsistent = candidatePaths.length
    ? result?.scope_valid === true && Number.isSafeInteger(reportedDiffBytes) && reportedDiffBytes > 0 &&
      HASH.test(reportedDiffHash || '') && reportedPaths !== null &&
      JSON.stringify(reportedPaths) === JSON.stringify(actualPaths)
    : (!Number.isSafeInteger(reportedDiffBytes) || reportedDiffBytes === 0) &&
      (!reportedPaths || reportedPaths.length === 0);
  if (!candidateDiffConsistent)
    return guardedResult(result, 'EXECUTOR_EDIT_CANDIDATE_DIFF_UNRECONCILED', evidence);

  return { ...result,
    local_evidence: { ...result?.local_evidence, executor_workspace_guard: evidence } };
}

function ensurePhysicalChildDirectory(parent, name, code) {
  assertPhysicalDirectory(parent, `${code}_PARENT_NOT_PHYSICAL`);
  const child = join(parent, name);
  try { lstatSync(child); }
  catch { mkdirSync(child); }
  assertPhysicalDirectory(child, code);
  return child;
}

function removeCandidateWorkspace(workspaceBase, attemptId, projectRoot = null) {
  if (projectRoot) {
    assertPhysicalDirectory(projectRoot, 'CANDIDATE_PROJECT_ROOT_NOT_PHYSICAL');
    const workspaceRoot = join(projectRoot, '.pty-native-executor');
    if (existsSync(workspaceRoot))
      assertPhysicalDirectory(workspaceRoot, 'CANDIDATE_WORKSPACE_BASE_NOT_PHYSICAL');
    const candidateRoot = join(workspaceRoot, 'candidate-workspaces');
    if (existsSync(candidateRoot))
      assertPhysicalDirectory(candidateRoot, 'CANDIDATE_WORKSPACE_ROOT_NOT_PHYSICAL');
  }
  const path = candidateWorkspacePath(workspaceBase, attemptId);
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('CANDIDATE_WORKSPACE_NOT_PHYSICAL_DIRECTORY');
  rmSync(path, { recursive: true, force: false });
  if (existsSync(path)) fail('CANDIDATE_WORKSPACE_CLEANUP_UNCONFIRMED');
}

function materializeCandidateWorkspace(manifestDir, workspaceBase, manifest, job, projectRoot = null) {
  if (!['opencode_plan', 'opencode_edit', 'antigravity_edit'].includes(job?.kind) ||
      !HASH.test(manifest.source_bundle_sha256 || ''))
    fail('CANDIDATE_SOURCE_BUNDLE_IDENTITY_INVALID');
  const bundleDir = resolve(manifestDir, 'candidate-bundles');
  assertPhysicalDirectory(bundleDir, 'CANDIDATE_SOURCE_BUNDLE_DIRECTORY_UNAVAILABLE');
  const bundle = candidateBundlePath(manifestDir, manifest.attempt_id);
  let bundleStat;
  try { bundleStat = lstatSync(bundle); } catch { fail('CANDIDATE_SOURCE_BUNDLE_UNAVAILABLE'); }
  if (!bundleStat.isFile() || bundleStat.isSymbolicLink() ||
      digest(readFileSync(bundle)) !== manifest.source_bundle_sha256.toLowerCase())
    fail('CANDIDATE_SOURCE_BUNDLE_HASH_MISMATCH');

  let workspaceRoot;
  if (projectRoot) {
    assertPhysicalDirectory(projectRoot, 'CANDIDATE_PROJECT_ROOT_NOT_PHYSICAL');
    if (resolve(workspaceBase) !== resolve(projectRoot, '.pty-native-executor'))
      fail('CANDIDATE_WORKSPACE_BASE_OUTSIDE_PROJECT');
    const executorRoot = ensurePhysicalChildDirectory(projectRoot, '.pty-native-executor',
      'CANDIDATE_WORKSPACE_BASE_NOT_PHYSICAL');
    workspaceRoot = ensurePhysicalChildDirectory(executorRoot, 'candidate-workspaces',
      'CANDIDATE_WORKSPACE_ROOT_NOT_PHYSICAL');
    const projectReal = realpathSync(projectRoot);
    const candidateRootReal = realpathSync(workspaceRoot);
    const remainder = relative(projectReal, candidateRootReal);
    if (remainder === '..' || isAbsolute(remainder) || remainder.startsWith(`..${sep}`))
      fail('CANDIDATE_WORKSPACE_ROOT_OUTSIDE_PROJECT');
  } else {
    workspaceRoot = resolve(workspaceBase, 'candidate-workspaces');
    mkdirSync(workspaceRoot, { recursive: true });
    assertPhysicalDirectory(workspaceRoot, 'CANDIDATE_WORKSPACE_ROOT_NOT_PHYSICAL');
  }
  const workspace = candidateWorkspacePath(workspaceBase, manifest.attempt_id);
  if (existsSync(workspace)) fail('CANDIDATE_WORKSPACE_ALREADY_EXISTS_NO_REUSE');
  const bundleRef = `refs/pty-native/executor-bundles/${manifest.attempt_id}`;
  try {
    runGit(['init', '--quiet', workspace], 'CANDIDATE_WORKSPACE_CREATE_FAILED', {
      encoding: 'utf8', windowsHide: true, shell: false, timeout: 120000,
      maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    runGit(['-C', workspace, 'fetch', '--quiet', '--no-tags', bundle,
      `${bundleRef}:${bundleRef}`], 'CANDIDATE_WORKSPACE_FETCH_FAILED', {
      encoding: 'utf8', windowsHide: true, shell: false, timeout: 120000,
      maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    runGit(['-C', workspace, 'checkout', '--quiet', '--detach', job.source_sha],
      'CANDIDATE_WORKSPACE_CHECKOUT_FAILED', {
      encoding: 'utf8', windowsHide: true, shell: false, timeout: 60000,
      maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const actual = runGit(['-C', workspace, 'rev-parse', 'HEAD'],
      'CANDIDATE_WORKSPACE_HEAD_READBACK_FAILED', {
      encoding: 'utf8', windowsHide: true, shell: false, timeout: 30000,
      maxBuffer: 32768, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (actual.toLowerCase() !== job.source_sha.toLowerCase())
      fail('CANDIDATE_WORKSPACE_SOURCE_SHA_MISMATCH');
    assertPhysicalDirectory(workspace, 'CANDIDATE_WORKSPACE_NOT_PHYSICAL_DIRECTORY');
    return workspace;
  } catch (error) {
    try { removeCandidateWorkspace(workspaceBase, manifest.attempt_id, projectRoot); }
    catch { fail('CANDIDATE_WORKSPACE_FAILED_CLEANUP_UNKNOWN'); }
    throw error;
  }
}

function atomicJson(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  renameSync(temp, path);
}

// A persisted terminal result is untrusted bytes until they are read back and
// matched field-for-field. Bound the read by the exact serialized record just
// written; do not impose a fixed receipt-size ceiling.
export function readPersistedResult(path, { expectedBytes, statFile = lstatSync,
  readBytes = readFileSync } = {}) {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0)
    fail('EXECUTOR_RESULT_READBACK_FAILED');
  let info;
  try { info = statFile(path); } catch { fail('EXECUTOR_RESULT_READBACK_FAILED'); }
  if (!info || typeof info.isFile !== 'function' || !info.isFile() || info.isSymbolicLink() ||
      !Number.isSafeInteger(info.size) || info.size !== expectedBytes)
    fail('EXECUTOR_RESULT_READBACK_FAILED');
  let bytes;
  try { bytes = readBytes(path); } catch { fail('EXECUTOR_RESULT_READBACK_FAILED'); }
  const raw = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8');
  if (raw.length !== expectedBytes) fail('EXECUTOR_RESULT_READBACK_FAILED');
  let value;
  try { value = JSON.parse(raw.toString('utf8')); }
  catch { fail('EXECUTOR_RESULT_READBACK_FAILED'); }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('EXECUTOR_RESULT_READBACK_FAILED');
  return value;
}

function persistAndReadback(path, record, readPersisted, { readError, mismatchError }) {
  atomicJson(path, record);
  let persisted;
  try {
    persisted = readPersisted(path, {
      expectedBytes: Buffer.byteLength(JSON.stringify(record, null, 2), 'utf8'),
    });
  } catch { fail(readError); }
  if (!persisted || typeof persisted !== 'object' || Array.isArray(persisted) ||
      JSON.stringify(persisted) !== JSON.stringify(record))
    fail(mismatchError);
  return persisted;
}

function hasVerifiedCompletedRunningAttempt({ filename, manifestDir, resultsDir, config, readPersisted }) {
  const match = /^([a-f0-9-]{36})\.running\.json$/i.exec(filename);
  if (!match) fail('EXECUTOR_RUNNING_MANIFEST_IDENTITY_INVALID');
  const attemptId = match[1];
  const manifestPath = join(manifestDir, filename);
  let manifest;
  try {
    const info = lstatSync(manifestPath);
    if (!info.isFile() || info.isSymbolicLink()) fail('EXECUTOR_RUNNING_MANIFEST_INVALID');
    manifest = JSON.parse(readFileSync(manifestPath).toString('utf8'));
  } catch (error) {
    if (/^EXECUTOR_/.test(error?.code || '')) throw error;
    fail('EXECUTOR_RUNNING_MANIFEST_INVALID');
  }
  const job = parseJob(JOB_MARKER + JSON.stringify(manifest?.job));
  if (!job || manifest.schema !== 1 || manifest.kind !== 'PTYSD_NATIVE_EXECUTOR_MANIFEST_V1' ||
      manifest.attempt_id !== attemptId || manifest.request_id !== job.request_id ||
      manifest.source_sha !== job.source_sha || manifest.spec_sha256 !== job.spec_sha256 ||
      typeof manifest.spec !== 'string' ||
      digest(Buffer.from(manifest.spec, 'utf8')) !== job.spec_sha256 ||
      job.project_id !== config.project_id || job.host.toUpperCase() !== config.host.toUpperCase() ||
      manifest.source_bundle_sha256 !== undefined && !HASH.test(manifest.source_bundle_sha256 || ''))
    fail('EXECUTOR_RUNNING_MANIFEST_IDENTITY_INVALID');
  if (manifest.source_bundle_sha256 !== undefined) {
    const bundlePath = candidateBundlePath(manifestDir, attemptId);
    let bundleInfo;
    try { bundleInfo = lstatSync(bundlePath); }
    catch { fail('EXECUTOR_RUNNING_SOURCE_BUNDLE_UNAVAILABLE'); }
    if (!bundleInfo.isFile() || bundleInfo.isSymbolicLink() ||
        digest(readFileSync(bundlePath)) !== manifest.source_bundle_sha256)
      fail('EXECUTOR_RUNNING_SOURCE_BUNDLE_HASH_MISMATCH');
  }
  const resultPath = executorResultPath(resultsDir, job.request_id, attemptId);
  if (!existsSync(resultPath)) return false;
  let resultInfo;
  try { resultInfo = lstatSync(resultPath); }
  catch { fail('EXECUTOR_RESULT_READBACK_FAILED'); }
  if (!resultInfo.isFile() || resultInfo.isSymbolicLink())
    fail('EXECUTOR_RESULT_READBACK_FAILED');
  const saved = readPersisted(resultPath, { expectedBytes: resultInfo.size });
  const terminal = parseReceipt(RECEIPT_MARKER + JSON.stringify(saved?.terminal));
  if (!terminal || saved.request_id !== job.request_id || saved.attempt_id !== attemptId ||
      terminal.project_id !== job.project_id || terminal.host.toUpperCase() !== job.host.toUpperCase() ||
      terminal.request_id !== job.request_id || terminal.attempt_id !== attemptId ||
      terminal.kind !== job.kind || terminal.source_sha !== job.source_sha ||
      job.model !== undefined && terminal.model !== job.model ||
      job.variant !== undefined && terminal.variant !== job.variant ||
      job.source_pr !== undefined && terminal.source_pr !== job.source_pr ||
      job.goal_comment_id !== undefined && terminal.goal_comment_id !== job.goal_comment_id ||
      job.goal_body_sha256 !== undefined && terminal.goal_body_sha256 !== job.goal_body_sha256 ||
      Array.isArray(job.edit_paths) &&
        terminal.edit_paths_sha256 !== digest(Buffer.from(JSON.stringify(job.edit_paths), 'utf8')))
    fail('EXECUTOR_RUNNING_RESULT_IDENTITY_MISMATCH');
  return terminal.state === 'FINISHED';
}

export async function executePendingManifest({ config, manifestDir, currentSid = getCurrentWindowsSid,
  execute = runPlan, rename = renameSync, readPersisted = readPersistedResult } = {}) {
  if (process.platform !== 'win32') fail('EXECUTOR_WINDOWS_ONLY');
  const runtime = config?.executor_runtime;
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) fail('EXECUTOR_RUNTIME_CONFIG_REQUIRED');
  const executionPhase = runtime.execution_phase ?? 'VM_ISOLATED';
  const sameIdentity = SID.test(runtime.user_sid || '') && SID.test(runtime.publisher_sid || '') &&
    runtime.user_sid.toUpperCase() === runtime.publisher_sid.toUpperCase();
  if (!SID.test(runtime.user_sid || '') || !SID.test(runtime.publisher_sid || '') ||
      RESERVED_SIDS.has(runtime.user_sid.toUpperCase()) || RESERVED_SIDS.has(runtime.publisher_sid.toUpperCase()) ||
      !['WIN11_TRANSITION', 'VM_ISOLATED'].includes(executionPhase) ||
      (executionPhase === 'WIN11_TRANSITION' && !sameIdentity) ||
      (executionPhase === 'VM_ISOLATED' && sameIdentity))
    fail('EXECUTOR_RUNTIME_IDENTITY_INVALID');
  const actualSid = currentSid().toUpperCase();
  if (actualSid !== runtime.user_sid.toUpperCase()) fail('EXECUTOR_RUNTIME_IDENTITY_MISMATCH');
  if (typeof runtime.manifest_dir !== 'string' || typeof runtime.results_dir !== 'string' ||
      resolve(runtime.manifest_dir).toLowerCase() !== resolve(manifestDir).toLowerCase() ||
      resolve(runtime.results_dir).toLowerCase() !== resolve(config.state_dir).toLowerCase())
    fail('EXECUTOR_RUNTIME_PATH_MISMATCH');
  assertPhysicalDirectory(runtime.results_dir, 'EXECUTOR_RESULT_DIRECTORY_UNAVAILABLE');
  assertPhysicalDirectory(config.workspace, 'EXECUTOR_WORKSPACE_NOT_PHYSICAL_DIRECTORY');

  const runningPath = claimPendingManifest(manifestDir, rename, filename =>
    hasVerifiedCompletedRunningAttempt({ filename, manifestDir, resultsDir: runtime.results_dir,
      config, readPersisted }));
  if (!runningPath) return { outcome: 'NO_PENDING_EXECUTOR_MANIFEST', exit_code: 0 };

  const runningBytes = readFileSync(runningPath);
  const manifest = JSON.parse(runningBytes.toString('utf8'));
  const parsedJob = parseJob(JOB_MARKER + JSON.stringify(manifest.job));
  if (!parsedJob || !['opencode_plan', 'opencode_edit', 'antigravity_edit'].includes(parsedJob.kind) || manifest.schema !== 1 ||
      manifest.kind !== 'PTYSD_NATIVE_EXECUTOR_MANIFEST_V1' ||
      parsedJob.project_id !== config.project_id || parsedJob.host.toUpperCase() !== config.host.toUpperCase() ||
      manifest.request_id !== parsedJob.request_id || manifest.source_sha !== parsedJob.source_sha ||
      manifest.spec_sha256 !== parsedJob.spec_sha256 || typeof manifest.spec !== 'string' ||
      digest(Buffer.from(manifest.spec, 'utf8')) !== parsedJob.spec_sha256 ||
      !/^[a-f0-9-]{36}$/.test(manifest.attempt_id || '') ||
      basename(runningPath).toLowerCase() !== `${manifest.attempt_id}.running.json`.toLowerCase())
    fail('EXECUTOR_MANIFEST_IDENTITY_OR_HASH_INVALID');
  if (manifest.source_bundle_sha256 !== undefined && !HASH.test(manifest.source_bundle_sha256 || ''))
    fail('EXECUTOR_SOURCE_BUNDLE_HASH_INVALID');

  const target = executorResultPath(runtime.results_dir, parsedJob.request_id, manifest.attempt_id);
  if (existsSync(target)) fail('EXECUTOR_RESULT_ALREADY_EXISTS');

  let result;
  let executionConfig = config;
  let workspaceGuard = null;
  const editJobRequiresPinnedWorkspace = ['opencode_edit', 'antigravity_edit'].includes(parsedJob.kind);
  if (editJobRequiresPinnedWorkspace && manifest.source_bundle_sha256 === undefined) {
    const laneDisabled = parsedJob.kind === 'opencode_edit'
      ? config.enable_v2_model_runs !== true : config.enable_antigravity_model_runs !== true;
    if (laneDisabled) {
      result = { outcome: parsedJob.kind === 'opencode_edit'
        ? 'V2_MODEL_EXECUTION_NOT_YET_APPROVED' : 'ANTIGRAVITY_MODEL_RUNS_NOT_ENABLED',
      exit_code: 48, evidence_sha256: null, evidence_bytes: 0,
      eligibility_state: 'WAITING', model_invoked: false, coding_state: 'NOT_STARTED' };
    } else {
      // Never let an edit executor fall back to its configured publisher/source
      // workspace. The attempt-specific bundle is the only writable candidate.
      result = { outcome: 'EXECUTOR_EDIT_SOURCE_BUNDLE_REQUIRED', exit_code: 46,
        evidence_sha256: null, evidence_bytes: 0,
        eligibility_state: 'BLOCKED', model_invoked: false, coding_state: 'NOT_STARTED' };
    }
  }
  if (!result && manifest.source_bundle_sha256 !== undefined) {
    try {
      const antigravityProjectRoot = parsedJob.kind === 'antigravity_edit' ? config.workspace : null;
      // Keep attempt workspaces outside the registered project checkout. The
      // CLI receives the exact candidate through --add-dir, while readback of
      // the project root can then detect real escaped writes without treating
      // the candidate directory itself as an untracked project change.
      const workspace = materializeCandidateWorkspace(manifestDir, runtime.results_dir,
        manifest, parsedJob);
      executionConfig = { ...config, workspace,
        ...(antigravityProjectRoot ? { antigravity_project_root: antigravityProjectRoot } : {}) };
    } catch (error) {
      const code = safeErrorCode(error, 'CANDIDATE_WORKSPACE_SETUP_UNKNOWN');
      result = { outcome: `CANDIDATE_WORKSPACE_SETUP_BLOCKED_${code}`,
        exit_code: -1, evidence_sha256: null, evidence_bytes: 0 };
    }
  }
  if (!result && editJobRequiresPinnedWorkspace) {
    try {
      const registeredBefore = await captureWorkspaceSnapshot(config.workspace);
      const candidateBefore = await captureWorkspaceSnapshot(executionConfig.workspace);
      if (samePhysicalDirectory(registeredBefore.identity, candidateBefore.identity))
        fail('EXECUTOR_EDIT_WORKSPACES_NOT_PHYSICALLY_SEPARATE');
      if (registeredBefore.changed && editScopesOverlap(registeredBefore.changed_paths,
          parsedJob.edit_paths))
        fail('EXECUTOR_EDIT_REGISTERED_ROOT_DIRTY_SCOPE_CONFLICT');
      if (candidateBefore.changed) fail('EXECUTOR_EDIT_CANDIDATE_WORKSPACE_NOT_CLEAN');
      workspaceGuard = { registered_path: config.workspace,
        candidate_path: executionConfig.workspace, registered_before: registeredBefore,
        candidate_before: candidateBefore };
    } catch (error) {
      result = { outcome: 'EXECUTOR_EDIT_WORKSPACE_PRECHECK_BLOCKED', exit_code: 46,
        evidence_sha256: null, evidence_bytes: 0, model_invoked: false,
        external_effects: 'NONE', scope_valid: false, coding_state: 'NOT_STARTED',
        local_evidence: { executor_workspace_guard: {
          readback: 'PRECHECK_FAILED', error: safeErrorCode(error) } } };
    }
  }
  if (!result) {
    try { result = await execute(manifest.spec, executionConfig, parsedJob, manifest.attempt_id); }
    catch (error) {
      result = { outcome: `EXECUTION_ERROR_${safeErrorCode(error)}`,
        exit_code: -1, evidence_sha256: null, evidence_bytes: 0 };
    }
    if (workspaceGuard) result = await reconcileEditWorkspace(result, parsedJob, workspaceGuard);
  }
  if (isRecoverableModelPreflightWait(result, parsedJob)) {
    const waiting = receipt(parsedJob.request_id, manifest.attempt_id, 'WAITING', parsedJob, result);
    const persisted = persistAndReadback(target, {
      request_id: parsedJob.request_id, attempt_id: manifest.attempt_id,
      terminal: waiting, local_evidence: result.local_evidence ?? null,
    }, readPersisted, {
      readError: 'EXECUTOR_WAITING_RESULT_READBACK_FAILED',
      mismatchError: 'EXECUTOR_WAITING_RESULT_IDENTITY_MISMATCH',
    });
    if (persisted.terminal.state !== 'WAITING' || persisted.terminal.outcome !== result.outcome ||
        persisted.terminal.model_invoked !== false)
      fail('EXECUTOR_WAITING_RESULT_IDENTITY_MISMATCH');
    return { outcome: 'EXECUTOR_WAITING_PREFLIGHT_PERSISTED', exit_code: 0,
      terminal_state: 'WAITING', model_invoked: false, result_path: target,
      attempt_id: manifest.attempt_id };
  }
  const terminal = receipt(parsedJob.request_id, manifest.attempt_id,
    terminalStateForResult(result), parsedJob, result);
  const persistedRecord = { request_id: parsedJob.request_id, attempt_id: manifest.attempt_id,
    terminal, local_evidence: result.local_evidence ?? null };
  // Read the exact persisted bytes back before reporting persisted. A missing,
  // unreadable or mismatched readback is a fixed sanitized failure. It must not
  // rerun the model and must not delete the already-written, ambiguous result.
  const persisted = persistAndReadback(target, persistedRecord, readPersisted, {
    readError: 'EXECUTOR_RESULT_READBACK_FAILED',
    mismatchError: 'EXECUTOR_RESULT_READBACK_MISMATCH',
  });
  return { outcome: 'EXECUTOR_RESULT_PERSISTED_NOT_SEMANTIC_ACCEPTANCE',
    exit_code: persisted.terminal.exit_code, terminal_state: persisted.terminal.state,
    result_path: target, evidence_sha256: persisted.terminal.evidence_sha256,
    evidence_bytes: persisted.terminal.evidence_bytes };
}

async function main() {
  const configArg = process.argv.indexOf('--config');
  const manifestArg = process.argv.indexOf('--manifest-dir');
  if (configArg < 0 || !process.argv[configArg + 1] || manifestArg < 0 || !process.argv[manifestArg + 1])
    fail('USAGE: executor.mjs --config <executor-config.json> --manifest-dir <directory>');
  const config = guardConfig(JSON.parse(readFileSync(resolve(process.argv[configArg + 1]), 'utf8').replace(/^\uFEFF/, '')));
  const result = await executePendingManifest({ config, manifestDir: resolve(process.argv[manifestArg + 1]) });
  console.log(`${result.outcome}${result.terminal_state ? `_${result.terminal_state}` : ''}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`NATIVE_EXECUTOR_BLOCKED: ${safeErrorCode(error)}`);
    process.exitCode = 2;
  });
}
