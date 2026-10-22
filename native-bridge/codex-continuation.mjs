// Source-only continuation primitives for the existing native Issue worker.
// GitHub remains the only task/receipt authority. This module does not install
// a Task Scheduler task, authenticate to GitHub, or invoke a model by itself.
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, openSync, writeFileSync, fsyncSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join, isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildHiddenWscriptArguments, getCurrentWindowsSid, validateWindowsTaskAction }
  from './windows-executor.mjs';

const CODEX_JOB_KIND = 'codex_plan';
export const NATIVE_JOB_MARKER = 'PTYSD_NATIVE_JOB_V1\n';
export const CODEX_JOB_KEYS = Object.freeze([
  'schema', 'project_id', 'host', 'request_id', 'kind', 'source_sha',
  'spec_path', 'spec_sha256', 'model', 'reasoning_effort', 'write_paths',
]);
export const CODEX_HUMAN_GOAL_JOB_KEYS = Object.freeze([
  ...CODEX_JOB_KEYS, 'goal_comment_id', 'goal_body_sha256', 'goal_author', 'goal_marker',
]);
const CODEX_EXECUTOR_TASK = 'PTYSD-Codex-Executor';
const CODEX_HUMAN_GOAL_ISSUE = 310;
export const CODEX_HUMAN_GOAL_SPEC_PATH = 'native-bridge/tasks/human-goal-source-only.md';
// GitHub rejects Issue comment bodies above 65,536 characters.
const MAX_GITHUB_ISSUE_COMMENT_BODY_LENGTH = 65_536;
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const REQUEST = /^[A-Z][A-Z0-9_-]{7,79}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/;
const FORBIDDEN_PATHS = new Set(['governance', 'runs', '.codex', '.git']);
const HUMAN_GOAL_MARKER = /^PTYSD_V53R4_(?:DELETE_FIRST_AUTONOMY_GOAL|P[0-3]|R\d{1,2}|EMERGENCY|CODEX_DIRECTIVE)(?:_[A-Z0-9]+)*_\d{8}$/;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function validReasoningEffort(value) {
  // Model catalogs can advertise new values; the per-model config gate below
  // decides authorization instead of a stale parser enum.
  return typeof value === 'string' && value.length > 0 && value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function safeRepoPath(value) {
  if (typeof value !== 'string' || value.length < 1 ||
      value.includes('\\') || value.startsWith('/') || value.includes(':')) return false;
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return false;
  if (FORBIDDEN_PATHS.has(parts[0].toLowerCase())) return false;
  if (parts[0].toLowerCase() === '.github' &&
      ['workflows', 'actions'].includes(parts[1]?.toLowerCase())) return false;
  return true;
}

export function parseCodexJob(body) {
  if (typeof body !== 'string' || body.length > MAX_GITHUB_ISSUE_COMMENT_BODY_LENGTH ||
      !body.startsWith(NATIVE_JOB_MARKER)) return null;
  let job;
  try { job = JSON.parse(body.slice(NATIVE_JOB_MARKER.length)); } catch { return null; }
  const expectedKeys = job?.schema === 3 ? CODEX_JOB_KEYS :
    job?.schema === 4 ? CODEX_HUMAN_GOAL_JOB_KEYS : null;
  if (!job || typeof job !== 'object' || Array.isArray(job) || !expectedKeys ||
      JSON.stringify(Object.keys(job).sort()) !== JSON.stringify([...expectedKeys].sort())) return null;
  if (job.project_id !== 'CHATGPT_GLOBAL_SKILL_GOVERNANCE' || job.kind !== CODEX_JOB_KIND ||
      !REQUEST.test(job.request_id) || typeof job.host !== 'string' ||
      !/^[A-Z0-9-]{3,64}$/.test(job.host) || !SHA.test(job.source_sha)) return null;
  if (typeof job.spec_path !== 'string' ||
      !/^native-bridge\/tasks\/[a-z0-9-]{1,70}\.md$/.test(job.spec_path) ||
      typeof job.spec_sha256 !== 'string' || !HASH.test(job.spec_sha256)) return null;
  if (typeof job.model !== 'string' || !MODEL.test(job.model) || !validReasoningEffort(job.reasoning_effort)) return null;
  if (!Array.isArray(job.write_paths) || job.write_paths.length < 1 ||
      !job.write_paths.every(safeRepoPath) || new Set(job.write_paths).size !== job.write_paths.length) return null;
  if (job.schema === 4) {
    const legacyRequestId = `PTYSD_HUMAN_GOAL_${job.goal_comment_id}`;
    const bodyBoundRequestId = `PTYSD_HUMAN_GOAL_${job.goal_comment_id}_${
      String(job.goal_body_sha256 || '').slice(0, 42).toUpperCase()}`;
    if (!Number.isSafeInteger(job.goal_comment_id) || job.goal_comment_id < 1 ||
        !HASH.test(job.goal_body_sha256 || '') || !/^[A-Za-z0-9-]{1,39}$/.test(job.goal_author || '') ||
        typeof job.goal_marker !== 'string' || !HUMAN_GOAL_MARKER.test(job.goal_marker) ||
        (job.request_id !== legacyRequestId && job.request_id !== bodyBoundRequestId) ||
        job.spec_path !== CODEX_HUMAN_GOAL_SPEC_PATH) return null;
  }
  return job;
}

export function parseCodexReceipt(body) {
  const marker = 'PTYSD_NATIVE_RECEIPT_V1\n';
  if (typeof body !== 'string' || body.length > MAX_GITHUB_ISSUE_COMMENT_BODY_LENGTH ||
      !body.startsWith(marker)) return null;
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
  if (config?.codex_sandbox_boundary !== 'VERIFIED_EXACT_PATH_PERMISSION_PROFILE')
    reasons.push('SANDBOX_BOUNDARY_NOT_VERIFIED');
  const publisherSid = config?.publisher_identity_sid;
  const executorSid = config?.executor_identity_sid;
  if (!/^S-1-(?:\d+-)+\d+$/i.test(publisherSid || '') ||
      !/^S-1-(?:\d+-)+\d+$/i.test(executorSid || '') ||
      publisherSid.toUpperCase() === executorSid.toUpperCase())
    reasons.push('PUBLISHER_EXECUTOR_IDENTITY_NOT_SEPARATED');
  if (config?.codex_executor_task !== CODEX_EXECUTOR_TASK)
    reasons.push('DEDICATED_EXECUTOR_TASK_NOT_CONFIGURED');
  if (!codexExecutorTaskDescriptorReady(config)) reasons.push('EXECUTOR_TASK_READBACK_DESCRIPTOR_MISSING');
  const allowed = config?.allowed_codex_models?.[job?.model];
  if (!Array.isArray(allowed) || !allowed.includes(job?.reasoning_effort)) reasons.push('MODEL_NOT_EXPLICITLY_ALLOWLISTED');
  return { allowed: reasons.length === 0, reasons };
}

function codexExecutorTaskIdentityReady(config) {
  return typeof config?.codex_executor_task_user === 'string' &&
    config.codex_executor_task_user.length > 0 && config.codex_executor_task_user.length <= 256 &&
    !/[\u0000-\u001f<>]/.test(config.codex_executor_task_user) &&
    /^S-1-(?:\d+-)+\d+$/i.test(config?.publisher_identity_sid || '') &&
    /^S-1-(?:\d+-)+\d+$/i.test(config?.executor_identity_sid || '') &&
    config.publisher_identity_sid.toUpperCase() !== config.executor_identity_sid.toUpperCase();
}

function codexExecutorTaskDescriptorReady(config) {
  const paths = ['codex_executor_wscript_path', 'codex_executor_launcher_path',
    'codex_executor_node_path', 'codex_executor_script_path', 'codex_executor_config_path',
    'codex_executor_working_directory'];
  return codexExecutorTaskIdentityReady(config) &&
    paths.every(key => typeof config?.[key] === 'string' && win32.isAbsolute(config[key]) &&
      !/[\r\n"]/.test(config[key]));
}

export function codexExecutorTaskArguments(config) {
  if (!codexExecutorTaskDescriptorReady(config)) throw new Error('CODEX_EXECUTOR_TASK_DESCRIPTOR_INVALID');
  return buildHiddenWscriptArguments({ launcher_path: config.codex_executor_launcher_path,
    node_bin: config.codex_executor_node_path, script_path: config.codex_executor_script_path,
    config_path: config.codex_executor_config_path });
}

export function validateCodexExecutorTaskXml(xml, config) {
  if (!codexExecutorTaskDescriptorReady(config)) throw new Error('CODEX_EXECUTOR_TASK_XML_INVALID');
  const result = validateWindowsTaskAction(xml, {
    taskName: `\\${CODEX_EXECUTOR_TASK}`,
    userIds: [config.codex_executor_task_user, config.executor_identity_sid],
    command: config.codex_executor_wscript_path,
    argumentsText: codexExecutorTaskArguments(config),
    workingDirectory: config.codex_executor_working_directory,
    errorPrefix: 'CODEX_EXECUTOR_TASK',
  });
  return { ready: true, task_name: CODEX_EXECUTOR_TASK,
    executor_user: config.codex_executor_task_user, run_level: 'LeastPrivilege',
    logon_type: result.logon_type, execution_time_limit: result.execution_time_limit,
    allow_hard_terminate: result.allow_hard_terminate, multiple_instances: result.multiple_instances };
}

export function assertCodexExecutorTaskReady(config, {
  currentSid = getCurrentWindowsSid,
  platform = process.platform,
  readTaskXml = taskName => execFileSync('schtasks.exe', ['/Query', '/TN', taskName, '/XML'], {
    encoding: 'utf8', windowsHide: true, shell: false, timeout: 10000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }),
} = {}) {
  if (platform !== 'win32') throw new Error('CODEX_EXECUTOR_TASK_READBACK_WINDOWS_ONLY');
  if (config?.codex_executor_task !== CODEX_EXECUTOR_TASK ||
      !codexExecutorTaskIdentityReady(config))
    throw new Error('CODEX_EXECUTOR_TASK_IDENTITY_CONFIG_INVALID');
  if (String(currentSid()).toUpperCase() !== config.publisher_identity_sid.toUpperCase())
    throw new Error('CODEX_EXECUTOR_PUBLISHER_SID_MISMATCH');
  return validateCodexExecutorTaskXml(readTaskXml(CODEX_EXECUTOR_TASK), config);
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
    ...(job.schema === 4 ? { goal_comment_id: job.goal_comment_id,
      goal_body_sha256: job.goal_body_sha256, goal_author: job.goal_author,
      goal_marker: job.goal_marker } : {}),
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
  const windowsPath = win32.isAbsolute(workspace);
  const root = windowsPath ? win32.resolve(workspace) : resolve(workspace);
  const resolvePath = windowsPath ? (...parts) => win32.resolve(...parts) : (...parts) => resolve(...parts);
  const relativePath = windowsPath ? (from, to) => win32.relative(from, to) : relative;
  const pathSeparator = windowsPath ? win32.sep : sep;
  const isAbsolutePath = windowsPath ? value => win32.isAbsolute(value) : isAbsolute;
  const scopedPaths = job.write_paths.map(repoPath => {
    const fullPath = resolvePath(root, ...repoPath.split('/'));
    const rel = relativePath(root, fullPath);
    if (!rel || rel === '..' || rel.startsWith(`..${pathSeparator}`) || isAbsolutePath(rel))
      throw new Error('CODEX_WRITE_SCOPE_PATH_INVALID');
    return fullPath;
  });
  const profile = 'pty_exact_scope';
  const filesystem = [
    [':minimal', 'read'],
    [root, 'read'],
    ...scopedPaths.map(path => [path, 'write']),
  ].map(([path, access]) => `${JSON.stringify(path)}=${JSON.stringify(access)}`).join(',');
  const config = [
    `default_permissions=${JSON.stringify(profile)}`,
    `permissions.${profile}.filesystem={${filesystem}}`,
    `permissions.${profile}.network.enabled=false`,
  ];
  return ['exec', '--json', '--ignore-user-config', '--strict-config', '--model', job.model,
    // Scheduled execution cannot answer approval prompts. Keep the CLI inside
    // its native exact-path permission profile and deny every undeclared write.
    '--config', 'approval_policy=never',
    '--config', `model_reasoning_effort=${JSON.stringify(job.reasoning_effort)}`,
    ...config.flatMap(value => ['--config', value]), '-C', root, '-'];
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

export function makeCodexExecutorRequest(job, attemptId, spec, bundlePath, bundleSha256,
  humanGoalContext = null) {
  if (!parseCodexJob(`${NATIVE_JOB_MARKER}${JSON.stringify(job)}`)) throw new Error('INVALID_CODEX_JOB');
  if (!/^[a-f0-9-]{36}$/.test(attemptId || '')) throw new Error('INVALID_ATTEMPT_ID');
  if (typeof spec !== 'string' || sha256(Buffer.from(spec, 'utf8')) !== job.spec_sha256)
    throw new Error('TASK_SPEC_HASH_MISMATCH');
  if (typeof bundlePath !== 'string' || !isAbsolute(bundlePath) ||
      typeof bundleSha256 !== 'string' || !HASH.test(bundleSha256))
    throw new Error('SOURCE_BUNDLE_IDENTITY_REQUIRED');
  const validatedGoal = validateHumanGoalContext(job, humanGoalContext);
  return { schema: 1, kind: CODEX_JOB_KIND, request_id: job.request_id, attempt_id: attemptId,
    source_sha: job.source_sha, fingerprint: codexTaskFingerprint(job), job,
    spec_base64: Buffer.from(spec, 'utf8').toString('base64'), bundle_path: bundlePath,
    bundle_sha256: bundleSha256,
    ...(validatedGoal ? { human_goal_context_base64:
      Buffer.from(JSON.stringify(validatedGoal), 'utf8').toString('base64') } : {}) };
}

function canonicalUtcTimestamp(value) {
  if (typeof value !== 'string') return false;
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return false;
  try { return new Date(epoch).toISOString() === value; }
  catch { return false; }
}

export function codexScopedActionStatus(body) {
  if (typeof body !== 'string' || body.length > MAX_GITHUB_ISSUE_COMMENT_BODY_LENGTH)
    return { ready: false, code: 'HUMAN_GOAL_SCOPED_ACTION_INVALID' };
  const matches = [...body.matchAll(/^\*\*Codex 下一動作\*\*[：:][ \t]*/gm)];
  if (matches.length === 0) return { ready: false, code: 'HUMAN_GOAL_SCOPED_ACTION_MISSING' };
  if (matches.length !== 1) return { ready: false, code: 'HUMAN_GOAL_SCOPED_ACTION_INVALID' };
  const match = matches[0];
  const tail = body.slice(match.index + match[0].length);
  const nextSection = /(?:^|\r?\n)(?:#{1,6}\s+|\*\*[^*\r\n]+\*\*[：:])/m.exec(tail);
  const action = (nextSection ? tail.slice(0, nextSection.index) : tail).trim();
  if (!action) return { ready: false, code: 'HUMAN_GOAL_SCOPED_ACTION_MISSING' };
  return { ready: true, action };
}

function extractCodexScopedAction(body) {
  const result = codexScopedActionStatus(body);
  if (!result.ready) throw new Error(result.code);
  return result.action;
}

function validateHumanGoalContext(job, context) {
  if (job.schema !== 4) {
    if (context !== null && context !== undefined) throw new Error('UNEXPECTED_HUMAN_GOAL_CONTEXT');
    return null;
  }
  if (!context || context.repo !== 'PT-Original-Point/ptysd-autonomous-factory' ||
      context.issue !== CODEX_HUMAN_GOAL_ISSUE || context.comment_id !== job.goal_comment_id ||
      context.author !== job.goal_author || context.body_sha256 !== job.goal_body_sha256 ||
      typeof context.body !== 'string' || context.body.length > MAX_GITHUB_ISSUE_COMMENT_BODY_LENGTH ||
      !canonicalUtcTimestamp(context.fetched_at) ||
      sha256(Buffer.from(context.body, 'utf8')) !== job.goal_body_sha256 ||
      !context.body.split(/\r?\n/).some(line =>
        line.trim().replace(/^<!--\s*|\s*-->$/g, '') === job.goal_marker))
    throw new Error('HUMAN_GOAL_CONTEXT_IDENTITY_INVALID');
  return { repo: context.repo, issue: context.issue, comment_id: context.comment_id,
    author: context.author, body_sha256: context.body_sha256, body: context.body,
    fetched_at: context.fetched_at, scoped_action: extractCodexScopedAction(context.body) };
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
  let goalContext = null;
  if (request.human_goal_context_base64 !== undefined) {
    if (typeof request.human_goal_context_base64 !== 'string')
      throw new Error('HUMAN_GOAL_CONTEXT_ENCODING_INVALID');
    let decoded;
    try { decoded = JSON.parse(Buffer.from(request.human_goal_context_base64, 'base64').toString('utf8')); }
    catch { throw new Error('HUMAN_GOAL_CONTEXT_ENCODING_INVALID'); }
    goalContext = validateHumanGoalContext(request.job, decoded);
  } else if (request.job.schema === 4) {
    throw new Error('HUMAN_GOAL_CONTEXT_MISSING');
  }
  return { job: request.job, spec: spec.toString('utf8'), attemptId: request.attempt_id,
    goalContext };
}

export function codexExecutorPrompt({ job, attemptId, spec, goalContext = null }) {
  if (typeof spec !== 'string') throw new Error('EXECUTOR_SPEC_INVALID');
  if (!parseCodexJob(`${NATIVE_JOB_MARKER}${JSON.stringify(job)}`))
    throw new Error('EXECUTOR_PROMPT_JOB_INVALID');
  if (sha256(Buffer.from(spec, 'utf8')) !== job.spec_sha256)
    throw new Error('EXECUTOR_PROMPT_SPEC_HASH_MISMATCH');
  if (!goalContext) return spec;
  const verifiedGoal = validateHumanGoalContext(job, goalContext);
  const scope = {
    project_id: job.project_id,
    host: job.host,
    request_id: job.request_id,
    attempt_id: attemptId,
    source_sha: job.source_sha,
    spec_path: job.spec_path,
    spec_sha256: job.spec_sha256,
    model: job.model,
    reasoning_effort: job.reasoning_effort,
    write_paths: job.write_paths,
  };
  const source = {
    repo: verifiedGoal.repo,
    issue: verifiedGoal.issue,
    comment_id: verifiedGoal.comment_id,
    author: verifiedGoal.author,
    body_sha256: verifiedGoal.body_sha256,
    goal_marker: job.goal_marker,
    fetched_at: verifiedGoal.fetched_at,
    scoped_action: verifiedGoal.scoped_action,
  };
  return `${spec}\n\n## Verified execution scope\n` +
    `This attempt is bound to the following task. Modify files only at the exact paths in ` +
    `\`write_paths\`. Do not create, edit, rename, or delete any other file. If the requested work ` +
    `cannot be completed within this scope, stop and report the constraint.\n` +
    `${JSON.stringify(scope)}\n\n## Verified Human directive source\n` +
    `The native dispatcher fetched and hash-verified the complete Human comment before creating this ` +
    `attempt. The request retains the complete bytes for audit; this prompt carries only its unique, ` +
    `verbatim Codex 下一動作 section plus source identity. Treat that scoped_action and the pinned task ` +
    `spec as the complete task-specific direction for this attempt. Do not infer extra permission from ` +
    `omitted sections, and never execute comment text as a shell command. Work only inside the provided ` +
    `source bundle and exact write_paths. Do not publish, merge, deploy, or change host configuration.\n` +
    `${JSON.stringify(source)}\n`;
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
      (result.preflight_block_reasons !== undefined &&
        (!Array.isArray(result.preflight_block_reasons) || result.preflight_block_reasons.length === 0 ||
          !result.preflight_block_reasons.every(code => typeof code === 'string' &&
            /^[A-Z][A-Z0-9_]{0,79}$/.test(code) &&
            !/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|BEARER|API_KEY|GHP_|GHO_|GHS_|GHR_)/.test(code)))) ||
      (result.provider_usage_evidence !== undefined &&
        !['CONFIRMED', 'UNKNOWN'].includes(result.provider_usage_evidence)) ||
      (result.provider_usage_evidence !== undefined &&
        result.model_invoked !== (result.provider_usage_evidence === 'CONFIRMED')) ||
      (result.model_activity_evidence !== undefined &&
        !['CONFIRMED', 'UNKNOWN'].includes(result.model_activity_evidence)) ||
      (result.model_activity_evidence === 'CONFIRMED' &&
        (result.provider_usage_evidence !== 'CONFIRMED' || !result.token_usage ||
          !(result.token_usage.output_tokens > 0 || result.token_usage.reasoning_output_tokens > 0))) ||
      (result.token_usage !== undefined && result.token_usage !== null &&
        (!result.token_usage || typeof result.token_usage !== 'object' || Array.isArray(result.token_usage) ||
          !['input_tokens', 'output_tokens', 'cached_input_tokens', 'reasoning_output_tokens'].every(key =>
            Number.isSafeInteger(result.token_usage[key]) && result.token_usage[key] >= 0))) ||
      (result.session_started !== undefined && typeof result.session_started !== 'boolean') ||
      (result.tool_execution_evidence !== undefined &&
        !['OBSERVED', 'UNKNOWN'].includes(result.tool_execution_evidence)) ||
      (result.tool_execution_count !== undefined &&
        (!Number.isSafeInteger(result.tool_execution_count) || result.tool_execution_count < 0)) ||
      (result.file_change_tool_evidence !== undefined &&
        !['COMPLETED', 'FAILED', 'INCOMPLETE', 'MIXED', 'UNKNOWN'].includes(result.file_change_tool_evidence)) ||
      (result.file_change_tool_completed_count !== undefined &&
        (!Number.isSafeInteger(result.file_change_tool_completed_count) || result.file_change_tool_completed_count < 0)) ||
      (result.file_change_tool_failed_count !== undefined &&
        (!Number.isSafeInteger(result.file_change_tool_failed_count) || result.file_change_tool_failed_count < 0)) ||
      (result.file_change_tool_incomplete_count !== undefined &&
        (!Number.isSafeInteger(result.file_change_tool_incomplete_count) || result.file_change_tool_incomplete_count < 0)) ||
      !Array.isArray(result.changed_paths) || !result.changed_paths.every(path => typeof path === 'string') ||
      !Array.isArray(result.out_of_scope_paths) || !result.out_of_scope_paths.every(path => typeof path === 'string') ||
      (result.diff_state !== undefined && !['CAPTURED', 'UNKNOWN_PROCESS_TREE_ACTIVE'].includes(result.diff_state)) ||
      (result.diff_state === 'UNKNOWN_PROCESS_TREE_ACTIVE' &&
        (!['ORPHAN_POSSIBLE', 'TERMINATION_REQUESTED', 'TERMINATION_UNCONFIRMED'].includes(result.termination_state) ||
          result.diff_sha256 !== null || result.changed_paths.length !== 0 || result.out_of_scope_paths.length !== 0 ||
          result.exit_code !== -1 || result.outcome !== 'CODEX_PROCESS_TERMINATION_FAILED')) ||
      (result.diff_state === 'CAPTURED' &&
        ['ORPHAN_POSSIBLE', 'TERMINATION_REQUESTED', 'TERMINATION_UNCONFIRMED'].includes(result.termination_state)) ||
      result.pr_url !== null || typeof result.tests !== 'string')
    throw new Error('EXECUTOR_RESULT_IDENTITY_INVALID');
  return result;
}
