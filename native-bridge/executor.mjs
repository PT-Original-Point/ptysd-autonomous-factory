#!/usr/bin/env node
// Dedicated Task Scheduler entrypoint. It has no GitHub publisher API calls.
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { guardConfig, JOB_MARKER, parseJob, receipt, runPlan, terminalStateForResult } from './worker.mjs';
import { assertPhysicalDirectory, candidateBundlePath, candidateWorkspacePath,
  claimPendingManifest, executorResultPath, getCurrentWindowsSid } from './windows-executor.mjs';

const SID = /^S-1-(?:\d+-)+\d+$/i;
const RESERVED_SIDS = new Set(['S-1-5-18', 'S-1-5-32-544']);
const HASH = /^[a-f0-9]{64}$/i;
const RECOVERABLE_PREFLIGHT_OUTCOMES = new Set([
  'V2_MODEL_EXECUTION_NOT_YET_APPROVED',
  'MODEL_NOT_EXPLICITLY_ALLOWED',
  'OPENCODE_V2_CLI_NOT_QUALIFIED',
  'OPENCODE_V2_AUTH_NOT_READY',
  'OPENCODE_V2_AUTH_METADATA_UNKNOWN',
  'V2_WORKSPACE_CONFIG_CONFLICT',
  'V2_WORKSPACE_CONFIG_UNKNOWN',
  'V2_WORKSPACE_CONFIG_READBACK_FAILED',
]);
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
  if (!['opencode_plan', 'opencode_edit'].includes(job?.kind) ||
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

function isRecoverablePreflightWait(result, job) {
  return ['opencode_plan', 'opencode_edit'].includes(job?.kind) &&
    result?.eligibility_state === 'WAITING' && result?.model_invoked === false &&
    RECOVERABLE_PREFLIGHT_OUTCOMES.has(result?.outcome);
}

function restorePendingManifest({ manifestDir, runningPath, manifest, runningBytes,
  target, rename = renameSync } = {}) {
  const pendingPath = join(manifestDir, `${manifest.attempt_id}.pending.json`);
  let current;
  try { current = lstatSync(runningPath); } catch { fail('EXECUTOR_WAITING_ATTEMPT_STATE_UNKNOWN'); }
  if (!current.isFile() || current.isSymbolicLink() ||
      !readFileSync(runningPath).equals(runningBytes) || existsSync(pendingPath) || existsSync(target))
    fail('EXECUTOR_WAITING_ATTEMPT_STATE_CHANGED');
  rename(runningPath, pendingPath);
  let restored;
  try { restored = lstatSync(pendingPath); } catch { fail('EXECUTOR_WAITING_MANIFEST_RESTORE_UNCONFIRMED'); }
  if (!restored.isFile() || restored.isSymbolicLink() ||
      !readFileSync(pendingPath).equals(runningBytes) || existsSync(runningPath))
    fail('EXECUTOR_WAITING_MANIFEST_RESTORE_UNCONFIRMED');
  return pendingPath;
}

export async function executePendingManifest({ config, manifestDir, currentSid = getCurrentWindowsSid,
  execute = runPlan, rename = renameSync } = {}) {
  if (process.platform !== 'win32') fail('EXECUTOR_WINDOWS_ONLY');
  const runtime = config?.executor_runtime;
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) fail('EXECUTOR_RUNTIME_CONFIG_REQUIRED');
  if (!SID.test(runtime.user_sid || '') || !SID.test(runtime.publisher_sid || '') ||
      RESERVED_SIDS.has(runtime.user_sid.toUpperCase()) || RESERVED_SIDS.has(runtime.publisher_sid.toUpperCase()) ||
      runtime.user_sid.toUpperCase() === runtime.publisher_sid.toUpperCase())
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
  if (!parsedJob || !['opencode_plan', 'opencode_edit'].includes(parsedJob.kind) || manifest.schema !== 1 ||
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
  if (manifest.source_bundle_sha256 !== undefined) {
    try {
      const workspace = materializeCandidateWorkspace(manifestDir, runtime.results_dir, manifest, parsedJob);
      executionConfig = { ...config, workspace };
    } catch (error) {
      const code = /^[A-Z0-9_]{1,72}$/.test(error?.code || '') ? error.code :
        'CANDIDATE_WORKSPACE_SETUP_UNKNOWN';
      result = { outcome: `CANDIDATE_WORKSPACE_SETUP_BLOCKED_${code}`,
        exit_code: -1, evidence_sha256: null, evidence_bytes: 0 };
    }
  }
  if (!result) {
    try { result = await execute(manifest.spec, executionConfig, parsedJob, manifest.attempt_id); }
    catch (error) {
      result = { outcome: `EXECUTION_ERROR_${String(error?.code || 'UNKNOWN').slice(0, 36)}`,
        exit_code: -1, evidence_sha256: null, evidence_bytes: 0 };
    }
  }
  if (isRecoverablePreflightWait(result, parsedJob)) {
    const pendingPath = restorePendingManifest({ manifestDir, runningPath, manifest,
      runningBytes, target });
    return { outcome: 'EXECUTOR_WAITING_PREFLIGHT_RESTORED', exit_code: 0,
      terminal_state: 'WAITING', model_invoked: false, pending_path: pendingPath,
      attempt_id: manifest.attempt_id };
  }
  const terminal = receipt(parsedJob.request_id, manifest.attempt_id,
    terminalStateForResult(result), parsedJob, result);
  atomicJson(target, { request_id: parsedJob.request_id, attempt_id: manifest.attempt_id,
    terminal, local_evidence: result.local_evidence ?? null });
  return { outcome: 'EXECUTOR_RESULT_PERSISTED_NOT_SEMANTIC_ACCEPTANCE',
    exit_code: terminal.exit_code, terminal_state: terminal.state, result_path: target,
    evidence_sha256: terminal.evidence_sha256, evidence_bytes: terminal.evidence_bytes };
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
    console.error(`NATIVE_EXECUTOR_BLOCKED: ${String(error?.code || error?.message || 'UNKNOWN').slice(0, 120)}`);
    process.exitCode = 2;
  });
}
