#!/usr/bin/env node
// Dedicated Task Scheduler entrypoint. It has no GitHub publisher API calls.
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { guardConfig, isRecoverableModelPreflightWait, JOB_MARKER, parseJob,
  receipt, runPlan, terminalStateForResult } from './worker.mjs';
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

function removeCandidateWorkspace(resultsDir, attemptId) {
  const path = candidateWorkspacePath(resultsDir, attemptId);
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('CANDIDATE_WORKSPACE_NOT_PHYSICAL_DIRECTORY');
  rmSync(path, { recursive: true, force: false });
  if (existsSync(path)) fail('CANDIDATE_WORKSPACE_CLEANUP_UNCONFIRMED');
}

function materializeCandidateWorkspace(manifestDir, resultsDir, manifest, job) {
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

  const workspaceRoot = resolve(resultsDir, 'candidate-workspaces');
  mkdirSync(workspaceRoot, { recursive: true });
  assertPhysicalDirectory(workspaceRoot, 'CANDIDATE_WORKSPACE_ROOT_NOT_PHYSICAL');
  const workspace = candidateWorkspacePath(resultsDir, manifest.attempt_id);
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
    try { removeCandidateWorkspace(resultsDir, manifest.attempt_id); }
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

  const runningPath = claimPendingManifest(manifestDir, rename);
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
      const workspace = materializeCandidateWorkspace(manifestDir, runtime.results_dir, manifest, parsedJob);
      executionConfig = { ...config, workspace };
    } catch (error) {
      const code = safeErrorCode(error, 'CANDIDATE_WORKSPACE_SETUP_UNKNOWN');
      result = { outcome: `CANDIDATE_WORKSPACE_SETUP_BLOCKED_${code}`,
        exit_code: -1, evidence_sha256: null, evidence_bytes: 0 };
    }
  }
  if (!result) {
    try { result = await execute(manifest.spec, executionConfig, parsedJob, manifest.attempt_id); }
    catch (error) {
      result = { outcome: `EXECUTION_ERROR_${safeErrorCode(error)}`,
        exit_code: -1, evidence_sha256: null, evidence_bytes: 0 };
    }
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
