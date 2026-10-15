// Source-only continuation primitives for the existing native Issue worker.
// GitHub remains the only task/receipt authority. This module does not install
// a Task Scheduler task, authenticate to GitHub, or invoke a model by itself.
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, openSync, writeFileSync, fsyncSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';

export const CODEX_JOB_KIND = 'codex_plan';
export const NATIVE_JOB_MARKER = 'PTYSD_NATIVE_JOB_V1\n';
export const CODEX_JOB_KEYS = Object.freeze([
  'schema', 'project_id', 'host', 'request_id', 'kind', 'source_sha',
  'spec_path', 'spec_sha256', 'model', 'reasoning_effort', 'write_paths',
]);
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const REQUEST = /^[A-Z][A-Z0-9_-]{7,79}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/;
const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);
const FORBIDDEN_PATHS = new Set(['governance', 'runs', '.codex', '.git']);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeRepoPath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 180 ||
      value.includes('\\') || value.startsWith('/') || value.includes(':')) return false;
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return false;
  if (FORBIDDEN_PATHS.has(parts[0].toLowerCase())) return false;
  if (parts[0].toLowerCase() === '.github' &&
      ['workflows', 'actions'].includes(parts[1]?.toLowerCase())) return false;
  return true;
}

export function parseCodexJob(body) {
  if (typeof body !== 'string' || body.length > 6000 || !body.startsWith(NATIVE_JOB_MARKER)) return null;
  let job;
  try { job = JSON.parse(body.slice(NATIVE_JOB_MARKER.length)); } catch { return null; }
  if (!job || typeof job !== 'object' || Array.isArray(job) || job.schema !== 3 ||
      JSON.stringify(Object.keys(job).sort()) !== JSON.stringify([...CODEX_JOB_KEYS].sort())) return null;
  if (job.project_id !== 'CHATGPT_GLOBAL_SKILL_GOVERNANCE' || job.kind !== CODEX_JOB_KIND ||
      !REQUEST.test(job.request_id) || typeof job.host !== 'string' ||
      !/^[A-Z0-9-]{3,64}$/.test(job.host) || !SHA.test(job.source_sha)) return null;
  if (typeof job.spec_path !== 'string' ||
      !/^native-bridge\/tasks\/[a-z0-9-]{1,70}\.md$/.test(job.spec_path) ||
      typeof job.spec_sha256 !== 'string' || !HASH.test(job.spec_sha256)) return null;
  if (typeof job.model !== 'string' || !MODEL.test(job.model) || !EFFORTS.has(job.reasoning_effort)) return null;
  if (!Array.isArray(job.write_paths) || job.write_paths.length < 1 || job.write_paths.length > 32 ||
      !job.write_paths.every(safeRepoPath) || new Set(job.write_paths).size !== job.write_paths.length) return null;
  return job;
}

export function parseCodexReceipt(body) {
  const marker = 'PTYSD_NATIVE_RECEIPT_V1\n';
  if (typeof body !== 'string' || body.length > 8000 || !body.startsWith(marker)) return null;
  let receipt;
  try { receipt = JSON.parse(body.slice(marker.length)); } catch { return null; }
  if (!receipt || receipt.schema !== 1 || receipt.project_id !== 'CHATGPT_GLOBAL_SKILL_GOVERNANCE' ||
      receipt.kind !== CODEX_JOB_KIND || !REQUEST.test(receipt.request_id || '') ||
      !/^[A-Z0-9-]{3,64}$/.test(receipt.host || '') || !SHA.test(receipt.source_sha || '') ||
      !['STARTED', 'FINISHED', 'BLOCKED'].includes(receipt.state) ||
      !/^[a-f0-9-]{36}$/.test(receipt.attempt_id || '')) return null;
  return receipt;
}

