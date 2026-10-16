#!/usr/bin/env node
// PTYSD native issue bridge. No listener, MCP, model router, or privileged daemon.
// Public GitHub issue comments are only pointers to immutable, reviewed source.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync,
  openSync, closeSync, fsyncSync } from 'node:fs';
import { homedir, hostname, platform } from 'node:os';
import { basename, dirname, join, resolve, relative, isAbsolute, delimiter } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { qualifyOpenCodeV2, validateV2Model, validateV2ScopedEditPaths,
  buildV2ScopedEditConfig,
  buildV2ScopedEditArgs, readOpenCodeV2RunEvidence } from './opencode-v2.mjs';
import { runV2AuthReadiness, runV2Readiness } from './v2-readiness.mjs';
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
import { readWindowsProcessTree, runCapturedProcess, terminateProcessTree } from './captured-process.mjs';
import { assertExecutorTaskReady, candidateBundlePath, cleanupExecutorAttempt, dispatchToExecutor,
  executorMailboxState, executorProcessPath, executorResultPath, getCurrentWindowsSid,
  makeExecutorManifest, readExecutorProcessEvidence, triggerPendingExecutorAttempt,
  validateExecutorDescriptor } from './windows-executor.mjs';

export const PROJECT = 'CHATGPT_GLOBAL_SKILL_GOVERNANCE';
export const REPO = 'PT-Original-Point/ptysd-autonomous-factory';
export const REPO_ID = 1352411536;
export const JOB_MARKER = 'PTYSD_NATIVE_JOB_V1\n';
export const RECEIPT_MARKER = 'PTYSD_NATIVE_RECEIPT_V1\n';
export const ISSUE_TITLE = '[PTYSD-NATIVE] OpenCode dispatch and receipts';
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const REQUEST = /^[A-Z][A-Z0-9_-]{7,79}$/;
const V1_KEYS = ['schema', 'project_id', 'host', 'request_id', 'kind', 'source_sha', 'spec_path', 'spec_sha256'];
const V2_KEYS = [...V1_KEYS, 'model', 'variant'];
const V4_KEYS = [...V1_KEYS, 'model', 'variant', 'write_paths'];
const V5_KEYS = [...V4_KEYS, 'candidate_pr'];
const V6_KEYS = [...V5_KEYS, 'goal_ref'];
const HUMAN_GOAL_ISSUE = 310;
const HUMAN_GOAL_MARKER = 'PTYSD_V53R4_DELETE_FIRST_AUTONOMY_GOAL_20261015';
const RECEIPT_STATES = new Set(['STARTED', 'FINISHED', 'BLOCKED']);
const terminalStates = new Set(['FINISHED', 'BLOCKED']);
// OpenCode reads its own saved provider account from the executor user's profile.
// Do not inherit arbitrary Publisher/provider secrets or config injection from
// the parent process; pass only the OS/runtime environment needed by the CLI.
const V2_EDIT_ENVIRONMENT_KEYS = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH',
  'TEMP', 'TMP', 'COMSPEC', 'ALLUSERSPROFILE', 'PROGRAMDATA', 'PROGRAMFILES',
  'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432', 'OS', 'COMPUTERNAME',
  'USERNAME', 'USERDOMAIN', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION',
  'LANG', 'LC_ALL', 'TERM', 'NO_COLOR', 'COLORTERM',
]);
const commandTimeout = 60000;
function digest(data) { return createHash('sha256').update(data).digest('hex'); }
function openCodeEditEnvironment(source = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    const canonical = key.toUpperCase();
    if (V2_EDIT_ENVIRONMENT_KEYS.has(canonical) && typeof value === 'string')
      env[canonical] = value;
  }
  if (env.USERPROFILE) env.HOME = env.USERPROFILE;
  env.OPENCODE_DISABLE_AUTOUPDATE = 'true';
  return env;
}
export function terminalStateForResult(result) {
  // This field records only the execution attempt lifecycle. A zero exit code
  // never upgrades the outcome to semantic, coding, PR, or source acceptance.
  if (!result || result.exit_code !== 0 || typeof result.outcome !== 'string') return 'BLOCKED';
  if (/(?:^|_)(?:FAILED|ERROR)(?:_|$)/.test(result.outcome)) return 'BLOCKED';
  return 'FINISHED';
}
function validGoalReference(value) {
  return value && !Array.isArray(value) && typeof value === 'object' &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify(['body_sha256', 'comment_id', 'issue', 'marker']) &&
    value.issue === HUMAN_GOAL_ISSUE && Number.isSafeInteger(value.comment_id) && value.comment_id > 0 &&
    value.marker === HUMAN_GOAL_MARKER && HASH.test(value.body_sha256 || '');
}
export function verifyGoalReference(job, dispatchers, apiRead = api,
  goalCommentsRead = () => issueCommentsFor(HUMAN_GOAL_ISSUE)) {
  if (job?.schema !== 6 || !validGoalReference(job.goal_ref) ||
      !Array.isArray(dispatchers) || typeof apiRead !== 'function' || typeof goalCommentsRead !== 'function')
    return { valid: false, reason: 'GOAL_REFERENCE_SHAPE_INVALID' };
  const reference = job.goal_ref;
  let goalComments;
  try { goalComments = goalCommentsRead(); }
  catch { return { valid: false, reason: 'LATEST_GOAL_READBACK_UNKNOWN' }; }
  if (!Array.isArray(goalComments))
    return { valid: false, reason: 'LATEST_GOAL_READBACK_UNKNOWN' };
  const latestGoal = goalComments.filter(comment =>
    comment?.issue_url === `https://api.github.com/repos/${REPO}/issues/${HUMAN_GOAL_ISSUE}` &&
    Number.isSafeInteger(comment.id) && comment.id > 0 &&
    typeof comment.user?.login === 'string' && dispatchers.includes(comment.user.login) &&
    typeof comment.body === 'string' && comment.body.includes(HUMAN_GOAL_MARKER))
    .sort((a, b) => a.id - b.id).at(-1);
  if (!latestGoal) return { valid: false, reason: 'LATEST_TRUSTED_GOAL_NOT_FOUND' };
  if (latestGoal.id !== reference.comment_id)
    return { valid: false, reason: 'GOAL_COMMENT_SUPERSEDED' };
  let comment;
  try { comment = apiRead(`repos/${REPO}/issues/comments/${reference.comment_id}`); }
  catch { return { valid: false, reason: 'GOAL_COMMENT_READBACK_UNKNOWN' }; }
  if (comment?.id !== reference.comment_id ||
      comment.issue_url !== `https://api.github.com/repos/${REPO}/issues/${HUMAN_GOAL_ISSUE}` ||
      !dispatchers.includes(comment.user?.login))
    return { valid: false, reason: 'GOAL_COMMENT_IDENTITY_MISMATCH' };
  if (typeof comment.body !== 'string' || !comment.body.includes(HUMAN_GOAL_MARKER) ||
      digest(comment.body) !== reference.body_sha256.toLowerCase())
    return { valid: false, reason: 'GOAL_COMMENT_CONTENT_MISMATCH' };
  return { valid: true, reason: null };
}
function validTaskSourceRef(value) {
  return value && !Array.isArray(value) && typeof value === 'object' &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify(['author', 'body_sha256', 'comment_id', 'issue']) &&
    value.issue === HUMAN_GOAL_ISSUE && Number.isSafeInteger(value.comment_id) && value.comment_id > 0 &&
    typeof value.author === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(value.author) &&
    HASH.test(value.body_sha256 || '');
}
function taskSourceRefForComment(comment, dispatchers) {
  if (comment?.issue_url !== `https://api.github.com/repos/${REPO}/issues/${HUMAN_GOAL_ISSUE}` ||
      !Number.isSafeInteger(comment.id) || comment.id < 1 ||
      typeof comment.user?.login !== 'string' || !dispatchers.includes(comment.user.login) ||
      typeof comment.body !== 'string') return null;
  return { issue: HUMAN_GOAL_ISSUE, comment_id: comment.id, author: comment.user.login,
    body_sha256: digest(comment.body) };
}
function taskSourceRefMatchesComment(source, comment) {
  return validTaskSourceRef(source) && comment?.id === source.comment_id &&
    comment.issue_url === `https://api.github.com/repos/${REPO}/issues/${source.issue}` &&
    comment.user?.login === source.author && typeof comment.body === 'string' &&
    digest(comment.body) === source.body_sha256;
}
function sameTaskSourceRef(left, right) {
  const a = left ?? null;
  const b = right ?? null;
  if (a === null || b === null) return a === b;
  return validTaskSourceRef(a) && validTaskSourceRef(b) && a.issue === b.issue &&
    a.comment_id === b.comment_id && a.author === b.author && a.body_sha256 === b.body_sha256;
}
function selectedSourceCommentMatches(selection, comment) {
  if (comment?.body !== selection?.originalBody) return false;
  const source = selection?.task_source_ref ?? null;
  if (source === null) return true;
  return taskSourceRefMatchesComment(source, comment);
}
export function parseJob(body) {
  const codexJob = parseCodexJob(body);
  if (codexJob) return codexJob;
  if (typeof body !== 'string' || !body.startsWith(JOB_MARKER)) return null;
  let obj; try { obj = JSON.parse(body.slice(JOB_MARKER.length)); } catch { return null; }
  if (!obj || Array.isArray(obj) || typeof obj !== 'object') return null;
  const keys = obj.schema === 1 ? V1_KEYS : obj.schema === 2 ? V2_KEYS :
    obj.schema === 4 ? V4_KEYS : obj.schema === 5 ? V5_KEYS : obj.schema === 6 ? V6_KEYS : null;
  if (!keys || JSON.stringify(Object.keys(obj).sort()) !== JSON.stringify(keys.slice().sort())) return null;
  if (obj.project_id !== PROJECT || !REQUEST.test(obj.request_id)) return null;
  if (typeof obj.host !== 'string' || !/^[A-Z0-9-]{3,64}$/.test(obj.host) || !SHA.test(obj.source_sha)) return null;
  if (obj.schema === 1 && (obj.kind === 'ping' || obj.kind === 'native_preflight' || obj.kind === 'native_v2_qualify')) {
    if (obj.spec_path !== null || obj.spec_sha256 !== null) return null;
    return obj;
  }
  // Never allow a model operation without an exact reviewed model + reasoning variant.
  // V1 opencode_plan without these fields is deliberately retired (no live V1 plan job).
  if (!((obj.schema === 2 && obj.kind === 'opencode_plan') ||
      ([4, 5, 6].includes(obj.schema) && obj.kind === 'opencode_edit'))) return null;
  if (typeof obj.spec_path !== 'string' || !/^native-bridge\/tasks\/[a-z0-9-]{1,70}\.md$/.test(obj.spec_path)) return null;
  if (typeof obj.spec_sha256 !== 'string' || !HASH.test(obj.spec_sha256)) return null;
  if (!validateV2Model(obj.model, obj.variant)) return null;
  if ([4, 5, 6].includes(obj.schema)) {
    try { validateV2ScopedEditPaths(obj.write_paths); } catch { return null; }
  }
  if ([5, 6].includes(obj.schema) && (!Number.isSafeInteger(obj.candidate_pr) || obj.candidate_pr < 1)) return null;
  if (obj.schema === 6 && !validGoalReference(obj.goal_ref)) return null;
  return obj;
}
export function candidatePullRequestEligible(job, liveMainSha, pullRequest) {
  return [5, 6].includes(job?.schema) && job.kind === 'opencode_edit' &&
    Number.isSafeInteger(job.candidate_pr) && job.candidate_pr > 0 &&
    SHA.test(job.source_sha || '') && SHA.test(liveMainSha || '') &&
    pullRequest?.number === job.candidate_pr && pullRequest.state === 'open' &&
    pullRequest.base?.ref === 'main' && pullRequest.base?.sha === liveMainSha &&
    pullRequest.head?.sha === job.source_sha &&
    pullRequest.base?.repo?.id === REPO_ID && pullRequest.head?.repo?.id === REPO_ID &&
    pullRequest.base?.repo?.full_name?.toLowerCase() === REPO.toLowerCase() &&
    pullRequest.head?.repo?.full_name?.toLowerCase() === REPO.toLowerCase();
}
function candidatePinKey(job) { return `${job.candidate_pr}:${job.source_sha}`; }
export function createCandidateSourceBundle({ workspace, executor, job, attemptId,
  execFile = execFileSync } = {}) {
  const sourcePinnedEdit = job?.kind === 'opencode_edit' &&
    ((job.schema === 4 && job.candidate_pr === undefined) ||
      ([5, 6].includes(job.schema) && Number.isSafeInteger(job.candidate_pr) && job.candidate_pr > 0));
  if (!executor || !sourcePinnedEdit || !SHA.test(job.source_sha || ''))
    throw new Error('CANDIDATE_SOURCE_BUNDLE_IDENTITY_INVALID');
  const bundlePath = candidateBundlePath(executor.manifest_dir, attemptId);
  const bundleDir = dirname(bundlePath);
  mkdirSync(bundleDir, { recursive: true });
  const directory = lstatSync(bundleDir);
  if (!directory.isDirectory() || directory.isSymbolicLink())
    throw new Error('CANDIDATE_SOURCE_BUNDLE_DIRECTORY_INVALID');
  if (existsSync(bundlePath)) throw new Error('CANDIDATE_SOURCE_BUNDLE_ALREADY_EXISTS_NO_OVERWRITE');
  const options = { encoding: 'utf8', windowsHide: true, shell: false, timeout: 120000,
    maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] };
  const temporaryRef = `refs/pty-native/candidate-bundles/${attemptId}`;
  let temporaryRefCreated = false;
  try {
    execFile('git', ['-C', resolve(workspace), 'update-ref', temporaryRef,
      job.source_sha, '0'.repeat(40)], options);
    temporaryRefCreated = true;
    execFile('git', ['-C', resolve(workspace), 'bundle', 'create', bundlePath, temporaryRef], options);
    execFile('git', ['-C', resolve(workspace), 'bundle', 'verify', bundlePath], options);
    const bundleInfo = lstatSync(bundlePath);
    if (!bundleInfo.isFile() || bundleInfo.isSymbolicLink())
      throw new Error('CANDIDATE_SOURCE_BUNDLE_NOT_REGULAR');
    return { source_sha: job.source_sha, sha256: digest(readFileSync(bundlePath)) };
  } catch (error) {
    try { rmSync(bundlePath, { force: true }); } catch { /* no manifest references the failed bundle */ }
    throw error;
  } finally {
    if (temporaryRefCreated) {
      try { execFile('git', ['-C', resolve(workspace), 'update-ref', '-d', temporaryRef,
        job.source_sha], options); }
      catch {
        try { rmSync(bundlePath, { force: true }); } catch { /* fail closed if local ref cleanup is uncertain */ }
        throw new Error('CANDIDATE_SOURCE_TEMP_REF_CLEANUP_FAILED');
      }
    }
  }
}
function readCandidatePullRequestPins(comments, dispatchers, workerLogin, host, liveMainSha,
  apiRead, blockedKinds, latestRequestId, log) {
  const jobs = new Map();
  const receipts = new Map();
  for (const comment of comments) {
    const sourceRef = comment.task_source_ref ?? null;
    const job = sourceRef !== null && !validTaskSourceRef(sourceRef) ? null : parseJob(comment.body);
    if ([5, 6].includes(job?.schema) && dispatchers.includes(comment.user?.login) &&
        job.host.toUpperCase() === host.toUpperCase() &&
        (!blockedKinds.has(job.kind) || job.request_id === latestRequestId)) {
      const prior = jobs.get(job.request_id);
      if (!prior) jobs.set(job.request_id, { job, body: comment.body,
        task_source_ref: sourceRef, duplicate: false });
      else if (prior.body !== comment.body || !sameTaskSourceRef(prior.task_source_ref, sourceRef))
        prior.duplicate = true;
    }
    if (comment.user?.login === workerLogin) {
      const receiptValue = parseReceipt(comment.body);
      if (receiptValue) {
        if (!receipts.has(receiptValue.request_id)) receipts.set(receiptValue.request_id, []);
        receipts.get(receiptValue.request_id).push(receiptValue);
      }
    }
  }
  const prReadbacks = new Map();
  const pins = new Set();
  for (const { job, task_source_ref: sourceRef, duplicate } of jobs.values()) {
    if (duplicate) continue;
    const sameRequest = receipts.get(job.request_id) || [];
    const sourceConflict = sameRequest.some(value =>
      value.host.toUpperCase() === job.host.toUpperCase() && value.source_sha === job.source_sha &&
      value.kind === job.kind && (value.candidate_pr ?? null) === job.candidate_pr &&
      JSON.stringify(value.goal_ref ?? null) === JSON.stringify(job.goal_ref ?? null) &&
      !sameTaskSourceRef(value.task_source_ref, sourceRef));
    if (sourceConflict) continue;
    const prior = sameRequest.filter(value =>
      value.host.toUpperCase() === job.host.toUpperCase() && value.source_sha === job.source_sha &&
      value.kind === job.kind && (value.candidate_pr ?? null) === job.candidate_pr &&
      JSON.stringify(value.goal_ref ?? null) === JSON.stringify(job.goal_ref ?? null) &&
      sameTaskSourceRef(value.task_source_ref, sourceRef));
    if (job.request_id !== latestRequestId &&
        prior.some(value => value.state === 'STARTED' || terminalStates.has(value.state))) continue;
    if (!prReadbacks.has(job.candidate_pr)) {
      try { prReadbacks.set(job.candidate_pr, apiRead(`repos/${REPO}/pulls/${job.candidate_pr}`)); }
      catch { prReadbacks.set(job.candidate_pr, null); }
    }
    if (candidatePullRequestEligible(job, liveMainSha, prReadbacks.get(job.candidate_pr)))
      pins.add(candidatePinKey(job));
    else log(`CANDIDATE_PR_PIN_NOT_CURRENT_${job.candidate_pr}_${job.request_id}`);
  }
  return pins;
}
export function parseReceipt(body) {
  if (typeof body !== 'string' || !body.startsWith(RECEIPT_MARKER)) return null;
  try {
    const o = JSON.parse(body.slice(RECEIPT_MARKER.length));
    if (o?.schema !== 1 || o.project_id !== PROJECT ||
        typeof o.host !== 'string' || !/^[A-Z0-9-]{3,64}$/.test(o.host) ||
        !SHA.test(o.source_sha) || typeof o.kind !== 'string' ||
        !['ping', 'native_preflight', 'native_v2_qualify', 'opencode_plan', 'opencode_edit', 'codex_plan'].includes(o.kind) ||
        typeof o.request_id !== 'string' || !REQUEST.test(o.request_id) ||
        !RECEIPT_STATES.has(o.state) || typeof o.attempt_id !== 'string' ||
        !/^[a-f0-9-]{36}$/.test(o.attempt_id)) return null;
    if (o.candidate_pr !== undefined &&
        (!Number.isSafeInteger(o.candidate_pr) || o.candidate_pr < 1 || o.kind !== 'opencode_edit')) return null;
    if (o.goal_ref !== undefined && (o.kind !== 'opencode_edit' || !validGoalReference(o.goal_ref))) return null;
    if (o.task_source_ref !== undefined &&
        (!['opencode_edit', 'codex_plan'].includes(o.kind) || !validTaskSourceRef(o.task_source_ref))) return null;
    if (o.model_invoked !== undefined && typeof o.model_invoked !== 'boolean') return null;
    if (o.kind === 'opencode_edit' && (o.schema !== 1 ||
        !validateV2Model(o.model, o.variant) ||
        (() => { try { validateV2ScopedEditPaths(o.write_paths); return false; } catch { return true; } })() ||
        (o.changed_paths !== null && o.changed_paths !== undefined &&
          (!Array.isArray(o.changed_paths) || !o.changed_paths.every(path =>
            typeof path === 'string' && o.write_paths.includes(path)))) ||
        (o.diff_sha256 !== undefined && o.diff_sha256 !== null && !HASH.test(o.diff_sha256)))) return null;
    if (o.kind === 'opencode_edit' &&
        ((o.session_id !== undefined && o.session_id !== null &&
          (typeof o.session_id !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(o.session_id))) ||
         (o.session_started !== undefined && typeof o.session_started !== 'boolean') ||
         (o.provider_usage_evidence !== undefined && !['CONFIRMED', 'UNKNOWN'].includes(o.provider_usage_evidence)) ||
         (o.model_activity_evidence !== undefined && !['CONFIRMED', 'UNKNOWN'].includes(o.model_activity_evidence)) ||
         (o.tool_execution_evidence !== undefined && !['OBSERVED', 'UNKNOWN'].includes(o.tool_execution_evidence)) ||
         (o.tool_execution_count !== undefined && (!Number.isSafeInteger(o.tool_execution_count) ||
           o.tool_execution_count < 0)) ||
         (o.file_change_tool_evidence !== undefined &&
           !['COMPLETED', 'FAILED', 'INCOMPLETE', 'MIXED', 'UNKNOWN'].includes(o.file_change_tool_evidence)) ||
         (['file_change_tool_completed_count', 'file_change_tool_failed_count',
           'file_change_tool_incomplete_count'].some(key => o[key] !== undefined &&
             (!Number.isSafeInteger(o[key]) || o[key] < 0))) ||
         (o.token_usage !== undefined && o.token_usage !== null &&
           (JSON.stringify(Object.keys(o.token_usage).sort()) !== JSON.stringify([
             'cached_input_tokens', 'input_tokens', 'output_tokens', 'reasoning_output_tokens']) ||
            Object.values(o.token_usage).some(value => value !== null &&
              (!Number.isSafeInteger(value) || value < 0)))) ||
         (['stdout_sha256', 'stderr_sha256'].some(key => o[key] !== undefined && o[key] !== null &&
           !HASH.test(o[key]))) ||
         (o.session_started === true && !o.session_id) ||
         (o.provider_usage_evidence === 'CONFIRMED' && (!o.token_usage ||
           !Object.values(o.token_usage).some(value => Number.isSafeInteger(value) && value > 0))) ||
         (o.model_invoked === true && o.provider_usage_evidence !== 'CONFIRMED' &&
           o.model_activity_evidence !== 'CONFIRMED') ||
         (o.tool_execution_evidence === 'OBSERVED' && !(o.tool_execution_count > 0)) ||
         (o.tool_execution_evidence === 'UNKNOWN' && o.tool_execution_count > 0))) return null;
    if (o.kind === 'codex_plan' &&
        ((o.session_started !== undefined && typeof o.session_started !== 'boolean') ||
         (o.provider_usage_evidence !== undefined && !['CONFIRMED', 'UNKNOWN'].includes(o.provider_usage_evidence)) ||
         (o.model_activity_evidence !== undefined && !['CONFIRMED', 'UNKNOWN'].includes(o.model_activity_evidence)) ||
         (o.tool_execution_evidence !== undefined && !['OBSERVED', 'UNKNOWN'].includes(o.tool_execution_evidence)) ||
         (o.tool_execution_count !== undefined && (!Number.isSafeInteger(o.tool_execution_count) ||
           o.tool_execution_count < 0)) ||
         (o.file_change_tool_evidence !== undefined &&
           !['COMPLETED', 'FAILED', 'INCOMPLETE', 'MIXED', 'UNKNOWN'].includes(o.file_change_tool_evidence)) ||
         (['file_change_tool_completed_count', 'file_change_tool_failed_count',
           'file_change_tool_incomplete_count'].some(key => o[key] !== undefined &&
             (!Number.isSafeInteger(o[key]) || o[key] < 0))) ||
         (o.changed_paths !== undefined && o.changed_paths !== null &&
           (!Array.isArray(o.changed_paths) || !o.changed_paths.every(path => typeof path === 'string'))))) return null;
    return o;
  } catch { return null; }
}
export function selectNext(comments, dispatchers, workerLogin, host, liveMainSha = null,
  blockedKinds = [], candidatePins = new Set()) {
  const jobs = new Map();
  const receipts = new Map();
  for (const c of comments) {
    const login = c.user?.login;
    const sourceRef = c.task_source_ref ?? null;
    const j = sourceRef !== null && !validTaskSourceRef(sourceRef) ? null : parseJob(c.body);
    if (j && dispatchers.includes(login) && j.host.toUpperCase() === host.toUpperCase()) {
      if (!jobs.has(j.request_id)) jobs.set(j.request_id, { job: j, content: c.body, id: c.id,
        task_source_ref: sourceRef, duplicate: false });
      else if (jobs.get(j.request_id).content !== c.body ||
          !sameTaskSourceRef(jobs.get(j.request_id).task_source_ref, sourceRef))
        jobs.get(j.request_id).duplicate = true;
    }
    const r = parseReceipt(c.body);
    if (r && login === workerLogin) {
      if (!receipts.has(r.request_id)) receipts.set(r.request_id, []);
      receipts.get(r.request_id).push(r);
    }
  }
  for (const [, v] of jobs) {
    const sameRequest = receipts.get(v.job.request_id) || [];
    const sourceConflict = sameRequest.some(x =>
      x.host.toUpperCase() === v.job.host.toUpperCase() && x.source_sha === v.job.source_sha &&
      x.kind === v.job.kind && (x.candidate_pr ?? null) === (v.job.candidate_pr ?? null) &&
      JSON.stringify(x.goal_ref ?? null) === JSON.stringify(v.job.goal_ref ?? null) &&
      !sameTaskSourceRef(x.task_source_ref, v.task_source_ref));
    const r = sameRequest.filter(x =>
      x.host.toUpperCase() === v.job.host.toUpperCase() &&
      x.source_sha === v.job.source_sha && x.kind === v.job.kind &&
      (x.candidate_pr ?? null) === (v.job.candidate_pr ?? null) &&
      JSON.stringify(x.goal_ref ?? null) === JSON.stringify(v.job.goal_ref ?? null) &&
      sameTaskSourceRef(x.task_source_ref, v.task_source_ref));
    if (v.duplicate || sourceConflict || v.job.kind === 'opencode_plan' || blockedKinds.includes(v.job.kind) ||
        r.some(x => terminalStates.has(x.state)) || r.some(x => x.state === 'STARTED')) continue;
    // A stale unsigned/unclaimed job must not starve a newer exact-main task.
    const pinKey = v.job.candidate_pr === undefined ? null : candidatePinKey(v.job);
    if ((pinKey !== null && !candidatePins.has(pinKey)) ||
        (liveMainSha !== null && v.job.source_sha !== liveMainSha &&
          (pinKey === null || !candidatePins.has(pinKey)))) continue;
    return { job: v.job, id: v.id, originalBody: v.content, task_source_ref: v.task_source_ref };
  }
  return null;
}
export function selectNextWithCodexClaim(comments, dispatchers, workerLogin, host,
  liveMainSha, stateDir, blockedKinds = [], candidatePins = new Set()) {
  const next = selectNext(comments, dispatchers, workerLogin, host, liveMainSha, blockedKinds, candidatePins);
  if (next?.job.kind !== 'codex_plan' ||
      !existsSync(join(stateDir, `codex-claim-${next.job.request_id}.json`)))
    return { next, unresolvedRequestId: null };
  const blocked = [...new Set([...blockedKinds, 'codex_plan'])];
  return { next: selectNext(comments, dispatchers, workerLogin, host, liveMainSha, blocked, candidatePins),
    unresolvedRequestId: next.job.request_id };
}
function gh(args, options = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', timeout: commandTimeout,
    maxBuffer: 8 * 1024 * 1024, windowsHide: true, ...options });
}
function api(uri, extras = []) { return JSON.parse(gh(['api', uri, ...extras])); }
function issueCommentsFor(issue) {
  const raw = JSON.parse(gh(['api', `repos/${REPO}/issues/${issue}/comments?per_page=100`, '--paginate', '--slurp']));
  return raw.flat().filter(c => typeof c?.id === 'number').sort((a, b) => a.id - b.id);
}
function issueComments(config) { return issueCommentsFor(config.issue); }
function latestOperatorJob(comments, config, workerLogin, mainSha, candidatePins = new Set()) {
  const jobs = comments.filter(c => config.dispatchers.includes(c.user?.login))
    .map(c => ({ id: c.id, body: c.body, job: parseJob(c.body),
      task_source_ref: c.task_source_ref ?? null }))
    .filter(x => x.job && x.job.host.toUpperCase() === config.host.toUpperCase())
    .sort((a, b) => a.id - b.id);
  if (!jobs.length) return null;
  const latest = jobs.at(-1);
  const job = latest.job;
  const duplicate = jobs.filter(entry => entry.job.request_id === job.request_id);
  if (new Set(duplicate.map(entry => entry.body)).size > 1 ||
      duplicate.some(entry => !sameTaskSourceRef(entry.task_source_ref, latest.task_source_ref))) {
    return { request_id: job.request_id, attempt_id: null, kind: job.kind,
      source_sha: job.source_sha, state: 'AMBIGUOUS_DUPLICATE' };
  }
  const sameRequest = comments.filter(c => c.user?.login === workerLogin)
    .map(c => ({ id: c.id, receipt: parseReceipt(c.body) }))
    .filter(x => x.receipt && x.receipt.request_id === job.request_id &&
      x.receipt.host.toUpperCase() === job.host.toUpperCase() &&
      x.receipt.source_sha === job.source_sha && x.receipt.kind === job.kind &&
      (x.receipt.candidate_pr ?? null) === (job.candidate_pr ?? null) &&
      JSON.stringify(x.receipt.goal_ref ?? null) === JSON.stringify(job.goal_ref ?? null));
  if (sameRequest.some(x => !sameTaskSourceRef(x.receipt.task_source_ref, latest.task_source_ref)))
    return { request_id: job.request_id, attempt_id: null, kind: job.kind,
      source_sha: job.source_sha, state: 'AMBIGUOUS_DUPLICATE' };
  const receipts = sameRequest.filter(x =>
      sameTaskSourceRef(x.receipt.task_source_ref, latest.task_source_ref))
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
  let state = job.kind === 'opencode_plan' && !last
    ? 'LEGACY_READONLY_NOT_DISPATCHED' : 'QUEUED_NOT_STARTED';
  if (state !== 'LEGACY_READONLY_NOT_DISPATCHED' &&
      job.candidate_pr !== undefined && !candidatePins.has(candidatePinKey(job)))
    state = 'CANDIDATE_SOURCE_UNVERIFIED';
  else if (state !== 'LEGACY_READONLY_NOT_DISPATCHED' &&
      job.candidate_pr === undefined && job.source_sha !== mainSha) state = 'STALE_SOURCE';
  else if (state !== 'LEGACY_READONLY_NOT_DISPATCHED' && last?.state === 'STARTED') state = 'STARTED_UNVERIFIED';
  else if (state !== 'LEGACY_READONLY_NOT_DISPATCHED' && last?.state === 'FINISHED') state = 'FINISHED_NOT_ACCEPTANCE';
  else if (state !== 'LEGACY_READONLY_NOT_DISPATCHED' && last?.state === 'BLOCKED') state = 'BLOCKED';
  return { request_id: job.request_id, attempt_id: attemptId, kind: job.kind,
    candidate_pr: job.candidate_pr ?? null,
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
  const historicalEvidence = prior.observation.historical_evidence || {
    snapshot_id: prior.observation.snapshot_id,
    observed_at: prior.observation.observed_at,
    opencode_v2: prior.observation.opencode_v2 || null,
    monitor_candidate: prior.observation.monitor_candidate || null,
    incident: prior.observation.incident || null,
  };
  let repositoryRunner = { status: 'UNKNOWN', count: null, observed_at: observedAt };
  try {
    const response = await (dependencies.readRunnerRegistration
      ? dependencies.readRunnerRegistration()
      : api('repos/' + OPERATOR_REPO + '/actions/runners?per_page=100'));
    if (Number.isSafeInteger(response.total_count) && response.total_count >= 0)
      repositoryRunner = { status: 'FRESH', count: response.total_count, observed_at: observedAt };
  } catch {}
  const latestTask = latestOperatorJob(comments, config, workerLogin, mainSha,
    dependencies.candidatePins ?? new Set());
  const activeTask = latestTask &&
    ['QUEUED_NOT_STARTED', 'STARTED_UNVERIFIED'].includes(latestTask.state)
    ? latestTask : null;
  const nextOwner = windows.status !== 'FRESH' ? 'OS_OBSERVATION_UNKNOWN'
    : windows.native_task.enabled === false ? 'NATIVE_SCHEDULER_REPAIR'
      : activeTask?.state === 'QUEUED_NOT_STARTED' ? 'NATIVE_WORKER'
        : activeTask?.state === 'STARTED_UNVERIFIED' ? 'VERIFY_ACTIVE_WORK'
          : latestTask?.state === 'CANDIDATE_SOURCE_UNVERIFIED' ? 'VERIFY_CANDIDATE_SOURCE'
            : latestTask?.state === 'LEGACY_READONLY_NOT_DISPATCHED' ? 'REPLACE_WITH_SCOPED_EDIT_TASK'
          : latestTask?.state === 'BLOCKED' ? 'REVIEW_BLOCKER' : 'NO_CURRENT_TASK';
  const snapshot = {
    schema: 1, project_id: OPERATOR_PROJECT, repo: OPERATOR_REPO, issue: OPERATOR_ISSUE,
    host_alias: 'win11-primary', snapshot_id: randomUUID(),
    sequence: (Number.isSafeInteger(prior.observation.sequence) ? prior.observation.sequence : 0) + 1,
    observed_at: observedAt,
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
      installed_version: null,
      version_verified_at: null,
      binary_sha256: null,
      process_observed_at: windows.observed_at,
      process_count: windows.opencode_process_count,
      active_session_count: null,
      active_session_state: 'UNKNOWN_NO_PASSIVE_API',
      historical_sessions_count: null,
      historical_sessions_observed_at: null,
      task_binding: 'UNPROVEN',
      model_execution: 'UNPROVEN',
      activity_observed_at: null,
      last_tool_activity_at: null,
      task_id: null,
      request_id: null,
      attempt_id: null,
      code_changes: 'UNPROVEN',
      remote_commit: null, pull_request: null, ci: 'UNKNOWN',
    },
    github: {
      observed_at: observedAt, main_sha: mainSha,
      issue_comments_count: Number.isSafeInteger(dependencies.issueCommentsCount)
        ? dependencies.issueCommentsCount : comments.length,
      runner_registration: repositoryRunner,
      organization_runner_registration: 'UNKNOWN_ORG_SCOPE_NOT_AVAILABLE',
      runner_service_count: windows.runner_service_count,
      runner_service_running: windows.runner_service_running,
    },
    incident: null,
    historical_evidence: historicalEvidence,
  };
  return updateExistingOperatorComment({
    comments, expectedLogin: workerLogin, body: encodeOperatorObservation(snapshot),
    now: () => new Date(dependencies.now ? dependencies.now() : Date.now()).getTime(),
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
      x.receipt.kind === identity.kind && (x.receipt.candidate_pr ?? null) === (identity.candidate_pr ?? null) &&
      JSON.stringify(x.receipt.goal_ref ?? null) === JSON.stringify(identity.goal_ref ?? null) &&
      sameTaskSourceRef(x.receipt.task_source_ref, identity.task_source_ref) &&
      x.receipt.state === identity.state);
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
      value?.kind === identity.kind && value?.state === identity.state &&
      sameTaskSourceRef(value.task_source_ref, identity.task_source_ref);
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
  if (c.allowed_edit_models !== undefined) {
    if (!c.allowed_edit_models || typeof c.allowed_edit_models !== 'object' || Array.isArray(c.allowed_edit_models))
      throw new Error('EDIT_MODEL_ALLOWLIST_INVALID');
    for (const [model, variants] of Object.entries(c.allowed_edit_models)) {
      if (!Array.isArray(variants) || !variants.length ||
          !variants.every(v => validateV2Model(model, v))) throw new Error('EDIT_MODEL_ALLOWLIST_INVALID');
    }
  }
  if (c.enable_v2_model_runs !== undefined && typeof c.enable_v2_model_runs !== 'boolean')
    throw new Error('V2_MODEL_ENABLE_FLAG_INVALID');
  if (c.enable_v2_edit_runs !== undefined && typeof c.enable_v2_edit_runs !== 'boolean')
    throw new Error('V2_EDIT_ENABLE_FLAG_INVALID');
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
  const editing = job?.schema === 6 && job.kind === 'opencode_edit' &&
    Number.isSafeInteger(job.candidate_pr) && job.candidate_pr > 0 && validGoalReference(job.goal_ref);
  if (!editing || config.enable_v2_edit_runs !== true) return false;
  const variants = config.allowed_edit_models?.[job.model];
  return Array.isArray(variants) && variants.includes(job.variant);
}
function editExecutorIdentityVerified(config, currentSid = getCurrentWindowsSid) {
  const runtime = config.executor_runtime;
  const sidPattern = /^S-1-(?:\d+-)+\d+$/i;
  const reserved = new Set(['S-1-5-18', 'S-1-5-32-544']);
  if (!runtime || !sidPattern.test(runtime.user_sid || '') ||
      !sidPattern.test(runtime.publisher_sid || '') ||
      reserved.has(runtime.user_sid.toUpperCase()) || reserved.has(runtime.publisher_sid.toUpperCase()) ||
      runtime.user_sid.toUpperCase() === runtime.publisher_sid.toUpperCase()) return false;
  try { return currentSid().toUpperCase() === runtime.user_sid.toUpperCase(); }
  catch { return false; }
}
function nativePreflight(config, job) {
  const cli = qualifyOpenCodeV2();
  const facts = {
    schema: 1, project_id: PROJECT, host: config.host, request_id: job.request_id,
    kind: 'native_preflight', source_sha: job.source_sha,
    node_version: process.version, platform: platform(), architecture: process.arch,
    opencode_v2_verified: cli.ready,
    native_executables_checked: cli.candidates_checked,
    edit_model_allowlist_entries: Object.keys(config.allowed_edit_models || {}).length,
    v2_edit_execution_enabled: config.enable_v2_edit_runs === true,
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
export async function runPlan(spec, config, job, attemptId, dependencies = {}) {
  const editing = job?.schema === 6 && job?.kind === 'opencode_edit' &&
    validGoalReference(job?.goal_ref) && Number.isSafeInteger(job?.candidate_pr);
  if (!editing) {
    const error = new Error('OPENCODE_READONLY_PLAN_RETIRED');
    error.code = 'OPENCODE_READONLY_PLAN_RETIRED';
    throw error;
  }
  const waiting = (outcome, exit_code) => ({ outcome, exit_code, evidence_sha256: null,
    evidence_bytes: 0, eligibility_state: 'WAITING', model_invoked: false });
  if (config.enable_v2_edit_runs !== true) {
    return waiting('V2_MODEL_EXECUTION_NOT_YET_APPROVED', 44);
  }
  if (!checkModelAuthorization(job, config)) {
    return waiting('MODEL_NOT_EXPLICITLY_ALLOWED', 42);
  }
  if (editing && !editExecutorIdentityVerified(config, dependencies.currentSid))
    return waiting('V2_EDIT_EXECUTOR_IDENTITY_NOT_VERIFIED', 46);
  const qualify = dependencies.qualifyOpenCodeV2 ?? qualifyOpenCodeV2;
  const runCaptured = dependencies.runCapturedProcess ?? runCapturedProcess;
  const processTreePlatform = dependencies.platformName ?? process.platform;
  const readProcessTree = dependencies.readProcessTree ??
    (pid => readWindowsProcessTree(pid, undefined, processTreePlatform));
  const canPollProcessTree = processTreePlatform === 'win32' ||
    typeof dependencies.readProcessTree === 'function';
  const cli = qualify();
  if (!cli.ready) return waiting('OPENCODE_V2_CLI_NOT_QUALIFIED', 43);
  let auth;
  try {
    auth = (dependencies.readV2AuthReadiness ?? runV2AuthReadiness)(cli.bin, config.workspace);
  } catch {
    auth = { status: 'AUTH_METADATA_UNKNOWN', saved_account_count: null };
  }
  if (auth?.status !== 'SAVED_ACCOUNT_RECORDS_PRESENT' ||
      !Number.isSafeInteger(auth.saved_account_count) || auth.saved_account_count < 1)
    return waiting(auth?.status === 'NO_SAVED_ACCOUNT_RECORDS'
      ? 'OPENCODE_V2_AUTH_NOT_READY' : 'OPENCODE_V2_AUTH_METADATA_UNKNOWN', 48);
  // V2, not V1: ordered permissions, shell/subagent, provider/model#variant.
  // Config is private, never echoed to the GitHub Issue; no shell expansion of prompts.
  const safePolicy = JSON.stringify(buildV2ScopedEditConfig(config.workspace, job.write_paths));
  // V2 beta builds have ignored OPENCODE_CONFIG[_CONTENT] in some execution paths.
  // The documented project-local opencode.json is the authoritative V2 policy input.
  // Never overwrite unrelated project configuration or allow higher-priority .opencode.
  const configFile = join(config.workspace, 'opencode.json');
  if (existsSync(join(config.workspace, 'opencode.jsonc')) ||
      existsSync(join(config.workspace, '.opencode')))
    return waiting('V2_WORKSPACE_CONFIG_CONFLICT', 45);
  if (existsSync(configFile)) {
    if (readFileSync(configFile, 'utf8') !== safePolicy)
      return waiting('V2_WORKSPACE_CONFIG_UNKNOWN', 45);
  } else writeFileSync(configFile, safePolicy, { flag: 'wx', mode: 0o600 });
  if (readFileSync(configFile, 'utf8') !== safePolicy)
    return waiting('V2_WORKSPACE_CONFIG_READBACK_FAILED', 45);
  const args = buildV2ScopedEditArgs(job, config.workspace, spec);
  const outputStem = `output-${job.request_id}-${attemptId}`;
  const stdoutPath = join(config.state_dir, `${outputStem}.stdout.bin`);
  const stderrPath = join(config.state_dir, `${outputStem}.stderr.bin`);
  // The saved OpenCode account belongs to this verified executor SID/profile.
  // Environment-sourced API keys, Publisher tokens, proxies, and policy overrides
  // are excluded so this run cannot silently switch identity or provider.
  const childEnv = openCodeEditEnvironment();
  const execution = await runCaptured(cli.bin, args, {
    cwd: config.workspace, env: childEnv, stdoutPath, stderrPath,
    terminate: child => terminateProcessTree(child, {
      runTaskkill: dependencies.runTaskkill,
      readProcessTree: dependencies.readProcessTree,
      platformName: dependencies.platformName,
    }),
    ...(typeof dependencies.onProcessSpawn === 'function' ? { onSpawn: pid => {
      if (!Number.isSafeInteger(pid) || pid < 1) return false;
      let identity;
      try { identity = readProcessTree(pid); } catch { return false; }
      const createdAt = identity?.root_created_at;
      if (identity?.state !== 'ALIVE' || identity.root_pid !== pid || identity.error !== null ||
          !Array.isArray(identity.process_ids) || !identity.process_ids.includes(pid) ||
          typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt)) ||
          new Date(createdAt).toISOString() !== createdAt) return false;
      return dependencies.onProcessSpawn(pid, identity) !== false;
    } } : {}),
  });
  const local = execution.local_evidence || {};
  const outputEvidence = local.storage_error || local.capture_error || local.spawn_error
    ? { valid: false, reason: local.storage_error ? 'OPEN_CODE_JSONL_STORAGE_FAILED' :
      local.capture_error ? 'OPEN_CODE_JSONL_CAPTURE_INCOMPLETE' : 'OPEN_CODE_JSONL_PROCESS_NOT_STARTED',
      session_id: null, session_started: false, provider_usage_evidence: 'UNKNOWN',
      model_activity_evidence: 'UNKNOWN', tool_execution_evidence: 'UNKNOWN',
      tool_execution_count: 0, file_change_tool_evidence: 'UNKNOWN',
      file_change_tool_completed_count: 0, file_change_tool_failed_count: 0,
      file_change_tool_incomplete_count: 0, token_usage: null, model_invoked: null }
    : await readOpenCodeV2RunEvidence(stdoutPath);
  let treeReadback;
  if (Number.isSafeInteger(local.process_id) && local.process_id > 0) {
    try { treeReadback = await readProcessTree(local.process_id); }
    catch (error) {
      treeReadback = { state: 'UNKNOWN', root_pid: local.process_id, process_ids: [],
        observed_at: new Date().toISOString(), error: String(error?.code || 'PROCESS_TREE_READBACK_FAILED') };
    }
  } else if (local.spawn_error) {
    treeReadback = { state: 'NOT_STARTED', root_pid: null, process_ids: [],
      observed_at: new Date().toISOString(), error: null };
  } else {
    treeReadback = { state: 'UNKNOWN', root_pid: null, process_ids: [],
      observed_at: new Date().toISOString(), error: 'PROCESS_PID_UNAVAILABLE' };
  }
  if (canPollProcessTree && Number.isSafeInteger(local.process_id) && local.process_id > 0) {
    const wait = dependencies.wait ?? (milliseconds =>
      new Promise(resolve => setTimeout(resolve, milliseconds)));
    while (!(treeReadback?.root_pid === local.process_id && treeReadback.state === 'DEAD' &&
        treeReadback.error === null && Array.isArray(treeReadback.process_ids) &&
        treeReadback.process_ids.length === 0)) {
      await wait(1000);
      try {
        treeReadback = await readProcessTree(local.process_id);
      } catch (error) {
        treeReadback = { state: 'UNKNOWN', root_pid: local.process_id, process_ids: [],
          observed_at: new Date().toISOString(),
          error: String(error?.code || 'PROCESS_TREE_READBACK_FAILED') };
      }
    }
  }
  return { ...execution,
    session_id: outputEvidence.session_id,
    session_started: outputEvidence.session_started,
    provider_usage_evidence: outputEvidence.provider_usage_evidence,
    model_activity_evidence: outputEvidence.model_activity_evidence,
    tool_execution_evidence: outputEvidence.tool_execution_evidence,
    tool_execution_count: outputEvidence.tool_execution_count,
    file_change_tool_evidence: outputEvidence.file_change_tool_evidence,
    file_change_tool_completed_count: outputEvidence.file_change_tool_completed_count,
    file_change_tool_failed_count: outputEvidence.file_change_tool_failed_count,
    file_change_tool_incomplete_count: outputEvidence.file_change_tool_incomplete_count,
    token_usage: outputEvidence.token_usage,
    ...(outputEvidence.model_invoked === true ? { model_invoked: true } : {}),
    local_evidence: { ...local,
    opencode_jsonl_state: outputEvidence.valid ? 'PARSED' : 'UNKNOWN',
    ...(outputEvidence.reason ? { opencode_jsonl_error: outputEvidence.reason } : {}),
    process_tree_state: treeReadback.state, process_tree_readback: treeReadback } };
}
function readSpec(job, apiRead = api) {
  const b = apiRead(`repos/${REPO}/contents/${job.spec_path}?ref=${job.source_sha}`);
  if (b.encoding !== 'base64' || typeof b.content !== 'string') throw new Error('SPEC_UNREADABLE');
  const bytes = Buffer.from(b.content.replace(/\s+/g, ''), 'base64');
  if (digest(bytes) !== job.spec_sha256) throw new Error('SPEC_HASH_MISMATCH');
  return bytes.toString('utf8');
}
export function receipt(requestId, attemptId, state, job, result = null, taskSourceRef = null) {
  if (taskSourceRef !== null && !validTaskSourceRef(taskSourceRef))
    throw new Error('TASK_SOURCE_REFERENCE_INVALID');
  return { schema: 1, project_id: PROJECT, host: job.host, request_id: requestId,
    attempt_id: attemptId, state, kind: job.kind, source_sha: job.source_sha,
    outcome: result?.outcome ?? (state === 'STARTED' ? 'DISPATCH_ACK_NOT_ACCEPTANCE' : 'UNKNOWN'),
    exit_code: result?.exit_code ?? null,
    evidence_sha256: result?.evidence_sha256 ?? null,
    evidence_bytes: result?.evidence_bytes ?? null,
    ...(typeof result?.model_invoked === 'boolean' ? { model_invoked: result.model_invoked } : {}),
    ...(job.schema === 2 ? { model: job.model, variant: job.variant } : {}),
    ...(job.schema === 3 ? { model: job.model, reasoning_effort: job.reasoning_effort,
      task_fingerprint: result?.fingerprint ?? result?.task_fingerprint ?? null,
      session_id: result?.session_id ?? null, session_started: result?.session_started === true,
      provider_usage_evidence: result?.provider_usage_evidence ?? 'UNKNOWN',
      model_activity_evidence: result?.model_activity_evidence ?? 'UNKNOWN',
      tool_execution_evidence: result?.tool_execution_evidence ?? 'UNKNOWN',
      tool_execution_count: Number.isSafeInteger(result?.tool_execution_count) ? result.tool_execution_count : 0,
      file_change_tool_evidence: result?.file_change_tool_evidence ?? 'UNKNOWN',
      file_change_tool_completed_count: Number.isSafeInteger(result?.file_change_tool_completed_count)
        ? result.file_change_tool_completed_count : 0,
      file_change_tool_failed_count: Number.isSafeInteger(result?.file_change_tool_failed_count)
        ? result.file_change_tool_failed_count : 0,
      file_change_tool_incomplete_count: Number.isSafeInteger(result?.file_change_tool_incomplete_count)
        ? result.file_change_tool_incomplete_count : 0,
      changed_paths: result?.changed_paths ?? null, diff_sha256: result?.diff_sha256 ?? null,
      stdout_sha256: result?.stdout_sha256 ?? null, stderr_sha256: result?.stderr_sha256 ?? null,
      tests: result?.tests ?? 'NOT_RUN', pr_url: result?.pr_url ?? null } : {}),
    ...([4, 5, 6].includes(job.schema) ? { model: job.model, variant: job.variant, write_paths: job.write_paths,
      changed_paths: result?.changed_paths ?? null, diff_sha256: result?.diff_sha256 ?? null,
      session_id: result?.session_id ?? null, session_started: result?.session_started === true,
      provider_usage_evidence: result?.provider_usage_evidence ?? 'UNKNOWN',
      model_activity_evidence: result?.model_activity_evidence ?? 'UNKNOWN',
      tool_execution_evidence: result?.tool_execution_evidence ?? 'UNKNOWN',
      tool_execution_count: Number.isSafeInteger(result?.tool_execution_count) ? result.tool_execution_count : 0,
      file_change_tool_evidence: result?.file_change_tool_evidence ?? 'UNKNOWN',
      file_change_tool_completed_count: Number.isSafeInteger(result?.file_change_tool_completed_count)
        ? result.file_change_tool_completed_count : 0,
      file_change_tool_failed_count: Number.isSafeInteger(result?.file_change_tool_failed_count)
        ? result.file_change_tool_failed_count : 0,
      file_change_tool_incomplete_count: Number.isSafeInteger(result?.file_change_tool_incomplete_count)
        ? result.file_change_tool_incomplete_count : 0,
      token_usage: result?.token_usage ?? null,
      stdout_sha256: result?.local_evidence?.stdout_sha256 ?? null,
      stderr_sha256: result?.local_evidence?.stderr_sha256 ?? null } : {}),
    ...([5, 6].includes(job.schema) ? { candidate_pr: job.candidate_pr } : {}),
    ...(job.schema === 6 ? { goal_ref: job.goal_ref } : {}),
    ...(taskSourceRef ? { task_source_ref: taskSourceRef } : {}) };
}
function completeInlineNativeTask(config, job, workerLogin, attemptId, postReceipt, log) {
  const start = receipt(job.request_id, attemptId, 'STARTED', job);
  postReceipt(config, start, workerLogin);
  let result;
  if (job.kind === 'ping') result = { outcome: 'BRIDGE_PING_OK_NOT_OS_ACCEPTANCE', exit_code: 0,
    evidence_sha256: null, evidence_bytes: 0 };
  else if (job.kind === 'native_preflight') result = nativePreflight(config, job);
  else if (job.kind === 'native_v2_qualify') result = nativeV2Qualify(config, job);
  else result = { outcome: 'UNSUPPORTED_INLINE_KIND_NO_MODEL_INVOCATION', exit_code: 52,
    evidence_sha256: null, evidence_bytes: 0 };
  const terminal = receipt(job.request_id, attemptId, terminalStateForResult(result), job, result);
  const terminalPath = join(config.state_dir, `result-${job.request_id}-${attemptId}.json`);
  atomicJSON(terminalPath, { request_id: job.request_id, attempt_id: attemptId, terminal,
    local_evidence: result.local_evidence ?? null });
  postReceipt(config, terminal, workerLogin);
  log(`${terminal.state}_${job.request_id}_${terminal.outcome}`);
  return { state: terminal.state, request_id: job.request_id, attempt_id: attemptId,
    outcome: terminal.outcome };
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
    result.outcome === 'CODEX_CLI_EXIT_0_UNVERIFIED' && result.session_started === true &&
    result.provider_usage_evidence === 'CONFIRMED' &&
    result.model_activity_evidence === 'CONFIRMED' && result.model_invoked === true &&
    result.process_tree_state === 'DEAD' && result.session_id !== null && Array.isArray(result.out_of_scope_paths) &&
    result.out_of_scope_paths.length === 0;
  const terminal = receipt(started.request_id, started.attempt_id,
    endedWithCapturedSession ? 'FINISHED' : 'BLOCKED', job, result,
    started.task_source_ref ?? null);
  terminal.outcome = result.outcome || (result.exit_code === 0 ?
    'CODEX_CLI_EXIT_0_UNVERIFIED' : 'CODEX_CLI_FAILED');
  return terminal;
}
function reserveCodexRequestCancellation(config, identity, reason) {
  const requestPath = join(config.codex_spool, 'requests',
    `${identity.request_id}-${identity.attempt_id}.json`);
  const cancellationPath = `${requestPath}.cancelled`;
  let fd;
  try {
    fd = openSync(cancellationPath, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify({ schema: 1, request_id: identity.request_id,
      attempt_id: identity.attempt_id, source_sha: identity.source_sha,
      fingerprint: identity.task_fingerprint ?? identity.fingerprint,
      reason, created_at: new Date().toISOString() }));
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    return true;
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* preserve original failure */ } }
    if (error.code === 'EEXIST') return false;
    throw error;
  }
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

      // A #310-sourced Codex request may be retriggered only while its exact
      // author/issue/body hash still read back. Missing or changed source is an
      // unresolved effect, never permission to replay the queued request. A
      // per-request cancellation marker prevents later executor ticks from
      // consuming the stale request while preserving its original bytes.
      if (started.task_source_ref) {
        if (typeof deps.verifyTaskSource !== 'function')
          return { status: 'UNKNOWN_NO_REPLAY', reason: 'TASK_SOURCE_READBACK_NOT_CONFIGURED' };
        let sourceStillMatches = false;
        try { sourceStillMatches = await deps.verifyTaskSource() === true; }
        catch { /* unknown source readback is not replay authorization */ }
        if (!sourceStillMatches) {
          reserveCodexRequestCancellation(config, started,
            'SOURCE_CHANGED_BEFORE_EXECUTOR_TRIGGER');
          return { status: 'UNKNOWN_NO_REPLAY', reason: 'TASK_SOURCE_READBACK_CHANGED_OR_UNKNOWN' };
        }
      }

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
    if (executorProcessTerminationUnconfirmed({
      ...result,
      local_evidence: { termination_state: result.termination_state,
        process_tree_state: result.process_tree_state },
    })) {
      blockedKinds.add('codex_plan');
      return { status: 'WAITING', reason: 'CODEX_PROCESS_TREE_READBACK_REQUIRED' };
    }
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
export async function dispatchCodexJob({ config, job, spec, workerLogin, taskSourceRef = null,
  verifyTaskSource = null,
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
  if (taskSourceRef !== null && !validTaskSourceRef(taskSourceRef))
    throw new Error('TASK_SOURCE_REFERENCE_INVALID');
  if (taskSourceRef !== null && typeof verifyTaskSource !== 'function')
    throw new Error('TASK_SOURCE_READBACK_REQUIRED');
  const sourceReadback = async () => {
    if (taskSourceRef === null) return 'MATCH';
    try { return await verifyTaskSource() === true ? 'MATCH' : 'CHANGED'; }
    catch { return 'UNKNOWN'; }
  };
  if (!config.codex_spool) throw new Error('CODEX_SPOOL_NOT_CONFIGURED');
  const bundleDir = join(config.codex_spool, 'bundles');
  mkdirSync(bundleDir, { recursive: true });
  const bundlePath = join(bundleDir, `${job.request_id}-${attemptId}.bundle`);
  await createBundle(bundlePath, job.source_sha);
  const bundleSha = digest(readFileSync(bundlePath));
  const request = makeCodexExecutorRequest(job, attemptId, spec, bundlePath, bundleSha);
  const beforeClaim = await sourceReadback();
  if (beforeClaim !== 'MATCH') {
    cleanupBundle(bundlePath);
    return { state: `CODEX_TASK_SOURCE_${beforeClaim}_NO_REQUEST`, invoked: false, attemptId };
  }
  const ownedClaim = claim(config.state_dir, job, attemptId);
  if (!ownedClaim.claimed) {
    cleanupBundle(bundlePath);
    return { state: 'CODEX_ATTEMPT_AMBIGUOUS', invoked: false, reason: ownedClaim.reason };
  }
  const beforeRequest = await sourceReadback();
  if (beforeRequest !== 'MATCH') {
    try { release(job, ownedClaim); }
    finally { cleanupBundle(bundlePath); }
    return { state: `CODEX_TASK_SOURCE_${beforeRequest}_NO_REQUEST`, invoked: false, attemptId };
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
  const started = { ...receipt(job.request_id, attemptId, 'STARTED', job, null, taskSourceRef),
    outcome: 'CODEX_EXECUTOR_DISPATCH_ACK_NOT_ACCEPTANCE',
    task_fingerprint: request.fingerprint };
  // The same source-bound, idempotent receipt writer used by the OpenCode lane
  // verifies pre-write identity and remote readback before a task is triggered.
  await publishStarted(started);
  const beforeTrigger = await sourceReadback();
  if (beforeTrigger !== 'MATCH') {
    // Leave the original request bytes for audit, but prevent later executor
    // ticks from consuming them after source identity became unknown.
    const cancellationBarrierWritten = reserveCodexRequestCancellation(config, started,
      `SOURCE_${beforeTrigger}_BEFORE_EXECUTOR_TRIGGER`);
    return { state: `CODEX_TASK_SOURCE_${beforeTrigger}_NO_TRIGGER`, invoked: false,
      cancellationBarrierWritten, attemptId, requestPath };
  }
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
      local.capture_complete !== false && terminal?.state === 'BLOCKED' &&
      /(?:FAILED|ERROR)/.test(terminal?.outcome || '')) return true;
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
  if (local.capture_complete === false) {
    if (terminal?.state !== 'BLOCKED' ||
        local.capture_error !== 'EXECUTOR_INTERRUPTED_BEFORE_CAPTURE_FINALIZATION' ||
        terminal?.evidence_sha256 !== null || terminal?.evidence_bytes !== 0)
      throw new Error('INTERRUPTED_CAPTURE_METADATA_INVALID');
    return true;
  }
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
export async function verifyScopedEditEvidence(resultDir, result, started) {
  const terminal = result?.terminal ?? result;
  const evidence = result?.diff_evidence;
  if (terminal?.state === 'BLOCKED' && !evidence && terminal.diff_sha256 == null &&
      terminal.changed_paths == null) return true;
  if (!evidence || !Array.isArray(started?.write_paths) ||
      !Array.isArray(terminal?.changed_paths) ||
      evidence.file !== `diff-${started.request_id}-${terminal.attempt_id}.patch` ||
      evidence.stderr_file !== `diff-${started.request_id}-${terminal.attempt_id}.stderr.bin` ||
      evidence.sha256 !== terminal.diff_sha256 || !HASH.test(evidence.sha256 || '') ||
      !Number.isSafeInteger(evidence.bytes) || evidence.bytes < 0 ||
      !HASH.test(evidence.stderr_sha256 || '') || !Number.isSafeInteger(evidence.stderr_bytes) ||
      evidence.stderr_bytes < 0) throw new Error('SCOPED_EDIT_DIFF_METADATA_INVALID');
  const allowed = new Set(started.write_paths.map(value =>
    platform() === 'win32' ? value.toLowerCase() : value));
  if (terminal.changed_paths.some(value => typeof value !== 'string' ||
      !allowed.has(platform() === 'win32' ? value.toLowerCase() : value)))
    throw new Error('SCOPED_EDIT_CHANGED_PATH_OUT_OF_SCOPE');
  const diffPath = join(resultDir, evidence.file);
  const stderrPath = join(resultDir, evidence.stderr_file);
  for (const path of [diffPath, stderrPath]) {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('SCOPED_EDIT_DIFF_NOT_REGULAR_FILE');
  }
  const [diffHash, stderrHash] = await Promise.all([hashEvidenceFile(diffPath), hashEvidenceFile(stderrPath)]);
  if (diffHash.sha256 !== evidence.sha256 || diffHash.bytes !== evidence.bytes ||
      stderrHash.sha256 !== evidence.stderr_sha256 || stderrHash.bytes !== evidence.stderr_bytes)
    throw new Error('SCOPED_EDIT_DIFF_HASH_MISMATCH');
  const paths = new Set();
  const input = createInterface({ input: createReadStream(diffPath), crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.startsWith('diff --git ')) continue;
    const match = line.match(/^diff --git a\/([A-Za-z0-9][A-Za-z0-9._/-]*) b\/([A-Za-z0-9][A-Za-z0-9._/-]*)$/);
    if (!match || match[1] !== match[2]) throw new Error('SCOPED_EDIT_DIFF_PATH_UNSUPPORTED');
    const key = platform() === 'win32' ? match[1].toLowerCase() : match[1];
    if (!allowed.has(key)) throw new Error('SCOPED_EDIT_DIFF_PATH_OUT_OF_SCOPE');
    paths.add(match[1]);
  }
  const expected = new Set(terminal.changed_paths);
  const normalize = value => platform() === 'win32' ? value.toLowerCase() : value;
  if (paths.size !== expected.size || [...paths].some(value =>
      ![...expected].some(item => normalize(item) === normalize(value))))
    throw new Error('SCOPED_EDIT_DIFF_PATH_SET_MISMATCH');
  return true;
}
function executorProcessTerminationUnconfirmed(result) {
  const local = result?.local_evidence || {};
  const treeState = result?.process_tree_state ?? local.process_tree_state;
  // Only an explicit process-tree readback can release the attempt conflict.
  // Missing/legacy states are UNKNOWN; a termination request or root exit is
  // not proof that descendants have stopped.
  return !['DEAD', 'NOT_STARTED'].includes(treeState);
}
function readActiveExecutorManifest(executor) {
  let mailbox;
  try { mailbox = executorMailboxState(executor.manifest_dir); }
  catch (error) { return { state: 'UNKNOWN', reason: error?.code || 'MAILBOX_READBACK_FAILED' }; }
  if (mailbox.active.length === 0) return { state: 'EMPTY' };
  if (mailbox.active.length !== 1) return { state: 'UNKNOWN', reason: 'MULTIPLE_ACTIVE_MANIFESTS' };
  const match = mailbox.active[0].match(/^([a-f0-9-]{36})\.(pending|running)\.json$/i);
  if (!match) return { state: 'UNKNOWN', reason: 'ACTIVE_MANIFEST_NAME_INVALID' };
  const [, attemptId, suffix] = match;
  const path = join(executor.manifest_dir, mailbox.active[0]);
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink())
      return { state: 'UNKNOWN', reason: 'ACTIVE_MANIFEST_NOT_REGULAR' };
    const bytes = readFileSync(path);
    const manifest = JSON.parse(bytes.toString('utf8'));
    return { state: 'ACTIVE', attemptId, suffix, path, bytes, manifest };
  } catch (error) {
    return { state: 'UNKNOWN', reason: error?.code || 'ACTIVE_MANIFEST_UNREADABLE' };
  }
}
function verifyActiveExecutorManifest(executor, active, job) {
  try {
    const manifest = active.manifest;
    if (!manifest || manifest.attempt_id !== active.attemptId || manifest.request_id !== job.request_id ||
        manifest.source_sha !== job.source_sha || manifest.spec_sha256 !== job.spec_sha256 ||
        !['opencode_edit'].includes(manifest.job?.kind) ||
        JSON.stringify(manifest.job) !== JSON.stringify(job) || typeof manifest.spec !== 'string' ||
        digest(manifest.spec) !== job.spec_sha256 || !HASH.test(manifest.source_bundle_sha256 || ''))
      return { state: 'UNKNOWN', reason: 'ACTIVE_MANIFEST_JOB_MISMATCH' };
    const expected = makeExecutorManifest(job, manifest.spec, active.attemptId,
      manifest.source_bundle_sha256);
    if (!Buffer.from(JSON.stringify(expected)).equals(active.bytes))
      return { state: 'UNKNOWN', reason: 'ACTIVE_MANIFEST_BYTES_MISMATCH' };
    const bundlePath = candidateBundlePath(executor.manifest_dir, active.attemptId);
    const bundleInfo = lstatSync(bundlePath);
    if (!bundleInfo.isFile() || bundleInfo.isSymbolicLink() ||
        digest(readFileSync(bundlePath)) !== manifest.source_bundle_sha256)
      return { state: 'UNKNOWN', reason: 'ACTIVE_SOURCE_BUNDLE_MISMATCH' };
    if (active.suffix === 'pending') {
      if (existsSync(executorResultPath(executor.results_dir, job.request_id, active.attemptId)))
        return { state: 'UNKNOWN', reason: 'PENDING_ATTEMPT_HAS_RESULT_EVIDENCE' };
      if (existsSync(executorProcessPath(executor.results_dir, active.attemptId)))
        return { state: 'UNKNOWN', reason: 'PENDING_ATTEMPT_HAS_PROCESS_EVIDENCE' };
      return { state: 'WAITING', attemptId: active.attemptId, manifest };
    }
    const processEvidence = readExecutorProcessEvidence(executor.results_dir, manifest, active.bytes);
    return { state: 'STARTED', attemptId: active.attemptId, manifest,
      processEvidence: processEvidence.record };
  } catch (error) {
    return { state: 'UNKNOWN', reason: error?.code || error?.message || 'ACTIVE_ATTEMPT_VALIDATION_FAILED' };
  }
}
function inspectOpenCodeExecutorAttempt(executor, { job = null, attemptId = null } = {}) {
  const active = readActiveExecutorManifest(executor);
  if (active.state !== 'ACTIVE') return active;
  if (attemptId && active.attemptId !== attemptId)
    return { state: 'UNKNOWN', reason: 'ACTIVE_ATTEMPT_ID_CHANGED' };
  if (!job) return { state: 'UNBOUND_ACTIVE', attemptId: active.attemptId,
    suffix: active.suffix, manifest: active.manifest, bytes: active.bytes };
  const verified = verifyActiveExecutorManifest(executor, active, job);
  return { ...verified, suffix: active.suffix, bytes: active.bytes };
}
export async function runWorker(configInput, adapters = {}) {
  const config = guardConfig(configInput);
  const apiRead = adapters.apiRead ?? api;
  const commentsRead = adapters.commentsRead ?? issueComments;
  const goalCommentsRead = adapters.goalCommentsRead ?? (() => issueCommentsFor(HUMAN_GOAL_ISSUE));
  const postReceipt = adapters.writeReceipt ?? writeReceipt;
  const verifyCodexTask = adapters.assertCodexExecutorTaskReady ?? assertCodexExecutorTaskReady;
  const verifyExecutor = adapters.assertExecutorTaskReady ?? assertExecutorTaskReady;
  const dispatchExecutor = adapters.dispatchToExecutor ?? dispatchToExecutor;
  const triggerPending = adapters.triggerPendingExecutorAttempt ?? triggerPendingExecutorAttempt;
  const buildCandidateBundle = adapters.createCandidateSourceBundle ?? createCandidateSourceBundle;
  const qualifyOpenCode = adapters.qualifyOpenCodeV2 ?? qualifyOpenCodeV2;
  const resolveExecutorResultsDir = adapters.executorResultsDir ?? (descriptor => descriptor.results_dir);
  const resolveExecutorResultPath = adapters.executorResultPath ?? executorResultPath;
  const inspectExecutorAttempt = adapters.inspectOpenCodeExecutorAttempt ?? inspectOpenCodeExecutorAttempt;
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
  const receiptComments = commentsRead(config);
  let humanTaskComments = [];
  if (config.issue === OPERATOR_ISSUE) {
    try {
      const sourceComments = goalCommentsRead();
      if (!Array.isArray(sourceComments)) throw new Error('HUMAN_TASK_COMMENT_LIST_INVALID');
      humanTaskComments = sourceComments.flatMap(comment => {
        const taskSourceRef = taskSourceRefForComment(comment, config.dispatchers);
        const job = parseJob(comment?.body);
        const supportedTask = (job?.schema === 6 && job.kind === 'opencode_edit') ||
          (job?.schema === 3 && job.kind === 'codex_plan');
        return taskSourceRef && supportedTask
          ? [{ ...comment, task_source_ref: taskSourceRef }] : [];
      });
    } catch {
      // A #310 discovery outage parks only that source. Existing #407 jobs and
      // receipts remain available to this native poll.
      log('HUMAN_TASK_DISCOVERY_READ_UNKNOWN');
    }
  }
  // Task comments may originate in #310, but all receipts and observation writes
  // continue to use the configured #407 issue as their sole durable authority.
  const comments = [...receiptComments, ...humanTaskComments].sort((a, b) => a.id - b.id);
  // Reconcile ambiguous model effects by scope; keep independent zero-token jobs runnable.
  // Never replay an OpenCode operation without its exact persisted terminal evidence.
  const blockedKinds = new Set();
  for (const c of comments) {
    if (c.user?.login !== me) continue;
    const s = parseReceipt(c.body);
    if (!s || s.state !== 'STARTED' || s.host.toUpperCase() !== config.host.toUpperCase()) continue;
    const hasTerminal = comments.some(v => v.user?.login === me &&
      (r => r?.request_id === s.request_id && r?.attempt_id === s.attempt_id &&
        r?.source_sha === s.source_sha && r?.kind === s.kind &&
        (r?.candidate_pr ?? null) === (s.candidate_pr ?? null) &&
        JSON.stringify(r?.goal_ref ?? null) === JSON.stringify(s.goal_ref ?? null) &&
        sameTaskSourceRef(r?.task_source_ref, s.task_source_ref) &&
        terminalStates.has(r.state))(parseReceipt(v.body)));
    if (s.kind === 'codex_plan') {
      if (hasTerminal) continue;
      const recovery = await reconcileCodexExecutorResult(s, config, me, blockedKinds, {
        ...(adapters.codexReconcileDependencies || {}),
        verifyTaskSource: adapters.codexReconcileDependencies?.verifyTaskSource ??
          (s.task_source_ref ? () => taskSourceRefMatchesComment(s.task_source_ref,
            apiRead(`repos/${REPO}/issues/comments/${s.task_source_ref.comment_id}`)) : undefined),
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
    const openCodeTask = s.kind === 'opencode_plan' || s.kind === 'opencode_edit';
    const resultDir = openCodeTask && config.executor ?
      resolveExecutorResultsDir(config.executor) : config.state_dir;
    const path = openCodeTask && config.executor ?
      resolveExecutorResultPath(resultDir, s.request_id, s.attempt_id) :
      join(resultDir, `result-${s.request_id}-${s.attempt_id}.json`);
    if (hasTerminal) {
      if (openCodeTask && config.executor) {
        let priorResult = null;
        if (!existsSync(path)) {
          blockedKinds.add(s.kind);
          log(`EXECUTOR_TERMINAL_RESULT_MISSING_${s.request_id}_NO_CLEANUP_NO_REPLAY`);
          continue;
        }
        try { priorResult = JSON.parse(readFileSync(path, 'utf8')); }
        catch (error) {
          blockedKinds.add(s.kind);
          log(`EXECUTOR_TERMINAL_EVIDENCE_UNREADABLE_${s.request_id}_${String(error?.code || 'UNKNOWN').slice(0, 32)}_NO_REPLAY`);
          continue;
        }
        if (executorProcessTerminationUnconfirmed(priorResult)) {
          blockedKinds.add(s.kind);
          log(`EXECUTOR_PROCESS_TERMINATION_UNRESOLVED_${s.request_id}`);
          continue;
        }
        try { cleanupExecutorAttempt(config.executor, s.attempt_id, {
          preserveCandidateWorkspace: s.kind === 'opencode_edit' && !priorResult?.diff_evidence,
        }); } catch { /* retain remote terminal evidence */ }
      }
      continue;
    }
    if (existsSync(path)) {
      let result;
      try {
        result = JSON.parse(readFileSync(path, 'utf8'));
        const resultTaskSourceRef = result.terminal?.task_source_ref;
        const taskSourceMatches = sameTaskSourceRef(resultTaskSourceRef, s.task_source_ref) ||
          (s.task_source_ref && resultTaskSourceRef === undefined);
        if (result.request_id !== s.request_id || result.attempt_id !== s.attempt_id ||
            result.terminal?.source_sha !== s.source_sha || result.terminal?.kind !== s.kind ||
            (result.terminal?.candidate_pr ?? null) !== (s.candidate_pr ?? null) ||
            JSON.stringify(result.terminal?.goal_ref ?? null) !== JSON.stringify(s.goal_ref ?? null) ||
            !taskSourceMatches ||
            !parseReceipt(RECEIPT_MARKER + JSON.stringify(result.terminal)))
          throw new Error('LOCAL_RECEIPT_IDENTITY_MISMATCH');
        if (openCodeTask) await verifyCapturedEvidence(resultDir, result);
        if (s.kind === 'opencode_edit') await verifyScopedEditEvidence(resultDir, result, s);
        // The executor manifest remains bound to the native job schema. Bind
        // its terminal receipt to the already-read-back source comment here.
        if (s.task_source_ref && resultTaskSourceRef === undefined)
          result.terminal = { ...result.terminal, task_source_ref: s.task_source_ref };
      } catch (error) {
        if (openCodeTask) blockedKinds.add(s.kind);
        log(`LOCAL_RESULT_RECONCILIATION_UNKNOWN_${s.request_id}_${String(error?.code || error?.message || 'UNKNOWN').slice(0, 48)}_NO_REPLAY`);
        continue;
      }
      if (openCodeTask && executorProcessTerminationUnconfirmed(result)) {
        blockedKinds.add(s.kind);
        log(`EXECUTOR_PROCESS_TERMINATION_UNRESOLVED_${s.request_id}`);
        continue;
      }
      postReceipt(config, result.terminal, me);
      if (openCodeTask && config.executor) {
        try { cleanupExecutorAttempt(config.executor, s.attempt_id, {
          preserveCandidateWorkspace: s.kind === 'opencode_edit' && !result.diff_evidence,
        }); } catch { /* exact result and receipt remain durable */ }
      }
      log(`RECOVERED_TERMINAL_${s.request_id}`);
      blockedKinds.add(s.kind);
      continue;
    }
    if (openCodeTask) {
      blockedKinds.add(s.kind);
      if (config.executor) {
        const original = comments.find(comment => config.dispatchers.includes(comment.user?.login) &&
          sameTaskSourceRef(comment.task_source_ref, s.task_source_ref) &&
          (job => job?.request_id === s.request_id)(parseJob(comment.body)));
        const expectedJob = original ? parseJob(original.body) : null;
        const startMatchesJob = expectedJob && expectedJob.host?.toUpperCase() === s.host.toUpperCase() &&
          expectedJob.source_sha === s.source_sha && expectedJob.kind === s.kind &&
          (expectedJob.candidate_pr ?? null) === (s.candidate_pr ?? null) &&
          JSON.stringify(expectedJob.goal_ref ?? null) === JSON.stringify(s.goal_ref ?? null) &&
          sameTaskSourceRef(original?.task_source_ref, s.task_source_ref) &&
          expectedJob.model === s.model &&
          (expectedJob.variant ?? null) === (s.variant ?? null) &&
          (s.spec_sha256 == null || expectedJob.spec_sha256 === s.spec_sha256) &&
          JSON.stringify(expectedJob.write_paths ?? []) === JSON.stringify(s.write_paths ?? []);
        if (startMatchesJob) {
          try {
            const triggered = triggerPending(config.executor, s.attempt_id, { expectedJob });
            if (triggered?.outcome === 'EXECUTOR_RUNNING_ATTEMPT_RECOVERY_TRIGGERED_NOT_ACCEPTANCE')
              log('RETRIGGERED_INTERRUPTED_EXECUTOR_RECOVERY_' + s.request_id + '_' + s.attempt_id);
            else log('RETRIGGERED_PENDING_EXECUTOR_' + s.request_id + '_' + s.attempt_id);
            continue;
          } catch (error) {
            log('PENDING_EXECUTOR_RETRY_NOT_CONFIRMED_' + s.request_id + '_' +
              String(error?.code || error?.message || 'UNKNOWN').slice(0, 48));
            continue;
          }
        }
      }
      log('AMBIGUOUS_STARTED_' + s.request_id + ': NO_REEXECUTION');
      continue;
    }
    log(`AMBIGUOUS_STARTED_${s.request_id}: NO_REEXECUTION`);
  }
  if (config.executor) {
    const active = inspectExecutorAttempt(config.executor);
    if (active.state === 'UNBOUND_ACTIVE') {
      blockedKinds.add('opencode_edit');
      const sources = comments.filter(comment => config.dispatchers.includes(comment.user?.login) &&
        (job => job?.request_id === active.manifest?.request_id && job?.kind === 'opencode_edit')(
          parseJob(comment.body)));
      if (sources.length !== 1) {
        log(`OPENCODE_ACTIVE_ATTEMPT_SOURCE_UNKNOWN_${active.attemptId}_NO_REPLAY`);
      } else {
        const original = sources[0];
        const job = parseJob(original.body);
        const verified = inspectExecutorAttempt(config.executor, { job, attemptId: active.attemptId });
        if (verified.state === 'WAITING' || verified.state === 'STARTED') {
          const latest = apiRead(`repos/${REPO}/issues/comments/${original.id}`);
          const sameMailbox = verified.suffix === active.suffix && verified.bytes?.equals(active.bytes);
          if (!selectedSourceCommentMatches({ id: original.id, originalBody: original.body,
            task_source_ref: original.task_source_ref ?? null }, latest) || !sameMailbox) {
            log(`OPENCODE_ACTIVE_ATTEMPT_READBACK_CHANGED_${active.attemptId}_NO_REPLAY`);
          } else {
            const attemptReceipts = comments.filter(comment => comment.user?.login === me)
              .map(comment => parseReceipt(comment.body))
              .filter(value => value?.request_id === job.request_id && value?.attempt_id === active.attemptId &&
                sameTaskSourceRef(value.task_source_ref, original.task_source_ref ?? null));
            if (verified.state === 'WAITING') {
              if (attemptReceipts.length === 0) {
                try {
                  triggerPending(config.executor, active.attemptId, { expectedJob: job });
                  log(`OPENCODE_ATTEMPT_WAITING_RETRIGGERED_${job.request_id}_${active.attemptId}`);
                } catch (error) {
                  log(`OPENCODE_ATTEMPT_WAITING_RETRY_UNCONFIRMED_${active.attemptId}_` +
                    String(error?.code || error?.message || 'UNKNOWN').slice(0, 40));
                }
              }
            } else if (attemptReceipts.length === 0) {
              const started = receipt(job.request_id, active.attemptId, 'STARTED', job, null,
                original.task_source_ref ?? null);
              postReceipt(config, started, me);
              const body = RECEIPT_MARKER + JSON.stringify(started);
              if (!comments.some(comment => comment.user?.login === me && comment.body === body)) {
                const id = Math.max(0, ...comments.map(comment => Number(comment.id) || 0)) + 1;
                comments.push({ id, body, user: { login: me } });
              }
              log(`OPENCODE_PROCESS_START_CONFIRMED_${job.request_id}_${active.attemptId}`);
            }
          }
        } else {
          log(`OPENCODE_ACTIVE_ATTEMPT_EVIDENCE_UNKNOWN_${active.attemptId}_` +
            String(verified.reason || verified.state).slice(0, 48));
        }
      }
    } else if (active.state === 'UNKNOWN') {
      blockedKinds.add('opencode_edit');
      log(`OPENCODE_MAILBOX_STATE_UNKNOWN_${String(active.reason || 'UNKNOWN').slice(0, 48)}_NO_REPLAY`);
    }
  }
  const head = apiRead(`repos/${REPO}/git/ref/heads/main`).object?.sha;
  if (!SHA.test(head || '')) throw new Error('MAIN_HEAD_UNREADABLE');
  const latestRequestId = comments.filter(c => config.dispatchers.includes(c.user?.login))
    .map(c => ({ id: c.id, job: parseJob(c.body) }))
    .filter(value => value.job && value.job.host.toUpperCase() === config.host.toUpperCase())
    .sort((a, b) => a.id - b.id).at(-1)?.job.request_id ?? null;
  const candidatePins = readCandidatePullRequestPins(comments, config.dispatchers, me,
    config.host, head, apiRead, blockedKinds, latestRequestId, log);
  const selected = selectNextWithCodexClaim(comments, config.dispatchers, me, config.host,
    head, config.state_dir, [...blockedKinds], candidatePins);
  let next = selected.next;
  let waitingOpenCodeEdit = null;
  if (selected.unresolvedRequestId)
    log(`CODEX_LOCAL_CLAIM_UNRECONCILED_${selected.unresolvedRequestId}_NO_REPLAY`);
  try {
    const observation = await publishOperatorObservation(
      config, me, comments, head, { ...adapters.observationDependencies, candidatePins,
        issueCommentsCount: receiptComments.length },
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
      next = selectNext(comments, config.dispatchers, me, config.host, head, [...blockedKinds], candidatePins);
    } else if (!config.codex_spool ||
        existsSync(join(config.codex_spool, 'locks', 'executor.active'))) {
      log('CODEX_EXECUTOR_SPOOL_OR_OWNER_NOT_READY');
      blockedKinds.add('codex_plan');
      next = selectNext(comments, config.dispatchers, me, config.host, head, [...blockedKinds], candidatePins);
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
        next = selectNext(comments, config.dispatchers, me, config.host, head, [...blockedKinds], candidatePins);
      }
    }
  }
  if (next?.job.kind === 'opencode_edit') {
    const modelAuthorized = config.enable_v2_edit_runs === true &&
      Array.isArray(config.allowed_edit_models?.[next.job.model]) &&
      config.allowed_edit_models[next.job.model].includes(next.job.variant);
    if (!modelAuthorized) {
      log('OPENCODE_EDIT_LANE_WAITING_EXPLICIT_MODEL_AUTH');
      waitingOpenCodeEdit = { request_id: next.job.request_id,
        reason: config.enable_v2_edit_runs === true ? 'MODEL_AUTHORIZATION_NOT_CONFIRMED' : 'V2_EDIT_RUNS_NOT_ENABLED' };
      blockedKinds.add('opencode_edit');
      next = selectNext(comments, config.dispatchers, me, config.host, head, [...blockedKinds], candidatePins);
    } else if (next.job.schema !== 6 || !validGoalReference(next.job.goal_ref) ||
        !Number.isSafeInteger(next.job.candidate_pr) || next.job.candidate_pr < 1) {
      log(`OPENCODE_EDIT_WAITING_HUMAN_GOAL_BOUND_CANDIDATE_${next.job.request_id}_NO_START`);
      waitingOpenCodeEdit = { request_id: next.job.request_id,
        reason: 'HUMAN_GOAL_BOUND_CANDIDATE_REQUIRED' };
      blockedKinds.add('opencode_edit');
      next = selectNext(comments, config.dispatchers, me, config.host, head, [...blockedKinds], candidatePins);
    } else if (!config.executor) {
      log('OPENCODE_EDIT_EXECUTOR_NOT_CONFIGURED_NO_MODEL_DISPATCH');
      waitingOpenCodeEdit = { request_id: next.job.request_id, reason: 'EXECUTOR_NOT_CONFIGURED' };
      blockedKinds.add('opencode_edit');
      next = selectNext(comments, config.dispatchers, me, config.host, head, [...blockedKinds], candidatePins);
    } else {
      try {
        if (qualifyOpenCode()?.ready !== true) {
          const error = new Error('OPENCODE_V2_CLI_NOT_QUALIFIED');
          error.code = 'OPENCODE_V2_CLI_NOT_QUALIFIED';
          throw error;
        }
        const taskReadback = verifyExecutor(config.executor);
        if (taskReadback?.ready !== true) throw new Error('EXECUTOR_TASK_READBACK_NOT_READY');
      } catch (error) {
        const code = String(error?.code || error?.message || 'TASK_READBACK_UNKNOWN')
          .replace(/[^A-Z0-9_]/gi, '_').slice(0, 72).toUpperCase();
        log(`OPENCODE_EDIT_EXECUTOR_NOT_READY_${code}`);
        waitingOpenCodeEdit = { request_id: next.job.request_id, reason: `EXECUTOR_NOT_READY_${code}` };
        blockedKinds.add('opencode_edit');
        next = selectNext(comments, config.dispatchers, me, config.host, head, [...blockedKinds], candidatePins);
      }
    }
  }
  if (!next) {
    if (waitingOpenCodeEdit) {
      log(`OPENCODE_EDIT_WAITING_${waitingOpenCodeEdit.reason}_${waitingOpenCodeEdit.request_id}_NO_MODEL_CALL`);
      return { state: 'WAITING', kind: 'opencode_edit', ...waitingOpenCodeEdit, model_invoked: false };
    }
    log('NO_DELTA_NO_LLM'); return { state: 'NO_DELTA' };
  }
  const job = next.job;
  if (job.candidate_pr !== undefined) {
    let dispatchMainSha;
    let pullRequest;
    let confirmedMainSha;
    try {
      dispatchMainSha = apiRead(`repos/${REPO}/git/ref/heads/main`).object?.sha;
      if (!SHA.test(dispatchMainSha || '')) throw new Error('MAIN_HEAD_UNREADABLE');
      pullRequest = apiRead(`repos/${REPO}/pulls/${job.candidate_pr}`);
      confirmedMainSha = apiRead(`repos/${REPO}/git/ref/heads/main`).object?.sha;
      if (!SHA.test(confirmedMainSha || '') || confirmedMainSha !== dispatchMainSha)
        throw new Error('MAIN_HEAD_CHANGED_DURING_CANDIDATE_READBACK');
    }
    catch { return { state: 'CANDIDATE_PR_READBACK_UNKNOWN_NO_START' }; }
    if (!candidatePullRequestEligible(job, dispatchMainSha, pullRequest)) {
      log(`CANDIDATE_PR_PIN_CHANGED_NO_START_${job.candidate_pr}_${job.request_id}`);
      return { state: 'CANDIDATE_PR_PIN_CHANGED_NO_START' };
    }
  } else if (job.source_sha !== head) {
    log(`STALE_SHA_SKIP_${job.request_id}`); return { state: 'STALE_SOURCE' };
  }
  // Check full issue comment remains immutable since selection. Edits/races abort the lane.
  const original = apiRead(`repos/${REPO}/issues/comments/${next.id}`);
  if (!selectedSourceCommentMatches(next, original))
    throw new Error('DISPATCH_COMMENT_CHANGED');
  let spec = null;
  if (job.kind === 'opencode_edit' || job.kind === 'codex_plan')
    spec = readSpec(job, apiRead);
  const executorDispatch = job.kind === 'opencode_edit' &&
    job.schema === 6 && validGoalReference(job.goal_ref) &&
    config.enable_v2_edit_runs === true && checkModelAuthorization(job, config);
  if (job.kind === 'opencode_edit' && !executorDispatch) {
    log(`OPENCODE_EDIT_NOT_AUTHORIZED_NO_START_${job.request_id}`);
    return { state: 'OPENCODE_EDIT_NOT_AUTHORIZED_NO_START', request_id: job.request_id };
  }
  if (executorDispatch) {
    if (!config.executor) { log('EXECUTOR_NOT_CONFIGURED_NO_MODEL_DISPATCH'); return { state: 'EXECUTOR_NOT_CONFIGURED' }; }
    try { verifyExecutor(config.executor); }
    catch (err) {
      log(`EXECUTOR_NOT_READY_${String(err.code || 'UNKNOWN').slice(0, 64)}`);
      return { state: 'EXECUTOR_NOT_READY', code: String(err.code || 'UNKNOWN') };
    }
  }
  const attemptId = randomUUID();
  let sourceBundleSha256 = null;
  if (job.kind === 'opencode_edit') {
    let bundle;
    try {
      bundle = await buildCandidateBundle({ workspace: config.workspace, executor: config.executor,
        job, attemptId, execFile: adapters.gitExecFileSync ?? execFileSync });
      if (bundle?.source_sha !== job.source_sha || !HASH.test(bundle?.sha256 || ''))
        throw new Error('CANDIDATE_SOURCE_BUNDLE_IDENTITY_MISMATCH');
      sourceBundleSha256 = bundle.sha256.toLowerCase();
    } catch (error) {
      try { rmSync(candidateBundlePath(config.executor.manifest_dir, attemptId), { force: true }); }
      catch { /* the request remains pending and no executor was started */ }
      const code = String(error?.code || error?.message || 'BUNDLE_UNAVAILABLE')
        .replace(/[^A-Z0-9_]/gi, '_').slice(0, 64).toUpperCase();
      log(`CANDIDATE_SOURCE_BUNDLE_WAITING_${job.request_id}_${code}_NO_START`);
      return { state: 'CANDIDATE_SOURCE_BUNDLE_WAITING_NO_START', request_id: job.request_id, code };
    }
    try {
      const latestMain = apiRead(`repos/${REPO}/git/ref/heads/main`).object?.sha;
      const unchangedComment = apiRead(`repos/${REPO}/issues/comments/${next.id}`);
      if (job.schema === 6) {
        const goalReference = verifyGoalReference(job, config.dispatchers, apiRead, goalCommentsRead);
        if (!goalReference.valid) {
          rmSync(candidateBundlePath(config.executor.manifest_dir, attemptId), { force: true });
          log(`HUMAN_GOAL_REFERENCE_WAITING_${goalReference.reason}_${job.request_id}_NO_START`);
          const independent = selectNext(comments, config.dispatchers, me, config.host, head,
            [...blockedKinds, 'opencode_edit', 'codex_plan'], candidatePins);
          if (independent && ['ping', 'native_preflight', 'native_v2_qualify'].includes(independent.job.kind)) {
            try {
              const source = apiRead(`repos/${REPO}/issues/comments/${independent.id}`);
              if (source?.body === independent.originalBody)
                return completeInlineNativeTask(config, independent.job, me, randomUUID(), postReceipt, log);
            } catch { /* uncertain task readback cannot authorize a fallback write */ }
          }
          return { state: 'WAITING_GOAL_REFERENCE_NO_START', request_id: job.request_id,
            reason: goalReference.reason };
        }
      }
      if (job.candidate_pr !== undefined) {
        const latestPullRequest = apiRead(`repos/${REPO}/pulls/${job.candidate_pr}`);
        const confirmedMain = apiRead(`repos/${REPO}/git/ref/heads/main`).object?.sha;
        if (!SHA.test(latestMain || '') || latestMain !== confirmedMain ||
            !candidatePullRequestEligible(job, latestMain, latestPullRequest) ||
            !selectedSourceCommentMatches(next, unchangedComment)) {
          rmSync(candidateBundlePath(config.executor.manifest_dir, attemptId), { force: true });
          log(`CANDIDATE_PR_PIN_CHANGED_NO_START_${job.candidate_pr}_${job.request_id}`);
          return { state: 'CANDIDATE_PR_PIN_CHANGED_NO_START', request_id: job.request_id };
        }
      } else if (!SHA.test(latestMain || '') || latestMain !== job.source_sha ||
          !selectedSourceCommentMatches(next, unchangedComment)) {
        rmSync(candidateBundlePath(config.executor.manifest_dir, attemptId), { force: true });
        log(`EDIT_SOURCE_HEAD_CHANGED_NO_START_${job.request_id}`);
        return { state: 'EDIT_SOURCE_HEAD_CHANGED_NO_START', request_id: job.request_id };
      }
    } catch {
      try { rmSync(candidateBundlePath(config.executor.manifest_dir, attemptId), { force: true }); }
      catch { /* no STARTED receipt or executor dispatch has occurred */ }
      return { state: job.candidate_pr !== undefined ? 'CANDIDATE_PR_READBACK_UNKNOWN_NO_START'
        : 'EDIT_SOURCE_READBACK_UNKNOWN_NO_START', request_id: job.request_id };
    }
  }
  if (job.kind === 'codex_plan') {
    const dispatched = await dispatchCodex({ config, job, spec, workerLogin: me, attemptId,
      taskSourceRef: next.task_source_ref ?? null,
      verifyTaskSource: next.task_source_ref ? () => selectedSourceCommentMatches(next,
        apiRead(`repos/${REPO}/issues/comments/${next.task_source_ref.comment_id}`)) : null });
    log(`${dispatched.state}_${job.request_id}_${attemptId}`);
    return { state: dispatched.state, request_id: job.request_id, attempt_id: attemptId,
      outcome: dispatched.reason ?? 'CODEX_EXECUTOR_DISPATCH_ACK_NOT_ACCEPTANCE' };
  }
  if (executorDispatch) {
    const dispatched = dispatchExecutor(config.executor, {
      request_id: job.request_id, attempt_id: attemptId, source_sha: job.source_sha, job, spec,
      ...(sourceBundleSha256 ? { source_bundle_sha256: sourceBundleSha256 } : {}),
    });
    const processStart = inspectExecutorAttempt(config.executor, { job, attemptId });
    if (processStart.state === 'STARTED') {
      let unchanged = false;
      try {
        unchanged = selectedSourceCommentMatches(next,
          apiRead(`repos/${REPO}/issues/comments/${next.id}`));
      } catch { /* an unknown source readback cannot authorize a public STARTED receipt */ }
      if (!unchanged) {
        log(`OPENCODE_START_SOURCE_READBACK_UNKNOWN_${job.request_id}_${attemptId}_NO_RECEIPT`);
        return { state: 'UNKNOWN_EXECUTOR_START_SOURCE_READBACK', request_id: job.request_id,
          attempt_id: attemptId, outcome: dispatched.outcome, model_invoked: false };
      }
      const start = receipt(job.request_id, attemptId, 'STARTED', job, null,
        next.task_source_ref ?? null);
      postReceipt(config, start, me);
      log(`PROCESS_START_CONFIRMED_${job.request_id}_${attemptId}`);
    } else {
      const state = processStart.state === 'WAITING' ? 'WAITING_EXECUTOR_START_EVIDENCE' :
        'UNKNOWN_EXECUTOR_START_EVIDENCE';
      log(`${state}_${job.request_id}_${attemptId}_${String(processStart.reason || 'NO_PROCESS_SPAWN_READBACK').slice(0, 48)}`);
      return { state, request_id: job.request_id, attempt_id: attemptId,
        outcome: dispatched.outcome, model_invoked: false };
    }
    log(`DISPATCHED_${job.request_id}_${dispatched.outcome}`);
    return { state: 'DISPATCHED', request_id: job.request_id, attempt_id: attemptId,
      outcome: dispatched.outcome };
  }
  return completeInlineNativeTask(config, job, me, attemptId, postReceipt, log);
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
    goalCommentsRead: options.goalCommentsRead,
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
