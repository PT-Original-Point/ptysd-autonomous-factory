#!/usr/bin/env node
// Dedicated Task Scheduler entrypoint. It has no GitHub publisher API calls.
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { guardConfig, JOB_MARKER, parseJob, receipt, runPlan, terminalStateForResult } from './worker.mjs';
import { assertPhysicalDirectory, candidateBundlePath, candidateWorkspacePath,
  classifyExecutorProcessTree, claimPendingManifest, executorMailboxState, executorProcessPath,
  executorResultPath, getCurrentWindowsSid, readExecutorProcessEvidence } from './windows-executor.mjs';
import { buildV2ScopedEditConfig } from './opencode-v2.mjs';
import { runCapturedProcess } from './captured-process.mjs';

const SID = /^S-1-(?:\d+-)+\d+$/i;
const RESERVED_SIDS = new Set(['S-1-5-18', 'S-1-5-32-544']);
const HASH = /^[a-f0-9]{64}$/i;
const RECOVERABLE_PREFLIGHT_OUTCOMES = new Set([
  'V2_MODEL_EXECUTION_NOT_YET_APPROVED',
  'MODEL_NOT_EXPLICITLY_ALLOWED',
  'V2_EDIT_EXECUTOR_IDENTITY_NOT_VERIFIED',
  'OPENCODE_V2_CLI_NOT_QUALIFIED',
  'V2_WORKSPACE_CONFIG_CONFLICT',
  'V2_WORKSPACE_CONFIG_UNKNOWN',
  'V2_WORKSPACE_CONFIG_READBACK_FAILED',
  'OPENCODE_V2_AUTH_NOT_READY',
  'OPENCODE_V2_AUTH_METADATA_UNKNOWN',
]);
const UNRESOLVED_CANDIDATE_SETUP_OUTCOMES = new Set([
  'CANDIDATE_WORKSPACE_SETUP_UNKNOWN',
  'CANDIDATE_WORKSPACE_ALREADY_EXISTS_NO_REUSE',
  'CANDIDATE_WORKSPACE_FAILED_CLEANUP_UNKNOWN',
  'CANDIDATE_WORKSPACE_CLEANUP_UNCONFIRMED',
]);
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function removeCandidateWorkspace(resultsDir, attemptId) {
  const path = candidateWorkspacePath(resultsDir, attemptId);
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('CANDIDATE_WORKSPACE_NOT_PHYSICAL_DIRECTORY');
  rmSync(path, { recursive: true, force: false });
  if (existsSync(path)) fail('CANDIDATE_WORKSPACE_CLEANUP_UNCONFIRMED');
}

