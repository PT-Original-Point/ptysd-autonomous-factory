#!/usr/bin/env node
// PTYSD native issue bridge. No listener, MCP, model router, or privileged daemon.
// Public GitHub issue comments are only pointers to immutable, reviewed source.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync,
  openSync, closeSync, fsyncSync } from 'node:fs';
import { homedir, hostname, platform } from 'node:os';
import { basename, join, resolve, relative, isAbsolute, delimiter } from 'node:path';
import { pathToFileURL } from 'node:url';
import { qualifyOpenCodeV2, validateV2Model, buildV2ReadOnlyConfig, buildV2ReadOnlyArgs } from './opencode-v2.mjs';
import { runV2Readiness } from './v2-readiness.mjs';
import { parseCodexJob, codexExecutionGate, claimCodexAttempt,
  releaseCodexAttempt, makeCodexExecutorRequest, publishCodexExecutorRequest,
  executorResultPath as codexExecutorResultPath,
  validateCodexExecutorRequest, validateCodexExecutorResult,
  assertCodexExecutorTaskReady } from './codex-continuation.mjs';
import {
  OPERATOR_REPO, OPERATOR_PROJECT, OPERATOR_ISSUE,
  collectWindowsObservation, encodeOperatorObservation, findOperatorComment,
  updateExistingOperatorComment,
} from './operator-observation.mjs';
import { runCapturedProcess } from './captured-process.mjs';
import { assertExecutorTaskReady, cleanupExecutorAttempt, dispatchToExecutor, executorResultPath,
  validateExecutorDescriptor } from './windows-executor.mjs';