export function codexExecutionGate(job, config) {
  const reasons = [];
  if (!job || job.kind !== CODEX_JOB_KIND) reasons.push('INVALID_CODEX_JOB');
  if (config?.github_transport_verified !== true) reasons.push('GITHUB_SOURCE_NOT_VERIFIED');
  if (config?.codex_cli_qualified !== true || config?.codex_login_verified !== true)
    reasons.push('CODEX_CLI_AUTH_NOT_QUALIFIED');
  if (config?.enable_codex_model_runs !== true) reasons.push('MODEL_RUNS_NOT_ENABLED');
  if (config?.codex_usage_authorized !== true) reasons.push('USAGE_AUTHORIZATION_UNKNOWN');
  if (config?.codex_sandbox_boundary !== 'VERIFIED_WORKSPACE_ONLY') reasons.push('SANDBOX_BOUNDARY_NOT_VERIFIED');
  const publisherSid = config?.publisher_identity_sid;
  const executorSid = config?.executor_identity_sid;
  if (typeof publisherSid !== 'string' || typeof executorSid !== 'string' || publisherSid === executorSid)
    reasons.push('PUBLISHER_EXECUTOR_IDENTITY_NOT_SEPARATED');
  if (!config?.codex_executor_task || config.codex_executor_task === 'PTYSD-Native-OpenCode')
    reasons.push('DEDICATED_EXECUTOR_TASK_NOT_CONFIGURED');
  if (config?.codex_executor_task_verified !== true || config?.codex_executor_is_standard_user !== true)
    reasons.push('EXECUTOR_TASK_OR_PRIVILEGE_NOT_VERIFIED');
  const allowed = config?.allowed_codex_models?.[job?.model];
  if (!Array.isArray(allowed) || !allowed.includes(job?.reasoning_effort)) reasons.push('MODEL_NOT_EXPLICITLY_ALLOWLISTED');
  return { allowed: reasons.length === 0, reasons };
}

export function codexTaskFingerprint(job) {
  const identity = {
    request_id: job.request_id,
    source_sha: job.source_sha,
    spec_path: job.spec_path,
    spec_sha256: job.spec_sha256,
    model: job.model,
    reasoning_effort: job.reasoning_effort,
    write_paths: [...job.write_paths].sort(),
  };
  return sha256(JSON.stringify(identity));
}

// Durable one-attempt claim. EEXIST is an ambiguous prior effect, never a retry.
export function claimCodexAttempt(stateDir, job, attemptId = randomUUID()) {
  const path = join(stateDir, `codex-claim-${job.request_id}.json`);
  const claim = {
    schema: 1, request_id: job.request_id, attempt_id: attemptId,
    source_sha: job.source_sha, fingerprint: codexTaskFingerprint(job),
  };
  let fd;
  try {
    fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(claim));
    fsyncSync(fd);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (error.code === 'EEXIST') return { claimed: false, reason: 'CLAIM_EXISTS_NO_REPLAY', path };
    throw error;
  }
  closeSync(fd);
  return { claimed: true, claim, path };
}

// A claim may be released only while the caller can prove no request/receipt or
// executor side effect was published. Exact bytes prevent deleting another
// attempt's claim after a race or local state replacement.
export function releaseCodexAttempt(job, claimed) {
  if (!claimed?.claimed || !claimed.path || !claimed.claim) return false;
  let current;
  try { current = readFileSync(claimed.path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (current !== JSON.stringify(claimed.claim) ||
      claimed.claim.request_id !== job.request_id ||
      claimed.claim.fingerprint !== codexTaskFingerprint(job)) return false;
  unlinkSync(claimed.path);
  return true;
}

export function buildCodexExecArgs(job, workspace) {
  if (!parseCodexJob(`PTYSD_NATIVE_JOB_V1\n${JSON.stringify(job)}`)) throw new Error('INVALID_CODEX_JOB');
  if (typeof workspace !== 'string' || !workspace) throw new Error('WORKSPACE_REQUIRED');
  return ['exec', '--json', '--sandbox', 'workspace-write', '--model', job.model,
    '--config', `model_reasoning_effort=${job.reasoning_effort}`, '-C', workspace, '-'];
}

export function codexSessionFromJsonl(text) {
  if (typeof text !== 'string') return null;
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type === 'thread.started' && typeof event.thread_id === 'string' &&
          /^[A-Za-z0-9_-]{8,100}$/.test(event.thread_id)) return event.thread_id;
    } catch { /* Ignore non-JSON diagnostic lines; the complete bytes remain hashed locally. */ }
  }
  return null;
}

export function codexRunOutcome(exitCode, sessionId) {
  if (exitCode === 0) return sessionId ? 'CODEX_CLI_EXIT_0_UNVERIFIED' : 'CODEX_SESSION_ID_MISSING_UNVERIFIED';
  if (exitCode === null || exitCode === undefined) return 'CODEX_CLI_EXIT_UNKNOWN';
  return 'CODEX_CLI_FAILED';
}

