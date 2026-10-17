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
import { qualifyOpenCodeV2, validateV2Model, buildV2ReadOnlyConfig, buildV2ReadOnlyArgs,
  buildV2ScopedEditConfig, buildV2ScopedEditArgs, readOpenCodeV2RunEvidence } from './opencode-v2.mjs';
import { runV2Readiness } from './v2-readiness.mjs';
import { parseCodexJob, codexExecutionGate, claimCodexAttempt,
  releaseCodexAttempt, makeCodexExecutorRequest, publishCodexExecutorRequest,
  executorResultPath as codexExecutorResultPath,
  validateCodexExecutorRequest, validateCodexExecutorResult,
  assertCodexExecutorTaskReady, CODEX_HUMAN_GOAL_SPEC_PATH } from './codex-continuation.mjs';
import {
  OPERATOR_REPO, OPERATOR_PROJECT, OPERATOR_ISSUE,
  collectWindowsObservation, encodeOperatorObservation, findOperatorComment,
  updateExistingOperatorComment,
} from './operator-observation.mjs';
import { runCapturedProcess, terminateProcessTree } from './captured-process.mjs';
import { assertExecutorTaskReady, cleanupExecutorAttempt, createExecutorSourceBundle,
  createPinnedSourceBundle, dispatchToExecutor, executorResultPath,
  validateExecutorDescriptor } from './windows-executor.mjs';