export const PROJECT = 'CHATGPT_GLOBAL_SKILL_GOVERNANCE';
export const REPO = 'PT-Original-Point/ptysd-autonomous-factory';
export const JOB_MARKER = 'PTYSD_NATIVE_JOB_V1\n';
export const RECEIPT_MARKER = 'PTYSD_NATIVE_RECEIPT_V1\n';
export const ISSUE_TITLE = '[PTYSD-NATIVE] OpenCode dispatch and receipts';
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const REQUEST = /^[A-Z][A-Z0-9_-]{7,79}$/;
const V1_KEYS = ['schema', 'project_id', 'host', 'request_id', 'kind', 'source_sha', 'spec_path', 'spec_sha256'];
const V2_KEYS = [...V1_KEYS, 'model', 'variant'];
const RECEIPT_STATES = new Set(['STARTED', 'FINISHED', 'BLOCKED']);
const terminalStates = new Set(['FINISHED', 'BLOCKED']);
const commandTimeout = 60000;
function digest(data) { return createHash('sha256').update(data).digest('hex'); }
export function terminalStateForResult(result) {
  // This field records only the execution attempt lifecycle. A zero exit code
  // never upgrades the outcome to semantic, coding, PR, or source acceptance.
  if (!result || result.exit_code !== 0 || typeof result.outcome !== 'string') return 'BLOCKED';
  if (/(?:^|_)(?:FAILED|ERROR)(?:_|$)/.test(result.outcome)) return 'BLOCKED';
  return 'FINISHED';
}
export function parseJob(body) {
  const codexJob = parseCodexJob(body);
  if (codexJob) return codexJob;
  if (typeof body !== 'string' || body.length > 5000 || !body.startsWith(JOB_MARKER)) return null;
  let obj; try { obj = JSON.parse(body.slice(JOB_MARKER.length)); } catch { return null; }
  if (!obj || Array.isArray(obj) || typeof obj !== 'object') return null;
  const keys = obj.schema === 1 ? V1_KEYS : obj.schema === 2 ? V2_KEYS : null;
  if (!keys || JSON.stringify(Object.keys(obj).sort()) !== JSON.stringify(keys.slice().sort())) return null;
  if (obj.project_id !== PROJECT || !REQUEST.test(obj.request_id)) return null;
  if (typeof obj.host !== 'string' || !/^[A-Z0-9-]{3,64}$/.test(obj.host) || !SHA.test(obj.source_sha)) return null;
  if (obj.schema === 1 && (obj.kind === 'ping' || obj.kind === 'native_preflight' || obj.kind === 'native_v2_qualify')) {
    if (obj.spec_path !== null || obj.spec_sha256 !== null) return null;
    return obj;
  }
  // Never allow a model operation without an exact reviewed model + reasoning variant.
  // V1 opencode_plan without these fields is deliberately retired (no live V1 plan job).
  if (obj.schema !== 2 || obj.kind !== 'opencode_plan') return null;
  if (typeof obj.spec_path !== 'string' || !/^native-bridge\/tasks\/[a-z0-9-]{1,70}\.md$/.test(obj.spec_path)) return null;
  if (typeof obj.spec_sha256 !== 'string' || !HASH.test(obj.spec_sha256)) return null;
  if (!validateV2Model(obj.model, obj.variant)) return null;
  return obj;
}
export function parseReceipt(body) {
  if (typeof body !== 'string' || body.length > 5000 || !body.startsWith(RECEIPT_MARKER)) return null;
  try {
    const o = JSON.parse(body.slice(RECEIPT_MARKER.length));
    if (o?.schema !== 1 || o.project_id !== PROJECT ||
        typeof o.host !== 'string' || !/^[A-Z0-9-]{3,64}$/.test(o.host) ||
        !SHA.test(o.source_sha) || typeof o.kind !== 'string' ||
        !['ping', 'native_preflight', 'native_v2_qualify', 'opencode_plan', 'codex_plan'].includes(o.kind) ||
        typeof o.request_id !== 'string' || !REQUEST.test(o.request_id) ||
        !RECEIPT_STATES.has(o.state) || typeof o.attempt_id !== 'string' ||
        !/^[a-f0-9-]{36}$/.test(o.attempt_id)) return null;
    return o;
  } catch { return null; }
}
export function selectNext(comments, dispatchers, workerLogin, host, liveMainSha = null, blockedKinds = []) {
  const jobs = new Map();
  const receipts = new Map();
  for (const c of comments) {
    const login = c.user?.login;
    const j = parseJob(c.body);
    if (j && dispatchers.includes(login) && j.host.toUpperCase() === host.toUpperCase()) {
      if (!jobs.has(j.request_id)) jobs.set(j.request_id, { job: j, content: c.body, id: c.id, duplicate: false });
      else if (jobs.get(j.request_id).content !== c.body) jobs.get(j.request_id).duplicate = true;
    }
    const r = parseReceipt(c.body);
    if (r && login === workerLogin) {
      if (!receipts.has(r.request_id)) receipts.set(r.request_id, []);
      receipts.get(r.request_id).push(r);
    }
  }
  for (const [, v] of jobs) {
    const r = (receipts.get(v.job.request_id) || []).filter(x =>
      x.host.toUpperCase() === v.job.host.toUpperCase() &&
      x.source_sha === v.job.source_sha && x.kind === v.job.kind);
    if (v.duplicate || blockedKinds.includes(v.job.kind) ||
        r.some(x => terminalStates.has(x.state)) || r.some(x => x.state === 'STARTED')) continue;
    // A stale unsigned/unclaimed job must not starve a newer exact-main task.
    if (liveMainSha !== null && v.job.source_sha !== liveMainSha) continue;
    return { job: v.job, id: v.id, originalBody: v.content };
  }
  return null;
}
export function selectNextWithCodexClaim(comments, dispatchers, workerLogin, host,
  liveMainSha, stateDir, blockedKinds = []) {
  const next = selectNext(comments, dispatchers, workerLogin, host, liveMainSha, blockedKinds);
  if (next?.job.kind !== 'codex_plan' ||
      !existsSync(join(stateDir, `codex-claim-${next.job.request_id}.json`)))
    return { next, unresolvedRequestId: null };
  const blocked = [...new Set([...blockedKinds, 'codex_plan'])];
  return { next: selectNext(comments, dispatchers, workerLogin, host, liveMainSha, blocked),
    unresolvedRequestId: next.job.request_id };
}
function gh(args, options = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', timeout: commandTimeout,
    maxBuffer: 8 * 1024 * 1024, windowsHide: true, ...options });
}
function api(uri, extras = []) { return JSON.parse(gh(['api', uri, ...extras])); }
function issueComments(config) {
  const raw = JSON.parse(gh(['api', `repos/${REPO}/issues/${config.issue}/comments?per_page=100`, '--paginate', '--slurp']));
  return raw.flat().filter(c => typeof c?.id === 'number').sort((a, b) => a.id - b.id);
}
function latestOperatorJob(comments, config, workerLogin, mainSha) {
  const jobs = comments.filter(c => config.dispatchers.includes(c.user?.login))
    .map(c => ({ id: c.id, body: c.body, job: parseJob(c.body) }))
    .filter(x => x.job && x.job.host.toUpperCase() === config.host.toUpperCase())
    .sort((a, b) => a.id - b.id);
  if (!jobs.length) return null;
  const job = jobs.at(-1).job;
  const duplicate = jobs.filter(entry => entry.job.request_id === job.request_id);
  if (new Set(duplicate.map(entry => entry.body)).size > 1) {
    return { request_id: job.request_id, attempt_id: null, kind: job.kind,
      source_sha: job.source_sha, state: 'AMBIGUOUS_DUPLICATE' };
  }
  const receipts = comments.filter(c => c.user?.login === workerLogin)
    .map(c => ({ id: c.id, receipt: parseReceipt(c.body) }))
    .filter(x => x.receipt && x.receipt.request_id === job.request_id &&
      x.receipt.host.toUpperCase() === job.host.toUpperCase() &&
      x.receipt.source_sha === job.source_sha && x.receipt.kind === job.kind)
    .sort((a, b) => a.id - b.id);
  const attempts = new Map();
  for (const entry of receipts) {
    if (!attempts.has(entry.receipt.attempt_id)) attempts.set(entry.receipt.attempt_id, []);
    attempts.get(entry.receipt.attempt_id).push(entry.receipt);
  }
  const latestAttempt = [...attempts.entries()].at(-1);
  const attemptId = latestAttempt?.[0] ?? null;
  const states = latestAttempt?.[1] ?? [];
  const last = states.at(-1) ?? null;
  let state = 'QUEUED_NOT_STARTED';
  if (job.source_sha !== mainSha) state = 'STALE_SOURCE';
  else if (last?.state === 'STARTED') state = 'STARTED_UNVERIFIED';
  else if (last?.state === 'FINISHED') state = 'FINISHED_NOT_ACCEPTANCE';
  else if (last?.state === 'BLOCKED') state = 'BLOCKED';
  return { request_id: job.request_id, attempt_id: attemptId, kind: job.kind,
    source_sha: job.source_sha, state,
    outcome: typeof last?.outcome === 'string' && /^[A-Z0-9_-]{1,80}$/.test(last.outcome)
      ? last.outcome : 'UNKNOWN',
    exit_code: Number.isSafeInteger(last?.exit_code) ? last.exit_code : null };
}
export async function publishOperatorObservation(config, workerLogin, comments, mainSha, dependencies = {}) {
  const existing = comments.find(c =>
    typeof c?.body === 'string' && c.body.startsWith('PTYSD_OPERATOR_OBSERVATION_V1\n'));
  if (!existing) return { status: 'NOT_SEEDED' };
  const now = dependencies.now ? dependencies.now() : new Date();
  const observedAt = now.toISOString();
  const windows = (dependencies.collectWindowsObservation || collectWindowsObservation)();
  const prior = findOperatorComment(comments, workerLogin);
  if (prior.status !== 'OK') throw new Error(prior.error || 'OPERATOR_COMMENT_UNKNOWN');
  let repositoryRunner = { status: 'UNKNOWN', count: null, observed_at: observedAt };
  try {
    const response = await (dependencies.readRunnerRegistration
      ? dependencies.readRunnerRegistration()
      : api('repos/' + OPERATOR_REPO + '/actions/runners?per_page=100'));
    if (Number.isSafeInteger(response.total_count) && response.total_count >= 0)
      repositoryRunner = { status: 'FRESH', count: response.total_count, observed_at: observedAt };
  } catch {}
  const latestTask = latestOperatorJob(comments, config, workerLogin, mainSha);
  const activeTask = latestTask &&
    ['QUEUED_NOT_STARTED', 'STARTED_UNVERIFIED'].includes(latestTask.state)
    ? latestTask : null;
  const nextOwner = windows.status !== 'FRESH' ? 'OS_OBSERVATION_UNKNOWN'
    : windows.native_task.enabled === false ? 'NATIVE_SCHEDULER_REPAIR'
      : activeTask?.state === 'QUEUED_NOT_STARTED' ? 'NATIVE_WORKER'
        : activeTask?.state === 'STARTED_UNVERIFIED' ? 'VERIFY_ACTIVE_WORK'
          : latestTask?.state === 'BLOCKED' ? 'REVIEW_BLOCKER' : 'NO_CURRENT_TASK';
  const snapshot = {
    schema: 1, project_id: OPERATOR_PROJECT, repo: OPERATOR_REPO, issue: OPERATOR_ISSUE,
    host_alias: 'win11-primary', snapshot_id: randomUUID(),
    sequence: (Number.isSafeInteger(prior.observation.sequence) ? prior.observation.sequence : 0) + 1,
    observed_at: observedAt, published_at: observedAt,
    expires_at: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
    source: {
      kind: 'WIN11_NATIVE_TASK_READBACK',
      comment_id: prior.comment.id,
      issue_comments_observed_at: observedAt,
      main_sha: mainSha,
    },
    windows,
    native_worker: {
      observed_at: observedAt,
      state: windows.status !== 'FRESH' ? 'OS_OBSERVATION_UNKNOWN'
        : windows.native_task.state === 'RUNNING' ? 'TASK_RUNNING_DURING_POLL'
          : 'POLL_EXECUTED_TASK_TRIGGER_UNVERIFIED',
      current_task: activeTask,
      latest_task: latestTask,
      files_modified: 'UNPROVEN',
      remote_commit: null, pull_request: null, ci: 'UNKNOWN',
      next_owner: nextOwner,
    },
    opencode_v2: {
      ...(prior.observation.opencode_v2 || {}),
      process_observed_at: windows.observed_at,
      process_count: windows.opencode_process_count,
      active_session_count: null,
      active_session_state: 'UNKNOWN_NO_PASSIVE_API',
      task_binding: 'UNPROVEN',
      code_changes: 'UNPROVEN',
      remote_commit: null, pull_request: null, ci: 'UNKNOWN',
    },
    github: {
      observed_at: observedAt, main_sha: mainSha,
      issue_comments_count: comments.length,
      runner_registration: repositoryRunner,
      organization_runner_registration: 'UNKNOWN_ORG_SCOPE_NOT_AVAILABLE',
      runner_service_count: windows.runner_service_count,
      runner_service_running: windows.runner_service_running,
    },
    monitor_candidate: prior.observation.monitor_candidate || null,
    incident: prior.observation.incident || null,
  };
  const body = encodeOperatorObservation(snapshot);
  return updateExistingOperatorComment({
    comments, expectedLogin: workerLogin, body,
    readComment: dependencies.readComment ||
      (id => api('repos/' + OPERATOR_REPO + '/issues/comments/' + id)),
    patchComment: (id, nextBody) => {
      if (dependencies.patchComment) return dependencies.patchComment(id, nextBody);
      const uri = 'repos/' + OPERATOR_REPO + '/issues/comments/' + id;
      const temp = join(config.state_dir, 'operator-observation-' + randomUUID() + '.json');
      writeFileSync(temp, JSON.stringify({ body: nextBody }),
        { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      try { gh(['api', uri, '--method', 'PATCH', '--input', temp]); }
      finally { rmSync(temp, { force: true }); }
    },
    readComments: dependencies.readComments || (() => issueComments(config)),
  });
}
export function writeReceipt(config, data, workerLogin, dependencies = {}) {
  const body = RECEIPT_MARKER + JSON.stringify(data);
  const identity = parseReceipt(body);
  if (!identity) throw new Error('INVALID_RECEIPT');
  const readComments = dependencies.readComments || issueComments;
  const postComment = dependencies.postComment || (nextBody => {
    const temp = join(config.state_dir, `comment-${randomUUID()}.txt`);
    writeFileSync(temp, nextBody, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    try { gh(['issue', 'comment', String(config.issue), '-R', REPO, '--body-file', temp]); }
    finally { rmSync(temp, { force: true }); }
  });
  const matchingReceipts = comments => comments
    .filter(c => c.user?.login === workerLogin)
    .map(c => ({ comment: c, receipt: parseReceipt(c.body) }))
    .filter(x => x.receipt && x.receipt.request_id === identity.request_id &&
      x.receipt.attempt_id === identity.attempt_id && x.receipt.source_sha === identity.source_sha &&
      x.receipt.kind === identity.kind && x.receipt.state === identity.state);
  let existing;
  try { existing = matchingReceipts(readComments(config)); }
  catch { throw new Error('RECEIPT_PREWRITE_READ_UNAVAILABLE_NO_WRITE'); }
  if (existing.some(x => x.comment.body === body)) {
    if (existing.length !== 1) throw new Error('DUPLICATE_RECEIPT_IDENTITY');
    return { status: 'ALREADY_PRESENT' };
  }
  if (existing.length) throw new Error('RECEIPT_IDENTITY_CONFLICT');
  try { postComment(body); }
  catch {
    let afterError;
    try { afterError = matchingReceipts(readComments(config)); }
    catch { throw new Error('RECEIPT_WRITE_AMBIGUOUS_NO_EXECUTION'); }
    if (afterError.length === 1 && afterError[0].comment.body === body)
      return { status: 'ALREADY_PRESENT' };
    if (afterError.length) throw new Error('RECEIPT_IDENTITY_CONFLICT');
    throw new Error('RECEIPT_WRITE_AMBIGUOUS_NO_EXECUTION');
  }
  let confirmed;
  try { confirmed = matchingReceipts(readComments(config)); }
  catch { throw new Error('RECEIPT_WRITE_AMBIGUOUS_NO_EXECUTION'); }
  if (confirmed.length === 1 && confirmed[0].comment.body === body)
    return { status: 'WRITTEN' };
  if (confirmed.length > 1) throw new Error('DUPLICATE_RECEIPT_IDENTITY');
  throw new Error('RECEIPT_WRITE_AMBIGUOUS_NO_EXECUTION');
}
export async function writeCodexReceiptOnce(config, data, workerLogin, deps = {}) {
  const body = RECEIPT_MARKER + JSON.stringify(data);
  const identity = parseReceipt(body);
  if (!identity || identity.kind !== 'codex_plan') throw new Error('CODEX_RECEIPT_INVALID');
  const readComments = deps.readComments || (() => issueComments(config));
  const matching = comments => comments.filter(comment => {
    if (comment.user?.login !== workerLogin) return false;
    const value = parseReceipt(comment.body);
    return value?.request_id === identity.request_id && value?.attempt_id === identity.attempt_id &&
      value?.host === identity.host && value?.source_sha === identity.source_sha &&
      value?.kind === identity.kind && value?.state === identity.state;
  });
  const before = matching(await readComments());
  if (before.length) {
    if (before.length !== 1 || before[0].body !== body)
      throw new Error('CODEX_RECEIPT_IDENTITY_CONFLICT_NO_REPLAY');
    return { state: 'ALREADY_READ_BACK' };
  }

  // This per-body file is an effect barrier only. GitHub remains the sole task
  // and receipt authority; an uncertain POST is never repeated blindly.
  const bodySha = digest(Buffer.from(body, 'utf8'));
  const claimPath = join(config.state_dir, `codex-receipt-${bodySha}.json`);
  const claim = { schema: 1, body_sha256: bodySha, request_id: data.request_id,
    attempt_id: data.attempt_id, state: 'POST_CLAIMED', updated_at: new Date().toISOString() };
  let fd;
  try {
    fd = openSync(claimPath, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(claim)); fsyncSync(fd); closeSync(fd); fd = undefined;
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* preserve original failure */ } }
    if (error.code === 'EEXIST') throw new Error('CODEX_RECEIPT_ALREADY_CLAIMED_NO_REPLAY');
    throw error;
  }
  const updateClaim = state => atomicJSON(claimPath,
    { ...claim, state, updated_at: new Date().toISOString() });
  try {
    if (deps.post) await deps.post(body);
    else {
      const temp = join(config.state_dir, `codex-comment-${randomUUID()}.txt`);
      writeFileSync(temp, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      try { gh(['issue', 'comment', String(config.issue), '-R', REPO, '--body-file', temp]); }
      finally { rmSync(temp, { force: true }); }
    }
  } catch {
    updateClaim('POST_OUTCOME_UNKNOWN_NO_REPLAY');
    throw new Error('CODEX_RECEIPT_POST_UNKNOWN_NO_REPLAY');
  }
  let after;
  try { after = matching(await readComments()); }
  catch { updateClaim('READBACK_UNKNOWN_NO_REPLAY'); throw new Error('CODEX_RECEIPT_READBACK_UNKNOWN_NO_REPLAY'); }
  if (after.length !== 1 || after[0].body !== body) {
    updateClaim('BODY_NOT_READ_BACK_NO_REPLAY');
    throw new Error('CODEX_RECEIPT_BODY_NOT_READ_BACK_NO_REPLAY');
  }
  updateClaim('READBACK_VERIFIED');
  return { state: 'READBACK_VERIFIED', body_sha256: bodySha };
}
function atomicJSON(path, data) {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 });
  renameSync(temp, path);
}
export function guardConfig(c) {
  if (c.repo !== REPO || c.project_id !== PROJECT || c.host.toUpperCase() !== hostname().toUpperCase())
    throw new Error('WRONG_PROJECT_OR_HOST');
  if (!Number.isSafeInteger(c.issue) || c.issue < 1) throw new Error('INVALID_ISSUE');
  if (!Array.isArray(c.dispatchers) || !c.dispatchers.length || !c.dispatchers.every(x => /^[a-zA-Z0-9-]{1,39}$/.test(x)))
    throw new Error('INVALID_TRUSTED_AUTHOR_SET');
  for (const p of ['workspace', 'state_dir']) {
    if (typeof c[p] !== 'string') throw new Error(`INVALID_${p.toUpperCase()}_TYPE`);
    const rel = relative(resolve(homedir()), resolve(c[p]));
    if (rel.startsWith('..') || isAbsolute(rel) || rel === '') throw new Error(`INVALID_${p.toUpperCase()}_NOT_UNDER_HOME`);
  }
  if (c.codex_spool !== undefined) {
    if (typeof c.codex_spool !== 'string') throw new Error('INVALID_CODEX_SPOOL_TYPE');
    const rel = relative(resolve(homedir()), resolve(c.codex_spool));
    if (rel.startsWith('..') || isAbsolute(rel) || rel === '')
      throw new Error('INVALID_CODEX_SPOOL_NOT_UNDER_HOME');
  }
  if (!existsSync(c.workspace) || !statSync(c.workspace).isDirectory()) throw new Error('WORKSPACE_NOT_DIRECTORY');
  if (c.allowed_models !== undefined) {
    if (!c.allowed_models || typeof c.allowed_models !== 'object' || Array.isArray(c.allowed_models))
      throw new Error('MODEL_ALLOWLIST_INVALID');
    for (const [model, variants] of Object.entries(c.allowed_models)) {
      if (!Array.isArray(variants) || !variants.length ||
          !variants.every(v => validateV2Model(model, v))) throw new Error('MODEL_ALLOWLIST_INVALID');
    }
  }
  if (c.enable_v2_model_runs !== undefined && typeof c.enable_v2_model_runs !== 'boolean')
    throw new Error('V2_MODEL_ENABLE_FLAG_INVALID');
  if (c.executor !== undefined) validateExecutorDescriptor(c.executor);
  mkdirSync(c.state_dir, { recursive: true });
  return c;
}
// Never put public paths, environment variables or provider credentials in a receipt.
// OpenCode's official Windows installation may expose a .cmd shim instead of .exe;
// resolve only a native binary for child_process shell=false to avoid CMD injection.
// Compatibility export for existing source tests. The file name alone never
// establishes trust: version 2.x is mandatory, rejecting V1 even if named opencode.
export function findNativeCLI(env = process.env, win = platform() === 'win32') {
  const check = qualifyOpenCodeV2(env, win);
  return { bin: check.bin, hasWrapper: false, v2_version: check.version };
}
function localEvidence(config, requestId, value) {
  const file = join(config.state_dir, `native-evidence-${requestId}-${randomUUID()}.json`);
  writeFileSync(file, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
  const bytes = readFileSync(file);
  return { evidence_sha256: digest(bytes), evidence_bytes: bytes.length };
}
export function checkModelAuthorization(job, config) {
  if (job.schema !== 2 || job.kind !== 'opencode_plan') return false;
  const variants = config.allowed_models?.[job.model];
  return Array.isArray(variants) && variants.includes(job.variant);
}
function nativePreflight(config, job) {
  const cli = qualifyOpenCodeV2();
  const facts = {
    schema: 1, project_id: PROJECT, host: config.host, request_id: job.request_id,
    kind: 'native_preflight', source_sha: job.source_sha,
    node_version: process.version, platform: platform(), architecture: process.arch,
    opencode_v2_verified: cli.ready,
    native_executables_checked: cli.candidates_checked,
    model_allowlist_entries: Object.keys(config.allowed_models || {}).length,
    v2_model_execution_enabled: config.enable_v2_model_runs === true,
    cli_version: cli.version ?? 'NOT_FOUND_OR_WRONG_MAJOR', model_auth: 'NOT_TESTED',
    elevated: 'NOT_CHECKED', old_windows_services: 'NOT_CHECKED',
  };
  return { outcome: cli.ready ? 'OPENCODE_V2_VERSION_CONFIRMED_NO_MODEL_AUTH' : 'OPENCODE_V2_CLI_NOT_QUALIFIED',
    exit_code: 0, ...localEvidence(config, job.request_id, facts) };
}
function nativeV2Qualify(config, job) {
  const cli = qualifyOpenCodeV2();
  if (!cli.ready) return { outcome: 'OPENCODE_V2_CLI_NOT_QUALIFIED',
    exit_code: 43, evidence_sha256: null, evidence_bytes: 0 };
  const summary = runV2Readiness(cli.bin, config.state_dir);
  const facts = { schema: 1, project_id: PROJECT, host: config.host, kind: job.kind,
    request_id: job.request_id, source_sha: job.source_sha, v2_cli_version: cli.version,
    auth_metadata: summary.auth, model_catalog: summary.models, issues: summary.issues,
    inference_executed: false, credential_values_collected: false,
    model_execution_enabled: config.enable_v2_model_runs === true };
  const evidence = localEvidence(config, job.request_id, facts);
  const bad = summary.issues.length ||
    !summary.auth?.status?.startsWith('SAVED_ACCOUNT_') &&
    summary.auth?.status !== 'NO_SAVED_ACCOUNT_RECORDS' ||
    summary.models?.status !== 'PUBLIC_CATALOG_IDS_PARSED_NOT_USABLE_PROOF';
  return { outcome: bad ? 'V2_METADATA_INCOMPLETE_NOT_MODEL_ACCEPTANCE' :
    'V2_ZERO_TOKEN_METADATA_ONLY_NOT_MODEL_ACCEPTANCE',
    exit_code: bad ? 47 : 0, ...evidence };
}
export async function runPlan(spec, config, job, attemptId) {
  if (config.enable_v2_model_runs !== true) {
    return { outcome: 'V2_MODEL_EXECUTION_NOT_YET_APPROVED', exit_code: 44,
      evidence_sha256: null, evidence_bytes: 0 };
  }
  if (!checkModelAuthorization(job, config)) {
    return { outcome: 'MODEL_NOT_EXPLICITLY_ALLOWED', exit_code: 42,
      evidence_sha256: null, evidence_bytes: 0 };
  }
  const cli = qualifyOpenCodeV2();
  if (!cli.ready) return { outcome: 'OPENCODE_V2_CLI_NOT_QUALIFIED', exit_code: 43,
    evidence_sha256: null, evidence_bytes: 0 };
  // V2, not V1: ordered permissions, shell/subagent, provider/model#variant.
  // Config is private, never echoed to the GitHub Issue; no shell expansion of prompts.
  const safePolicy = JSON.stringify(buildV2ReadOnlyConfig());
  // V2 beta builds have ignored OPENCODE_CONFIG[_CONTENT] in some execution paths.
  // The documented project-local opencode.json is the authoritative V2 policy input.
  // Never overwrite unrelated project configuration or allow higher-priority .opencode.
  const configFile = join(config.workspace, 'opencode.json');
  if (existsSync(join(config.workspace, 'opencode.jsonc')) ||
      existsSync(join(config.workspace, '.opencode')))
    return { outcome: 'V2_WORKSPACE_CONFIG_CONFLICT', exit_code: 45, evidence_sha256: null, evidence_bytes: 0 };
  if (existsSync(configFile)) {
    if (readFileSync(configFile, 'utf8') !== safePolicy)
      return { outcome: 'V2_WORKSPACE_CONFIG_UNKNOWN', exit_code: 45, evidence_sha256: null, evidence_bytes: 0 };
  } else writeFileSync(configFile, safePolicy, { flag: 'wx', mode: 0o600 });
  if (readFileSync(configFile, 'utf8') !== safePolicy)
    return { outcome: 'V2_WORKSPACE_CONFIG_READBACK_FAILED', exit_code: 45, evidence_sha256: null, evidence_bytes: 0 };
  const args = buildV2ReadOnlyArgs(job, config.workspace, spec);
  const outputStem = `output-${job.request_id}-${attemptId}`;
  const stdoutPath = join(config.state_dir, `${outputStem}.stdout.bin`);
  const stderrPath = join(config.state_dir, `${outputStem}.stderr.bin`);
  // Forbid inherited config injections from silently weakening our project file.
  // Model credentials remain inherited from the same non-privileged OS user.
  const childEnv = { ...process.env };
  for (const key of ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT',
    'OPENCODE_PERMISSION', 'OPENCODE_AUTO_SHARE', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN'])
    delete childEnv[key];
  childEnv.OPENCODE_DISABLE_AUTOUPDATE = 'true';
  return runCapturedProcess(cli.bin, args, {
    cwd: config.workspace, env: childEnv, stdoutPath, stderrPath,
    terminate: killTree,
  });
}
function killTree(child) {
  if (!child.pid) return;
  // Never target a PID after Node has observed the root exit: Windows may have
  // reused it. A root-only fallback is best effort and explicitly not tree proof.
  if (child.exitCode !== null || child.signalCode) {
    return { rootOnly: true, error: 'ROOT_EXITED_TREE_STATUS_UNKNOWN' };
  }
  if (platform() === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'],
        { timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      return { treeConfirmed: true };
    } catch {
      try { return { rootOnly: child.kill(), error: 'TASKKILL_TREE_FAILED' }; }
      catch { return { rootOnly: false, error: 'TASKKILL_AND_ROOT_TERMINATION_FAILED' }; }
    }
  }
  try { return { rootOnly: child.kill('SIGKILL'), error: 'NON_WINDOWS_TREE_TERMINATION_UNVERIFIED' }; }
  catch { return { rootOnly: false, error: 'ROOT_TERMINATION_FAILED' }; }
}
function readSpec(job, apiRead = api) {
  const b = apiRead(`repos/${REPO}/contents/${job.spec_path}?ref=${job.source_sha}`);
  if (b.encoding !== 'base64' || typeof b.content !== 'string') throw new Error('SPEC_UNREADABLE');
  const bytes = Buffer.from(b.content.replace(/\s+/g, ''), 'base64');
  if (digest(bytes) !== job.spec_sha256) throw new Error('SPEC_HASH_MISMATCH');
  return bytes.toString('utf8');
}
export function receipt(requestId, attemptId, state, job, result = null) {
  return { schema: 1, project_id: PROJECT, host: job.host, request_id: requestId,
    attempt_id: attemptId, state, kind: job.kind, source_sha: job.source_sha,
    outcome: result?.outcome ?? (state === 'STARTED' ? 'DISPATCH_ACK_NOT_ACCEPTANCE' : 'UNKNOWN'),
    exit_code: result?.exit_code ?? null,
    evidence_sha256: result?.evidence_sha256 ?? null,
    evidence_bytes: result?.evidence_bytes ?? null,
    ...(job.schema === 2 ? { model: job.model, variant: job.variant } : {}),
    ...(job.schema === 3 ? { model: job.model, reasoning_effort: job.reasoning_effort,
      task_fingerprint: result?.fingerprint ?? result?.task_fingerprint ?? null,
      session_id: result?.session_id ?? null, diff_sha256: result?.diff_sha256 ?? null,
      stdout_sha256: result?.stdout_sha256 ?? null, stderr_sha256: result?.stderr_sha256 ?? null,
      tests: result?.tests ?? 'NOT_RUN', pr_url: result?.pr_url ?? null } : {}) };
}
function triggerCodexExecutor(config) {
  if (config.codex_executor_task !== 'PTYSD-Codex-Executor')
    throw new Error('CODEX_EXECUTOR_TASK_IDENTITY_MISMATCH');
  assertCodexExecutorTaskReady(config);
  execFileSync('schtasks.exe', ['/run', '/tn', config.codex_executor_task], {
    encoding: 'utf8', timeout: 20000, maxBuffer: 65536, windowsHide: true, shell: false,
  });
}
export function codexTerminalReceipt(started, result) {
  if (!HASH.test(started?.task_fingerprint || '')) throw new Error('CODEX_START_FINGERPRINT_REQUIRED');
  validateCodexExecutorResult(result, started);
  const job = { ...started, schema: 3, model: started.model,
    reasoning_effort: started.reasoning_effort };
  // FINISHED describes this attempt's terminal lifecycle only. Even the
  // unverified zero-exit outcome is never evidence of coding or acceptance.
  const endedWithCapturedSession = result.exit_code === 0 &&
    result.outcome === 'CODEX_CLI_EXIT_0_UNVERIFIED' && result.model_invoked === true &&
    result.session_id !== null && Array.isArray(result.out_of_scope_paths) &&
    result.out_of_scope_paths.length === 0;
  const terminal = receipt(started.request_id, started.attempt_id,
    endedWithCapturedSession ? 'FINISHED' : 'BLOCKED', job, result);
  terminal.outcome = result.outcome || (result.exit_code === 0 ?
    'CODEX_CLI_EXIT_0_UNVERIFIED' : 'CODEX_CLI_FAILED');
  return terminal;
}
export async function reconcileCodexExecutorResult(started, config, workerLogin,
  blockedKinds, deps = {}) {
  const spool = config.codex_spool || '';
  const resultPath = codexExecutorResultPath(spool, started.request_id,
    started.attempt_id);
  const exists = deps.exists || existsSync;
  if (!exists(resultPath)) {
    blockedKinds.add('codex_plan');
    try {
      const requestPath = join(spool, 'requests', `${started.request_id}-${started.attempt_id}.json`);
      const requestInfo = lstatSync(requestPath);
      if (!requestInfo.isFile() || requestInfo.isSymbolicLink())
        throw new Error('CODEX_REQUEST_NOT_REGULAR_FILE');
      const requestBytes = readFileSync(requestPath, 'utf8');
      const requestObject = JSON.parse(requestBytes);
      const request = validateCodexExecutorRequest(requestObject);
      if (request.job.request_id !== started.request_id || request.job.host !== started.host ||
          request.job.source_sha !== started.source_sha || request.job.model !== started.model ||
          request.job.reasoning_effort !== started.reasoning_effort ||
          request.attemptId !== started.attempt_id ||
          requestObject.fingerprint !== started.task_fingerprint)
        throw new Error('CODEX_REQUEST_START_IDENTITY_MISMATCH');

      // The executor's per-attempt claim is created before any model process.
      // If it exists, this attempt may already have effects; never retrigger it.
      const executorClaim = join(spool, 'claims', `${started.request_id}-${started.attempt_id}.json`);
      if (exists(executorClaim)) return { status: 'WAITING', reason: 'EXECUTOR_ATTEMPT_CLAIMED_NO_RESULT' };
      const lockDir = join(spool, 'locks');
      const activeLock = join(lockDir, 'executor.active');
      if (exists(activeLock)) return { status: 'WAITING', reason: 'EXECUTOR_ACTIVE_NO_RESULT' };

      // A single durable marker bounds recovery for this exact attempt. It is
      // intentionally retained if Task Scheduler returns an ambiguous result.
      const recoveryClaim = join(lockDir,
        `retrigger-${started.request_id}-${started.attempt_id}.json`);
      mkdirSync(lockDir, { recursive: true });
      let fd;
      try {
        fd = openSync(recoveryClaim, 'wx', 0o600);
        writeFileSync(fd, JSON.stringify({ schema: 1, request_id: started.request_id,
          attempt_id: started.attempt_id, fingerprint: started.task_fingerprint,
          created_at: new Date().toISOString() }));
        fsyncSync(fd);
      } catch (error) {
        if (fd !== undefined) { try { closeSync(fd); } catch { /* preserve original failure */ } }
        if (error.code === 'EEXIST')
          return { status: 'WAITING', reason: 'RECOVERY_TRIGGER_ALREADY_ATTEMPTED' };
        throw error;
      }
      closeSync(fd);
      await (deps.triggerExecutor || triggerCodexExecutor)(config);
      return { status: 'RETRIGGERED' };
    } catch (error) {
      const safe = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value);
      const reason = safe(error?.code) ? error.code : safe(error?.message) ? error.message :
        'RECOVERY_TRIGGER_UNKNOWN_NO_REPLAY';
      return { status: 'UNKNOWN_NO_REPLAY', reason };
    }
  }
  try {
    const read = deps.read || readFileSync;
    const result = JSON.parse(read(resultPath, 'utf8'));
    const terminal = codexTerminalReceipt(started, result);
    const publish = deps.writeReceiptOnce || deps.writeReceipt || writeCodexReceiptOnce;
    await publish(config, terminal, workerLogin, deps.receiptDependencies || deps);
    return { status: 'RECOVERED' };
  } catch (error) {
    // A malformed result or uncertain receipt write belongs to this attempt.
    // Preserve the STARTED claim and let independent zero-token jobs continue.
    blockedKinds.add('codex_plan');
    const safe = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value);
    const reason = safe(error?.code) ? error.code : safe(error?.message) ? error.message :
      'RESULT_OR_RECEIPT_INVALID';
    return { status: 'UNKNOWN_NO_REPLAY', reason };
  }
}
export async function dispatchCodexJob({ config, job, spec, workerLogin,
  attemptId = randomUUID(),
  createBundle = async (bundlePath, sourceSha) => {
    mkdirSync(join(config.codex_spool, 'bundles'), { recursive: true });
    execFileSync('git', ['-C', config.workspace, 'bundle', 'create', bundlePath, sourceSha], {
      encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024, windowsHide: true,
      shell: false,
    });
  },
  claim = claimCodexAttempt, release = releaseCodexAttempt,
  publishRequest = publishCodexExecutorRequest,
  publishStarted = async data => writeCodexReceiptOnce(config, data, workerLogin),
  trigger = () => triggerCodexExecutor(config),
  cleanupBundle = path => rmSync(path, { force: true }) }) {
  if (!config.codex_spool) throw new Error('CODEX_SPOOL_NOT_CONFIGURED');
  const bundleDir = join(config.codex_spool, 'bundles');
  mkdirSync(bundleDir, { recursive: true });
  const bundlePath = join(bundleDir, `${job.request_id}-${attemptId}.bundle`);
  await createBundle(bundlePath, job.source_sha);
  const bundleSha = digest(readFileSync(bundlePath));
  const request = makeCodexExecutorRequest(job, attemptId, spec, bundlePath, bundleSha);
  const ownedClaim = claim(config.state_dir, job, attemptId);
  if (!ownedClaim.claimed) {
    cleanupBundle(bundlePath);
    return { state: 'CODEX_ATTEMPT_AMBIGUOUS', invoked: false, reason: ownedClaim.reason };
  }
  const requestPath = join(config.codex_spool, 'requests',
    `${job.request_id}-${attemptId}.json`);
  try { await publishRequest(config.codex_spool, request); }
  catch (error) {
    // Releasing a claim is safe only when the exact attempt request is absent.
    // Existing bytes may already be consumable by a scheduled executor.
    if (!existsSync(requestPath)) {
      release(job, ownedClaim);
      cleanupBundle(bundlePath);
    }
    throw error;
  }
  const started = { ...receipt(job.request_id, attemptId, 'STARTED', job),
    outcome: 'CODEX_EXECUTOR_DISPATCH_ACK_NOT_ACCEPTANCE',
    task_fingerprint: request.fingerprint };
  // The same source-bound, idempotent receipt writer used by the OpenCode lane
  // verifies pre-write identity and remote readback before a task is triggered.
  await publishStarted(started);
  await trigger();
  return { state: 'CODEX_EXECUTOR_REQUESTED', invoked: false, attemptId,
    requestPath };
}
async function hashEvidenceFile(path) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) { hash.update(chunk); bytes += chunk.length; }
  return { sha256: hash.digest('hex'), bytes };
}
async function updateCombinedHash(hash, path) {
  for await (const chunk of createReadStream(path)) hash.update(chunk);
}
export async function verifyCapturedEvidence(resultDir, result) {
  const local = result?.local_evidence;
  const terminal = result?.terminal ?? result;
  if (!local && terminal?.evidence_sha256 == null && terminal?.evidence_bytes === 0) return true;
  if (local && (local.storage_error || local.capture_error || local.spawn_error) &&
      terminal?.state === 'BLOCKED' && /(?:FAILED|ERROR)/.test(terminal?.outcome || '')) return true;
  const names = [local?.stdout_file, local?.stderr_file];
  if (!local || names.some(name => typeof name !== 'string' || basename(name) !== name ||
      !/^[A-Za-z0-9._-]{1,180}$/.test(name))) throw new Error('CAPTURED_EVIDENCE_PATH_INVALID');
  const paths = names.map(name => join(resultDir, name));
  for (const path of paths) {
    let info;
    try { info = lstatSync(path); } catch { throw new Error('CAPTURED_EVIDENCE_READBACK_FAILED'); }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('CAPTURED_EVIDENCE_PATH_NOT_REGULAR_FILE');
  }
  let stdout, stderr;
  try { [stdout, stderr] = await Promise.all(paths.map(hashEvidenceFile)); }
  catch { throw new Error('CAPTURED_EVIDENCE_READBACK_FAILED'); }
  if (stdout.sha256 !== local.stdout_sha256 || stdout.bytes !== local.stdout_bytes ||
      stderr.sha256 !== local.stderr_sha256 || stderr.bytes !== local.stderr_bytes)
    throw new Error('CAPTURED_EVIDENCE_FILE_HASH_MISMATCH');
  const combined = createHash('sha256');
  try {
    await updateCombinedHash(combined, paths[0]);
    combined.update(Buffer.from('\n--- STDERR ---\n', 'utf8'));
    await updateCombinedHash(combined, paths[1]);
  } catch { throw new Error('CAPTURED_EVIDENCE_READBACK_FAILED'); }
  if (combined.digest('hex') !== terminal.evidence_sha256 ||
      stdout.bytes + Buffer.byteLength('\n--- STDERR ---\n') + stderr.bytes !== terminal.evidence_bytes)
    throw new Error('CAPTURED_EVIDENCE_COMBINED_HASH_MISMATCH');
  return true;
}
function executorProcessTerminationUnconfirmed(result) {
  return ['ORPHAN_POSSIBLE', 'TERMINATION_UNCONFIRMED', 'TERMINATION_REQUESTED']
    .includes(result?.local_evidence?.termination_state);
}
export async function runWorker(configInput, adapters = {}) {
  const config = guardConfig(configInput);
  const apiRead = adapters.apiRead ?? api;
  const commentsRead = adapters.commentsRead ?? issueComments;
  const postReceipt = adapters.writeReceipt ?? writeReceipt;
  const verifyCodexTask = adapters.assertCodexExecutorTaskReady ?? assertCodexExecutorTaskReady;
  const verifyExecutor = adapters.assertExecutorTaskReady ?? assertExecutorTaskReady;
  const dispatchExecutor = adapters.dispatchToExecutor ?? dispatchToExecutor;
  const resolveExecutorResultsDir = adapters.executorResultsDir ?? (descriptor => descriptor.results_dir);
  const resolveExecutorResultPath = adapters.executorResultPath ?? executorResultPath;
  const executeInline = adapters.runPlan ?? runPlan;
  const log = adapters.log ?? (message => console.log(message));
  const dispatchCodex = adapters.dispatchCodexJob ?? (options => dispatchCodexJob({
    ...options,
    ...(adapters.codexDispatchOptions || {}),
    publishStarted: adapters.codexDispatchOptions?.publishStarted ??
      (data => writeCodexReceiptOnce(config, data, me)),
  }));
  const me = apiRead('user').login;
  if (!me) throw new Error('GH_AUTH_REQUIRED');
  const issue = apiRead(`repos/${REPO}/issues/${config.issue}`);
  if (issue.title !== ISSUE_TITLE || issue.state !== 'open' || issue.pull_request) throw new Error('ISSUE_IDENTITY_MISMATCH');
  const comments = commentsRead(config);
  // Reconcile ambiguous model effects by scope; keep independent zero-token jobs runnable.
  // Never replay an OpenCode operation without its exact persisted terminal evidence.
  const blockedKinds = new Set();
  for (const c of comments) {
    if (c.user?.login !== me) continue;
    const s = parseReceipt(c.body);
    if (!s || s.state !== 'STARTED' || s.host.toUpperCase() !== config.host.toUpperCase()) continue;
    const hasTerminal = comments.some(v => v.user?.login === me &&
      (r => r?.request_id === s.request_id && r?.attempt_id === s.attempt_id &&
        r?.source_sha === s.source_sha && r?.kind === s.kind && terminalStates.has(r.state))(parseReceipt(v.body)));
    if (s.kind === 'codex_plan') {
      if (hasTerminal) continue;
      const recovery = await reconcileCodexExecutorResult(s, config, me, blockedKinds, {
        ...(adapters.codexReconcileDependencies || {}),
        writeReceiptOnce: adapters.codexReconcileDependencies?.writeReceiptOnce ??
          adapters.codexReconcileDependencies?.writeReceipt ??
          ((receiptConfig, data, login) => writeCodexReceiptOnce(receiptConfig, data, login)),
      });
      if (recovery.status === 'RECOVERED') {
        log(`RECOVERED_CODEX_TERMINAL_${s.request_id}`);
        // This worker's comment snapshot predates the verified terminal write.
        // Suppress this Codex lane for the remainder of the tick, then allow
        // unrelated READY work to proceed without waiting for another poll.
        blockedKinds.add('codex_plan');
        continue;
      }
      if (recovery.status === 'RETRIGGERED')
        log(`CODEX_EXECUTOR_RECOVERY_TRIGGER_SENT_${s.request_id}_NO_DUPLICATE_RECEIPT`);
      else if (recovery.status === 'WAITING')
        log(`CODEX_EXECUTOR_RESULT_WAITING_${recovery.reason || 'NOT_YET_READABLE'}_${s.request_id}_NO_REPLAY`);
      else log(`CODEX_EXECUTOR_RESULT_${recovery.reason}_${s.request_id}_UNKNOWN_NO_REPLAY`);
      continue;
    }
    const resultDir = s.kind === 'opencode_plan' && config.executor ?
      resolveExecutorResultsDir(config.executor) : config.state_dir;
    const path = s.kind === 'opencode_plan' && config.executor ?
      resolveExecutorResultPath(resultDir, s.request_id, s.attempt_id) :
      join(resultDir, `result-${s.request_id}-${s.attempt_id}.json`);
    if (hasTerminal) {
      if (s.kind === 'opencode_plan' && config.executor) {
        if (existsSync(path)) {
          let result;
          try { result = JSON.parse(readFileSync(path, 'utf8')); }
          catch (error) {
            blockedKinds.add(s.kind);
            log(`EXECUTOR_TERMINAL_EVIDENCE_UNREADABLE_${s.request_id}_${String(error?.code || 'UNKNOWN').slice(0, 32)}_NO_REPLAY`);
            continue;
          }
          if (executorProcessTerminationUnconfirmed(result)) {
            blockedKinds.add(s.kind);
            log(`EXECUTOR_PROCESS_TERMINATION_UNRESOLVED_${s.request_id}`);
            continue;
          }
        }
        try { cleanupExecutorAttempt(config.executor, s.attempt_id); } catch { /* retain remote terminal evidence */ }
      }
      continue;
    }
    if (existsSync(path)) {
      let result;
      try {
        result = JSON.parse(readFileSync(path, 'utf8'));
        if (result.request_id !== s.request_id || result.attempt_id !== s.attempt_id ||
            result.terminal?.source_sha !== s.source_sha || result.terminal?.kind !== s.kind ||
            !parseReceipt(RECEIPT_MARKER + JSON.stringify(result.terminal)))
          throw new Error('LOCAL_RECEIPT_IDENTITY_MISMATCH');
        if (s.kind === 'opencode_plan') await verifyCapturedEvidence(resultDir, result);
      } catch (error) {
        if (s.kind === 'opencode_plan') blockedKinds.add(s.kind);
        log(`LOCAL_RESULT_RECONCILIATION_UNKNOWN_${s.request_id}_${String(error?.code || error?.message || 'UNKNOWN').slice(0, 48)}_NO_REPLAY`);
        continue;
      }
      if (s.kind === 'opencode_plan' && executorProcessTerminationUnconfirmed(result)) {
        blockedKinds.add(s.kind);
        log(`EXECUTOR_PROCESS_TERMINATION_UNRESOLVED_${s.request_id}`);
        continue;
      }
      postReceipt(config, result.terminal, me);
      if (s.kind === 'opencode_plan' && config.executor) {
        try { cleanupExecutorAttempt(config.executor, s.attempt_id); } catch { /* exact result and receipt remain durable */ }
      }
      log(`RECOVERED_TERMINAL_${s.request_id}`);
      return { state: 'RECOVERED_TERMINAL', request_id: s.request_id };
    }
    if (s.kind === 'opencode_plan') blockedKinds.add(s.kind);
    log(`AMBIGUOUS_STARTED_${s.request_id}: NO_REEXECUTION`);
  }
  const head = apiRead(`repos/${REPO}/git/ref/heads/main`).object?.sha;
  if (!SHA.test(head || '')) throw new Error('MAIN_HEAD_UNREADABLE');
  const selected = selectNextWithCodexClaim(comments, config.dispatchers, me, config.host,
    head, config.state_dir, [...blockedKinds]);
  let next = selected.next;
  if (selected.unresolvedRequestId)
    log(`CODEX_LOCAL_CLAIM_UNRECONCILED_${selected.unresolvedRequestId}_NO_REPLAY`);
  try {
    const observation = await publishOperatorObservation(
      config, me, comments, head, adapters.observationDependencies,
    );
    if (observation.status === 'UPDATED') log('OPERATOR_OBSERVATION_UPDATED');
    else if (observation.status === 'UNKNOWN') log('OPERATOR_OBSERVATION_UPDATE_UNKNOWN');
  } catch {
    // Status publishing failure must not block a valid queued task.
    log('OPERATOR_OBSERVATION_UPDATE_UNKNOWN');
  }
  if (next?.job.kind === 'codex_plan') {
    const gate = codexExecutionGate(next.job, config);
    if (!gate.allowed) {
      log(`CODEX_LANE_WAITING_AUTH_${gate.reasons.join(',')}`);
      blockedKinds.add('codex_plan');
      next = selectNext(comments, config.dispatchers, me, config.host, head, [...blockedKinds]);
    } else if (!config.codex_spool ||
        existsSync(join(config.codex_spool, 'locks', 'executor.active'))) {
      log('CODEX_EXECUTOR_SPOOL_OR_OWNER_NOT_READY');
      blockedKinds.add('codex_plan');
      next = selectNext(comments, config.dispatchers, me, config.host, head, [...blockedKinds]);
    } else {
      try {
        const taskReadback = verifyCodexTask(config, adapters.codexTaskReadbackOptions);
        if (taskReadback?.ready !== true) throw new Error('CODEX_EXECUTOR_TASK_READBACK_NOT_READY');
      }
      catch (error) {
        const code = String(error?.code || error?.message || 'TASK_READBACK_UNKNOWN')
          .replace(/[^A-Z0-9_]/gi, '_').slice(0, 72).toUpperCase();
        log(`CODEX_EXECUTOR_TASK_READBACK_FAILED_${code}`);
        blockedKinds.add('codex_plan');
        next = selectNext(comments, config.dispatchers, me, config.host, head, [...blockedKinds]);
      }
    }
  }
  if (!next) { log('NO_DELTA_NO_LLM'); return { state: 'NO_DELTA' }; }
  const job = next.job;
  if (job.source_sha !== head) { log(`STALE_SHA_SKIP_${job.request_id}`); return { state: 'STALE_SOURCE' }; }
  // Check full issue comment remains immutable since selection. Edits/races abort the lane.
  const original = apiRead(`repos/${REPO}/issues/comments/${next.id}`);
  if (original.body !== next.originalBody)
    throw new Error('DISPATCH_COMMENT_CHANGED');
  let spec = null;
  if (job.kind === 'opencode_plan' || job.kind === 'codex_plan') spec = readSpec(job, apiRead);
  const executorDispatch = job.kind === 'opencode_plan' && config.enable_v2_model_runs === true &&
    checkModelAuthorization(job, config);
  if (executorDispatch) {
    if (!config.executor) { log('EXECUTOR_NOT_CONFIGURED_NO_MODEL_DISPATCH'); return { state: 'EXECUTOR_NOT_CONFIGURED' }; }
    try { verifyExecutor(config.executor); }
    catch (err) {
      log(`EXECUTOR_NOT_READY_${String(err.code || 'UNKNOWN').slice(0, 64)}`);
      return { state: 'EXECUTOR_NOT_READY', code: String(err.code || 'UNKNOWN') };
    }
  }
  const attemptId = randomUUID();
  if (job.kind === 'codex_plan') {
    const dispatched = await dispatchCodex({ config, job, spec, workerLogin: me, attemptId });
    log(`${dispatched.state}_${job.request_id}_${attemptId}`);
    return { state: dispatched.state, request_id: job.request_id, attempt_id: attemptId,
      outcome: dispatched.reason ?? 'CODEX_EXECUTOR_DISPATCH_ACK_NOT_ACCEPTANCE' };
  }
  const start = receipt(job.request_id, attemptId, 'STARTED', job);
  postReceipt(config, start, me);
  if (executorDispatch) {
    const dispatched = dispatchExecutor(config.executor, {
      request_id: job.request_id, attempt_id: attemptId, source_sha: job.source_sha, job, spec,
    });
    log(`DISPATCHED_${job.request_id}_${dispatched.outcome}`);
    return { state: 'DISPATCHED', request_id: job.request_id, attempt_id: attemptId,
      outcome: dispatched.outcome };
  }
  let result;
  if (job.kind === 'ping') result = { outcome: 'BRIDGE_PING_OK_NOT_OS_ACCEPTANCE', exit_code: 0, evidence_sha256: null, evidence_bytes: 0 };
  else if (job.kind === 'native_preflight') result = nativePreflight(config, job);
  else if (job.kind === 'native_v2_qualify') result = nativeV2Qualify(config, job);
  else { try { result = await executeInline(spec, config, job, attemptId); }
    catch (err) { result = { outcome: `EXECUTION_ERROR_${String(err.code || 'UNKNOWN').slice(0, 36)}`, exit_code: -1, evidence_sha256: null, evidence_bytes: 0 }; } }
  const terminal = receipt(job.request_id, attemptId, terminalStateForResult(result), job, result);
  const terminalPath = join(config.state_dir, `result-${job.request_id}-${attemptId}.json`);
  atomicJSON(terminalPath, { request_id: job.request_id, attempt_id: attemptId, terminal,
    local_evidence: result.local_evidence ?? null });
  postReceipt(config, terminal, me);
  log(`${terminal.state}_${job.request_id}_${terminal.outcome}`);
  return { state: terminal.state, request_id: job.request_id, attempt_id: attemptId,
    outcome: terminal.outcome };
}

export async function main(options = {}) {
  let configInput = options.config;
  if (!configInput) {
    const i = process.argv.indexOf('--config');
    if (i === -1 || !process.argv[i + 1]) throw new Error('USAGE: --config config.json');
    configInput = JSON.parse(readFileSync(resolve(process.argv[i + 1]), 'utf8').replace(/^\\uFEFF/, ''));
  }
  return runWorker(configInput, {
    apiRead: options.apiRead ?? options.api,
    commentsRead: options.commentsRead ?? options.issueComments,
    writeReceipt: options.writeReceipt,
    observationDependencies: options.observationDependencies,
    dispatchCodexJob: options.dispatchCodexJob,
    codexDispatchOptions: options.codexDispatchOptions,
    codexReconcileDependencies: options.codexReconcileDependencies,
    log: options.log,
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(err => { console.error(`NATIVE_BRIDGE_BLOCKED: ${String(err.message || err).slice(0, 140)}`); process.exitCode = 2; });
}