export function makeCodexExecutorRequest(job, attemptId, spec, bundlePath, bundleSha256) {
  if (!parseCodexJob(`${NATIVE_JOB_MARKER}${JSON.stringify(job)}`)) throw new Error('INVALID_CODEX_JOB');
  if (!/^[a-f0-9-]{36}$/.test(attemptId || '')) throw new Error('INVALID_ATTEMPT_ID');
  if (typeof spec !== 'string' || sha256(Buffer.from(spec, 'utf8')) !== job.spec_sha256)
    throw new Error('TASK_SPEC_HASH_MISMATCH');
  if (typeof bundlePath !== 'string' || !isAbsolute(bundlePath) ||
      typeof bundleSha256 !== 'string' || !HASH.test(bundleSha256))
    throw new Error('SOURCE_BUNDLE_IDENTITY_REQUIRED');
  return { schema: 1, kind: CODEX_JOB_KIND, request_id: job.request_id, attempt_id: attemptId,
    source_sha: job.source_sha, fingerprint: codexTaskFingerprint(job), job,
    spec_base64: Buffer.from(spec, 'utf8').toString('base64'), bundle_path: bundlePath,
    bundle_sha256: bundleSha256 };
}

export function publishCodexExecutorRequest(spoolDir, request) {
  validateCodexExecutorRequest(request);
  const requestsDir = join(spoolDir, 'requests');
  mkdirSync(requestsDir, { recursive: true });
  const path = join(requestsDir, `${request.request_id}-${request.attempt_id}.json`);
  let fd;
  let created = false;
  try {
    fd = openSync(path, 'wx', 0o600);
    created = true;
    writeFileSync(fd, JSON.stringify(request)); fsyncSync(fd);
    closeSync(fd); fd = undefined;
    return path;
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* preserve original failure */ } }
    // This path is unique to the UUID attempt and was created with wx above.
    if (created) { try { unlinkSync(path); } catch { /* leave ambiguous artifact for audit */ } }
    throw error;
  }
}

export function validateCodexExecutorRequest(request) {
  if (!request || request.schema !== 1 || request.kind !== CODEX_JOB_KIND ||
      request.request_id !== request.job?.request_id || request.source_sha !== request.job?.source_sha ||
      !parseCodexJob(`${NATIVE_JOB_MARKER}${JSON.stringify(request.job)}`) ||
      request.fingerprint !== codexTaskFingerprint(request.job) ||
      !/^[a-f0-9-]{36}$/.test(request.attempt_id || '') || typeof request.spec_base64 !== 'string' ||
      typeof request.bundle_path !== 'string' || !isAbsolute(request.bundle_path) ||
      !HASH.test(request.bundle_sha256 || ''))
    throw new Error('EXECUTOR_REQUEST_IDENTITY_INVALID');
  const spec = Buffer.from(request.spec_base64, 'base64');
  if (sha256(spec) !== request.job.spec_sha256) throw new Error('EXECUTOR_SPEC_HASH_MISMATCH');
  return { job: request.job, spec: spec.toString('utf8'), attemptId: request.attempt_id };
}

export function executorResultPath(spoolDir, requestId, attemptId) {
  if (!REQUEST.test(requestId || '') || !/^[a-f0-9-]{36}$/.test(attemptId || ''))
    throw new Error('INVALID_RESULT_IDENTITY');
  return join(spoolDir, 'results', `${requestId}-${attemptId}.json`);
}

export function validateCodexExecutorResult(result, expected) {
  if (!result || result.schema !== 1 || result.kind !== CODEX_JOB_KIND ||
      result.request_id !== expected.request_id || result.attempt_id !== expected.attempt_id ||
      result.source_sha !== expected.source_sha || !Number.isInteger(result.exit_code) ||
      result.exit_code < -1 || result.exit_code > 0xffffffff ||
      !HASH.test(expected.task_fingerprint || '') || !HASH.test(result.fingerprint || '') ||
      result.fingerprint !== expected.task_fingerprint ||
      (result.session_id !== null && !/^[A-Za-z0-9_-]{8,100}$/.test(result.session_id || '')) ||
      (result.diff_sha256 !== null && !HASH.test(result.diff_sha256 || '')) ||
      !HASH.test(result.stdout_sha256 || '') || !HASH.test(result.stderr_sha256 || '') ||
      typeof result.outcome !== 'string' || typeof result.model_invoked !== 'boolean' ||
      !Array.isArray(result.changed_paths) || !result.changed_paths.every(path => typeof path === 'string') ||
      !Array.isArray(result.out_of_scope_paths) || !result.out_of_scope_paths.every(path => typeof path === 'string') ||
      result.pr_url !== null || typeof result.tests !== 'string')
    throw new Error('EXECUTOR_RESULT_IDENTITY_INVALID');
  return result;
}