export const PROJECT = 'CHATGPT_GLOBAL_SKILL_GOVERNANCE';
export const REPO = 'PT-Original-Point/ptysd-autonomous-factory';
export const JOB_MARKER = 'PTYSD_NATIVE_JOB_V1\n';
export const RECEIPT_MARKER = 'PTYSD_NATIVE_RECEIPT_V1\n';
export const ISSUE_TITLE = '[PTYSD-NATIVE] OpenCode dispatch and receipts';
// GitHub rejects Issue comment bodies above 65,536 characters.
const MAX_GITHUB_ISSUE_COMMENT_BODY_LENGTH = 65_536;
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const REQUEST = /^[A-Z][A-Z0-9_-]{7,79}$/;
const V1_KEYS = ['schema', 'project_id', 'host', 'request_id', 'kind', 'source_sha', 'spec_path', 'spec_sha256'];
const V2_KEYS = [...V1_KEYS, 'model', 'variant'];
const V4_KEYS = [...V2_KEYS, 'edit_paths'];
const V5_KEYS = [...V4_KEYS, 'source_pr'];
const V6_KEYS = [...V5_KEYS, 'goal_comment_id', 'goal_body_sha256'];
const OFFICIAL_REPOSITORY_ID = 1352411536;
const V53_GOAL_ISSUE = 310;
const V53_GOAL_MARKER = /^PTYSD_V53R4_DELETE_FIRST_AUTONOMY_GOAL_\d{8}$/m;
const V53_HUMAN_DIRECTIVE_MARKER = /^PTYSD_V53R4_(?:DELETE_FIRST_AUTONOMY_GOAL|P[0-3]|R\d{1,2}|EMERGENCY|CODEX_DIRECTIVE)(?:_[A-Z0-9]+)*_\d{8}$/;
const OPENCODE_EXECUTION_KINDS = new Set(['opencode_plan', 'opencode_edit']);
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
function validEditPaths(paths) {
  if (!Array.isArray(paths) || paths.length < 1) return false;
  const seen = new Set();
  for (const file of paths) {
    if (typeof file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(file)) return false;
    const parts = file.split('/');
    if (parts.some(part => !part || part === '.' || part === '..' ||
        /^\.(?:git|github|opencode)$/i.test(part) || /^\.env(?:\.|$)/i.test(part) ||
        /^opencode\.jsonc?$/i.test(part) ||
        /(?:secret|credential|token|password|auth\.json)/i.test(part)) ||
        ['governance', 'runs'].includes(parts[0].toLowerCase())) return false;
    const key = process.platform === 'win32' ? file.toLowerCase() : file;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}
function isOpenCodeExecutionKind(kind) { return OPENCODE_EXECUTION_KINDS.has(kind); }
export function parseJob(body) {
  const codexJob = parseCodexJob(body);
  if (codexJob) return codexJob;
  if (typeof body !== 'string' || body.length > MAX_GITHUB_ISSUE_COMMENT_BODY_LENGTH ||
      !body.startsWith(JOB_MARKER)) return null;
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
  if (obj.schema === 2 && obj.kind !== 'opencode_plan' ||
      obj.schema === 4 && (obj.kind !== 'opencode_edit' || !validEditPaths(obj.edit_paths)) ||
      [5, 6].includes(obj.schema) && (obj.kind !== 'opencode_edit' || !validEditPaths(obj.edit_paths) ||
        !Number.isSafeInteger(obj.source_pr) || obj.source_pr < 1) ||
      obj.schema === 6 && (!Number.isSafeInteger(obj.goal_comment_id) || obj.goal_comment_id < 1 ||
        !HASH.test(obj.goal_body_sha256 || '')) ||
      ![2, 4, 5, 6].includes(obj.schema)) return null;
  if (typeof obj.spec_path !== 'string' || !/^native-bridge\/tasks\/[a-z0-9-]{1,70}\.md$/.test(obj.spec_path)) return null;
  if (typeof obj.spec_sha256 !== 'string' || !HASH.test(obj.spec_sha256)) return null;
  if (!validateV2Model(obj.model, obj.variant)) return null;
  return obj;
}
export function parseReceipt(body) {
  if (typeof body !== 'string' || body.length > MAX_GITHUB_ISSUE_COMMENT_BODY_LENGTH ||
      !body.startsWith(RECEIPT_MARKER)) return null;
  try {
    const o = JSON.parse(body.slice(RECEIPT_MARKER.length));
    if (o?.schema !== 1 || o.project_id !== PROJECT ||
        typeof o.host !== 'string' || !/^[A-Z0-9-]{3,64}$/.test(o.host) ||
        !SHA.test(o.source_sha) || typeof o.kind !== 'string' ||
        !['ping', 'native_preflight', 'native_v2_qualify', 'opencode_plan', 'opencode_edit', 'codex_plan'].includes(o.kind) ||
        typeof o.request_id !== 'string' || !REQUEST.test(o.request_id) ||
         o.source_pr !== undefined && (!Number.isSafeInteger(o.source_pr) || o.source_pr < 1) ||
        (o.goal_comment_id === undefined) !== (o.goal_body_sha256 === undefined) ||
        o.goal_comment_id !== undefined && (!Number.isSafeInteger(o.goal_comment_id) ||
          o.goal_comment_id < 1 || !HASH.test(o.goal_body_sha256 || '')) ||
        o.goal_author !== undefined && (!/^[A-Za-z0-9-]{1,39}$/.test(o.goal_author) ||
          o.kind !== 'codex_plan' || !Number.isSafeInteger(o.goal_comment_id) ||
          typeof o.goal_marker !== 'string' || !V53_HUMAN_DIRECTIVE_MARKER.test(o.goal_marker)) ||
        o.goal_marker !== undefined && o.goal_author === undefined ||
        !RECEIPT_STATES.has(o.state) || typeof o.attempt_id !== 'string' ||
        !/^[a-f0-9-]{36}$/.test(o.attempt_id)) return null;
    return o;
  } catch { return null; }
}
function candidatePullRequestHeadSha(job, pull) {
  const repositoryName = REPO.toLowerCase();
  if (!([5, 6].includes(job?.schema) && Number.isSafeInteger(job.source_pr) &&
    pull?.number === job.source_pr && pull.state === 'open' &&
    pull.base?.ref === 'main' && pull.base?.repo?.id === OFFICIAL_REPOSITORY_ID &&
    pull.head?.repo?.id === OFFICIAL_REPOSITORY_ID &&
    typeof pull.base.repo.full_name === 'string' &&
    pull.base.repo.full_name.toLowerCase() === repositoryName &&
    typeof pull.head.repo.full_name === 'string' &&
    pull.head.repo.full_name.toLowerCase() === repositoryName &&
    SHA.test(pull.head.sha || ''))) return null;
  return pull.head.sha;
}
function candidateGoalCommentMatches(job, comment, dispatchers) {
  return job?.schema === 6 && comment?.id === job.goal_comment_id &&
    comment?.issue_url === `https://api.github.com/repos/${REPO}/issues/${V53_GOAL_ISSUE}` &&
    typeof comment.user?.login === 'string' && dispatchers.includes(comment.user.login) &&
    typeof comment.body === 'string' && V53_GOAL_MARKER.test(comment.body) &&
    digest(Buffer.from(comment.body, 'utf8')) === job.goal_body_sha256;
}
function latestTrustedHumanGoal(comments, dispatchers) {
  return comments.filter(comment => comment?.issue_url ===
      `https://api.github.com/repos/${REPO}/issues/${V53_GOAL_ISSUE}` &&
    Number.isSafeInteger(comment.id) && comment.id > 0 &&
    typeof comment.user?.login === 'string' && dispatchers.includes(comment.user.login) &&
    typeof comment.body === 'string' && V53_GOAL_MARKER.test(comment.body))
    .sort((a, b) => a.id - b.id).at(-1) ?? null;
}
function humanDirectiveMarker(body) {
  if (typeof body !== 'string' || body.length > MAX_GITHUB_ISSUE_COMMENT_BODY_LENGTH) return null;
  for (const line of body.split(/\r?\n/)) {
    const value = line.trim().replace(/^<!--\s*|\s*-->$/g, '');
    if (V53_HUMAN_DIRECTIVE_MARKER.test(value)) return value;
  }
  return null;
}
function latestTrustedHumanDirective(comments, dispatchers) {
  return comments.filter(comment => comment?.issue_url ===
      `https://api.github.com/repos/${REPO}/issues/${V53_GOAL_ISSUE}` &&
    Number.isSafeInteger(comment.id) && comment.id > 0 &&
    typeof comment.user?.login === 'string' && dispatchers.includes(comment.user.login) &&
    humanDirectiveMarker(comment.body) !== null)
    .sort((a, b) => a.id - b.id).at(-1) ?? null;
}
function humanDirectiveCodexIdentity(comment) {
  if (!Number.isSafeInteger(comment?.id) || comment.id < 1 ||
      typeof comment.body !== 'string' || !humanDirectiveMarker(comment.body)) return null;
  const bodySha256 = digest(Buffer.from(comment.body, 'utf8'));
  return { bodySha256,
    requestId: `PTYSD_HUMAN_GOAL_${comment.id}_${bodySha256.slice(0, 42).toUpperCase()}` };
}
function humanGoalLegacyReceiptStatus(comments, workerLogin, commentId, bodySha256, host) {
  const requestId = `PTYSD_HUMAN_GOAL_${commentId}`;
  const requestPrefix = `${requestId}_`;
  const belongsToGoal = receipt => receipt?.goal_comment_id === commentId ||
    receipt?.request_id === requestId ||
    (typeof receipt?.request_id === 'string' && receipt.request_id.startsWith(requestPrefix));
  const receipts = [];
  let malformedMatch = false;
  for (const comment of comments) {
    if (comment.user?.login !== workerLogin || typeof comment.body !== 'string') continue;
    const parsed = parseReceipt(comment.body);
    if (parsed && belongsToGoal(parsed)) {
      receipts.push({ comment, receipt: parsed });
    } else if (!parsed && comment.body.startsWith(RECEIPT_MARKER)) {
      try {
        const raw = JSON.parse(comment.body.slice(RECEIPT_MARKER.length));
        if (belongsToGoal(raw)) malformedMatch = true;
      } catch {
        if (comment.body.slice(RECEIPT_MARKER.length).includes(requestId)) malformedMatch = true;
      }
    }
  }
  if (malformedMatch) return 'UNKNOWN';
  if (!receipts.length) return 'NONE';

  const attempts = new Map();
  for (const { comment, receipt } of receipts) {
    const digestRequestId = HASH.test(receipt.goal_body_sha256 || '')
      ? `${requestPrefix}${receipt.goal_body_sha256.slice(0, 42).toUpperCase()}` : null;
    if (!Number.isSafeInteger(comment.id) || comment.id < 1 ||
        receipt.kind !== 'codex_plan' || receipt.goal_comment_id !== commentId ||
        !HASH.test(receipt.goal_body_sha256 || '') || receipt.host.toUpperCase() !== host.toUpperCase() ||
        (receipt.request_id !== requestId && receipt.request_id !== digestRequestId))
      return 'UNKNOWN';
    if (receipt.goal_body_sha256 === bodySha256) return 'SAME_BODY';
    if (!attempts.has(receipt.attempt_id)) attempts.set(receipt.attempt_id, []);
    attempts.get(receipt.attempt_id).push({ commentId: comment.id, receipt });
  }
  for (const entries of attempts.values()) {
    const bodyDigests = new Set(entries.map(({ receipt }) => receipt.goal_body_sha256));
    if (bodyDigests.size !== 1) return 'UNKNOWN';
    entries.sort((left, right) => left.commentId - right.commentId);
    if (!terminalStates.has(entries.at(-1).receipt.state)) return 'UNKNOWN';
  }
  return 'PRIOR_BODY_TERMINAL';
}
function humanDirectiveMatches(job, comment, dispatchers) {
  return job?.kind === 'codex_plan' && job.schema === 4 &&
    comment?.id === job.goal_comment_id &&
    comment?.issue_url === `https://api.github.com/repos/${REPO}/issues/${V53_GOAL_ISSUE}` &&
    comment.user?.login === job.goal_author && dispatchers.includes(comment.user.login) &&
    typeof comment.body === 'string' && humanDirectiveMarker(comment.body) === job.goal_marker &&
    digest(Buffer.from(comment.body, 'utf8')) === job.goal_body_sha256;
}
function codexGoalPolicyReady(policy) {
  return policy?.enabled === true && typeof policy.model === 'string' &&
    typeof policy.reasoning_effort === 'string' && Array.isArray(policy.write_paths) &&
    policy.write_paths.length > 0;
}
function humanDirectiveCodexJob(comment, host, sourceSha, spec, policy) {
  const marker = humanDirectiveMarker(comment?.body);
  const identity = humanDirectiveCodexIdentity(comment);
  if (!marker || !identity || !comment.user?.login) return null;
  const job = { schema: 4, project_id: PROJECT, host, request_id: identity.requestId,
    kind: 'codex_plan', source_sha: sourceSha, spec_path: CODEX_HUMAN_GOAL_SPEC_PATH,
    spec_sha256: digest(Buffer.from(spec, 'utf8')), model: policy.model,
    reasoning_effort: policy.reasoning_effort, write_paths: policy.write_paths,
    goal_comment_id: comment.id, goal_body_sha256: identity.bodySha256,
    goal_author: comment.user.login, goal_marker: marker };
  return parseCodexJob(JOB_MARKER + JSON.stringify(job)) ? job : null;
}
export async function readPinnedCandidateSources(comments, dispatchers, workerLogin, host,
  apiRead, log = () => {}, blockedKinds = [], goalCommentsRead = () => issueCommentsFor(V53_GOAL_ISSUE)) {
  const jobs = new Map();
  const receipts = new Map();
  for (const comment of comments) {
    const login = comment.user?.login;
    const job = dispatchers.includes(login) ? parseJob(comment.body) : null;
    if (job?.schema === 6 && job.host.toUpperCase() === host.toUpperCase()) {
      if (!jobs.has(job.request_id)) jobs.set(job.request_id,
        { job, body: comment.body, duplicate: false });
      else if (jobs.get(job.request_id).body !== comment.body) jobs.get(job.request_id).duplicate = true;
    }
    if (login === workerLogin) {
      const receipt = parseReceipt(comment.body);
      if (receipt) {
        if (!receipts.has(receipt.request_id)) receipts.set(receipt.request_id, []);
        receipts.get(receipt.request_id).push(receipt);
      }
    }
  }
  const sourceShas = new Map();
  const pendingGoals = [...jobs.values()].filter(({ job, duplicate }) => {
    if (duplicate || blockedKinds.includes(job.kind)) return false;
    const prior = (receipts.get(job.request_id) || []).filter(receipt =>
      receipt.host.toUpperCase() === job.host.toUpperCase() &&
      receipt.source_sha.toLowerCase() === job.source_sha.toLowerCase() && receipt.kind === job.kind);
    return !prior.some(receipt => terminalStates.has(receipt.state) || receipt.state === 'STARTED');
  });
  if (!pendingGoals.length) return sourceShas;
  let latestGoal;
  try { latestGoal = latestTrustedHumanGoal(goalCommentsRead(), dispatchers); }
  catch {
    log('HUMAN_GOAL_LATEST_READBACK_UNKNOWN');
    return sourceShas;
  }
  if (!latestGoal) {
    log('HUMAN_GOAL_LATEST_TRUSTED_COMMENT_NOT_FOUND');
    return sourceShas;
  }
  const pullReadbacks = new Map();
  const goalReadbacks = new Map();
  for (const { job, duplicate } of jobs.values()) {
    if (duplicate || blockedKinds.includes(job.kind)) continue;
    const prior = (receipts.get(job.request_id) || []).filter(receipt =>
      receipt.host.toUpperCase() === job.host.toUpperCase() &&
      receipt.source_sha.toLowerCase() === job.source_sha.toLowerCase() && receipt.kind === job.kind);
    if (prior.some(receipt => terminalStates.has(receipt.state) || receipt.state === 'STARTED')) continue;
    if (job.goal_comment_id !== latestGoal.id) {
      log(`HUMAN_GOAL_SUPERSEDED_${job.goal_comment_id}_LATEST_${latestGoal.id}`);
      continue;
    }
    if (!goalReadbacks.has(job.goal_comment_id)) {
      try { goalReadbacks.set(job.goal_comment_id,
        await apiRead(`repos/${REPO}/issues/comments/${job.goal_comment_id}`)); }
      catch {
        goalReadbacks.set(job.goal_comment_id, null);
        log(`HUMAN_GOAL_READBACK_UNKNOWN_${job.goal_comment_id}`);
      }
    }
    if (!candidateGoalCommentMatches(job, goalReadbacks.get(job.goal_comment_id), dispatchers)) {
      log(`HUMAN_GOAL_REFERENCE_UNVERIFIED_${job.goal_comment_id}`);
      continue;
    }
    if (!pullReadbacks.has(job.source_pr)) {
      try { pullReadbacks.set(job.source_pr, await apiRead(`repos/${REPO}/pulls/${job.source_pr}`)); }
      catch {
        pullReadbacks.set(job.source_pr, null);
        log(`CANDIDATE_PR_READBACK_UNKNOWN_${job.source_pr}`);
      }
    }
    const headSha = candidatePullRequestHeadSha(job, pullReadbacks.get(job.source_pr));
    if (headSha) sourceShas.set(job.source_pr, headSha);
  }
  return sourceShas;
}
export function selectNext(comments, dispatchers, workerLogin, host, liveMainSha = null,
  blockedKinds = [], candidateSourceShas = new Map()) {
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
    // Schema-2 plans remain parseable for historical receipt recovery, but
    // new read-only model tasks are no longer part of the executable path.
    if (v.job.kind === 'opencode_plan') continue;
    // Candidate work must bind to a byte-verified Human GOAL comment. Schema 5
    // remains parseable for historical receipts, but is no longer dispatched.
    if (v.job.source_pr !== undefined && v.job.schema !== 6) continue;
    const r = (receipts.get(v.job.request_id) || []).filter(x =>
      x.host.toUpperCase() === v.job.host.toUpperCase() && x.kind === v.job.kind &&
      (v.job.schema === 4 || x.source_sha === v.job.source_sha));
    if (v.duplicate || blockedKinds.includes(v.job.kind) ||
        r.some(x => terminalStates.has(x.state)) || r.some(x => x.state === 'STARTED')) continue;
    // A stale unsigned/unclaimed job must not starve a newer exact-main task.
    if (v.job.source_pr !== undefined) {
      if (candidateSourceShas.get(v.job.source_pr)?.toLowerCase() !== v.job.source_sha.toLowerCase()) continue;
    } else if (liveMainSha !== null && v.job.source_sha !== liveMainSha) continue;
    return { job: v.job, id: v.id, originalBody: v.content };
  }
  return null;
}
export function selectNextWithCodexClaim(comments, dispatchers, workerLogin, host,
  liveMainSha, stateDir, blockedKinds = [], candidateSourceShas = new Map()) {
  const next = selectNext(comments, dispatchers, workerLogin, host, liveMainSha,
    blockedKinds, candidateSourceShas);
  if (next?.job.kind !== 'codex_plan' ||
      !existsSync(join(stateDir, `codex-claim-${next.job.request_id}.json`)))
    return { next, unresolvedRequestId: null };
  const blocked = [...new Set([...blockedKinds, 'codex_plan'])];
  return { next: selectNext(comments, dispatchers, workerLogin, host, liveMainSha,
    blocked, candidateSourceShas),
    unresolvedRequestId: next.job.request_id };
}
function gh(args, options = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', timeout: commandTimeout,
    maxBuffer: 8 * 1024 * 1024, windowsHide: true, ...options });
}
function api(uri, extras = []) { return JSON.parse(gh(['api', uri, ...extras])); }
function issueCommentsFor(issueNumber) {
  const raw = JSON.parse(gh(['api', `repos/${REPO}/issues/${issueNumber}/comments?per_page=100`, '--paginate', '--slurp']));
  return raw.flat().filter(c => typeof c?.id === 'number').sort((a, b) => a.id - b.id);
}
function issueComments(config) { return issueCommentsFor(config.issue); }
function latestOperatorJob(comments, config, workerLogin, mainSha, candidateSourceShas = new Map()) {
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
      x.receipt.kind === job.kind && (job.schema === 4
        ? x.receipt.goal_comment_id === job.goal_comment_id
        : x.receipt.source_sha === job.source_sha))
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
  const candidateHeadKnown = job.source_pr === undefined || candidateSourceShas.has(job.source_pr);
  const sourceCurrent = job.source_pr === undefined ? job.source_sha === mainSha
    : candidateSourceShas.get(job.source_pr)?.toLowerCase() === job.source_sha.toLowerCase();
  if (last?.state === 'STARTED') state = 'STARTED_UNVERIFIED';
  else if (last?.state === 'FINISHED') state = 'FINISHED_NOT_ACCEPTANCE';
  else if (last?.state === 'BLOCKED') state = 'BLOCKED';
  else if (!candidateHeadKnown) state = 'SOURCE_UNKNOWN';
  else if (!sourceCurrent) state = 'STALE_SOURCE';
  return { request_id: job.request_id, attempt_id: attemptId, kind: job.kind,
    source_sha: job.source_sha, ...(job.source_pr !== undefined ? { source_pr: job.source_pr } : {}), state,
    outcome: typeof last?.outcome === 'string' && /^[A-Z0-9_-]{1,80}$/.test(last.outcome)
      ? last.outcome : 'UNKNOWN',
    exit_code: Number.isSafeInteger(last?.exit_code) ? last.exit_code : null };
}
export async function publishOperatorObservation(config, workerLogin, comments, mainSha,
  dependencies = {}, candidateSourceShas = new Map()) {
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
  const latestTask = latestOperatorJob(comments, config, workerLogin, mainSha, candidateSourceShas);
  const activeTask = latestTask &&
    ['QUEUED_NOT_STARTED', 'STARTED_UNVERIFIED'].includes(latestTask.state)
    ? latestTask : null;
  const nextOwner = windows.status !== 'FRESH' ? 'OS_OBSERVATION_UNKNOWN'
    : windows.native_task.enabled === false ? 'NATIVE_SCHEDULER_REPAIR'
      : activeTask?.state === 'QUEUED_NOT_STARTED' ? 'NATIVE_WORKER'
        : activeTask?.state === 'STARTED_UNVERIFIED' ? 'VERIFY_ACTIVE_WORK'
          : ['SOURCE_UNKNOWN', 'STALE_SOURCE'].includes(latestTask?.state)
            ? 'VERIFY_CANDIDATE_SOURCE'
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
    monitor_candidate: null,
    incident: null,
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
    now: dependencies.now || Date.now,
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
  if (!((job.schema === 2 && job.kind === 'opencode_plan') ||
      ([4, 5, 6].includes(job.schema) && job.kind === 'opencode_edit' && validEditPaths(job.edit_paths) &&
        ([5, 6].includes(job.schema) ? Number.isSafeInteger(job.source_pr) && job.source_pr > 0 : true) &&
        (job.schema !== 6 || Number.isSafeInteger(job.goal_comment_id) && job.goal_comment_id > 0 &&
          HASH.test(job.goal_body_sha256 || ''))))) return false;
  const variants = config.allowed_models?.[job.model];
  return Array.isArray(variants) && variants.includes(job.variant);
}
async function captureGitStdout(workspace, stateDir, requestId, attemptId, label, args,
  keepStdout = false) {
  const stem = `edit-git-${label}-${requestId}-${attemptId}`;
  const stdoutPath = join(stateDir, `${stem}.stdout.bin`);
  const stderrPath = join(stateDir, `${stem}.stderr.bin`);
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_EXTERNAL_DIFF', 'GIT_PAGER']) delete env[key];
  const result = await runCapturedProcess('git', ['-C', workspace, ...args], {
    cwd: workspace, env, stdoutPath, stderrPath, terminate: terminateProcessTree,
  });
  const evidence = result.local_evidence || {};
  if (result.exit_code !== 0 || evidence.capture_error || evidence.storage_error || evidence.spawn_error ||
      evidence.termination_state && evidence.termination_state !== 'NOT_REQUESTED') {
    throw new Error(`EDIT_GIT_${label.toUpperCase()}_FAILED`);
  }
  const output = readFileSync(stdoutPath);
  if (!keepStdout) rmSync(stdoutPath, { force: false });
  rmSync(stderrPath, { force: false });
  return { output, result, stdoutPath };
}
function parseGitStatusPaths(bytes) {
  const records = bytes.toString('utf8').split('\0').filter(Boolean);
  return records.map(record => {
    if (record.length < 4 || record[2] !== ' ') throw new Error('EDIT_GIT_STATUS_FORMAT_INVALID');
    return { status: record.slice(0, 2), path: record.slice(3).replaceAll('\\', '/') };
  });
}
async function assertEditWorkspaceReady(config, job, attemptId) {
  const head = await captureGitStdout(config.workspace, config.state_dir, job.request_id,
    attemptId, 'head', ['rev-parse', 'HEAD']);
  if (head.output.toString('utf8').trim().toLowerCase() !== job.source_sha.toLowerCase())
    throw new Error('EDIT_WORKSPACE_SOURCE_SHA_MISMATCH');
  const status = await captureGitStdout(config.workspace, config.state_dir, job.request_id,
    attemptId, 'before', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']);
  if (status.output.length !== 0) throw new Error('EDIT_WORKSPACE_NOT_CLEAN');
}
export async function captureScopedEditDiff({ workspace, state_dir, job, attempt_id }) {
  if (!workspace || !state_dir || !job || job.kind !== 'opencode_edit' ||
      !validEditPaths(job.edit_paths) || !/^[a-f0-9-]{36}$/i.test(attempt_id || ''))
    throw new Error('EDIT_DIFF_CAPTURE_INPUT_INVALID');
  const head = await captureGitStdout(workspace, state_dir, job.request_id,
    attempt_id, 'after-head', ['rev-parse', 'HEAD']);
  if (head.output.toString('utf8').trim().toLowerCase() !== job.source_sha.toLowerCase())
    throw new Error('EDIT_WORKSPACE_SOURCE_SHA_CHANGED');
  const status = await captureGitStdout(workspace, state_dir, job.request_id,
    attempt_id, 'after', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']);
  const changes = parseGitStatusPaths(status.output);
  const changedFiles = [...new Set(changes.map(change => change.path))].sort();
  const allowed = new Set(job.edit_paths.map(path => process.platform === 'win32' ? path.toLowerCase() : path));
  const scopeValid = changedFiles.every(path => allowed.has(
    process.platform === 'win32' ? path.toLowerCase() : path));
  const untracked = changes.filter(change => change.status === '??').map(change => change.path);
  if (scopeValid && untracked.length) {
    execFileSync('git', ['-C', workspace, 'add', '--intent-to-add', '--', ...untracked], {
      windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'],
    });
  }
  const diffPath = join(state_dir, `edit-diff-${job.request_id}-${attempt_id}.patch`);
  const diff = await captureGitStdout(workspace, state_dir, job.request_id, attempt_id,
    'diff', ['diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', 'HEAD'], true);
  if (diff.stdoutPath.toLowerCase() !== diffPath.toLowerCase()) {
    // Capture into the unique attempt artifact name without buffering the patch.
    renameSync(diff.stdoutPath, diffPath);
  }
  const local = diff.result.local_evidence || {};
  return {
    file: basename(diffPath), sha256: local.stdout_sha256,
    bytes: local.stdout_bytes, changed_files: changedFiles,
    allowed_paths: job.edit_paths, scope_valid: scopeValid,
  };
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
export async function runPlan(spec, config, job, attemptId, dependencies = {}) {
  const qualify = dependencies.qualifyOpenCodeV2 ?? qualifyOpenCodeV2;
  const runCaptured = dependencies.runCapturedProcess ?? runCapturedProcess;
  const editMode = job?.kind === 'opencode_edit';
  if (!isOpenCodeExecutionKind(job?.kind))
    return { outcome: 'UNSUPPORTED_OPENCODE_JOB_KIND', exit_code: 41,
      evidence_sha256: null, evidence_bytes: 0 };
  if (config.enable_v2_model_runs !== true) {
    return { outcome: 'V2_MODEL_EXECUTION_NOT_YET_APPROVED', exit_code: 44,
      evidence_sha256: null, evidence_bytes: 0 };
  }
  if (!checkModelAuthorization(job, config)) {
    return { outcome: 'MODEL_NOT_EXPLICITLY_ALLOWED', exit_code: 42,
      evidence_sha256: null, evidence_bytes: 0 };
  }
  const cli = qualify();
  if (!cli.ready) return { outcome: 'OPENCODE_V2_CLI_NOT_QUALIFIED', exit_code: 43,
    evidence_sha256: null, evidence_bytes: 0 };
  // V2, not V1: ordered permissions, shell/subagent, provider/model#variant.
  // Config is private, never echoed to the GitHub Issue; no shell expansion of prompts.
  let safePolicy;
  try {
    safePolicy = JSON.stringify(editMode ?
      buildV2ScopedEditConfig(config.workspace, job.edit_paths) : buildV2ReadOnlyConfig());
    if (editMode) await assertEditWorkspaceReady(config, job, attemptId);
  } catch (error) {
    return { outcome: `V2_EDIT_SCOPE_OR_SOURCE_${String(error?.code || error?.message || 'INVALID')
      .replace(/[^A-Z0-9_]/gi, '_').slice(0, 56).toUpperCase()}`, exit_code: 46,
      evidence_sha256: null, evidence_bytes: 0, coding_state: 'NOT_STARTED' };
  }
  // V2 beta builds have ignored OPENCODE_CONFIG[_CONTENT] in some execution paths.
  // The documented project-local opencode.json is the authoritative V2 policy input.
  // Never overwrite unrelated project configuration or allow higher-priority .opencode.
  const configFile = join(config.workspace, 'opencode.json');
  const hadExistingPolicy = existsSync(configFile);
  if (existsSync(join(config.workspace, 'opencode.jsonc')) ||
      existsSync(join(config.workspace, '.opencode')))
    return { outcome: 'V2_WORKSPACE_CONFIG_CONFLICT', exit_code: 45, evidence_sha256: null, evidence_bytes: 0 };
  if (existsSync(configFile)) {
    if (readFileSync(configFile, 'utf8') !== safePolicy)
      return { outcome: 'V2_WORKSPACE_CONFIG_UNKNOWN', exit_code: 45, evidence_sha256: null, evidence_bytes: 0 };
  } else writeFileSync(configFile, safePolicy, { flag: 'wx', mode: 0o600 });
  if (readFileSync(configFile, 'utf8') !== safePolicy)
    return { outcome: 'V2_WORKSPACE_CONFIG_READBACK_FAILED', exit_code: 45, evidence_sha256: null, evidence_bytes: 0 };
  const args = editMode ? buildV2ScopedEditArgs(job, config.workspace, spec) :
    buildV2ReadOnlyArgs(job, config.workspace, spec);
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
  const processResult = await runCaptured(cli.bin, args, {
    cwd: config.workspace, env: childEnv, stdoutPath, stderrPath,
    terminate: terminateProcessTree,
  });
  const capturedStdout = processResult.local_evidence?.stdout_file;
  const capturedHash = processResult.local_evidence?.stdout_sha256;
  const runEvidence = await readOpenCodeV2RunEvidence(
    typeof capturedStdout === 'string' && basename(capturedStdout) === capturedStdout
      ? join(config.state_dir, capturedStdout) : '',
    typeof capturedHash === 'string' ? capturedHash : '',
  );
  const evidencedResult = {
    ...processResult,
    session_id: runEvidence.session_id,
    session_started: runEvidence.session_started,
    model_invoked: runEvidence.model_invoked,
    provider_usage_evidence: runEvidence.provider_usage_evidence,
    model_activity_evidence: runEvidence.model_activity_evidence,
    token_usage: runEvidence.token_usage,
    tool_execution_evidence: runEvidence.tool_execution_evidence,
    tool_execution_count: runEvidence.tool_execution_count,
    file_change_tool_evidence: runEvidence.file_change_tool_evidence,
    file_change_tool_completed_count: runEvidence.file_change_tool_completed_count,
    file_change_tool_failed_count: runEvidence.file_change_tool_failed_count,
    file_change_tool_incomplete_count: runEvidence.file_change_tool_incomplete_count,
    local_evidence: { ...processResult.local_evidence,
      opencode_run: { valid: runEvidence.valid, reason: runEvidence.reason,
        event_count: runEvidence.event_count, stdout_bytes: runEvidence.stdout_bytes ?? 0 } },
  };
  if (!editMode) return evidencedResult;
  if (evidencedResult.local_evidence?.termination_state &&
      ['ORPHAN_POSSIBLE', 'TERMINATION_UNCONFIRMED', 'TERMINATION_REQUESTED']
        .includes(evidencedResult.local_evidence.termination_state))
    return { ...evidencedResult, outcome: 'V2_EDIT_PROCESS_TERMINATION_UNCONFIRMED',
      exit_code: -1, coding_state: 'UNKNOWN_PROCESS_MAY_STILL_WRITE',
      local_evidence: { ...evidencedResult.local_evidence, edit_policy: 'PRESERVED_TERMINATION_UNKNOWN' } };
  let policyChanged = false;
  try {
    if (readFileSync(configFile, 'utf8') !== safePolicy) policyChanged = true;
    else if (!hadExistingPolicy) rmSync(configFile, { force: false });
  } catch { policyChanged = true; }
  let diff;
  try { diff = await captureScopedEditDiff({ workspace: config.workspace,
    state_dir: config.state_dir, job, attempt_id: attemptId }); }
  catch (error) {
    return { ...evidencedResult,
      outcome: `V2_EDIT_DIFF_CAPTURE_FAILED_${String(error?.code || error?.message || 'UNKNOWN')
        .replace(/[^A-Z0-9_]/gi, '_').slice(0, 48).toUpperCase()}`,
      exit_code: -1, coding_state: 'UNKNOWN',
      local_evidence: { ...evidencedResult.local_evidence, edit_diff_error: 'CAPTURE_FAILED' } };
  }
  const localEvidence = { ...evidencedResult.local_evidence, edit_diff: diff };
  if (policyChanged || !diff.scope_valid)
    return { ...evidencedResult, outcome: policyChanged ? 'V2_EDIT_POLICY_CHANGED' : 'V2_EDIT_SCOPE_VIOLATION',
      cli_exit_code: processResult.exit_code, exit_code: 46, coding_state: 'REJECTED_SCOPE',
      scope_valid: false, diff_sha256: diff.sha256, diff_bytes: diff.bytes,
      ...diff, local_evidence: localEvidence };
  if (localEvidence.storage_error || localEvidence.capture_error || localEvidence.spawn_error ||
      localEvidence.process_error || localEvidence.stdin_error)
    return { ...evidencedResult,
      outcome: diff.changed_files.length ? 'V2_EDIT_EVIDENCE_CAPTURE_FAILED_DIFF_PRESERVED' :
        'V2_EDIT_EVIDENCE_CAPTURE_FAILED_NO_DIFF',
      cli_exit_code: processResult.exit_code, exit_code: -1,
      coding_state: diff.changed_files.length ? 'DIFF_CAPTURED_UNVERIFIED' : 'UNKNOWN',
      scope_valid: true, diff_sha256: diff.sha256, diff_bytes: diff.bytes,
      ...diff, local_evidence: localEvidence };
  if (!diff.changed_files.length || diff.bytes === 0)
    return { ...evidencedResult, outcome: 'V2_EDIT_NO_DIFF', cli_exit_code: evidencedResult.exit_code,
      exit_code: 47, coding_state: 'NO_DIFF', scope_valid: true,
      diff_sha256: diff.sha256, diff_bytes: diff.bytes, ...diff,
      local_evidence: localEvidence };
  if (evidencedResult.exit_code !== 0)
    return { ...evidencedResult, outcome: 'V2_EDIT_PROCESS_FAILED_DIFF_PRESERVED',
      cli_exit_code: evidencedResult.exit_code, coding_state: 'DIFF_CAPTURED_UNVERIFIED',
      scope_valid: true, diff_sha256: diff.sha256, diff_bytes: diff.bytes,
      ...diff, local_evidence: localEvidence };
  return { ...evidencedResult, outcome: 'V2_EDIT_DIFF_CAPTURED_UNVERIFIED',
    coding_state: 'DIFF_CAPTURED_UNVERIFIED', scope_valid: true,
    diff_sha256: diff.sha256, diff_bytes: diff.bytes,
    ...diff, local_evidence: localEvidence };
}
function readSpecBytes(path, sourceSha, apiRead = api) {
  const b = apiRead(`repos/${REPO}/contents/${path}?ref=${sourceSha}`);
  if (b.encoding !== 'base64' || typeof b.content !== 'string') throw new Error('SPEC_UNREADABLE');
  return Buffer.from(b.content.replace(/\s+/g, ''), 'base64');
}
function readSpec(job, apiRead = api) {
  const bytes = readSpecBytes(job.spec_path, job.source_sha, apiRead);
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
    ...(job.kind === 'codex_plan' ? { model: job.model, reasoning_effort: job.reasoning_effort,
      ...(job.goal_comment_id !== undefined ? { goal_comment_id: job.goal_comment_id,
        goal_body_sha256: job.goal_body_sha256, goal_author: job.goal_author,
        goal_marker: job.goal_marker } : {}),
      task_fingerprint: result?.fingerprint ?? result?.task_fingerprint ?? null,
      session_id: result?.session_id ?? null, diff_sha256: result?.diff_sha256 ?? null,
      stdout_sha256: result?.stdout_sha256 ?? null, stderr_sha256: result?.stderr_sha256 ?? null,
      session_started: result?.session_started ?? (result?.session_id !== null && result?.session_id !== undefined),
      model_invoked: result?.model_invoked ?? false,
      provider_usage_evidence: result?.provider_usage_evidence ?? 'UNKNOWN',
      model_activity_evidence: result?.model_activity_evidence ?? 'UNKNOWN',
      token_usage: result?.token_usage ?? null,
      tool_execution_evidence: result?.tool_execution_evidence ?? 'UNKNOWN',
      tool_execution_count: result?.tool_execution_count ?? 0,
      file_change_tool_evidence: result?.file_change_tool_evidence ?? 'UNKNOWN',
      file_change_tool_completed_count: result?.file_change_tool_completed_count ?? 0,
      file_change_tool_failed_count: result?.file_change_tool_failed_count ?? 0,
      file_change_tool_incomplete_count: result?.file_change_tool_incomplete_count ?? 0,
      tests: result?.tests ?? 'NOT_RUN', pr_url: result?.pr_url ?? null } : {}),
    ...(job.kind !== 'codex_plan' && (job.schema === 2 || job.schema === 4)
      ? { model: job.model, variant: job.variant } : {}),
    ...(job.kind !== 'codex_plan' && job.schema === 4 ? {
      edit_paths_sha256: digest(Buffer.from(JSON.stringify(job.edit_paths), 'utf8')),
      diff_sha256: result?.diff_sha256 ?? null, diff_bytes: result?.diff_bytes ?? null,
      changed_files_sha256: result?.changed_files ?
        digest(Buffer.from(JSON.stringify(result.changed_files), 'utf8')) : null,
      changed_files_count: result?.changed_files?.length ?? null,
      coding_state: result?.coding_state ?? 'UNVERIFIED',
      scope_valid: result?.scope_valid ?? null,
      cli_exit_code: result?.cli_exit_code ?? result?.exit_code ?? null } : {}),
    ...(job.kind !== 'codex_plan' && job.schema === 5 ? {
      source_pr: job.source_pr,
      edit_paths_sha256: digest(Buffer.from(JSON.stringify(job.edit_paths), 'utf8')),
      diff_sha256: result?.diff_sha256 ?? null, diff_bytes: result?.diff_bytes ?? null,
      changed_files_sha256: result?.changed_files ?
        digest(Buffer.from(JSON.stringify(result.changed_files), 'utf8')) : null,
      changed_files_count: result?.changed_files?.length ?? null,
      coding_state: result?.coding_state ?? 'UNVERIFIED',
      scope_valid: result?.scope_valid ?? null,
      cli_exit_code: result?.cli_exit_code ?? result?.exit_code ?? null } : {}),
    ...(job.kind !== 'codex_plan' && job.schema === 6 ? {
      source_pr: job.source_pr, goal_comment_id: job.goal_comment_id,
      goal_body_sha256: job.goal_body_sha256,
      edit_paths_sha256: digest(Buffer.from(JSON.stringify(job.edit_paths), 'utf8')),
      diff_sha256: result?.diff_sha256 ?? null, diff_bytes: result?.diff_bytes ?? null,
      changed_files_sha256: result?.changed_files ?
        digest(Buffer.from(JSON.stringify(result.changed_files), 'utf8')) : null,
      changed_files_count: result?.changed_files?.length ?? null,
      coding_state: result?.coding_state ?? 'UNVERIFIED',
      scope_valid: result?.scope_valid ?? null,
      cli_exit_code: result?.cli_exit_code ?? result?.exit_code ?? null } : {}),
    ...(job.kind !== 'codex_plan' && job.schema === 3 ? { model: job.model, reasoning_effort: job.reasoning_effort,
      task_fingerprint: result?.fingerprint ?? result?.task_fingerprint ?? null,
      session_id: result?.session_id ?? null, diff_sha256: result?.diff_sha256 ?? null,
      stdout_sha256: result?.stdout_sha256 ?? null, stderr_sha256: result?.stderr_sha256 ?? null,
      session_started: result?.session_started ?? (result?.session_id !== null && result?.session_id !== undefined),
      model_invoked: result?.model_invoked ?? false,
      provider_usage_evidence: result?.provider_usage_evidence ?? 'UNKNOWN',
      model_activity_evidence: result?.model_activity_evidence ?? 'UNKNOWN',
      token_usage: result?.token_usage ?? null,
      tool_execution_evidence: result?.tool_execution_evidence ?? 'UNKNOWN',
      tool_execution_count: result?.tool_execution_count ?? 0,
      file_change_tool_evidence: result?.file_change_tool_evidence ?? 'UNKNOWN',
      file_change_tool_completed_count: result?.file_change_tool_completed_count ?? 0,
      file_change_tool_failed_count: result?.file_change_tool_failed_count ?? 0,
      file_change_tool_incomplete_count: result?.file_change_tool_incomplete_count ?? 0,
      tests: result?.tests ?? 'NOT_RUN', pr_url: result?.pr_url ?? null } : {}),
    ...(isOpenCodeExecutionKind(job.kind) ? { model: job.model, variant: job.variant,
      session_id: result?.session_id ?? null, session_started: result?.session_started ?? null,
      model_invoked: result?.model_invoked ?? null,
      provider_usage_evidence: result?.provider_usage_evidence ?? 'UNKNOWN',
      model_activity_evidence: result?.model_activity_evidence ?? 'UNKNOWN',
      token_usage: result?.token_usage ?? null,
      tool_execution_evidence: result?.tool_execution_evidence ?? 'UNKNOWN',
      tool_execution_count: result?.tool_execution_count ?? 0,
      file_change_tool_evidence: result?.file_change_tool_evidence ?? 'UNKNOWN',
      file_change_tool_completed_count: result?.file_change_tool_completed_count ?? 0,
      file_change_tool_failed_count: result?.file_change_tool_failed_count ?? 0,
      file_change_tool_incomplete_count: result?.file_change_tool_incomplete_count ?? 0,
      stdout_sha256: result?.local_evidence?.stdout_sha256 ?? null,
      stderr_sha256: result?.local_evidence?.stderr_sha256 ?? null } : {}) };
}
function triggerCodexExecutor(config) {
  if (config.codex_executor_task !== 'PTYSD-Codex-Executor')
    throw new Error('CODEX_EXECUTOR_TASK_IDENTITY_MISMATCH');
  assertCodexExecutorTaskReady(config);
  execFileSync('schtasks.exe', ['/run', '/tn', config.codex_executor_task], {
    encoding: 'utf8', timeout: 20000, maxBuffer: 65536, windowsHide: true, shell: false,
  });
}
function assertCodexResultScopeMatchesRequest(started, result, spool) {
  const requestPath = join(spool, 'requests', `${started.request_id}-${started.attempt_id}.json`);
  const info = lstatSync(requestPath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('CODEX_REQUEST_NOT_REGULAR_FILE');
  const requestBytes = readFileSync(requestPath, 'utf8');
  const requestObject = JSON.parse(requestBytes);
  const request = validateCodexExecutorRequest(requestObject);
  const job = request.job;
  if (job.request_id !== started.request_id || job.host !== started.host ||
      job.source_sha !== started.source_sha || job.model !== started.model ||
      job.reasoning_effort !== started.reasoning_effort || request.attemptId !== started.attempt_id ||
      requestObject.fingerprint !== started.task_fingerprint)
    throw new Error('CODEX_REQUEST_START_IDENTITY_MISMATCH');

  const normalize = path => path.replaceAll('\\', '/');
  const changed = result.changed_paths.map(normalize);
  if (new Set(changed).size !== changed.length) throw new Error('CODEX_RESULT_SCOPE_MISMATCH');
  const allowed = new Set(job.write_paths);
  const expectedOutOfScope = changed.filter(path => !allowed.has(path)).sort();
  const reportedOutOfScope = result.out_of_scope_paths.map(normalize).sort();
  if (JSON.stringify(reportedOutOfScope) !== JSON.stringify(expectedOutOfScope) ||
      (expectedOutOfScope.length > 0 && result.outcome !== 'WRITE_SCOPE_VIOLATION') ||
      (expectedOutOfScope.length === 0 && result.outcome === 'WRITE_SCOPE_VIOLATION'))
    throw new Error('CODEX_RESULT_SCOPE_MISMATCH');
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
    validateCodexExecutorResult(result, started);
    assertCodexResultScopeMatchesRequest(started, result, spool);
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
export async function dispatchCodexJob({ config, job, spec, workerLogin, humanGoalContext = null,
  attemptId = randomUUID(),
  createBundle = async (bundlePath, sourceSha) => createPinnedSourceBundle({
    workspace: config.workspace, bundlePath, sourceSha, attemptId, refNamespace: 'codex-bundles',
  }),
  claim = claimCodexAttempt, release = releaseCodexAttempt,
  publishRequest = publishCodexExecutorRequest,
  publishStarted = async data => writeCodexReceiptOnce(config, data, workerLogin),
  trigger = () => triggerCodexExecutor(config),
  cleanupBundle = path => rmSync(path, { force: true }) }) {
  if (!config.codex_spool) throw new Error('CODEX_SPOOL_NOT_CONFIGURED');
  const bundleDir = join(config.codex_spool, 'bundles');
  mkdirSync(bundleDir, { recursive: true });
  const bundlePath = join(bundleDir, `${job.request_id}-${attemptId}.bundle`);
  const createdBundle = await createBundle(bundlePath, job.source_sha);
  const bundleSha = typeof createdBundle?.sha256 === 'string' && HASH.test(createdBundle.sha256)
    ? createdBundle.sha256 : digest(readFileSync(bundlePath));
  const request = makeCodexExecutorRequest(job, attemptId, spec, bundlePath, bundleSha, humanGoalContext);
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
  const outputCaptureFailed = Boolean(local &&
    (local.storage_error || local.capture_error || local.spawn_error || local.process_error || local.stdin_error) &&
    terminal?.state === 'BLOCKED' && /(?:FAILED|ERROR)/.test(terminal?.outcome || ''));
  if (outputCaptureFailed && (terminal.kind !== 'opencode_edit' || terminal.diff_sha256 == null)) return true;
  if (!outputCaptureFailed) {
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
  }
  if (terminal.kind === 'opencode_edit' && terminal.diff_sha256 !== null) {
    const diff = local.edit_diff;
    if (!diff || typeof diff.file !== 'string' || basename(diff.file) !== diff.file ||
        !/^[A-Za-z0-9._-]{1,180}$/.test(diff.file) ||
        !HASH.test(diff.sha256 || '') || diff.sha256 !== terminal.diff_sha256 ||
        !Number.isSafeInteger(diff.bytes) || diff.bytes < 0 || diff.bytes !== terminal.diff_bytes ||
        !Array.isArray(diff.changed_files) || !Array.isArray(diff.allowed_paths) ||
        !validEditPaths(diff.allowed_paths) ||
        digest(Buffer.from(JSON.stringify(diff.allowed_paths), 'utf8')) !== terminal.edit_paths_sha256 ||
        digest(Buffer.from(JSON.stringify(diff.changed_files), 'utf8')) !== terminal.changed_files_sha256 ||
        diff.changed_files.length !== terminal.changed_files_count)
      throw new Error('EDIT_DIFF_EVIDENCE_METADATA_INVALID');
    const diffPath = join(resultDir, diff.file);
    let info;
    try { info = lstatSync(diffPath); } catch { throw new Error('EDIT_DIFF_READBACK_FAILED'); }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('EDIT_DIFF_PATH_NOT_REGULAR_FILE');
    let saved;
    try { saved = await hashEvidenceFile(diffPath); }
    catch { throw new Error('EDIT_DIFF_READBACK_FAILED'); }
    if (saved.sha256 !== diff.sha256 || saved.bytes !== diff.bytes)
      throw new Error('EDIT_DIFF_FILE_HASH_MISMATCH');
    const allow = new Set(diff.allowed_paths.map(path =>
      process.platform === 'win32' ? path.toLowerCase() : path));
    const actualScopeValid = diff.changed_files.every(path =>
      typeof path === 'string' && allow.has(process.platform === 'win32' ? path.toLowerCase() : path));
    if (diff.scope_valid !== actualScopeValid || terminal.scope_valid !== actualScopeValid)
      throw new Error('EDIT_DIFF_SCOPE_READBACK_MISMATCH');
  }
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
  const goalCommentsRead = adapters.goalCommentsRead ?? (() => issueCommentsFor(V53_GOAL_ISSUE));
  const postReceipt = adapters.writeReceipt ?? writeReceipt;
  const verifyCodexTask = adapters.assertCodexExecutorTaskReady ?? assertCodexExecutorTaskReady;
  const verifyExecutor = adapters.assertExecutorTaskReady ?? assertExecutorTaskReady;
  const createSourceBundle = adapters.createExecutorSourceBundle ?? createExecutorSourceBundle;
  const dispatchExecutor = adapters.dispatchToExecutor ?? dispatchToExecutor;
  const resolveExecutorResultsDir = adapters.executorResultsDir ?? (descriptor => descriptor.results_dir);
  const resolveExecutorResultPath = adapters.executorResultPath ?? executorResultPath;
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
  const receiptAndLegacyComments = commentsRead(config);
  let humanGoalComments = null;
  let humanGoalWaitingReason = null;
  try { humanGoalComments = goalCommentsRead(); }
  catch {
    humanGoalWaitingReason = 'HUMAN_GOAL_SOURCE_READ_UNKNOWN';
    log('HUMAN_GOAL_DISCOVERY_READ_UNKNOWN');
  }
  const humanCandidateJobs = (humanGoalComments || []).filter(comment =>
    comment.issue_url === `https://api.github.com/repos/${REPO}/issues/${V53_GOAL_ISSUE}` &&
    config.dispatchers.includes(comment.user?.login) && parseJob(comment.body)?.schema === 6);
  // Issue #310 may carry the same exact structured candidate job. Its receipts
  // still belong to Issue #407, so one existing comment stream remains the
  // durable deduplication and recovery authority.
  const comments = [...receiptAndLegacyComments, ...humanCandidateJobs];
  // Reconcile ambiguous model effects by scope; keep independent zero-token jobs runnable.
  // Never replay an OpenCode operation without its exact persisted terminal evidence.
  const blockedKinds = new Set();
  const skippedRequestIds = new Set();
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
    const resultDir = isOpenCodeExecutionKind(s.kind) && config.executor ?
      resolveExecutorResultsDir(config.executor) : config.state_dir;
    const path = isOpenCodeExecutionKind(s.kind) && config.executor ?
      resolveExecutorResultPath(resultDir, s.request_id, s.attempt_id) :
      join(resultDir, `result-${s.request_id}-${s.attempt_id}.json`);
    if (hasTerminal) {
      if (isOpenCodeExecutionKind(s.kind) && config.executor) {
        if (existsSync(path)) {
          let result;
          try { result = JSON.parse(readFileSync(path, 'utf8')); }
          catch (error) {
            blockedKinds.add(s.kind);
            log(`EXECUTOR_TERMINAL_EVIDENCE_UNREADABLE_${s.request_id}_${String(error?.code || 'UNKNOWN').slice(0, 32)}_NO_REPLAY`);
            continue;
          }
          try { await verifyCapturedEvidence(resultDir, result); }
          catch (error) {
            blockedKinds.add(s.kind);
            log(`EXECUTOR_TERMINAL_CAPTURE_READBACK_UNKNOWN_${s.request_id}_${String(error?.code || 'UNKNOWN').slice(0, 32)}_NO_CLEANUP`);
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
        if (isOpenCodeExecutionKind(s.kind)) await verifyCapturedEvidence(resultDir, result);
      } catch (error) {
        if (isOpenCodeExecutionKind(s.kind)) blockedKinds.add(s.kind);
        log(`LOCAL_RESULT_RECONCILIATION_UNKNOWN_${s.request_id}_${String(error?.code || error?.message || 'UNKNOWN').slice(0, 48)}_NO_REPLAY`);
        continue;
      }
      if (isOpenCodeExecutionKind(s.kind) && executorProcessTerminationUnconfirmed(result)) {
        blockedKinds.add(s.kind);
        log(`EXECUTOR_PROCESS_TERMINATION_UNRESOLVED_${s.request_id}`);
        continue;
      }
      postReceipt(config, result.terminal, me);
      if (isOpenCodeExecutionKind(s.kind) && config.executor) {
        try { cleanupExecutorAttempt(config.executor, s.attempt_id); } catch { /* exact result and receipt remain durable */ }
      }
      log(`RECOVERED_TERMINAL_${s.request_id}`);
      blockedKinds.add(s.kind);
      continue;
    }
    if (isOpenCodeExecutionKind(s.kind)) blockedKinds.add(s.kind);
    log(`AMBIGUOUS_STARTED_${s.request_id}: NO_REEXECUTION`);
  }
  const head = apiRead(`repos/${REPO}/git/ref/heads/main`).object?.sha;
  if (!SHA.test(head || '')) throw new Error('MAIN_HEAD_UNREADABLE');
  let humanGoalTask = null;
  const latestDirective = latestTrustedHumanDirective(humanGoalComments || [], config.dispatchers);
  if (latestDirective) {
    const identity = humanDirectiveCodexIdentity(latestDirective);
    const requestId = identity?.requestId;
    const priorGoalReceipt = comments.some(comment => comment.user?.login === me &&
      parseReceipt(comment.body)?.request_id === requestId);
    const legacyReceiptStatus = humanGoalLegacyReceiptStatus(comments, me, latestDirective.id,
      identity?.bodySha256, config.host);
    if (priorGoalReceipt) {
      log(`HUMAN_GOAL_ALREADY_HAS_RECEIPT_${latestDirective.id}_NO_REPLAY`);
    } else if (legacyReceiptStatus === 'SAME_BODY') {
      log(`HUMAN_GOAL_ALREADY_HAS_LEGACY_RECEIPT_${latestDirective.id}_NO_REPLAY`);
    } else if (legacyReceiptStatus === 'UNKNOWN') {
      humanGoalWaitingReason ??= 'HUMAN_GOAL_LEGACY_RECEIPT_BODY_UNKNOWN';
      log(`HUMAN_GOAL_LEGACY_RECEIPT_BODY_UNKNOWN_${latestDirective.id}_NO_REPLAY`);
    } else if (!codexGoalPolicyReady(config.human_goal_codex_policy)) {
      humanGoalWaitingReason ??= 'HUMAN_GOAL_CODEX_POLICY_NOT_CONFIGURED';
      log(`HUMAN_GOAL_CODEX_POLICY_NOT_CONFIGURED_${latestDirective.id}_NO_MODEL`);
    } else {
      try {
        const goalSpecBytes = readSpecBytes(CODEX_HUMAN_GOAL_SPEC_PATH, head, apiRead);
        const goalSpec = goalSpecBytes.toString('utf8');
        const job = humanDirectiveCodexJob(latestDirective, config.host, head, goalSpec,
          config.human_goal_codex_policy);
        if (!job) {
          humanGoalWaitingReason ??= 'HUMAN_GOAL_CODEX_POLICY_INVALID';
          log(`HUMAN_GOAL_CODEX_POLICY_INVALID_${latestDirective.id}_NO_MODEL`);
        } else {
          humanGoalTask = { comment: latestDirective, spec: goalSpec };
          comments.push({ id: latestDirective.id, body: JOB_MARKER + JSON.stringify(job),
            user: latestDirective.user, issue_url: latestDirective.issue_url });
          comments.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
        }
      } catch {
        humanGoalWaitingReason ??= 'HUMAN_GOAL_CODEX_SPEC_READ_UNKNOWN';
        log(`HUMAN_GOAL_CODEX_SPEC_READ_UNKNOWN_${latestDirective.id}_NO_DISPATCH`);
      }
    }
    if (legacyReceiptStatus === 'PRIOR_BODY_TERMINAL')
      log(`HUMAN_GOAL_PRIOR_BODY_TERMINAL_${latestDirective.id}_NEW_BODY_MAY_PROCEED`);
  }
  const candidateSourceShas = await readPinnedCandidateSources(comments,
    config.dispatchers, me, config.host, apiRead, log, [...blockedKinds],
    () => humanGoalComments ?? goalCommentsRead());
  const selectNextCandidate = () => selectNextWithCodexClaim(comments.filter(comment => {
    const job = parseJob(comment.body);
    return !job || !skippedRequestIds.has(job.request_id);
  }), config.dispatchers, me, config.host, head, config.state_dir,
  [...blockedKinds], candidateSourceShas);
  let selected = selectNextCandidate();
  let next = selected.next;
  if (selected.unresolvedRequestId)
    log(`CODEX_LOCAL_CLAIM_UNRECONCILED_${selected.unresolvedRequestId}_NO_REPLAY`);
  try {
    const observation = await publishOperatorObservation(
      config, me, comments, head, adapters.observationDependencies, candidateSourceShas,
    );
    if (observation.status === 'UPDATED') log('OPERATOR_OBSERVATION_UPDATED');
    else if (observation.status === 'UNKNOWN') log('OPERATOR_OBSERVATION_UPDATE_UNKNOWN');
  } catch {
    // Status publishing failure must not block a valid queued task.
    log('OPERATOR_OBSERVATION_UPDATE_UNKNOWN');
  }
  let waitingEligibility = null;
  let preparedSourceBundle = null;
  while (next) {
    preparedSourceBundle = null;
    if (next.job.kind === 'codex_plan') {
      const gate = codexExecutionGate(next.job, config);
      let reason = null;
      if (!gate.allowed) {
        reason = `CODEX_AUTH_${gate.reasons.join(',')}`;
      } else if (!config.codex_spool ||
          existsSync(join(config.codex_spool, 'locks', 'executor.active'))) {
        reason = 'CODEX_EXECUTOR_SPOOL_OR_OWNER_NOT_READY';
      } else {
        try {
          const taskReadback = verifyCodexTask(config, adapters.codexTaskReadbackOptions);
          if (taskReadback?.ready !== true) throw new Error('CODEX_EXECUTOR_TASK_READBACK_NOT_READY');
        } catch (error) {
          reason = `CODEX_EXECUTOR_TASK_READBACK_${String(error?.code || error?.message || 'UNKNOWN')
            .replace(/[^A-Z0-9_]/gi, '_').slice(0, 64).toUpperCase()}`;
        }
      }
      if (reason) {
        waitingEligibility ??= reason;
        log(`CODEX_LANE_WAITING_ELIGIBILITY_${reason}`);
        blockedKinds.add('codex_plan');
        selected = selectNextCandidate();
        next = selected.next;
        if (selected.unresolvedRequestId)
          log(`CODEX_LOCAL_CLAIM_UNRECONCILED_${selected.unresolvedRequestId}_NO_REPLAY`);
        continue;
      }
    } else if (isOpenCodeExecutionKind(next.job.kind)) {
      let reason = null;
      if (config.enable_v2_model_runs !== true) reason = 'MODEL_RUNS_NOT_ENABLED';
      else if (!checkModelAuthorization(next.job, config)) reason = 'MODEL_NOT_EXPLICITLY_ALLOWED';
      else if (next.job.kind === 'opencode_edit') {
        try { buildV2ScopedEditConfig(config.workspace, next.job.edit_paths); }
        catch (error) {
          reason = `EDIT_SCOPE_${String(error?.code || error?.message || 'INVALID')
            .replace(/[^A-Z0-9_]/gi, '_').slice(0, 64).toUpperCase()}`;
        }
      }
      if (!reason && !config.executor) reason = 'EXECUTOR_NOT_CONFIGURED';
      else if (!reason) {
        try {
          // The OpenCode verifier's contract is throw-on-failure and return the
          // validated Task Scheduler readback on success; unlike the Codex
          // verifier, it does not expose a `ready` boolean.
          verifyExecutor(config.executor);
        } catch (error) {
          reason = `EXECUTOR_TASK_${String(error?.code || error?.message || 'UNKNOWN')
            .replace(/[^A-Z0-9_]/gi, '_').slice(0, 64).toUpperCase()}`;
        }
      }
      if (!reason && config.executor.source_bundle_per_attempt === true) {
        try {
          const bundle = createSourceBundle({ workspace: config.workspace,
            descriptor: config.executor, job: next.job, attemptId: randomUUID() });
          if (bundle.source_sha !== next.job.source_sha || !HASH.test(bundle.sha256 || ''))
            throw new Error('EXECUTOR_SOURCE_BUNDLE_IDENTITY_MISMATCH');
          preparedSourceBundle = { attempt_id: bundle.attempt_id, sha256: bundle.sha256 };
        } catch (error) {
          reason = `EXECUTOR_SOURCE_BUNDLE_${String(error?.code || error?.message || 'UNKNOWN')
            .replace(/[^A-Z0-9_]/gi, '_').slice(0, 64).toUpperCase()}`;
        }
      }
      if (reason) {
        waitingEligibility ??= `OPENCODE_${reason}`;
        log(`OPENCODE_LANE_WAITING_ELIGIBILITY_${reason}`);
        // Eligibility is effect-free and request-specific. Skip only this exact
        // request so an unrelated edit in the same lane can still run this tick.
        skippedRequestIds.add(next.job.request_id);
        selected = selectNextCandidate();
        next = selected.next;
        if (selected.unresolvedRequestId)
          log(`CODEX_LOCAL_CLAIM_UNRECONCILED_${selected.unresolvedRequestId}_NO_REPLAY`);
        continue;
      }
    }
    break;
  }
  if (!next) {
    const waitingReason = waitingEligibility ?? humanGoalWaitingReason;
    if (waitingReason) {
      log(`WAITING_ELIGIBILITY_${waitingReason}`);
      return { state: 'WAITING_ELIGIBILITY', reason: waitingReason };
    }
    log('NO_DELTA_NO_LLM');
    return { state: 'NO_DELTA' };
  }
  const job = next.job;
  const discardPreparedSourceBundle = () => {
    if (!preparedSourceBundle) return;
    try { cleanupExecutorAttempt(config.executor, preparedSourceBundle.attempt_id); }
    catch { log(`EXECUTOR_SOURCE_BUNDLE_CLEANUP_UNKNOWN_${job.request_id}`); }
  };
  if (job.source_pr === undefined && job.source_sha !== head) {
    discardPreparedSourceBundle();
    log(`STALE_SHA_SKIP_${job.request_id}`);
    return { state: 'STALE_SOURCE' };
  }
  // Check full issue comment remains immutable since selection. Edits/races abort the lane.
  let original;
  try { original = apiRead(`repos/${REPO}/issues/comments/${next.id}`); }
  catch (error) { discardPreparedSourceBundle(); throw error; }
  if (job.kind === 'codex_plan' && job.schema === 4) {
    if (!humanDirectiveMatches(job, original, config.dispatchers)) {
      discardPreparedSourceBundle();
      log(`HUMAN_GOAL_CHANGED_OR_UNTRUSTED_${job.goal_comment_id}_NO_DISPATCH`);
      return { state: 'STALE_HUMAN_GOAL', request_id: job.request_id };
    }
  } else if (original.body !== next.originalBody) {
    discardPreparedSourceBundle();
    throw new Error('DISPATCH_COMMENT_CHANGED');
  }
  let spec = null;
  if (isOpenCodeExecutionKind(job.kind) || job.kind === 'codex_plan')
    spec = job.kind === 'codex_plan' && job.schema === 4
      ? humanGoalTask?.spec ?? readSpec(job, apiRead) : readSpec(job, apiRead);
  if (job.source_pr !== undefined) {
    if (job.schema !== 6) {
      discardPreparedSourceBundle();
      log(`CANDIDATE_SOURCE_WITHOUT_HUMAN_GOAL_${job.source_pr}_NO_DISPATCH`);
      return { state: 'UNVERIFIED_HUMAN_GOAL', request_id: job.request_id };
    }
    let latestGoal;
    try { latestGoal = latestTrustedHumanGoal(goalCommentsRead(), config.dispatchers); }
    catch {
      discardPreparedSourceBundle();
      log(`HUMAN_GOAL_LATEST_FINAL_READBACK_UNKNOWN_${job.goal_comment_id}_NO_DISPATCH`);
      return { state: 'WAITING_HUMAN_GOAL_READBACK', request_id: job.request_id };
    }
    if (!latestGoal || latestGoal.id !== job.goal_comment_id) {
      discardPreparedSourceBundle();
      log(`HUMAN_GOAL_SUPERSEDED_FINAL_${job.goal_comment_id}_NO_DISPATCH`);
      return { state: 'STALE_HUMAN_GOAL', request_id: job.request_id };
    }
    let currentGoal;
    try { currentGoal = await apiRead(`repos/${REPO}/issues/comments/${job.goal_comment_id}`); }
    catch {
      discardPreparedSourceBundle();
      log(`HUMAN_GOAL_FINAL_READBACK_UNKNOWN_${job.goal_comment_id}_NO_DISPATCH`);
      return { state: 'WAITING_HUMAN_GOAL_READBACK', request_id: job.request_id };
    }
    if (!candidateGoalCommentMatches(job, currentGoal, config.dispatchers)) {
      discardPreparedSourceBundle();
      log(`HUMAN_GOAL_CHANGED_OR_UNTRUSTED_${job.goal_comment_id}_NO_DISPATCH`);
      return { state: 'STALE_HUMAN_GOAL', request_id: job.request_id };
    }
    let currentPull;
    try { currentPull = await apiRead(`repos/${REPO}/pulls/${job.source_pr}`); }
    catch {
      discardPreparedSourceBundle();
      log(`CANDIDATE_PR_FINAL_READBACK_UNKNOWN_${job.source_pr}_NO_DISPATCH`);
      return { state: 'WAITING_CANDIDATE_SOURCE_READBACK', request_id: job.request_id };
    }
    if (candidatePullRequestHeadSha(job, currentPull)?.toLowerCase() !== job.source_sha.toLowerCase()) {
      discardPreparedSourceBundle();
      log(`CANDIDATE_PR_HEAD_OR_BASE_CHANGED_${job.source_pr}_NO_DISPATCH`);
      return { state: 'STALE_CANDIDATE_SOURCE', request_id: job.request_id };
    }
  }
  let humanGoalContext = null;
  if (job.kind === 'codex_plan' && job.schema === 4) {
    let latestCurrentDirective;
    try { latestCurrentDirective = latestTrustedHumanDirective(goalCommentsRead(), config.dispatchers); }
    catch {
      discardPreparedSourceBundle();
      log(`HUMAN_GOAL_LATEST_FINAL_READBACK_UNKNOWN_${job.goal_comment_id}_NO_DISPATCH`);
      return { state: 'WAITING_HUMAN_GOAL_READBACK', request_id: job.request_id };
    }
    if (!latestCurrentDirective || latestCurrentDirective.id !== job.goal_comment_id) {
      discardPreparedSourceBundle();
      log(`HUMAN_GOAL_SUPERSEDED_FINAL_${job.goal_comment_id}_NO_DISPATCH`);
      return { state: 'STALE_HUMAN_GOAL', request_id: job.request_id };
    }
    let currentDirective;
    try { currentDirective = apiRead(`repos/${REPO}/issues/comments/${job.goal_comment_id}`); }
    catch {
      discardPreparedSourceBundle();
      log(`HUMAN_GOAL_FINAL_READBACK_UNKNOWN_${job.goal_comment_id}_NO_DISPATCH`);
      return { state: 'WAITING_HUMAN_GOAL_READBACK', request_id: job.request_id };
    }
    if (!humanDirectiveMatches(job, currentDirective, config.dispatchers)) {
      discardPreparedSourceBundle();
      log(`HUMAN_GOAL_CHANGED_OR_UNTRUSTED_FINAL_${job.goal_comment_id}_NO_DISPATCH`);
      return { state: 'STALE_HUMAN_GOAL', request_id: job.request_id };
    }
    const fetchedAt = new Date().toISOString();
    log(`HUMAN_GOAL_READBACK_${job.goal_comment_id}_${job.goal_body_sha256}_${fetchedAt}`);
    humanGoalContext = { repo: REPO, issue: V53_GOAL_ISSUE, comment_id: job.goal_comment_id,
      author: job.goal_author, body_sha256: job.goal_body_sha256, fetched_at: fetchedAt,
      body: currentDirective.body };
  }
  const executorDispatch = isOpenCodeExecutionKind(job.kind);
  const attemptId = preparedSourceBundle?.attempt_id ?? randomUUID();
  if (job.kind === 'codex_plan') {
    const dispatched = await dispatchCodex({ config, job, spec, workerLogin: me, attemptId,
      humanGoalContext });
    log(`${dispatched.state}_${job.request_id}_${attemptId}`);
    return { state: dispatched.state, request_id: job.request_id, attempt_id: attemptId,
      outcome: dispatched.reason ?? 'CODEX_EXECUTOR_DISPATCH_ACK_NOT_ACCEPTANCE' };
  }
  const start = receipt(job.request_id, attemptId, 'STARTED', job);
  postReceipt(config, start, me);
  if (executorDispatch) {
    const dispatched = dispatchExecutor(config.executor, {
      request_id: job.request_id, attempt_id: attemptId, source_sha: job.source_sha, job, spec,
      ...(preparedSourceBundle ? { source_bundle_sha256: preparedSourceBundle.sha256 } : {}),
    });
    log(`DISPATCHED_${job.request_id}_${dispatched.outcome}`);
    return { state: 'DISPATCHED', request_id: job.request_id, attempt_id: attemptId,
      outcome: dispatched.outcome };
  }
  let result;
  if (job.kind === 'ping') result = { outcome: 'BRIDGE_PING_OK_NOT_OS_ACCEPTANCE', exit_code: 0, evidence_sha256: null, evidence_bytes: 0 };
  else if (job.kind === 'native_preflight') result = nativePreflight(config, job);
  else if (job.kind === 'native_v2_qualify') result = nativeV2Qualify(config, job);
  else result = { outcome: 'UNSUPPORTED_DISPATCH_JOB_KIND', exit_code: 1,
    evidence_sha256: null, evidence_bytes: 0 };
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