function materializeCandidateWorkspace(manifestDir, resultsDir, manifest, job) {
  const sourcePinnedEdit = job?.kind === 'opencode_edit' &&
    ((job.schema === 4 && job.candidate_pr === undefined) ||
      ([5, 6].includes(job.schema) && Number.isSafeInteger(job.candidate_pr) && job.candidate_pr > 0));
  if (!sourcePinnedEdit || !HASH.test(manifest.source_bundle_sha256 || ''))
    fail('CANDIDATE_SOURCE_BUNDLE_IDENTITY_INVALID');
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
  try {
    // The bundle advertises an attempt-scoped ref outside refs/heads and refs/tags.
    // A normal `git clone <bundle>` can omit that ref, leaving the advertised
    // commit unavailable in the new repository. Fetch the exact ref explicitly.
    const bundleRef = `refs/pty-native/candidate-bundles/${manifest.attempt_id}`;
    execFileSync('git', ['init', '--quiet', workspace], {
      encoding: 'utf8', windowsHide: true, shell: false, timeout: 120000, maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    execFileSync('git', ['-C', workspace, 'fetch', '--quiet', '--no-tags', bundle,
      `${bundleRef}:${bundleRef}`], {
      encoding: 'utf8', windowsHide: true, shell: false, timeout: 120000, maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    execFileSync('git', ['-C', workspace, 'checkout', '--quiet', '--detach', job.source_sha], {
      encoding: 'utf8', windowsHide: true, shell: false, timeout: 60000, maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], {
      encoding: 'utf8', windowsHide: true, shell: false, timeout: 30000, maxBuffer: 32768,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim().toLowerCase() !== job.source_sha.toLowerCase())
      fail('CANDIDATE_WORKSPACE_SOURCE_SHA_MISMATCH');
    return workspace;
  } catch (error) {
    try { removeCandidateWorkspace(resultsDir, manifest.attempt_id); }
    catch { fail('CANDIDATE_WORKSPACE_FAILED_CLEANUP_UNKNOWN'); }
    throw error;
  }
}
function isRecoverablePreflightWait(result, job) {
  return ['opencode_plan', 'opencode_edit'].includes(job?.kind) &&
    result?.eligibility_state === 'WAITING' && result?.model_invoked === false &&
    RECOVERABLE_PREFLIGHT_OUTCOMES.has(result?.outcome);
}

function restorePendingManifest({ manifestDir, runningPath, manifest, runningBytes,
  target, rename = renameSync } = {}) {
  const pendingPath = join(manifestDir, manifest.attempt_id + '.pending.json');
  const current = lstatSync(runningPath);
  if (!current.isFile() || current.isSymbolicLink() ||
      !readFileSync(runningPath).equals(runningBytes) ||
      existsSync(pendingPath) || existsSync(target))
    fail('EXECUTOR_WAITING_ATTEMPT_STATE_CHANGED');
  rename(runningPath, pendingPath);
  const restored = lstatSync(pendingPath);
  if (!restored.isFile() || restored.isSymbolicLink() ||
      !readFileSync(pendingPath).equals(runningBytes) || existsSync(runningPath))
    fail('EXECUTOR_WAITING_MANIFEST_RESTORE_UNCONFIRMED');
  return pendingPath;
}

function atomicJson(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  renameSync(temp, path);
}

async function hashInterruptedCapture(path) {
  let info;
  try { info = lstatSync(path); }
  catch (error) {
    if (error?.code !== 'ENOENT') fail('EXECUTOR_INTERRUPTED_OUTPUT_READBACK_FAILED');
    try { writeFileSync(path, Buffer.alloc(0), { flag: 'wx', mode: 0o600 }); }
    catch { fail('EXECUTOR_INTERRUPTED_OUTPUT_CREATE_UNKNOWN'); }
    info = lstatSync(path);
  }
  if (!info.isFile() || info.isSymbolicLink()) fail('EXECUTOR_INTERRUPTED_OUTPUT_NOT_REGULAR');
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of createReadStream(path)) { hash.update(chunk); bytes += chunk.length; }
  } catch { fail('EXECUTOR_INTERRUPTED_OUTPUT_READBACK_FAILED'); }
  return { sha256: hash.digest('hex'), bytes };
}

async function interruptedCaptureEvidence(resultsDir, job, attemptId, processRecord, processTree) {
  const stdoutFile = `output-${job.request_id}-${attemptId}.stdout.bin`;
  const stderrFile = `output-${job.request_id}-${attemptId}.stderr.bin`;
  const [stdout, stderr] = await Promise.all([
    hashInterruptedCapture(resolve(resultsDir, stdoutFile)),
    hashInterruptedCapture(resolve(resultsDir, stderrFile)),
  ]);
  return { stdoutFile, stderrFile, localEvidence: {
    stdout_file: stdoutFile, stderr_file: stderrFile,
    stdout_sha256: stdout.sha256, stdout_bytes: stdout.bytes,
    stderr_sha256: stderr.sha256, stderr_bytes: stderr.bytes,
    storage_error: null, capture_error: 'EXECUTOR_INTERRUPTED_BEFORE_CAPTURE_FINALIZATION',
    spawn_error: null, process_error: null, stdin_error: null,
    termination_state: 'PROCESS_TREE_READBACK_DEAD', termination_error: null,
    process_id: processRecord.process_id, process_tree_state: 'DEAD',
    process_tree_readback: processTree, exit_signal: null, capture_complete: false,
  } };
}

function gitText(workspace, args) {
  return execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8',
    windowsHide: true, shell: false, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
}

function statusEntries(text) {
  if (!text.trim()) return [];
  return text.split(/\r?\n/).filter(Boolean).map(line => {
    if (line.length < 4 || line[2] !== ' ') fail('EDIT_GIT_STATUS_FORMAT_INVALID');
    const status = line.slice(0, 2);
    const path = line.slice(3);
    if (!path || /[RC]/.test(status) || path.startsWith('"') || path.includes(' -> '))
      fail('EDIT_GIT_STATUS_PATH_UNSUPPORTED');
    return { status, path: path.replaceAll('\\', '/') };
  });
}

function editPolicyBytes(workspace, job) {
  return JSON.stringify(buildV2ScopedEditConfig(workspace, job.write_paths));
}

function assertEditWorkspaceReady(workspace, job) {
  if (gitText(workspace, ['rev-parse', 'HEAD']).trim().toLowerCase() !== job.source_sha.toLowerCase())
    fail('EDIT_WORKSPACE_SOURCE_SHA_MISMATCH');
  const tracked = new Set(gitText(workspace, ['ls-files', '--error-unmatch', '--', ...job.write_paths])
    .split(/\r?\n/).filter(Boolean).map(value => value.replaceAll('\\', '/')));
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
  for (const path of job.write_paths) {
    if (![...tracked].some(item => normalize(item) === normalize(path)))
      fail('EDIT_ALLOWLIST_TARGET_NOT_TRACKED');
  }
  const policy = editPolicyBytes(workspace, job);
  const entries = statusEntries(gitText(workspace, ['status', '--porcelain=v1', '--untracked-files=all']));
  for (const entry of entries) {
    if (entry.path !== 'opencode.json' || readFileSync(resolve(workspace, entry.path), 'utf8') !== policy)
      fail('EDIT_WORKSPACE_DIRTY_BEFORE_EXECUTION');
  }
}

async function captureScopedEditDiff(workspace, resultsDir, job, attemptId, result) {
  const allowed = new Set(job.write_paths.map(value =>
    process.platform === 'win32' ? value.toLowerCase() : value));
  const policy = editPolicyBytes(workspace, job);
  const entries = statusEntries(gitText(workspace, ['status', '--porcelain=v1', '--untracked-files=all']));
  const changed = [];
  for (const entry of entries) {
    if (entry.path === 'opencode.json' && readFileSync(resolve(workspace, entry.path), 'utf8') === policy) {
      if (entry.status.includes('?')) rmSync(resolve(workspace, entry.path));
      continue;
    }
    const key = process.platform === 'win32' ? entry.path.toLowerCase() : entry.path;
    if (!allowed.has(key)) fail('OPENCODE_EDIT_OUT_OF_SCOPE_CHANGE');
    if (entry.status.includes('?')) fail('OPENCODE_EDIT_UNTRACKED_FILE_UNSUPPORTED');
    changed.push(entry.path);
  }
  const changedPaths = gitText(workspace,
    ['diff', '--name-only', '--no-renames', 'HEAD', '--', ...job.write_paths])
    .split(/\r?\n/).filter(Boolean).map(value => value.replaceAll('\\', '/')).sort();
  if (changedPaths.some(value => !allowed.has(process.platform === 'win32' ? value.toLowerCase() : value)))
    fail('OPENCODE_EDIT_DIFF_SCOPE_MISMATCH');
  const statusPaths = changed.slice().sort();
  if (changedPaths.length !== statusPaths.length || changedPaths.some((value, index) =>
      (process.platform === 'win32' ? value.toLowerCase() : value) !==
      (process.platform === 'win32' ? statusPaths[index]?.toLowerCase() : statusPaths[index])))
    fail('OPENCODE_EDIT_STATUS_DIFF_MISMATCH');

  const diffFile = `diff-${job.request_id}-${attemptId}.patch`;
  const stderrFile = `diff-${job.request_id}-${attemptId}.stderr.bin`;
  const diffPath = resolve(resultsDir, diffFile);
  const stderrPath = resolve(resultsDir, stderrFile);
  const diff = await runCapturedProcess('git', ['-C', workspace, 'diff', '--binary',
    '--no-ext-diff', '--no-textconv', '--no-renames', 'HEAD', '--', ...job.write_paths], {
    cwd: workspace, env: { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' },
    stdoutPath: diffPath, stderrPath,
    terminate: child => ({ rootOnly: child.kill(), error: 'GIT_DIFF_TREE_STATUS_UNKNOWN' }),
  });
  if (diff.exit_code !== 0 || diff.outcome !== 'OPENCODE_V2_EXIT_0_UNTRUSTED' ||
      diff.local_evidence.storage_error || diff.local_evidence.capture_error)
    fail('OPENCODE_EDIT_DIFF_CAPTURE_FAILED');
  const evidence = diff.local_evidence;
  return { ...result, changed_paths: changedPaths, diff_sha256: evidence.stdout_sha256,
    diff_evidence: { file: diffFile, sha256: evidence.stdout_sha256,
      bytes: evidence.stdout_bytes, stderr_file: stderrFile,
      stderr_sha256: evidence.stderr_sha256, stderr_bytes: evidence.stderr_bytes } };
}

export async function executePendingManifest({ config, manifestDir, currentSid = getCurrentWindowsSid,
  execute = runPlan, rename = renameSync, platformName = process.platform,
  readProcessTree = undefined } = {}) {
  if (platformName !== 'win32') fail('EXECUTOR_WINDOWS_ONLY');
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

  const mailbox = executorMailboxState(manifestDir);
  const runningEntries = mailbox.active.filter(name => name.endsWith('.running.json'));
  const pendingEntries = mailbox.active.filter(name => name.endsWith('.pending.json'));
  const recovering = runningEntries.length === 1 && pendingEntries.length === 0 && mailbox.active.length === 1;
  if ((runningEntries.length || pendingEntries.length) && !recovering &&
      !(runningEntries.length === 0 && pendingEntries.length === mailbox.active.length))
    fail('EXECUTOR_ATTEMPT_STATE_AMBIGUOUS');
  const runningPath = recovering ? join(manifestDir, runningEntries[0]) :
    claimPendingManifest(manifestDir, rename);
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

  const target = executorResultPath(runtime.results_dir, parsedJob.request_id, manifest.attempt_id);
  if (existsSync(target)) fail('EXECUTOR_RESULT_ALREADY_EXISTS');
  const isolatedEdit = parsedJob.kind === 'opencode_edit';
  if (isolatedEdit ? !(typeof manifest.source_bundle_sha256 === 'string' &&
      HASH.test(manifest.source_bundle_sha256)) : manifest.source_bundle_sha256 !== undefined)
    fail(isolatedEdit ? 'EXECUTOR_EDIT_SOURCE_BUNDLE_REQUIRED' : 'EXECUTOR_CANDIDATE_BUNDLE_UNEXPECTED');

  if (recovering) {
    let processEvidence;
    try { processEvidence = readExecutorProcessEvidence(runtime.results_dir, manifest, runningBytes); }
    catch (error) {
      return { outcome: 'EXECUTOR_RECOVERY_UNRESOLVED', exit_code: 0,
        eligibility_state: 'UNKNOWN', model_invoked: false, attempt_id: manifest.attempt_id,
        reason: String(error?.code || 'PROCESS_EVIDENCE_UNKNOWN') };
    }
    const processStatus = classifyExecutorProcessTree(processEvidence.record, readProcessTree);
    if (processStatus.state !== 'DEAD')
      return { outcome: 'EXECUTOR_RECOVERY_UNRESOLVED', exit_code: 0,
        eligibility_state: 'UNKNOWN', model_invoked: false, attempt_id: manifest.attempt_id,
        reason: processStatus.reason || `PROCESS_TREE_${processStatus.state}` };

    const captured = await interruptedCaptureEvidence(runtime.results_dir, parsedJob,
      manifest.attempt_id, processEvidence.record, processStatus.tree);
    let result = { outcome: 'EXECUTOR_INTERRUPTED_AFTER_PROCESS_START_UNVERIFIED',
      exit_code: -1, evidence_sha256: null, evidence_bytes: 0,
      local_evidence: captured.localEvidence };
    if (isolatedEdit) {
      const candidateWorkspace = candidateWorkspacePath(runtime.results_dir, manifest.attempt_id);
      try {
        const workspaceInfo = lstatSync(candidateWorkspace);
        if (!workspaceInfo.isDirectory() || workspaceInfo.isSymbolicLink())
          fail('CANDIDATE_WORKSPACE_NOT_PHYSICAL_DIRECTORY');
        if (gitText(candidateWorkspace, ['rev-parse', 'HEAD']).trim().toLowerCase() !== parsedJob.source_sha.toLowerCase())
          fail('EDIT_WORKSPACE_SOURCE_SHA_MISMATCH');
        result = await captureScopedEditDiff(candidateWorkspace, runtime.results_dir,
          parsedJob, manifest.attempt_id, result);
      } catch (error) {
        result = { ...result, outcome: String(error?.code || error?.message || 'EDIT_DIFF_UNKNOWN')
          .replace(/[^A-Z0-9_]/gi, '_').slice(0, 72).toUpperCase(), exit_code: -1,
          changed_paths: null, diff_sha256: null };
      }
    }
    const terminal = receipt(parsedJob.request_id, manifest.attempt_id,
      terminalStateForResult(result), parsedJob, result);
    const target = executorResultPath(runtime.results_dir, parsedJob.request_id, manifest.attempt_id);
    const state = executorMailboxState(manifestDir);
    if (state.active.length !== 1 || state.active[0] !== `${manifest.attempt_id}.running.json` ||
        !readFileSync(runningPath).equals(runningBytes) ||
        existsSync(target) || !readFileSync(executorProcessPath(runtime.results_dir, manifest.attempt_id))
          .equals(processEvidence.bytes))
      fail('EXECUTOR_RECOVERY_ATTEMPT_CHANGED');
    atomicJson(target, { request_id: parsedJob.request_id, attempt_id: manifest.attempt_id,
      terminal, local_evidence: result.local_evidence ?? null,
      diff_evidence: result.diff_evidence ?? null });
    return { outcome: 'EXECUTOR_INTERRUPTED_ATTEMPT_CAPTURED_UNVERIFIED_NOT_ACCEPTANCE',
      exit_code: terminal.exit_code, terminal_state: terminal.state, result_path: target,
      evidence_sha256: terminal.evidence_sha256, evidence_bytes: terminal.evidence_bytes };
  }

  let executionWorkspace = config.workspace;
  let candidateSetupFailed = false;
  let result;
  if (isolatedEdit) {
    try {
      executionWorkspace = materializeCandidateWorkspace(manifestDir, runtime.results_dir, manifest, parsedJob);
    } catch (error) {
      const code = /^[A-Z0-9_]{1,72}$/.test(error?.code || '') ? error.code :
        'CANDIDATE_WORKSPACE_SETUP_UNKNOWN';
      if (UNRESOLVED_CANDIDATE_SETUP_OUTCOMES.has(code))
        return { outcome: 'EXECUTOR_CANDIDATE_SETUP_UNRESOLVED', exit_code: 0,
          eligibility_state: 'UNKNOWN', model_invoked: false, attempt_id: manifest.attempt_id,
          reason: code };
      candidateSetupFailed = true;
      result = { outcome: `CANDIDATE_SETUP_BLOCKED_${code}`, exit_code: -1,
        evidence_sha256: null, evidence_bytes: 0, eligibility_state: 'BLOCKED', model_invoked: false };
    }
  }

  const executionConfig = executionWorkspace === config.workspace ? config :
    { ...config, workspace: executionWorkspace };
  if (!candidateSetupFailed) {
    try {
      if (parsedJob.kind === 'opencode_edit') assertEditWorkspaceReady(executionWorkspace, parsedJob);
      const persistProcessIdentity = (processId, identity) => {
        const createdAt = identity?.root_created_at;
        if (!Number.isSafeInteger(processId) || processId < 1 || identity?.state !== 'ALIVE' ||
            identity.root_pid !== processId || identity.error !== null ||
            !Array.isArray(identity.process_ids) || !identity.process_ids.includes(processId) ||
            typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt)) ||
            new Date(createdAt).toISOString() !== createdAt) return false;
        const record = { schema: 1, kind: 'PTYSD_NATIVE_EXECUTOR_PROCESS_V1',
          request_id: parsedJob.request_id, attempt_id: manifest.attempt_id,
          source_sha: parsedJob.source_sha, spec_sha256: parsedJob.spec_sha256,
          manifest_sha256: digest(runningBytes),
          job_sha256: digest(Buffer.from(JSON.stringify(manifest.job), 'utf8')),
          process_id: processId, process_created_at: createdAt,
          observed_at: new Date().toISOString() };
        const path = executorProcessPath(runtime.results_dir, manifest.attempt_id);
        try {
          writeFileSync(path, JSON.stringify(record), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
          const file = lstatSync(path);
          return file.isFile() && !file.isSymbolicLink() &&
            readFileSync(path, 'utf8') === JSON.stringify(record);
        } catch { return false; }
      };
      result = await execute(manifest.spec, executionConfig, parsedJob, manifest.attempt_id,
        { onProcessSpawn: persistProcessIdentity });
    }
    catch (error) {
      result = { outcome: `EXECUTION_ERROR_${String(error?.code || 'UNKNOWN').slice(0, 36)}`,
        exit_code: -1, evidence_sha256: null, evidence_bytes: 0 };
    }
  }
  if (!candidateSetupFailed && isRecoverablePreflightWait(result, parsedJob)) {
    if (isolatedEdit) removeCandidateWorkspace(runtime.results_dir, manifest.attempt_id);
    restorePendingManifest({ manifestDir, runningPath, manifest, runningBytes, target, rename });
    return { outcome: 'EXECUTOR_ATTEMPT_WAITING_REEVALUATE', exit_code: 0,
      eligibility_state: 'WAITING', model_invoked: false, attempt_id: manifest.attempt_id };
  }
  if (parsedJob.kind === 'opencode_edit' && !candidateSetupFailed) {
    try { result = await captureScopedEditDiff(executionWorkspace, runtime.results_dir,
      parsedJob, manifest.attempt_id, result); }
    catch (error) {
      result = { ...result, outcome: String(error?.code || error?.message || 'EDIT_DIFF_UNKNOWN')
        .replace(/[^A-Z0-9_]/gi, '_').slice(0, 72).toUpperCase(), exit_code: -1,
        changed_paths: null, diff_sha256: null };
    }
  }
  const terminal = receipt(parsedJob.request_id, manifest.attempt_id,
    terminalStateForResult(result), parsedJob, result);
  atomicJson(target, { request_id: parsedJob.request_id, attempt_id: manifest.attempt_id,
    terminal, local_evidence: result.local_evidence ?? null,
    diff_evidence: result.diff_evidence ?? null });
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
