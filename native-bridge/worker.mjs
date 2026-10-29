#!/usr/bin/env node
// PTYSD native issue bridge. No listener, MCP, model router, or privileged daemon.
// Public GitHub issue comments are only pointers to immutable, reviewed source.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync, renameSync, rmSync, statSync,
  openSync, closeSync, fsyncSync } from 'node:fs';
import { homedir, hostname, platform } from 'node:os';
import { basename, join, resolve, relative, isAbsolute, delimiter } from 'node:path';
import { pathToFileURL } from 'node:url';
import { qualifyOpenCodeV2, validateV2Model, buildV2ReadOnlyConfig, buildV2ReadOnlyArgs,
  buildV2ScopedEditConfig, buildV2ScopedEditArgs, readOpenCodeV2RunEvidence } from './opencode-v2.mjs';
import { ANTIGRAVITY_V2_MODEL, ANTIGRAVITY_RUN_DISPOSITIONS, buildNativeChildEnvironment,
  buildAntigravityChildEnvironment,
  antigravityV2ReadinessExecutionFailure,
  emptyAntigravityFileChangeTargetEvidence, readAntigravityV2RunEvidence, readV2ProviderAuth,
  resolveAntigravityProjectId, runV2Readiness, runAntigravityV2Readiness } from './v2-readiness.mjs';
import { parseCodexJob, codexExecutionGate, claimCodexAttempt, codexScopedActionStatus,
  releaseCodexAttempt, makeCodexExecutorRequest, publishCodexExecutorRequest,
  executorResultPath as codexExecutorResultPath,
  validateCodexExecutorRequest, validateCodexExecutorResult,
  assertCodexExecutorTaskReady, CODEX_HUMAN_GOAL_SPEC_PATH } from './codex-continuation.mjs';
import {
  OPERATOR_REPO, OPERATOR_PROJECT, OPERATOR_ISSUE, OPERATOR_COMMENT_ID,
  collectWindowsObservation, collectRuntimeDeployment, encodeOperatorObservation, findOperatorComment,
  updateExistingOperatorComment,
} from './operator-observation.mjs';
import { runCapturedProcess, terminateProcessTree } from './captured-process.mjs';
import { safeErrorCode } from './safe-error-code.mjs';
import { assertExecutorTaskReady, cleanupExecutorAttempt, createExecutorSourceBundle,
  createPinnedSourceBundle, dispatchToExecutor, executorResultPath, triggerPendingExecutorAttempt,
  readExecutorWorkspace, validateExecutorRoutingMap, validateExecutorDescriptor } from './windows-executor.mjs';

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
const V53_HUMAN_DIRECTIVE_MARKER = /^PTYSD_V53R4_(?:DELETE_FIRST_AUTONOMY_GOAL|P[0-3]|R\d{1,2}|EMERGENCY|CODEX_DIRECTIVE|DUAL_AUDIT|W1_W2_CLI_ONLY)(?:_[A-Z0-9]+)*_\d{8}$/;
const OPENCODE_EXECUTION_KINDS = new Set(['opencode_plan', 'opencode_edit']);
const ANTIGRAVITY_EXECUTION_KINDS = new Set(['antigravity_edit']);
const MODEL_EXECUTION_KINDS = new Set([...OPENCODE_EXECUTION_KINDS, ...ANTIGRAVITY_EXECUTION_KINDS]);
const EDIT_EXECUTION_KINDS = new Set(['opencode_edit', 'antigravity_edit']);
const RECOVERABLE_MODEL_PREFLIGHT_OUTCOMES = new Set([
  'V2_MODEL_EXECUTION_NOT_YET_APPROVED', 'MODEL_NOT_EXPLICITLY_ALLOWED',
  'OPENCODE_V2_CLI_NOT_QUALIFIED', 'OPENCODE_V2_AUTH_NOT_READY',
  'OPENCODE_V2_AUTH_METADATA_UNKNOWN', 'V2_WORKSPACE_CONFIG_CONFLICT',
  'V2_WORKSPACE_CONFIG_UNKNOWN', 'V2_WORKSPACE_CONFIG_READBACK_FAILED',
  'ANTIGRAVITY_MODEL_RUNS_NOT_ENABLED', 'ANTIGRAVITY_EXECUTION_ATTESTATION_UNKNOWN',
  'ANTIGRAVITY_EXECUTION_ATTESTATION_STALE', 'ANTIGRAVITY_QUOTA_EMPTY',
  'ANTIGRAVITY_CREDIT_OVERAGE_NOT_DISABLED', 'ANTIGRAVITY_CLI_NOT_QUALIFIED',
  'ANTIGRAVITY_CREDIT_FALLBACK_SETTING_UNKNOWN', 'ANTIGRAVITY_AGGREGATE_QUOTA_UNKNOWN',
  'ANTIGRAVITY_AUTH_NOT_VERIFIED', 'ANTIGRAVITY_AUTH_NOT_LOGGED_IN',
  'ANTIGRAVITY_CLI_AUTH_NOT_VERIFIED', 'ANTIGRAVITY_CUA_MCP_TOOL_POLICY_UNVERIFIED',
  'ANTIGRAVITY_PROJECT_SCOPE_UNVERIFIED',
  'ANTIGRAVITY_NONFILE_TOOL_POLICY_UNVERIFIED',
  'ANTIGRAVITY_CLI_BINARY_HASH_UNAVAILABLE',
]);
const RECEIPT_STATES = new Set(['STARTED', 'WAITING', 'FINISHED', 'BLOCKED']);
const terminalStates = new Set(['FINISHED', 'BLOCKED']);
const resolvedAttemptStates = new Set(['WAITING', ...terminalStates]);
const commandTimeout = 60000;
function digest(data) { return createHash('sha256').update(data).digest('hex'); }
async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export function terminalStateForResult(result) {
  // This field records only the execution attempt lifecycle. A zero exit code
  // never upgrades the outcome to semantic, coding, PR, or source acceptance.
  if (!result || result.exit_code !== 0 || typeof result.outcome !== 'string') return 'BLOCKED';
  if (/(?:^|_)(?:FAILED|ERROR)(?:_|$)/.test(result.outcome)) return 'BLOCKED';
  return 'FINISHED';
}
export function isRecoverableModelPreflightWait(result, job) {
  return MODEL_EXECUTION_KINDS.has(job?.kind) &&
    result?.eligibility_state === 'WAITING' && result?.model_invoked === false &&
    RECOVERABLE_MODEL_PREFLIGHT_OUTCOMES.has(result?.outcome);
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
function isModelExecutionKind(kind) { return MODEL_EXECUTION_KINDS.has(kind); }
function isEditExecutionKind(kind) { return EDIT_EXECUTION_KINDS.has(kind); }
function executorLaneForJobKind(kind) {
  if (isOpenCodeExecutionKind(kind)) return 'opencode';
  if (ANTIGRAVITY_EXECUTION_KINDS.has(kind)) return 'antigravity';
  return null;
}
export function executorForJobKind(config, kind) {
  const lane = executorLaneForJobKind(kind);
  if (!lane) return null;
  if (config?.executors !== undefined) return config.executors?.[lane] ?? null;
  if (config?.executor_lane !== undefined)
    return config.executor_lane === lane ? config.executor ?? null : null;
  // The legacy descriptor came from the OpenCode registrar; never infer that
  // it is an Antigravity identity. W2 requires an explicit lane binding.
  return lane === 'opencode' ? config?.executor ?? null : null;
}
function strictExecutorLaneRouting(config) {
  return config.executors !== undefined || config.executor_lane !== undefined ||
    config.executor !== undefined;
}
function executorRouteFailure(config, kind) {
  const lane = executorLaneForJobKind(kind);
  if (config.executors !== undefined || config.executor_lane !== undefined ||
      (config.executor !== undefined && lane === 'antigravity'))
    return 'EXECUTOR_NOT_CONFIGURED_FOR_' + lane.toUpperCase();
  return 'EXECUTOR_NOT_CONFIGURED';
}
function opencodeExecutorIsolationFailure(descriptor) {
  const phase = descriptor?.execution_phase ?? 'VM_ISOLATED';
  const userSid = typeof descriptor?.user_sid === 'string' ? descriptor.user_sid.trim() : '';
  const publisherSid = typeof descriptor?.publisher_sid === 'string' ? descriptor.publisher_sid.trim() : '';
  if (!userSid || !publisherSid) return 'EXECUTOR_OS_ISOLATION_REQUIRED';
  const sameIdentity = userSid.toUpperCase() === publisherSid.toUpperCase();
  // Match EXECUTOR-ISOLATION.md: the Human-authorized Win11 transition uses
  // the current Publisher SID, while VM isolation requires a distinct SID.
  if (!((phase === 'WIN11_TRANSITION' && sameIdentity) ||
        (phase === 'VM_ISOLATED' && !sameIdentity)))
    return 'EXECUTOR_OS_ISOLATION_REQUIRED';
  return null;
}
function validateExecutorRouting(config) {
  if (config.executors === undefined) {
    if (config.executor_lane !== undefined &&
        (!['opencode', 'antigravity'].includes(config.executor_lane) || config.executor === undefined))
      throw new Error('EXECUTOR_LANE_CONFIG_INVALID');
    if (config.executor !== undefined) validateExecutorDescriptor(config.executor);
    return;
  }
  if (config.executor !== undefined || config.executor_lane !== undefined)
    throw new Error('EXECUTOR_ROUTING_CONFIG_AMBIGUOUS');
  validateExecutorRoutingMap(config.executors);
}
function validJobModel(job) {
  return job?.kind === 'antigravity_edit'
    ? job.schema === 6 && job.model === ANTIGRAVITY_V2_MODEL && job.variant === 'high'
    : validateV2Model(job?.model, job?.variant);
}
function validConfiguredModel(model, variant) {
  return model === ANTIGRAVITY_V2_MODEL
    ? variant === 'high'
    : validateV2Model(model, variant);
}
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
      obj.schema === 5 && (obj.kind !== 'opencode_edit' || !validEditPaths(obj.edit_paths) ||
        !Number.isSafeInteger(obj.source_pr) || obj.source_pr < 1) ||
      obj.schema === 6 && (!EDIT_EXECUTION_KINDS.has(obj.kind) || !validEditPaths(obj.edit_paths) ||
        !Number.isSafeInteger(obj.source_pr) || obj.source_pr < 1) ||
      obj.schema === 6 && (!Number.isSafeInteger(obj.goal_comment_id) || obj.goal_comment_id < 1 ||
        !HASH.test(obj.goal_body_sha256 || '')) ||
      ![2, 4, 5, 6].includes(obj.schema)) return null;
  if (obj.kind === 'antigravity_edit' && obj.schema !== 6) return null;
  if (typeof obj.spec_path !== 'string' || !/^native-bridge\/tasks\/[a-z0-9-]{1,70}\.md$/.test(obj.spec_path)) return null;
  if (typeof obj.spec_sha256 !== 'string' || !HASH.test(obj.spec_sha256)) return null;
  if (!validJobModel(obj)) return null;
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
        !['ping', 'native_preflight', 'native_v2_qualify', 'opencode_plan', 'opencode_edit',
          'antigravity_edit', 'codex_plan'].includes(o.kind) ||
        o.permission_mode_evidence !== undefined &&
          (o.kind !== 'antigravity_edit' ||
            !['UNKNOWN', 'ACCEPT_EDITS_CONFIRMED', 'REQUEST_REVIEW_CONFIRMED']
              .includes(o.permission_mode_evidence)) ||
         o.cli_status !== undefined && (o.kind !== 'antigravity_edit' ||
           !Object.hasOwn(ANTIGRAVITY_RUN_DISPOSITIONS, o.cli_status)) ||
         o.run_disposition !== undefined && (o.kind !== 'antigravity_edit' ||
           !Object.values(ANTIGRAVITY_RUN_DISPOSITIONS).includes(o.run_disposition) ||
           o.cli_status === undefined ||
           ANTIGRAVITY_RUN_DISPOSITIONS[o.cli_status] !== o.run_disposition) ||
          o.external_effects !== undefined && (!MODEL_EXECUTION_KINDS.has(o.kind) ||
            !['NONE', 'UNKNOWN', 'OBSERVED'].includes(o.external_effects)) ||
          o.source_diff_evidence !== undefined && (!MODEL_EXECUTION_KINDS.has(o.kind) ||
            !['NOT_INSPECTED', 'CAPTURED', 'UNKNOWN'].includes(o.source_diff_evidence)) ||
          o.task_acceptance !== undefined && (!MODEL_EXECUTION_KINDS.has(o.kind) ||
            !['UNKNOWN', 'UNVERIFIED'].includes(o.task_acceptance)) ||
         o.cli_version !== undefined && (o.kind !== 'antigravity_edit' ||
           o.cli_version !== null && (typeof o.cli_version !== 'string' || !/^\d+\.\d+\.\d+$/.test(o.cli_version))) ||
         o.cli_binary_sha256 !== undefined && (o.kind !== 'antigravity_edit' ||
           o.cli_binary_sha256 !== null && !HASH.test(o.cli_binary_sha256)) ||
         o.cli_binary_integrity_evidence !== undefined && (o.kind !== 'antigravity_edit' ||
           !['UNKNOWN', 'MATCHED', 'CHANGED_OR_UNKNOWN'].includes(o.cli_binary_integrity_evidence)) ||
         o.tool_policy_evidence !== undefined && (o.kind !== 'antigravity_edit' ||
           !['UNKNOWN', 'CUA_OR_MCP_DENY_MISSING', 'CUA_AND_MCP_DENIED',
             'W2_NONFILE_ACTIONS_DENIED', 'W2_NONFILE_ACTION_DENY_INCOMPLETE', 'TOOL_POLICY_UNKNOWN']
             .includes(o.tool_policy_evidence)) ||
         o.forbidden_tool_execution_evidence !== undefined && (o.kind !== 'antigravity_edit' ||
           !['UNKNOWN', 'NOT_OBSERVED', 'OBSERVED'].includes(o.forbidden_tool_execution_evidence)) ||
        o.file_change_target_evidence !== undefined && (o.kind !== 'antigravity_edit' ||
          !validAntigravityFileChangeTargetEvidence(o.file_change_target_evidence)) ||
          o.tool_execution_failed_count !== undefined && (o.kind !== 'antigravity_edit' ||
            !Number.isSafeInteger(o.tool_execution_failed_count) || o.tool_execution_failed_count < 0) ||
          o.tool_execution_incomplete_count !== undefined && (o.kind !== 'antigravity_edit' ||
            !Number.isSafeInteger(o.tool_execution_incomplete_count) || o.tool_execution_incomplete_count < 0) ||
        (o.state === 'WAITING' && (!MODEL_EXECUTION_KINDS.has(o.kind) ||
          o.eligibility_state !== 'WAITING' || o.model_invoked !== false ||
          !RECOVERABLE_MODEL_PREFLIGHT_OUTCOMES.has(o.outcome))) ||
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
function validAntigravityFileChangeTargetEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== 8 ||
      !['NO_FILE_CHANGE_TOOLS', 'TARGETS_UNAVAILABLE', 'CANDIDATE_ROOT_ONLY',
        'REGISTERED_ROOT_ONLY', 'OUTSIDE_OR_UNKNOWN_ROOT_ONLY',
        'RELATIVE_OR_UNKNOWN_ONLY', 'MIXED_ROOTS'].includes(value.status)) return false;
  const countKeys = ['tool_count', 'target_count', 'candidate_root_count', 'registered_root_count',
    'outside_or_unknown_root_count', 'relative_or_unknown_root_count', 'unidentified_tool_count'];
  if (countKeys.some(key => !Number.isSafeInteger(value[key]) || value[key] < 0)) return false;
  if (value.unidentified_tool_count > value.tool_count) return false;
  if (value.target_count < value.tool_count - value.unidentified_tool_count) return false;
  const rootCount = value.candidate_root_count + value.registered_root_count +
    value.outside_or_unknown_root_count + value.relative_or_unknown_root_count;
  if (rootCount !== value.target_count) return false;
  if ((value.tool_count === 0) !== (value.status === 'NO_FILE_CHANGE_TOOLS')) return false;
  const observedRoots = ['candidate_root_count', 'registered_root_count',
    'outside_or_unknown_root_count', 'relative_or_unknown_root_count']
    .filter(key => value[key] > 0);
  let expectedStatus;
  if (!value.tool_count) expectedStatus = 'NO_FILE_CHANGE_TOOLS';
  else if (!observedRoots.length) {
    if (value.unidentified_tool_count !== value.tool_count) return false;
    expectedStatus = 'TARGETS_UNAVAILABLE';
  } else if (observedRoots.length > 1 || value.unidentified_tool_count > 0)
    expectedStatus = 'MIXED_ROOTS';
  else if (observedRoots[0] === 'candidate_root_count') expectedStatus = 'CANDIDATE_ROOT_ONLY';
  else if (observedRoots[0] === 'registered_root_count') expectedStatus = 'REGISTERED_ROOT_ONLY';
  else if (observedRoots[0] === 'outside_or_unknown_root_count')
    expectedStatus = 'OUTSIDE_OR_UNKNOWN_ROOT_ONLY';
  else expectedStatus = 'RELATIVE_OR_UNKNOWN_ONLY';
  return value.status === expectedStatus;
}
function hasBlockingRequestReceipt(entries) {
  if (!entries.length) return false;
  if (entries.some(entry => terminalStates.has(entry.receipt.state))) return true;
  const attempts = new Map();
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.id) || entry.id < 1) return true;
    const id = entry.receipt.attempt_id;
    if (!attempts.has(id)) attempts.set(id, []);
    attempts.get(id).push(entry);
  }
  for (const attemptEntries of attempts.values()) {
    attemptEntries.sort((a, b) => a.id - b.id);
    const states = attemptEntries.map(entry => entry.receipt.state);
    const last = states.at(-1);
    if (last === 'STARTED') return true;
    if (last !== 'WAITING' || !states.includes('STARTED')) return true;
  }
  return false;
}
function receiptMayBlockReplay(login, workerLogin, dispatchers) {
  // A trusted dispatcher may have published an earlier native Worker receipt
  // before the local GitHub CLI identity changed. Count it only as a replay
  // blocker; Worker acceptance and live activity remain tied to workerLogin.
  return login === workerLogin || dispatchers.includes(login);
}
function hasRequestBoundScopedEditDiff(receipt, job) {
  // Schema-1 terminals written before source_diff_evidence was introduced can
  // still prove a complete, request-bound diff through their scope, digest,
  // byte-count, and changed-file fields. An explicit UNKNOWN/NOT_INSPECTED value
  // remains fail-closed.
  const sourceDiffCaptured = receipt?.source_diff_evidence === 'CAPTURED' ||
    receipt?.source_diff_evidence === undefined;
  return receipt?.model_invoked === true && receipt.coding_state === 'DIFF_CAPTURED_UNVERIFIED' &&
    receipt.scope_valid === true &&
    sourceDiffCaptured &&
    receipt.source_pr === job.source_pr && receipt.goal_comment_id === job.goal_comment_id &&
    receipt.goal_body_sha256 === job.goal_body_sha256 &&
    receipt.edit_paths_sha256 === digest(Buffer.from(JSON.stringify(job.edit_paths), 'utf8')) &&
    /^[a-f0-9]{64}$/i.test(receipt.diff_sha256 || '') &&
    Number.isSafeInteger(receipt.diff_bytes) && receipt.diff_bytes > 0 &&
    /^[a-f0-9]{64}$/i.test(receipt.changed_files_sha256 || '') &&
    Number.isSafeInteger(receipt.changed_files_count) && receipt.changed_files_count > 0;
}
// A verified candidate-root-only W2 diff also releases the W2 same-path lease,
// even when the attempt is BLOCKED and its task acceptance or external effects
// remain UNKNOWN. Every file-change tool target and changed path must be bound
// to the isolated candidate root and complete scoped diff. This does not accept
// the task, clear UNKNOWN effects, or release the path for another Worker lane.
function hasIsolatedW2ScopedEditDiff(receipt, job) {
  const targets = receipt?.file_change_target_evidence;
  const fileToolEvents = receipt?.file_change_tool_completed_count +
    receipt?.file_change_tool_failed_count + receipt?.file_change_tool_incomplete_count;
  return job?.kind === 'antigravity_edit' && receipt?.kind === 'antigravity_edit' &&
    terminalStates.has(receipt?.state) && hasRequestBoundScopedEditDiff(receipt, job) &&
    receipt.source_diff_evidence === 'CAPTURED' &&
    receipt.tool_execution_evidence === 'OBSERVED' &&
    receipt.file_change_tool_evidence === 'OBSERVED' &&
    Number.isSafeInteger(fileToolEvents) &&
    validAntigravityFileChangeTargetEvidence(targets) &&
    targets.status === 'CANDIDATE_ROOT_ONLY' && targets.tool_count > 0 &&
    targets.target_count > 0 &&
    targets.candidate_root_count === targets.target_count &&
    targets.registered_root_count === 0 && targets.outside_or_unknown_root_count === 0 &&
    targets.relative_or_unknown_root_count === 0 && targets.unidentified_tool_count === 0 &&
    fileToolEvents === targets.tool_count &&
    receipt.permission_mode_evidence === 'REQUEST_REVIEW_CONFIRMED' &&
    receipt.tool_policy_evidence === 'W2_NONFILE_ACTIONS_DENIED' &&
    receipt.cli_binary_integrity_evidence === 'MATCHED' &&
    receipt.forbidden_tool_execution_evidence === 'NOT_OBSERVED';
}
function hasCompletedScopedEditDiff(receipt, job) {
  // FINISHED plus a complete request-bound diff releases the same-path lease;
  // task acceptance remains a separate review.
  return receipt?.state === 'FINISHED' && hasRequestBoundScopedEditDiff(receipt, job);
}
function unresolvedEditAttempt(job, entries, { allowIsolatedW2ScopedDiff = false } = {}) {
  if (!validEditPaths(job?.edit_paths)) return true;
  const matching = entries.filter(entry => entry.receipt.host.toUpperCase() === job.host.toUpperCase() &&
    entry.receipt.kind === job.kind && entry.receipt.source_sha === job.source_sha);
  if (matching.some(entry => !Number.isSafeInteger(entry.id) || entry.id < 1)) return true;
  const attempts = new Map();
  for (const entry of matching) {
    const attemptId = entry.receipt.attempt_id;
    if (!attempts.has(attemptId)) attempts.set(attemptId, []);
    attempts.get(attemptId).push(entry);
  }
  for (const attemptEntries of attempts.values()) {
    attemptEntries.sort((a, b) => a.id - b.id);
    const last = attemptEntries.at(-1)?.receipt;
    if (last?.state === 'STARTED' || (terminalStates.has(last?.state) &&
        last.external_effects !== 'NONE' && last.model_invoked !== false &&
        !hasCompletedScopedEditDiff(last, job) &&
        !(allowIsolatedW2ScopedDiff && hasIsolatedW2ScopedEditDiff(last, job)))) return true;
  }
  return false;
}
function editPathsOverlap(left, right) {
  const normalize = value => (process.platform === 'win32' ? value.toLowerCase() : value)
    .replaceAll('\\', '/').replace(/\/+$/, '');
  return left.some(a => right.some(b => {
    const x = normalize(a), y = normalize(b);
    return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
  }));
}
function resolvedAttemptState(comments, started, workerLogin) {
  const entries = comments.filter(comment => comment.user?.login === workerLogin)
    .map(comment => ({ id: comment.id, receipt: parseReceipt(comment.body) }))
    .filter(entry => entry.receipt?.request_id === started.request_id &&
      entry.receipt?.attempt_id === started.attempt_id &&
      entry.receipt?.source_sha === started.source_sha &&
      entry.receipt?.kind === started.kind)
    .sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  if (entries.some(entry => !Number.isSafeInteger(entry.id) || entry.id < 1)) return null;
  const last = entries.at(-1)?.receipt;
  return resolvedAttemptStates.has(last?.state) ? last.state : null;
}
function candidatePullRequestSourceStatus(job, pull) {
  const repositoryName = REPO.toLowerCase();
  const observedSha = SHA.test(pull?.head?.sha || '') ? pull.head.sha.toLowerCase() : null;
  const mergedSource = pull?.state === 'closed' && pull.merged === true &&
    typeof pull.merged_at === 'string' && pull.merged_at.length > 0 &&
    SHA.test(pull.merge_commit_sha || '');
  let reason = null;
  if (!([5, 6].includes(job?.schema) && Number.isSafeInteger(job?.source_pr)))
    reason = 'JOB_SOURCE_BINDING_INVALID';
  else if (!pull || typeof pull !== 'object') reason = 'PR_READBACK_INVALID';
  else if (pull.number !== job.source_pr) reason = 'PR_NUMBER_MISMATCH';
  // A queued task may survive until its exact source PR is merged. Permit that
  // immutable source only when GitHub supplies closed-merge evidence; closed,
  // unmerged PRs remain ineligible.
  else if (pull.state !== 'open' && !mergedSource) reason = 'PR_NOT_OPEN';
  else if (pull.base?.ref !== 'main') reason = 'BASE_NOT_MAIN';
  else if (pull.base?.repo?.id !== OFFICIAL_REPOSITORY_ID) reason = 'BASE_REPOSITORY_ID_MISMATCH';
  else if (pull.head?.repo?.id !== OFFICIAL_REPOSITORY_ID) reason = 'HEAD_REPOSITORY_ID_MISMATCH';
  else if (typeof pull.base.repo.full_name !== 'string' ||
      pull.base.repo.full_name.toLowerCase() !== repositoryName)
    reason = 'BASE_REPOSITORY_NAME_MISMATCH';
  else if (typeof pull.head.repo.full_name !== 'string' ||
      pull.head.repo.full_name.toLowerCase() !== repositoryName)
    reason = 'HEAD_REPOSITORY_NAME_MISMATCH';
  else if (!observedSha) reason = 'HEAD_SHA_INVALID';
  return { eligible: reason === null, reason, sha: reason === null ? observedSha : null, observedSha };
}
function candidatePullRequestHeadSha(job, pull) {
  return candidatePullRequestSourceStatus(job, pull).sha;
}
function staleCandidateSourceEntries(comments, dispatchers, workerLogin, host, candidateSourceShas) {
  const jobs = new Map();
  const receipts = new Map();
  for (const comment of comments) {
    const login = comment.user?.login;
    const job = dispatchers.includes(login) ? parseJob(comment.body) : null;
    if (job?.schema === 6 && job.host.toUpperCase() === host.toUpperCase() &&
        Number.isSafeInteger(job.source_pr)) {
      if (!jobs.has(job.request_id)) jobs.set(job.request_id,
        { job, body: comment.body, id: comment.id, duplicate: false });
      else if (jobs.get(job.request_id).body !== comment.body) jobs.get(job.request_id).duplicate = true;
    }
    if (receiptMayBlockReplay(login, workerLogin, dispatchers)) {
      const receipt = parseReceipt(comment.body);
      if (receipt) {
        if (!receipts.has(receipt.request_id)) receipts.set(receipt.request_id, []);
        receipts.get(receipt.request_id).push({ id: comment.id, receipt });
      }
    }
  }
  const stale = [];
  for (const { job, id, duplicate } of jobs.values()) {
    if (duplicate) continue;
    const prior = (receipts.get(job.request_id) || []).filter(entry =>
      entry.receipt.host.toUpperCase() === job.host.toUpperCase() &&
      entry.receipt.source_sha.toLowerCase() === job.source_sha.toLowerCase() &&
      entry.receipt.kind === job.kind);
    if (hasBlockingRequestReceipt(prior)) continue;
    const observedSha = candidateSourceShas.get(job.source_pr);
    if (SHA.test(observedSha || '') && observedSha.toLowerCase() !== job.source_sha.toLowerCase())
      stale.push({ id, request_id: job.request_id, source_pr: job.source_pr,
        expected_sha: job.source_sha.toLowerCase(), observed_sha: observedSha.toLowerCase() });
  }
  return stale.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
}
function candidateGoalCommentMatches(job, comment, dispatchers) {
  return job?.schema === 6 && comment?.id === job.goal_comment_id &&
    comment?.issue_url === `https://api.github.com/repos/${REPO}/issues/${V53_GOAL_ISSUE}` &&
    typeof comment.user?.login === 'string' && dispatchers.includes(comment.user.login) &&
    humanGoalMarkerMatches(comment.body) &&
    digest(Buffer.from(comment.body, 'utf8')) === job.goal_body_sha256;
}
function latestTrustedHumanGoal(comments, dispatchers) {
  return comments.filter(comment => comment?.issue_url ===
      `https://api.github.com/repos/${REPO}/issues/${V53_GOAL_ISSUE}` &&
    Number.isSafeInteger(comment.id) && comment.id > 0 &&
    typeof comment.user?.login === 'string' && dispatchers.includes(comment.user.login) &&
    humanGoalMarkerMatches(comment.body))
    .sort((a, b) => a.id - b.id).at(-1) ?? null;
}
function humanGoalMarkerMatches(body) {
  if (typeof body !== 'string' || body.length > MAX_GITHUB_ISSUE_COMMENT_BODY_LENGTH) return false;
  return body.split(/\r?\n/).some(line => {
    const value = line.trim().replace(/^<!--\s*|\s*-->$/g, '').trim();
    return V53_GOAL_MARKER.test(value);
  });
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
function codexGoalPolicyFailure(policy) {
  if (!policy || typeof policy !== 'object') return 'HUMAN_GOAL_CODEX_POLICY_NOT_CONFIGURED';
  if (policy.enabled !== true) return policy.enabled === false
    ? 'HUMAN_GOAL_CODEX_POLICY_DISABLED' : 'HUMAN_GOAL_CODEX_POLICY_INVALID';
  if (typeof policy.model !== 'string' || !policy.model ||
      typeof policy.reasoning_effort !== 'string' || !policy.reasoning_effort ||
      !Array.isArray(policy.write_paths) || policy.write_paths.length === 0)
    return 'HUMAN_GOAL_CODEX_POLICY_INVALID';
  return null;
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
    if (receiptMayBlockReplay(login, workerLogin, dispatchers)) {
      const receipt = parseReceipt(comment.body);
      if (receipt) {
        if (!receipts.has(receipt.request_id)) receipts.set(receipt.request_id, []);
        receipts.get(receipt.request_id).push({ id: comment.id, receipt });
      }
    }
  }
  const sourceShas = new Map();
  const pendingGoals = [...jobs.values()].filter(({ job, duplicate }) => {
    if (duplicate || blockedKinds.includes(job.kind)) return false;
    const prior = (receipts.get(job.request_id) || []).filter(entry =>
      entry.receipt.host.toUpperCase() === job.host.toUpperCase() &&
      entry.receipt.source_sha.toLowerCase() === job.source_sha.toLowerCase() &&
      entry.receipt.kind === job.kind);
    return !hasBlockingRequestReceipt(prior);
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
    const prior = (receipts.get(job.request_id) || []).filter(entry =>
      entry.receipt.host.toUpperCase() === job.host.toUpperCase() &&
      entry.receipt.source_sha.toLowerCase() === job.source_sha.toLowerCase() &&
      entry.receipt.kind === job.kind);
    if (hasBlockingRequestReceipt(prior)) continue;
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
    const pull = pullReadbacks.get(job.source_pr);
    if (pull === null || pull === undefined) continue;
    const sourceStatus = candidatePullRequestSourceStatus(job, pull);
    if (sourceStatus.eligible) sourceShas.set(job.source_pr, sourceStatus.sha);
    else log(`CANDIDATE_SOURCE_NOT_DISPATCHABLE_${job.request_id}_PR_${job.source_pr}_` +
      `REASON_${sourceStatus.reason}_EXPECTED_SHA_${job.source_sha.toLowerCase()}_` +
      `OBSERVED_SHA_${sourceStatus.observedSha || 'UNKNOWN'}_NO_DISPATCH`);
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
    if (r && receiptMayBlockReplay(login, workerLogin, dispatchers)) {
      if (!receipts.has(r.request_id)) receipts.set(r.request_id, []);
      receipts.get(r.request_id).push({ id: c.id, receipt: r });
    }
  }
  for (const [, v] of jobs) {
    // Schema-2 plans remain parseable for historical receipt recovery, but
    // new read-only model tasks are no longer part of the executable path.
    if (v.job.kind === 'opencode_plan') continue;
    // Candidate work must bind to a byte-verified Human GOAL comment. Schema 5
    // remains parseable for historical receipts, but is no longer dispatched.
    if (v.job.source_pr !== undefined && v.job.schema !== 6) continue;
    const r = (receipts.get(v.job.request_id) || []).filter(entry =>
      entry.receipt.host.toUpperCase() === v.job.host.toUpperCase() &&
      entry.receipt.kind === v.job.kind &&
      (v.job.schema === 4 || entry.receipt.source_sha === v.job.source_sha));
    if (v.duplicate || blockedKinds.includes(v.job.kind) || hasBlockingRequestReceipt(r)) continue;
    // A stale unsigned/unclaimed job must not starve a newer exact-main task.
    if (v.job.source_pr !== undefined) {
      if (candidateSourceShas.get(v.job.source_pr)?.toLowerCase() !== v.job.source_sha.toLowerCase()) continue;
    } else if (liveMainSha !== null && v.job.source_sha !== liveMainSha) continue;
    if (isEditExecutionKind(v.job.kind) && [...jobs.values()].some(owner =>
      owner.job.request_id !== v.job.request_id && isEditExecutionKind(owner.job.kind) &&
      editPathsOverlap(v.job.edit_paths, owner.job.edit_paths) &&
      unresolvedEditAttempt(owner.job, receipts.get(owner.job.request_id) || [], {
        allowIsolatedW2ScopedDiff: v.job.kind === 'antigravity_edit' &&
          owner.job.kind === 'antigravity_edit',
      }))) continue;
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
function capturedDiffReceiptSummary(receipt) {
  if (!receipt || !['FINISHED', 'BLOCKED'].includes(receipt.state) ||
      receipt.coding_state !== 'DIFF_CAPTURED_UNVERIFIED' || receipt.scope_valid !== true ||
      !/^[a-f0-9]{64}$/i.test(receipt.diff_sha256 || '') ||
      !Number.isSafeInteger(receipt.diff_bytes) || receipt.diff_bytes < 1 ||
      !/^[a-f0-9]{64}$/i.test(receipt.changed_files_sha256 || '') ||
      !Number.isSafeInteger(receipt.changed_files_count) || receipt.changed_files_count < 1)
    return null;
  return {
    coding_state: 'DIFF_CAPTURED_UNVERIFIED',
    diff_sha256: receipt.diff_sha256.toLowerCase(),
    diff_bytes: receipt.diff_bytes,
    changed_files_sha256: receipt.changed_files_sha256.toLowerCase(),
    changed_files_count: receipt.changed_files_count,
    scope_valid: true,
  };
}
function latestOperatorJob(comments, config, workerLogin, mainSha, candidateSourceShas = new Map(),
  allowedKinds = null) {
  const allJobs = comments.filter(c => config.dispatchers.includes(c.user?.login))
    .map(c => ({ id: c.id, body: c.body, job: parseJob(c.body) }))
    .filter(x => x.job && x.job.host.toUpperCase() === config.host.toUpperCase())
    .sort((a, b) => a.id - b.id);
  const jobs = allowedKinds ? allJobs.filter(x => allowedKinds.has(x.job.kind)) : allJobs;
  if (!jobs.length) return null;
  const selected = jobs.at(-1);
  const job = selected.job;
  const duplicate = allJobs.filter(entry => entry.job.request_id === job.request_id);
  if (new Set(duplicate.map(entry => entry.body)).size > 1) {
    return { request_id: job.request_id, attempt_id: null, kind: job.kind,
      source_sha: job.source_sha, job_comment_id: selected.id,
      state: 'AMBIGUOUS_DUPLICATE' };
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
  else if (last?.state === 'WAITING') state = 'WAITING_ELIGIBILITY';
  else if (last?.state === 'FINISHED') state = 'FINISHED_NOT_ACCEPTANCE';
  else if (last?.state === 'BLOCKED') state = 'BLOCKED';
  else if (!candidateHeadKnown) state = 'SOURCE_UNKNOWN';
  else if (!sourceCurrent) state = 'STALE_SOURCE';
  const capturedDiff = capturedDiffReceiptSummary(last);
  return { request_id: job.request_id, attempt_id: attemptId, kind: job.kind,
    job_comment_id: selected.id,
    source_sha: job.source_sha, ...(job.source_pr !== undefined ? { source_pr: job.source_pr } : {}), state,
    outcome: typeof last?.outcome === 'string' && /^[A-Z0-9_-]{1,80}$/.test(last.outcome)
      ? last.outcome : 'UNKNOWN',
    exit_code: Number.isSafeInteger(last?.exit_code) ? last.exit_code : null,
    ...(capturedDiff || {}) };
}
function observationWorkerRecords(comments, config, workerLogin, mainSha, candidateSourceShas,
  preflightBlockers = new Map()) {
  const records = [];
  for (const [workerId, kinds] of [
    ['W1', new Set(['opencode_edit'])],
    ['W2', new Set(['antigravity_edit'])],
  ]) {
    const modelSetting = workerId === 'W1'
      ? config.enable_v2_model_runs : config.enable_antigravity_model_runs;
    const modelExecutionSwitch = typeof modelSetting === 'boolean'
      ? (modelSetting ? 'ENABLED' : 'DISABLED') : 'UNKNOWN';
    const task = latestOperatorJob(comments, config, workerLogin, mainSha,
      candidateSourceShas, kinds);
    if (!task) {
      records.push({ worker_id: workerId, status: 'UNKNOWN',
        blocker_code: workerId === 'W1' ? 'NO_AUTHORIZED_W1_JOB' : 'NO_CURRENT_W2_TASK',
        model_eligibility: 'UNKNOWN', model_execution_switch: modelExecutionSwitch,
        next_owner: '等待精確、受信任的正式任務來源' });
      continue;
    }
    const status = ['QUEUED_NOT_STARTED', 'STARTED_UNVERIFIED', 'WAITING_ELIGIBILITY']
      .includes(task.state) ? 'PENDING'
      : ['BLOCKED', 'STALE_SOURCE', 'AMBIGUOUS_DUPLICATE'].includes(task.state) ? 'BLOCKED' : 'UNKNOWN';
    // A valid queued W2 task is effect-free, but the current global model gate
    // is enough to explain why it has no STARTED receipt. Keep it PENDING and
    // scoped to W2; do not turn this lane denial into a factory-wide stop.
    const queueWaitsForModelGate = workerId === 'W2' && task.state === 'QUEUED_NOT_STARTED' &&
      config.enable_antigravity_model_runs === false;
    const blocker = task.state === 'STALE_SOURCE' ? 'STALE_CANDIDATE_SOURCE'
      : task.state === 'SOURCE_UNKNOWN' ? 'CANDIDATE_PR_READBACK_UNKNOWN'
        : task.state === 'AMBIGUOUS_DUPLICATE' ? 'DUPLICATE_TASK_REQUEST_AMBIGUOUS'
          : task.state === 'STARTED_UNVERIFIED' ? 'STARTED_WITHOUT_VERIFIED_MODEL_ACTIVITY'
            : task.state === 'WAITING_ELIGIBILITY' || task.state === 'BLOCKED'
              ? task.outcome : queueWaitsForModelGate
                ? 'ANTIGRAVITY_MODEL_RUNS_NOT_ENABLED'
                : preflightBlockers.get(task.request_id);
    const taskSource = `Issue #310 comment ${task.job_comment_id}` +
      (task.source_pr ? `; PR #${task.source_pr}@${task.source_sha}` : `; main@${task.source_sha}`);
    const hasCapturedDiff = task.coding_state === 'DIFF_CAPTURED_UNVERIFIED';
    records.push({ worker_id: workerId, status, task_id: task.request_id,
      task_kind: task.kind, task_source: taskSource, task_source_sha: task.source_sha,
      task_comment_id: task.job_comment_id, ...(task.source_pr ? { source_pr: task.source_pr } : {}),
      ...(task.attempt_id ? { attempt_id: task.attempt_id } : {}), task_state: task.state,
      model_execution_switch: modelExecutionSwitch,
      model_eligibility: task.state === 'WAITING_ELIGIBILITY' || queueWaitsForModelGate ||
        preflightBlockers.has(task.request_id)
        ? 'WAITING' : 'UNKNOWN',
      code_changes: hasCapturedDiff ? 'DIFF_CAPTURED_UNVERIFIED' : 'UNPROVEN',
      files_modified: hasCapturedDiff ? 'COUNT_REPORTED_UNVERIFIED' : 'UNPROVEN',
      ...(hasCapturedDiff ? { coding_state: task.coding_state,
        diff_sha256: task.diff_sha256, diff_bytes: task.diff_bytes,
        changed_files_sha256: task.changed_files_sha256,
        changed_files_count: task.changed_files_count,
        scope_valid: task.scope_valid } : {}),
      ...(task.state === 'FINISHED_NOT_ACCEPTANCE'
        ? { delivery_status: 'FINISHED_UNVERIFIED' }
        : task.state === 'BLOCKED' && hasCapturedDiff
          ? { delivery_status: 'BLOCKED_DIFF_CAPTURED_UNVERIFIED' } : {}),
      ...(blocker ? { blocker_code: blocker } : {}),
      evidence_ref: task.job_comment_id
        ? `https://github.com/${REPO}/issues/310#issuecomment-${task.job_comment_id}` : undefined,
      next_owner: task.state === 'STALE_SOURCE' ? 'Codex：核對新來源後再評估，不重播舊任務'
        : task.state === 'FINISHED_NOT_ACCEPTANCE' ? 'Codex：驗證交付證據與語意結果'
          : task.state === 'WAITING_ELIGIBILITY' ? '重新檢查資格；不自動重播未知效果'
            : queueWaitsForModelGate ? 'W2 Worker：資格恢復後重新評估；不建立重複任務'
              : preflightBlockers.has(task.request_id) ? 'Codex：修復並讀回原生派工阻擋'
            : 'Codex：核對此任務的即時執行證據' });
  }
  records.push({ worker_id: 'W3', status: 'UNKNOWN',
    blocker_code: 'W3_ZERO_RISK_HANDOFF_NOT_IN_NATIVE_SNAPSHOT',
    model_eligibility: 'UNKNOWN', next_owner: 'Codex 建立有效請求；Human 手動轉送 Zero Risk' });
  return records;
}
function operatorPublisherError(code, identity) {
  const error = new Error(code);
  error.operator_identity = identity;
  return error;
}
function operatorRequestFailureCode(stage, error) {
  const status = [error?.status, error?.statusCode, error?.response?.status]
    .find(value => Number.isSafeInteger(value) && value >= 400 && value <= 599);
  if (status) return `OPERATOR_COMMENT_${stage}_HTTP_${status}`;
  const text = [error?.stderr, error?.message]
    .map(value => Buffer.isBuffer(value) ? value.toString('utf8') : String(value || ''))
    .join('\n');
  const match = text.match(/\b(?:HTTP(?:\s+status)?|status(?:\s+code)?)\s*[:=]?\s*([45]\d{2})\b/i);
  if (match) return `OPERATOR_COMMENT_${stage}_HTTP_${match[1]}`;
  const systemCode = safeErrorCode(error, 'UNKNOWN');
  return systemCode !== 'UNKNOWN'
    ? `OPERATOR_COMMENT_${stage}_${systemCode}`
    : `OPERATOR_COMMENT_${stage}_FAILED`;
}
function operatorPublisherStageError(stage, error, identity) {
  const causeCode = safeErrorCode(error, 'UNKNOWN');
  return operatorPublisherError('OPERATOR_OBSERVATION_' + stage + '_' + causeCode, identity);
}
function operatorPublisherStageValue(stage, read, identity) {
  try { return read(); }
  catch (error) { throw operatorPublisherStageError(stage, error, identity); }
}
export async function publishOperatorObservation(config, workerLogin, comments, mainSha,
  dependencies = {}, candidateSourceShas = new Map(), issueCommentsCount = null,
  preflightBlockers = new Map()) {
  const marked = comments.filter(c =>
    typeof c?.body === 'string' && c.body.startsWith('PTYSD_OPERATOR_OBSERVATION_V1\n'));
  if (!marked.length) return { status: 'NOT_SEEDED' };
  const existing = marked[0];
  const commentAuthorLogin = existing.user?.login;
  const publisherIdentity = { publisher_login: workerLogin,
    comment_author_login: commentAuthorLogin };
  const now = operatorPublisherStageValue('CLOCK_READBACK',
    () => dependencies.now ? dependencies.now() : new Date(), publisherIdentity);
  const observedAt = operatorPublisherStageValue('CLOCK_SERIALIZATION',
    () => now.toISOString(), publisherIdentity);
  const windows = operatorPublisherStageValue('WINDOWS_READBACK',
    () => (dependencies.collectWindowsObservation || collectWindowsObservation)(), publisherIdentity);
  const runtimeDeployment = operatorPublisherStageValue('RUNTIME_MANIFEST',
    () => dependencies.collectRuntimeDeployment
      ? dependencies.collectRuntimeDeployment()
      : collectRuntimeDeployment({ now: () => observedAt }), publisherIdentity);
  const prior = findOperatorComment(comments, commentAuthorLogin, OPERATOR_COMMENT_ID);
  if (prior.status !== 'OK')
    throw operatorPublisherError(prior.error || 'OPERATOR_COMMENT_UNKNOWN', publisherIdentity);
  if (prior.comment.id !== existing.id || prior.observation.source?.comment_id !== existing.id)
    throw operatorPublisherError('OPERATOR_COMMENT_ID_MISMATCH', publisherIdentity);
  if (workerLogin !== commentAuthorLogin && !config.dispatchers.includes(workerLogin))
    throw operatorPublisherError('OPERATOR_PUBLISHER_IDENTITY_NOT_AUTHORIZED', publisherIdentity);
  let repositoryRunner = { status: 'UNKNOWN', count: null, observed_at: observedAt };
  try {
    const response = await (dependencies.readRunnerRegistration
      ? dependencies.readRunnerRegistration()
      : api('repos/' + OPERATOR_REPO + '/actions/runners?per_page=100'));
    if (Number.isSafeInteger(response.total_count) && response.total_count >= 0)
      repositoryRunner = { status: 'FRESH', count: response.total_count, observed_at: observedAt };
  } catch {}
  const latestTask = operatorPublisherStageValue('TASK_READ',
    () => latestOperatorJob(comments, config, workerLogin, mainSha, candidateSourceShas), publisherIdentity);
  const activeTask = latestTask &&
    ['QUEUED_NOT_STARTED', 'STARTED_UNVERIFIED'].includes(latestTask.state)
    ? latestTask : null;
  const nextOwner = operatorPublisherStageValue('NEXT_OWNER', () => (
    windows.status !== 'FRESH' ? 'OS_OBSERVATION_UNKNOWN'
    : windows.native_task.enabled === false ? 'NATIVE_SCHEDULER_REPAIR'
      : activeTask && preflightBlockers.has(activeTask.request_id) ? 'CODEX_REPAIR_NATIVE_PREFLIGHT'
        : activeTask?.state === 'QUEUED_NOT_STARTED' ? 'NATIVE_WORKER'
        : activeTask?.state === 'STARTED_UNVERIFIED' ? 'VERIFY_ACTIVE_WORK'
          : ['SOURCE_UNKNOWN', 'STALE_SOURCE'].includes(latestTask?.state)
            ? 'VERIFY_CANDIDATE_SOURCE'
            : latestTask?.state === 'BLOCKED' ? 'REVIEW_BLOCKER' : 'NO_CURRENT_TASK'), publisherIdentity);
  const snapshot = operatorPublisherStageValue('SNAPSHOT_BUILD', () => ({
    schema: 1, project_id: OPERATOR_PROJECT, repo: OPERATOR_REPO, issue: OPERATOR_ISSUE,
    host_alias: 'win11-primary', snapshot_id: randomUUID(),
    publisher_login: workerLogin,
    comment_author_login: commentAuthorLogin,
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
    runtime_deployment: runtimeDeployment,
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
    workers: operatorPublisherStageValue('WORKER_RECORDS',
      () => observationWorkerRecords(comments, config, workerLogin, mainSha, candidateSourceShas,
        preflightBlockers),
      publisherIdentity),
    github: {
      observed_at: observedAt, main_sha: mainSha,
      issue_comments_count: Number.isSafeInteger(issueCommentsCount) && issueCommentsCount >= 0
        ? issueCommentsCount : null,
      runner_registration: repositoryRunner,
      organization_runner_registration: 'UNKNOWN_ORG_SCOPE_NOT_AVAILABLE',
      runner_service_count: windows.runner_service_count,
      runner_service_running: windows.runner_service_running,
    },
    monitor_candidate: null,
    incident: null,
  }), publisherIdentity);
  const body = operatorPublisherStageValue('SNAPSHOT_VALIDATION',
    () => encodeOperatorObservation(snapshot), publisherIdentity);
  const readComment = dependencies.readComment ||
    (id => api('repos/' + OPERATOR_REPO + '/issues/comments/' + id));
  const readComments = dependencies.readComments || (() => issueComments(config));
  try {
    const result = await updateExistingOperatorComment({
      comments, expectedLogin: commentAuthorLogin, expectedCommentId: OPERATOR_COMMENT_ID, body,
      readComment: async id => {
        try { return await readComment(id); }
        catch (error) {
          throw operatorPublisherError(operatorRequestFailureCode('PREWRITE_READ', error), publisherIdentity);
        }
      },
      patchComment: async (id, nextBody) => {
        try {
          if (dependencies.patchComment) return await dependencies.patchComment(id, nextBody);
          const uri = 'repos/' + OPERATOR_REPO + '/issues/comments/' + id;
          const temp = join(config.state_dir, 'operator-observation-' + randomUUID() + '.json');
          writeFileSync(temp, JSON.stringify({ body: nextBody }),
            { encoding: 'utf8', flag: 'wx', mode: 0o600 });
          try { gh(['api', uri, '--method', 'PATCH', '--input', temp]); }
          finally { rmSync(temp, { force: true }); }
        } catch (error) {
          throw operatorPublisherError(operatorRequestFailureCode('PATCH', error), publisherIdentity);
        }
      },
      readComments,
      readCommentsFailureCode: error => operatorRequestFailureCode('UPDATE_READBACK', error),
      now: dependencies.now || Date.now,
    });
    return { ...result, publisher_identity: publisherIdentity };
  } catch (error) {
    const wrapped = new Error(error?.message || 'OPERATOR_COMMENT_UPDATE_FAILED');
    if (error?.code) wrapped.code = error.code;
    wrapped.operator_identity = publisherIdentity;
    throw wrapped;
  }
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
function persistOperatorObservationDiagnostic(config, status, sourceSha, error, publisherIdentity = null) {
  const path = join(config.state_dir, 'operator-observation-last-error.json');
  if (status === 'UPDATED') {
    try { rmSync(path, { force: true }); } catch { /* diagnostics never change publication status */ }
    return null;
  }
  const diagnosticStatus = status === 'NOT_SEEDED' ? 'NOT_SEEDED' : 'UNKNOWN';
  const fallback = diagnosticStatus === 'NOT_SEEDED'
    ? 'OPERATOR_OBSERVATION_NOT_SEEDED' : 'OPERATOR_OBSERVATION_UPDATE_UNKNOWN';
  const safeError = typeof error === 'string' ? { code: error } : error;
  const errorCode = safeErrorCode(safeError, fallback);
  const diagnostic = {
    schema: 1,
    status: diagnosticStatus,
    observed_at: new Date().toISOString(),
    source_sha: SHA.test(sourceSha || '') ? sourceSha.toLowerCase() : null,
    error_code: errorCode,
  };
  if (publisherIdentity && typeof publisherIdentity === 'object') {
    const safeLogin = value => typeof value === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(value)
      ? value : undefined;
    const publisher = safeLogin(publisherIdentity.publisher_login);
    const author = safeLogin(publisherIdentity.comment_author_login);
    if (publisher || author) diagnostic.publisher_identity = {
      ...(publisher ? { publisher_login: publisher } : {}),
      ...(author ? { comment_author_login: author } : {}),
    };
  }
  atomicJSON(path, diagnostic);
  return errorCode;
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
      !variants.every(v => validConfiguredModel(model, v))) throw new Error('MODEL_ALLOWLIST_INVALID');
    }
  }
  // A public model catalog is not a price or terms receipt. This local-only
  // allowlist is explicit operator authorization and cannot be supplied by a job.
  if (c.unauthenticated_free_models !== undefined) {
    const models = c.unauthenticated_free_models;
    if (!Array.isArray(models) || new Set(models).size !== models.length || models.some(model =>
      typeof model !== 'string' || model.split('/')[0]?.toLowerCase() !== 'opencode' ||
      !validConfiguredModel(model, null) || !c.allowed_models?.[model]?.includes(null)))
      throw new Error('UNAUTHENTICATED_FREE_MODEL_ALLOWLIST_INVALID');
  }
  if (c.enable_v2_model_runs !== undefined && typeof c.enable_v2_model_runs !== 'boolean')
    throw new Error('V2_MODEL_ENABLE_FLAG_INVALID');
  if (c.enable_antigravity_model_runs !== undefined && typeof c.enable_antigravity_model_runs !== 'boolean')
    throw new Error('ANTIGRAVITY_MODEL_ENABLE_FLAG_INVALID');
  if (c.antigravity_cli_project_id !== undefined &&
      (typeof c.antigravity_cli_project_id !== 'string' ||
       !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(c.antigravity_cli_project_id)))
    throw new Error('ANTIGRAVITY_CLI_PROJECT_ID_INVALID');
  validateExecutorRouting(c);
  mkdirSync(c.state_dir, { recursive: true });
  return c;
}
// Never put public paths, environment variables or provider credentials in a receipt.
function localEvidence(config, requestId, value) {
  const file = join(config.state_dir, `native-evidence-${requestId}-${randomUUID()}.json`);
  writeFileSync(file, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
  const bytes = readFileSync(file);
  return { evidence_sha256: digest(bytes), evidence_bytes: bytes.length };
}
export function checkModelAuthorization(job, config) {
  const validOpenCodeJob = job?.schema === 2 && job.kind === 'opencode_plan' ||
    [4, 5, 6].includes(job?.schema) && job.kind === 'opencode_edit' && validEditPaths(job.edit_paths) &&
      ([5, 6].includes(job.schema) ? Number.isSafeInteger(job.source_pr) && job.source_pr > 0 : true) &&
      (job.schema !== 6 || Number.isSafeInteger(job.goal_comment_id) && job.goal_comment_id > 0 &&
        HASH.test(job.goal_body_sha256 || ''));
  const validAntigravityJob = job?.schema === 6 && job.kind === 'antigravity_edit' &&
    validEditPaths(job.edit_paths) && Number.isSafeInteger(job.source_pr) && job.source_pr > 0 &&
    Number.isSafeInteger(job.goal_comment_id) && job.goal_comment_id > 0 &&
    HASH.test(job.goal_body_sha256 || '') && validJobModel(job);
  if (!validOpenCodeJob && !validAntigravityJob) return false;
  const variants = config.allowed_models?.[job.model];
  return Array.isArray(variants) && variants.includes(job.variant);
}
function hasExplicitUnauthenticatedFreeModelAuthorization(job, config) {
  return typeof job?.model === 'string' && job.model.split('/')[0]?.toLowerCase() === 'opencode' &&
    Array.isArray(config?.unauthenticated_free_models) &&
    config.unauthenticated_free_models.includes(job.model) &&
    Array.isArray(config.allowed_models?.[job.model]) &&
    config.allowed_models[job.model].includes(job.variant);
}
export function antigravityExecutionAuthorization(job, config, now = Date.now()) {
  if (job?.kind !== 'antigravity_edit' || job.schema !== 6 || !validJobModel(job))
    return 'ANTIGRAVITY_JOB_IDENTITY_INVALID';
  if (config.enable_antigravity_model_runs !== true)
    return 'ANTIGRAVITY_MODEL_RUNS_NOT_ENABLED';
  if (config.antigravity_cli_project_id !== undefined &&
      (typeof config.antigravity_cli_project_id !== 'string' ||
       !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(config.antigravity_cli_project_id)))
    return 'ANTIGRAVITY_PROJECT_SCOPE_UNVERIFIED';
  const attestation = config.antigravity_execution_attestation;
  if (!attestation || attestation.model !== ANTIGRAVITY_V2_MODEL ||
      attestation.entitlement !== 'VERIFIED' ||
      attestation.cost !== 'NO_ADDITIONAL_CHARGE')
    return 'ANTIGRAVITY_EXECUTION_ATTESTATION_UNKNOWN';
  const observedAt = Date.parse(attestation.observed_at);
  // This is a durable Human policy grant, not a five-minute login/quota lease.
  // Current CLI auth, model catalog and quota are re-read by readiness before
  // each dispatch; reject malformed or future-dated policy evidence only.
  if (!Number.isFinite(observedAt) || observedAt > now + 30_000)
    return 'ANTIGRAVITY_EXECUTION_ATTESTATION_UNKNOWN';
  return null;
}
export function buildOpenCodeChildEnv(sourceEnv = process.env, hostPlatform = platform()) {
  // Preserve the signed-in profile paths, but derive authorization from the
  // exact job/profile readback; ambient provider/Publisher credentials and
  // Node injection cannot change billing, auth, or child execution policy.
  const childEnv = buildNativeChildEnvironment(sourceEnv, hostPlatform);
  childEnv.OPENCODE_DISABLE_AUTOUPDATE = 'true';
  return childEnv;
}
async function captureGitStdout(workspace, stateDir, requestId, attemptId, label, args,
  keepStdout = false, readProcessTree, platformName = platform()) {
  const stem = `edit-git-${label}-${requestId}-${attemptId}`;
  const stdoutPath = join(stateDir, `${stem}.stdout.bin`);
  const stderrPath = join(stateDir, `${stem}.stderr.bin`);
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_EXTERNAL_DIFF', 'GIT_PAGER']) delete env[key];
  const result = await runCapturedProcess('git', ['-C', workspace, ...args], {
    cwd: workspace, env, stdoutPath, stderrPath, terminate: terminateProcessTree, platformName,
    ...(typeof readProcessTree === 'function' ? { readProcessTree } : {}),
  });
  const evidence = result.local_evidence || {};
  const terminationFailure = {
    TERMINATION_CONFIRMED: 'TERMINATION_CONFIRMED',
    TERMINATION_REQUESTED: 'TERMINATION_REQUESTED',
    TERMINATION_UNCONFIRMED: 'TERMINATION_UNCONFIRMED',
    ORPHAN_POSSIBLE: 'ORPHAN_POSSIBLE',
  }[evidence.termination_state] ??
    (evidence.termination_state && evidence.termination_state !== 'NOT_REQUESTED'
      ? 'TERMINATION_STATE_UNKNOWN' : null);
  const failure = evidence.spawn_error ? 'SPAWN_FAILED' :
    evidence.capture_error ? 'CAPTURE_FAILED' :
      evidence.storage_error ? 'STORAGE_FAILED' :
        evidence.process_error ? 'PROCESS_FAILED' :
          evidence.stdin_error ? 'STDIN_FAILED' :
            result.exit_code !== 0 ? 'EXIT_NONZERO' : terminationFailure;
  if (failure) throw new Error(`EDIT_GIT_${label.toUpperCase()}_${failure}`);
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
function editPathPhysicalScope(workspace, editPaths) {
  let workspaceStat, physicalRoot;
  try {
    workspaceStat = lstatSync(workspace);
    if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink())
      return { status: 'UNKNOWN', failure: 'EDIT_WORKSPACE_NOT_PHYSICAL' };
    physicalRoot = realpathSync.native(workspace);
  } catch (error) {
    return { status: 'UNKNOWN', failure: `EDIT_PATH_PHYSICAL_ROOT_READBACK_${safeErrorCode(error)}` };
  }
  for (const editPath of editPaths) {
    let current = physicalRoot;
    for (const component of editPath.split('/')) {
      current = resolve(current, component);
      let componentStat;
      try { componentStat = lstatSync(current); }
      catch (error) {
        if (error?.code === 'ENOENT') break;
        return { status: 'UNKNOWN', failure:
          `EDIT_PATH_PHYSICAL_COMPONENT_READBACK_${safeErrorCode(error)}` };
      }
      let physicalComponent;
      try { physicalComponent = realpathSync.native(current); }
      catch (error) {
        return { status: 'UNKNOWN', failure:
          `EDIT_PATH_PHYSICAL_COMPONENT_READBACK_${safeErrorCode(error)}` };
      }
      const relativeComponent = relative(physicalRoot, physicalComponent);
      const firstRelativeComponent = relativeComponent.split(/[\\/]/, 1)[0];
      if (relativeComponent && (firstRelativeComponent === '..' || isAbsolute(relativeComponent)))
        return { status: 'ESCAPED', failure: 'EDIT_PATH_PHYSICAL_ROOT_ESCAPE' };
      if (componentStat.isSymbolicLink() && !relativeComponent)
        return { status: 'UNKNOWN', failure: 'EDIT_PATH_PHYSICAL_ALIAS_AMBIGUOUS' };
    }
  }
  return { status: 'PASS', failure: null };
}
function assertEditPathsPhysicallyScoped(workspace, editPaths) {
  const result = editPathPhysicalScope(workspace, editPaths);
  if (result.status !== 'PASS') {
    const error = new Error(result.failure);
    error.code = result.failure;
    throw error;
  }
}
async function assertEditWorkspaceReady(config, job, attemptId, readProcessTree, platformName = platform()) {
  const head = await captureGitStdout(config.workspace, config.state_dir, job.request_id,
    attemptId, 'head', ['rev-parse', 'HEAD'], false, readProcessTree, platformName);
  if (head.output.toString('utf8').trim().toLowerCase() !== job.source_sha.toLowerCase())
    throw new Error('EDIT_WORKSPACE_SOURCE_SHA_MISMATCH');
  assertEditPathsPhysicallyScoped(config.workspace, job.edit_paths);
  const status = await captureGitStdout(config.workspace, config.state_dir, job.request_id,
    attemptId, 'before', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'],
    false, readProcessTree, platformName);
  if (status.output.length !== 0) throw new Error('EDIT_WORKSPACE_NOT_CLEAN');
}
async function captureAntigravityProjectRootSnapshot(config, job, attemptId, label,
  readProcessTree, platformName = platform()) {
  const root = config.antigravity_project_root;
  const headBefore = await captureGitStdout(root, config.state_dir, job.request_id,
    attemptId, `${label}-head-before`, ['rev-parse', 'HEAD'], false, readProcessTree, platformName);
  const status = await captureGitStdout(root, config.state_dir, job.request_id,
    attemptId, `${label}-status`, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'],
    false, readProcessTree, platformName);
  const headAfter = await captureGitStdout(root, config.state_dir, job.request_id,
    attemptId, `${label}-head-after`, ['rev-parse', 'HEAD'], false, readProcessTree, platformName);
  const beforeSha = headBefore.output.toString('utf8').trim().toLowerCase();
  const afterSha = headAfter.output.toString('utf8').trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(beforeSha) || !/^[a-f0-9]{40}$/.test(afterSha) || beforeSha !== afterSha)
    throw new Error('EDIT_PROJECT_ROOT_HEAD_CHANGED_DURING_READ');
  return { head_sha: beforeSha, status_bytes: status.output,
    changes: parseGitStatusPaths(status.output) };
}
function projectRootStatusChanges(before, after) {
  const keyFor = change => process.platform === 'win32'
    ? change.path.replaceAll('\\', '/').toLowerCase()
    : change.path.replaceAll('\\', '/');
  const prior = new Map(before.changes.map(change => [keyFor(change), change]));
  const current = new Map(after.changes.map(change => [keyFor(change), change]));
  const keys = new Set([...prior.keys(), ...current.keys()]);
  return [...keys].filter(key => prior.get(key)?.status !== current.get(key)?.status)
    .map(key => current.get(key) ?? prior.get(key));
}
function antigravityProjectRootBindingFailure(config) {
  const projectRoot = config?.antigravity_project_root;
  const candidateRoot = config?.workspace;
  if (typeof projectRoot !== 'string' || !isAbsolute(projectRoot) ||
      typeof candidateRoot !== 'string' || !isAbsolute(candidateRoot))
    return 'ANTIGRAVITY_EDIT_PROJECT_ROOT_NOT_CONFIGURED';
  let projectStat, candidateStat, projectReal, candidateReal;
  try {
    projectStat = lstatSync(projectRoot);
    candidateStat = lstatSync(candidateRoot);
    if (!projectStat.isDirectory() || projectStat.isSymbolicLink() ||
        !candidateStat.isDirectory() || candidateStat.isSymbolicLink())
      return 'ANTIGRAVITY_EDIT_PROJECT_ROOT_NOT_PHYSICAL';
    projectReal = realpathSync.native(projectRoot);
    candidateReal = realpathSync.native(candidateRoot);
  } catch (error) {
    return `ANTIGRAVITY_EDIT_PROJECT_ROOT_READBACK_UNKNOWN_${safeErrorCode(error, 'UNKNOWN')}`;
  }
  const samePhysicalRoot = platform() === 'win32'
    ? projectReal.toLowerCase() === candidateReal.toLowerCase()
    : projectReal === candidateReal;
  return samePhysicalRoot ? 'ANTIGRAVITY_EDIT_PROJECT_ROOT_SAME_AS_CANDIDATE' : null;
}
export async function captureScopedEditDiff({ workspace, state_dir, job, attempt_id, readProcessTree,
  platformName = platform() }) {
  if (!workspace || !state_dir || !job || !isEditExecutionKind(job.kind) ||
      !validEditPaths(job.edit_paths) || !/^[a-f0-9-]{36}$/i.test(attempt_id || ''))
    throw new Error('EDIT_DIFF_CAPTURE_INPUT_INVALID');
  const physicalScope = editPathPhysicalScope(workspace, job.edit_paths);
  if (physicalScope.status !== 'PASS') return {
    file: null, sha256: null, bytes: null, changed_files: [], allowed_paths: job.edit_paths,
    scope_valid: false, physical_scope_status: physicalScope.status,
    physical_scope_failure: physicalScope.failure,
    diff_capture_status: 'NOT_CAPTURED_PHYSICAL_SCOPE_UNVERIFIED',
  };
  const head = await captureGitStdout(workspace, state_dir, job.request_id,
    attempt_id, 'after-head', ['rev-parse', 'HEAD'], false, readProcessTree, platformName);
  if (head.output.toString('utf8').trim().toLowerCase() !== job.source_sha.toLowerCase())
    throw new Error('EDIT_WORKSPACE_SOURCE_SHA_CHANGED');
  const status = await captureGitStdout(workspace, state_dir, job.request_id,
    attempt_id, 'after', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'],
    false, readProcessTree, platformName);
  const ignored = await captureGitStdout(workspace, state_dir, job.request_id,
    attempt_id, 'after-ignored', ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'],
    false, readProcessTree, platformName);
  const changesByPath = new Map(parseGitStatusPaths(status.output).map(change => [
    process.platform === 'win32' ? change.path.toLowerCase() : change.path, change,
  ]));
  for (const rawPath of ignored.output.toString('utf8').split('\0').filter(Boolean)) {
    const path = rawPath.replaceAll('\\', '/');
    const key = process.platform === 'win32' ? path.toLowerCase() : path;
    if (!changesByPath.has(key)) changesByPath.set(key, { status: '!!', path });
  }
  const changes = [...changesByPath.values()];
  const changedFiles = [...new Set(changes.map(change => change.path))].sort();
  const allowed = new Set(job.edit_paths.map(path => process.platform === 'win32' ? path.toLowerCase() : path));
  const scopeValid = changedFiles.every(path => allowed.has(
    process.platform === 'win32' ? path.toLowerCase() : path));
  const untracked = changes.filter(change => change.status === '??' || change.status === '!!')
    .map(change => change.path);
  if (scopeValid && untracked.length) {
    execFileSync('git', ['-C', workspace, 'add', '--intent-to-add', '--force', '--', ...untracked], {
      windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'],
    });
  }
  const diffPath = join(state_dir, `edit-diff-${job.request_id}-${attempt_id}.patch`);
  const diff = await captureGitStdout(workspace, state_dir, job.request_id, attempt_id,
    'diff', ['diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', 'HEAD'],
    true, readProcessTree, platformName);
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
async function runAntigravityEdit(spec, config, job, attemptId, dependencies = {}) {
  const wait = outcome => ({ outcome, exit_code: 48, evidence_sha256: null, evidence_bytes: 0,
    eligibility_state: 'WAITING', model_invoked: false });
  const projectRootFailure = antigravityProjectRootBindingFailure(config);
  if (projectRootFailure) return {
    outcome: projectRootFailure, exit_code: 46, evidence_sha256: null, evidence_bytes: 0,
    eligibility_state: 'BLOCKED', coding_state: 'NOT_STARTED', model_invoked: false,
    scope_valid: false, external_effects: 'NONE',
    local_evidence: { antigravity_project_root_check: {
      status: projectRootFailure.includes('READBACK_UNKNOWN') ? 'READBACK_UNKNOWN' : 'REJECTED',
      reason: projectRootFailure,
    } },
  };
  const authorizationFailure = antigravityExecutionAuthorization(job, config,
    typeof dependencies.now === 'function' ? dependencies.now() : Date.now());
  if (authorizationFailure) return wait(authorizationFailure);
  if (!checkModelAuthorization(job, config)) return wait('MODEL_NOT_EXPLICITLY_ALLOWED');

  const baseEnv = dependencies.baseEnv ?? process.env;
  const localAppData = dependencies.localAppData ?? baseEnv.LOCALAPPDATA;
  const cliPath = typeof localAppData === 'string' && isAbsolute(localAppData)
    ? join(localAppData, 'agy', 'bin', 'agy.exe') : '';
  let projectId = config.antigravity_cli_project_id;
  if (projectId === undefined || projectId === null) {
    const binding = (dependencies.resolveAntigravityProjectId ?? resolveAntigravityProjectId)(
      config.workspace, baseEnv);
    if (binding?.projectScopeEvidence !== 'PROJECT_WORKSPACE_MATCHED' ||
        typeof binding.projectId !== 'string') return wait('ANTIGRAVITY_PROJECT_SCOPE_UNVERIFIED');
    projectId = binding.projectId;
  }
  const readiness = (dependencies.runAntigravityV2Readiness ?? runAntigravityV2Readiness)(
    cliPath, config.workspace, dependencies.runAntigravityMetadata, baseEnv,
    dependencies.verifyAntigravitySignature, projectId,
    typeof config.antigravity_project_root === 'string'
      ? config.antigravity_project_root : config.workspace);
  const readinessFailure = antigravityV2ReadinessExecutionFailure(readiness);
  if (readinessFailure) return wait(readinessFailure);

  let cliBinarySha256;
  try { cliBinarySha256 = await sha256File(cliPath); }
  catch { return wait('ANTIGRAVITY_CLI_BINARY_HASH_UNAVAILABLE'); }

  try { await assertEditWorkspaceReady(config, job, attemptId, dependencies.readGitProcessTree); }
  catch (error) {
    return { outcome: `ANTIGRAVITY_EDIT_SOURCE_${safeErrorCode(error, 'UNKNOWN')}`,
      exit_code: 46, evidence_sha256: null, evidence_bytes: 0,
      eligibility_state: 'BLOCKED', model_invoked: false, coding_state: 'NOT_STARTED',
      scope_valid: false, external_effects: 'NONE' };
  }
  let projectRootBefore = null;
  if (typeof config.antigravity_project_root === 'string') {
    try {
      projectRootBefore = await captureAntigravityProjectRootSnapshot(config, job, attemptId,
        'project-root-before', dependencies.readGitProcessTree);
      if (projectRootBefore.changes.some(change =>
        editPathsOverlap([change.path], job.edit_paths)))
        throw new Error('EDIT_PROJECT_ROOT_DIRTY_SCOPE_CONFLICT');
    } catch (error) {
      return { outcome: `ANTIGRAVITY_EDIT_PROJECT_ROOT_${safeErrorCode(error, 'UNKNOWN')}`,
        exit_code: 46, evidence_sha256: null, evidence_bytes: 0,
        eligibility_state: 'BLOCKED', model_invoked: false, coding_state: 'NOT_STARTED' };
    }
  }

  const scopedAbsolutePaths = job.edit_paths.map(path => resolve(config.workspace, path));
  const prompt = `${spec}\n\nThe only writable files are these exact absolute paths inside this attempt workspace: ` +
    `${scopedAbsolutePaths.join(', ')}. Use only the exact absolute paths supplied for the current attempt workspace. ` +
    'Never resolve or edit a path from the registered parent project. ' +
    'Read files from byte offset zero in bounded chunks no larger than 16 KiB. ' +
    'If more content is needed, use the known byte length and a valid next byte offset; never use a line number or an offset beyond the returned content/file length. ' +
    'Immediately before each `edit_file`, reread the exact current target text from the same path and attempt workspace. ' +
    'Build the replacement from that fresh text, not from an earlier read or remembered source. ' +
    'If an exact target no longer matches, reread the affected section once and adjust to the current exact text. ' +
    'If the target is still ambiguous or absent, stop without broad replacement and report the blocker. ' +
    'After each edit, reread the changed span and verify the intended result before proceeding. ' +

    'Do not run shell commands, access the network, inspect credentials, or edit any other path. ' +
    'Do not request broader permissions. ' +

    'If a required permission or file is unavailable, report the blocker without requesting broader access.';
  // Stream-json mode exclusively consumes user prompts from stdin; passing the
  // --print alias here can consume the next option as a positional prompt.
  const args = ['--input-format', 'stream-json', '--output-format', 'stream-json',
    `--project=${projectId}`,
    // Antigravity's selected project can remain bound to the outer task PR
    // while the executor runs in a per-attempt checkout beneath it. Explicitly
    // add that checkout so file tools can address the exact candidate root.
    '--add-dir', config.workspace,
    // The exact model ID pins Gemini 3.8 Flash High. A separate --effort
    // override previously failed for this model, so keep it out of the command.
    '--model', ANTIGRAVITY_V2_MODEL,
    // This selects the documented agent execution mode. The stream's
    // permission_mode is a separate headless tool-policy value and may be
    // request-review. Keep the sandbox and validate every captured path.
    '--mode=accept-edits', '--sandbox',
    '--disable-slash-commands'];
  const outputStem = `output-${job.request_id}-${attemptId}`;
  const stdoutPath = join(config.state_dir, `${outputStem}.stdout.bin`);
  const stderrPath = join(config.state_dir, `${outputStem}.stderr.bin`);
  const processResult = await (dependencies.runCapturedProcess ?? runCapturedProcess)(cliPath, args, {
    cwd: config.workspace, env: buildAntigravityChildEnvironment(baseEnv),
    stdinText: `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`,
    stdoutPath, stderrPath, terminate: dependencies.terminateProcessTree ?? terminateProcessTree,
  });
  let cliBinaryIntegrityEvidence = 'CHANGED_OR_UNKNOWN';
  try {
    if (await sha256File(cliPath) === cliBinarySha256) cliBinaryIntegrityEvidence = 'MATCHED';
  } catch { /* preserve unknown after the process; never upgrade the run */ }
  const capturedStdout = processResult.local_evidence?.stdout_file;
  const capturedHash = processResult.local_evidence?.stdout_sha256;
  const runEvidence = await (dependencies.readAntigravityV2RunEvidence ?? readAntigravityV2RunEvidence)(
    typeof capturedStdout === 'string' && basename(capturedStdout) === capturedStdout
      ? join(config.state_dir, capturedStdout) : '',
    typeof capturedHash === 'string' ? capturedHash : '', config.workspace,
    typeof config.antigravity_project_root === 'string' ? config.antigravity_project_root : null);
  const evidencedResult = {
    ...processResult,
    cli_version: readiness.version ?? null, cli_binary_sha256: cliBinarySha256,
    cli_binary_integrity_evidence: cliBinaryIntegrityEvidence,
    project_scope_evidence: readiness.project_scope_evidence ?? 'UNKNOWN',
    effective_config_evidence: readiness.effective_config_evidence ?? 'UNKNOWN',
    credit_fallback_setting: readiness.credit_fallback_setting ?? 'UNKNOWN',
    tool_policy_evidence: readiness.tool_policy_evidence ?? 'TOOL_POLICY_UNKNOWN',
    forbidden_tool_execution_evidence: runEvidence.forbidden_tool_execution_evidence ?? 'UNKNOWN',
    session_id: runEvidence.session_id, session_started: runEvidence.session_started,
    cli_status: runEvidence.cli_status, run_disposition: runEvidence.run_disposition,
        workspace_cwd_evidence: runEvidence.workspace_cwd_evidence ?? { status: 'UNKNOWN' },
    external_effects: runEvidence.external_effects,
    source_diff_evidence: runEvidence.source_diff_evidence,
    task_acceptance: runEvidence.task_acceptance,
    permission_mode_evidence: runEvidence.permission_mode_evidence,
    model_invoked: runEvidence.model_invoked,
    provider_usage_evidence: runEvidence.provider_usage_evidence,
    model_activity_evidence: runEvidence.model_activity_evidence,
    token_usage: runEvidence.token_usage,
    tool_execution_evidence: runEvidence.tool_execution_evidence,
    tool_execution_count: runEvidence.tool_execution_count,
    tool_execution_failed_count: runEvidence.tool_execution_failed_count,
    tool_execution_incomplete_count: runEvidence.tool_execution_incomplete_count,
    file_change_tool_evidence: runEvidence.file_change_tool_evidence,
    file_change_tool_completed_count: runEvidence.file_change_tool_completed_count,
    file_change_tool_failed_count: runEvidence.file_change_tool_failed_count,
    file_change_tool_incomplete_count: runEvidence.file_change_tool_incomplete_count,
    file_change_target_evidence: runEvidence.file_change_target_evidence ??
      emptyAntigravityFileChangeTargetEvidence(),
    local_evidence: { ...processResult.local_evidence,
      ...(projectRootBefore ? { antigravity_project_root_check: {
        status: 'CLEAN_BEFORE', head_sha: projectRootBefore.head_sha,
      } } : {}),
      antigravity_run: { valid: runEvidence.valid, reason: runEvidence.reason,
          cli_version: readiness.version ?? null, cli_binary_sha256: cliBinarySha256,
          cli_binary_integrity_evidence: cliBinaryIntegrityEvidence,
          tool_policy_evidence: readiness.tool_policy_evidence ?? 'TOOL_POLICY_UNKNOWN',
          forbidden_tool_execution_evidence: runEvidence.forbidden_tool_execution_evidence ?? 'UNKNOWN',
          cli_status: runEvidence.cli_status, run_disposition: runEvidence.run_disposition,
          external_effects: runEvidence.external_effects,
          source_diff_evidence: runEvidence.source_diff_evidence,
          task_acceptance: runEvidence.task_acceptance,
        permission_mode_evidence: runEvidence.permission_mode_evidence,
          file_change_target_evidence: runEvidence.file_change_target_evidence ??
            emptyAntigravityFileChangeTargetEvidence(),
          event_count: runEvidence.event_count, stdout_bytes: runEvidence.stdout_bytes ?? 0,
          tool_execution_failed_count: runEvidence.tool_execution_failed_count,
          tool_execution_incomplete_count: runEvidence.tool_execution_incomplete_count } },
  };
  const fileChangeTargets = runEvidence.file_change_target_evidence ??
    emptyAntigravityFileChangeTargetEvidence();
  const hasForeignFileTarget = fileChangeTargets.registered_root_count > 0 ||
    fileChangeTargets.outside_or_unknown_root_count > 0;
  const hasUnknownFileTarget = fileChangeTargets.relative_or_unknown_root_count > 0 ||
    fileChangeTargets.unidentified_tool_count > 0;
  if (evidencedResult.local_evidence?.termination_state &&
      ['ORPHAN_POSSIBLE', 'TERMINATION_UNCONFIRMED', 'TERMINATION_REQUESTED']
        .includes(evidencedResult.local_evidence.termination_state))
    return { ...evidencedResult, outcome: 'ANTIGRAVITY_EDIT_PROCESS_TERMINATION_UNCONFIRMED',
      exit_code: -1, coding_state: 'UNKNOWN_PROCESS_MAY_STILL_WRITE' };
  if (typeof config.antigravity_project_root === 'string') {
    let projectRootAfter;
    try {
      projectRootAfter = await captureAntigravityProjectRootSnapshot(config, job, attemptId,
        'project-root-after', dependencies.readGitProcessTree);
    } catch (error) {
      return { ...evidencedResult, outcome:
        `ANTIGRAVITY_EDIT_PROJECT_ROOT_READBACK_UNKNOWN_${safeErrorCode(error, 'UNKNOWN')}`,
      exit_code: -1, coding_state: 'UNKNOWN', external_effects: 'UNKNOWN', scope_valid: false,
      local_evidence: { ...evidencedResult.local_evidence,
        antigravity_project_root_check: { status: 'READBACK_UNKNOWN' } } };
    }
    if (projectRootAfter.head_sha !== projectRootBefore?.head_sha) {
      return { ...evidencedResult, outcome: 'ANTIGRAVITY_EDIT_PROJECT_ROOT_HEAD_CHANGED',
        exit_code: -1, coding_state: 'UNKNOWN', external_effects: 'UNKNOWN', scope_valid: false,
        local_evidence: { ...evidencedResult.local_evidence,
          antigravity_project_root_check: { status: 'HEAD_CHANGED',
            head_before_sha: projectRootBefore?.head_sha ?? null,
            head_after_sha: projectRootAfter.head_sha } } };
    }
    const projectRootChanged = projectRootStatusChanges(projectRootBefore, projectRootAfter);
    if (projectRootChanged.length) {
      const allowedProjectPaths = new Set(job.edit_paths.map(path =>
        platform() === 'win32' ? path.toLowerCase() : path));
      const projectRootChangedPaths = [...new Set(projectRootChanged
        .map(change => change.path.replaceAll('\\', '/'))
        .filter(path => allowedProjectPaths.has(
          platform() === 'win32' ? path.toLowerCase() : path)))].sort();
      return { ...evidencedResult, outcome: 'ANTIGRAVITY_EDIT_PROJECT_ROOT_WRITE_ESCAPED_ATTEMPT',
        exit_code: -1, coding_state: 'PROJECT_ROOT_WRITE_PRESERVED_UNVERIFIED',
        external_effects: 'UNKNOWN', scope_valid: false,
        project_root_changed_files_count: projectRootChanged.length,
        project_root_changed_paths: projectRootChangedPaths,
        project_root_out_of_scope_changed_files_count:
          projectRootChanged.length - projectRootChangedPaths.length,
        local_evidence: { ...evidencedResult.local_evidence,
          antigravity_project_root_check: { status: 'CHANGES_PRESERVED',
            head_sha: projectRootAfter.head_sha,
            changed_allowed_paths: projectRootChangedPaths,
            out_of_scope_changed_files_count:
              projectRootChanged.length - projectRootChangedPaths.length,
            sha256: createHash('sha256').update(projectRootAfter.status_bytes).digest('hex'),
            bytes: projectRootAfter.status_bytes.length } } };
    }
    evidencedResult.local_evidence.antigravity_project_root_check = {
      status: projectRootBefore.changes.length
        ? 'UNCHANGED_PREEXISTING_CHANGES' : 'CLEAN_STABLE',
      head_before_sha: projectRootBefore.head_sha,
      head_after_sha: projectRootAfter.head_sha,
      status_sha256: createHash('sha256').update(projectRootAfter.status_bytes).digest('hex'),
      status_bytes: projectRootAfter.status_bytes.length,
      baseline_changed_files_count: projectRootBefore.changes.length,
      changed_files_count: 0,
    };
  }
  if (!runEvidence.valid && runEvidence.workspace_cwd_evidence?.status !== 'MATCHED') {
    // A process stream bound to another or unknown working directory cannot
    // prove an empty diff in the configured candidate. Keep the captured
    // stream/artifacts, but do not inspect a different checkout and call it 0.
    return { ...evidencedResult,
      outcome: hasForeignFileTarget
        ? 'ANTIGRAVITY_EDIT_FILE_TARGET_ROOT_MISMATCH_WORKSPACE_IDENTITY_UNKNOWN'
        : `ANTIGRAVITY_EDIT_WORKSPACE_IDENTITY_UNKNOWN_${runEvidence.reason}`,
      exit_code: -1, coding_state: 'UNKNOWN_WORKSPACE_EFFECTS_PRESERVED',
      scope_valid: false, external_effects: 'UNKNOWN', source_diff_evidence: 'UNKNOWN',
      task_acceptance: 'UNKNOWN', diff_sha256: null, diff_bytes: null,
      local_evidence: { ...evidencedResult.local_evidence,
        antigravity_run: { ...evidencedResult.local_evidence.antigravity_run,
          source_diff_evidence: 'UNKNOWN' },
        source_diff_evidence: 'UNKNOWN',
        edit_diff: { status: 'NOT_CAPTURED_WORKSPACE_IDENTITY_UNKNOWN' },
        workspace_cwd_evidence: runEvidence.workspace_cwd_evidence ?? { status: 'UNKNOWN' } } };
  }
  if (!runEvidence.valid) {
    // The process has exited, so it is now safe to inspect its scoped workspace
    // even when its stream is truncated or malformed. Preserve any real diff,
    // but keep model activity, external effects and task acceptance unknown.
    let diff;
    try { diff = await captureScopedEditDiff({ workspace: config.workspace,
      state_dir: config.state_dir, job, attempt_id: attemptId,
      readProcessTree: dependencies.readGitProcessTree }); }
    catch (error) {
      const errorCode = safeErrorCode(error);
      const physicalScopeFailure = errorCode.startsWith('EDIT_PATH_PHYSICAL_');
      return { ...evidencedResult,
        outcome: physicalScopeFailure ? 'ANTIGRAVITY_EDIT_PHYSICAL_PATH_SCOPE_UNKNOWN'
          : `ANTIGRAVITY_STREAM_EVIDENCE_${runEvidence.reason || 'UNKNOWN'}_DIFF_CAPTURE_FAILED_${errorCode}`,
        exit_code: -1, coding_state: 'UNKNOWN', model_invoked: runEvidence.model_invoked,
        ...(physicalScopeFailure ? { scope_valid: false, external_effects: 'UNKNOWN',
          source_diff_evidence: 'UNKNOWN' } : {}),
        local_evidence: { ...evidencedResult.local_evidence,
          ...(physicalScopeFailure ? { antigravity_run: { ...evidencedResult.local_evidence.antigravity_run,
            source_diff_evidence: 'UNKNOWN' } } : {}),
          edit_diff_error: physicalScopeFailure ? errorCode : 'CAPTURE_FAILED' } };
    }
    if (diff.diff_capture_status === 'NOT_CAPTURED_PHYSICAL_SCOPE_UNVERIFIED')
      return { ...evidencedResult, outcome: 'ANTIGRAVITY_EDIT_PHYSICAL_PATH_SCOPE_UNKNOWN',
        exit_code: -1, coding_state: 'UNKNOWN', scope_valid: false, external_effects: 'UNKNOWN',
        source_diff_evidence: 'UNKNOWN',
        diff_sha256: null, diff_bytes: null, ...diff,
        local_evidence: { ...evidencedResult.local_evidence,
          antigravity_run: { ...evidencedResult.local_evidence.antigravity_run,
            source_diff_evidence: 'UNKNOWN' },
          source_diff_evidence: 'UNKNOWN', edit_diff: diff } };
    const localEvidence = { ...evidencedResult.local_evidence,
      antigravity_run: { ...evidencedResult.local_evidence.antigravity_run,
        source_diff_evidence: 'CAPTURED' }, edit_diff: diff };
    const incompleteResult = { ...evidencedResult, source_diff_evidence: 'CAPTURED',
      local_evidence: localEvidence };
    if (!diff.scope_valid)
      return { ...incompleteResult, outcome: 'ANTIGRAVITY_EDIT_SCOPE_VIOLATION', exit_code: 46,
        coding_state: 'REJECTED_SCOPE', scope_valid: false,
        diff_sha256: diff.sha256, diff_bytes: diff.bytes, ...diff };
    const forbiddenToolObserved = runEvidence.forbidden_tool_execution_evidence === 'OBSERVED';
    return { ...incompleteResult,
      outcome: forbiddenToolObserved
        ? `ANTIGRAVITY_FORBIDDEN_CUA_TOOL_EVENT_${runEvidence.reason || 'STREAM_INVALID'}` +
          (diff.changed_files.length ? '_DIFF_CAPTURED_UNVERIFIED' : '_NO_DIFF_UNVERIFIED')
        : `ANTIGRAVITY_STREAM_EVIDENCE_${runEvidence.reason || 'UNKNOWN'}` +
          (diff.changed_files.length ? '_DIFF_CAPTURED_UNVERIFIED' : ''),
      exit_code: -1,
      coding_state: diff.changed_files.length ? 'DIFF_CAPTURED_UNVERIFIED' : 'UNKNOWN',
      scope_valid: true, diff_sha256: diff.sha256, diff_bytes: diff.bytes, ...diff };
  }

  let diff;
  try { diff = await captureScopedEditDiff({ workspace: config.workspace,
    state_dir: config.state_dir, job, attempt_id: attemptId,
    readProcessTree: dependencies.readGitProcessTree }); }
  catch (error) {
    const errorCode = safeErrorCode(error);
    const physicalScopeFailure = errorCode.startsWith('EDIT_PATH_PHYSICAL_');
    return { ...evidencedResult,
      outcome: physicalScopeFailure ? 'ANTIGRAVITY_EDIT_PHYSICAL_PATH_SCOPE_UNKNOWN'
        : `ANTIGRAVITY_EDIT_DIFF_CAPTURE_FAILED_${errorCode}`,
      ...(physicalScopeFailure ? { scope_valid: false, external_effects: 'UNKNOWN',
        source_diff_evidence: 'UNKNOWN' } : {}),
      exit_code: -1, coding_state: 'UNKNOWN',
      local_evidence: { ...evidencedResult.local_evidence,
        ...(physicalScopeFailure ? { antigravity_run: { ...evidencedResult.local_evidence.antigravity_run,
          source_diff_evidence: 'UNKNOWN' } } : {}),
        edit_diff_error: physicalScopeFailure ? errorCode : 'CAPTURE_FAILED' } };
  }
  if (diff.diff_capture_status === 'NOT_CAPTURED_PHYSICAL_SCOPE_UNVERIFIED')
    return { ...evidencedResult, outcome: 'ANTIGRAVITY_EDIT_PHYSICAL_PATH_SCOPE_UNKNOWN',
      exit_code: -1, coding_state: 'UNKNOWN', scope_valid: false, external_effects: 'UNKNOWN',
      source_diff_evidence: 'UNKNOWN',
      diff_sha256: null, diff_bytes: null, ...diff,
      local_evidence: { ...evidencedResult.local_evidence,
        antigravity_run: { ...evidencedResult.local_evidence.antigravity_run,
          source_diff_evidence: 'UNKNOWN' },
        source_diff_evidence: 'UNKNOWN', edit_diff: diff } };
  const localEvidence = { ...evidencedResult.local_evidence,
    antigravity_run: { ...evidencedResult.local_evidence.antigravity_run,
      source_diff_evidence: 'CAPTURED' }, edit_diff: diff };
  const diffEvidencedResult = { ...evidencedResult, source_diff_evidence: 'CAPTURED' };
  if (!diff.scope_valid)
    return { ...diffEvidencedResult, outcome: 'ANTIGRAVITY_EDIT_SCOPE_VIOLATION', exit_code: 46,
      coding_state: 'REJECTED_SCOPE', scope_valid: false, diff_sha256: diff.sha256,
      diff_bytes: diff.bytes, ...diff, local_evidence: localEvidence };
  if (hasForeignFileTarget) {
    return { ...diffEvidencedResult,
      outcome: diff.changed_files.length
        ? 'ANTIGRAVITY_EDIT_FILE_TARGET_ROOT_MISMATCH_DIFF_PRESERVED'
        : 'ANTIGRAVITY_EDIT_FILE_TARGET_MISMATCH_NO_CANDIDATE_DIFF',
      exit_code: -1, coding_state: diff.changed_files.length ? 'DIFF_CAPTURED_UNVERIFIED' : 'UNKNOWN',
      scope_valid: false, external_effects: 'UNKNOWN', task_acceptance: 'UNKNOWN',
      diff_sha256: diff.sha256, diff_bytes: diff.bytes, ...diff, scope_valid: false,
      external_effects: 'UNKNOWN', task_acceptance: 'UNKNOWN', local_evidence: localEvidence };
  }
  if (hasUnknownFileTarget &&
      runEvidence.file_change_tool_completed_count > 0) {
    return { ...diffEvidencedResult,
      outcome: diff.changed_files.length
        ? 'ANTIGRAVITY_EDIT_FILE_TARGET_UNKNOWN_DIFF_PRESERVED'
        : 'ANTIGRAVITY_EDIT_FILE_TARGET_UNKNOWN_NO_CANDIDATE_DIFF',
      exit_code: -1, coding_state: diff.changed_files.length ? 'DIFF_CAPTURED_UNVERIFIED' : 'UNKNOWN',
      scope_valid: false, external_effects: 'UNKNOWN', task_acceptance: 'UNKNOWN',
      diff_sha256: diff.sha256, diff_bytes: diff.bytes, ...diff, scope_valid: false,
      external_effects: 'UNKNOWN', task_acceptance: 'UNKNOWN', local_evidence: localEvidence };
  }
  if (runEvidence.file_change_tool_completed_count > 0 &&
      (!diff.changed_files.length || diff.bytes === 0)) {
    return { ...diffEvidencedResult,
      outcome: 'ANTIGRAVITY_EDIT_FILE_CHANGE_TOOLS_WITH_NO_CANDIDATE_DIFF',
      exit_code: -1, coding_state: 'UNKNOWN', scope_valid: true,
      external_effects: 'UNKNOWN', task_acceptance: 'UNKNOWN',
      diff_sha256: diff.sha256, diff_bytes: diff.bytes, ...diff, local_evidence: localEvidence };
  }
  if (runEvidence.forbidden_tool_execution_evidence === 'OBSERVED')
    return { ...diffEvidencedResult,
      outcome: diff.changed_files.length
        ? 'ANTIGRAVITY_FORBIDDEN_CUA_TOOL_EVENT_DIFF_CAPTURED_UNVERIFIED'
        : 'ANTIGRAVITY_FORBIDDEN_CUA_TOOL_EVENT_NO_DIFF_UNVERIFIED',
      exit_code: -1, coding_state: diff.changed_files.length ? 'DIFF_CAPTURED_UNVERIFIED' : 'UNVERIFIED',
      scope_valid: true, diff_sha256: diff.sha256, diff_bytes: diff.bytes,
      ...diff, local_evidence: localEvidence };
  if (localEvidence.storage_error || localEvidence.capture_error || localEvidence.spawn_error ||
      localEvidence.process_error || localEvidence.stdin_error)
    return { ...diffEvidencedResult, outcome: diff.changed_files.length
      ? 'ANTIGRAVITY_EDIT_EVIDENCE_CAPTURE_FAILED_DIFF_PRESERVED'
      : 'ANTIGRAVITY_EDIT_EVIDENCE_CAPTURE_FAILED_NO_DIFF',
    exit_code: -1, coding_state: diff.changed_files.length ? 'DIFF_CAPTURED_UNVERIFIED' : 'UNKNOWN',
    scope_valid: true, diff_sha256: diff.sha256, diff_bytes: diff.bytes,
    ...diff, local_evidence: localEvidence };
  if (cliBinaryIntegrityEvidence !== 'MATCHED')
    return { ...diffEvidencedResult, outcome: 'ANTIGRAVITY_CLI_BINARY_CHANGED_OR_UNKNOWN_DURING_RUN',
      exit_code: -1, coding_state: 'DIFF_CAPTURED_UNVERIFIED', scope_valid: true,
      diff_sha256: diff.sha256, diff_bytes: diff.bytes,
      ...diff, local_evidence: localEvidence };
  if (runEvidence.model_invoked !== true)
    return { ...diffEvidencedResult, outcome: diff.changed_files.length
      ? 'ANTIGRAVITY_NO_POSITIVE_MODEL_USAGE_DIFF_PRESERVED'
      : 'ANTIGRAVITY_NO_POSITIVE_MODEL_USAGE_EVIDENCE',
    exit_code: -1, coding_state: diff.changed_files.length ? 'DIFF_CAPTURED_UNVERIFIED' : 'UNVERIFIED',
    scope_valid: true, diff_sha256: diff.sha256, diff_bytes: diff.bytes,
    ...diff, local_evidence: localEvidence };
  if (runEvidence.tool_execution_failed_count > runEvidence.file_change_tool_failed_count)
    return { ...diffEvidencedResult,
      outcome: diff.changed_files.length
        ? 'ANTIGRAVITY_EDIT_TOOL_EXECUTION_FAILED_DIFF_PRESERVED'
        : 'ANTIGRAVITY_EDIT_TOOL_EXECUTION_FAILED_NO_DIFF',
      cli_exit_code: evidencedResult.exit_code, exit_code: -1,
      coding_state: diff.changed_files.length ? 'DIFF_CAPTURED_UNVERIFIED' : 'UNVERIFIED',
      scope_valid: true, diff_sha256: diff.sha256, diff_bytes: diff.bytes,
      ...diff, local_evidence: localEvidence };
  if (runEvidence.tool_execution_incomplete_count > runEvidence.file_change_tool_incomplete_count)
    return { ...diffEvidencedResult,
      outcome: diff.changed_files.length
        ? 'ANTIGRAVITY_EDIT_TOOL_EXECUTION_INCOMPLETE_DIFF_PRESERVED'
        : 'ANTIGRAVITY_EDIT_TOOL_EXECUTION_INCOMPLETE_NO_DIFF',
      cli_exit_code: evidencedResult.exit_code, exit_code: -1,
      coding_state: diff.changed_files.length ? 'DIFF_CAPTURED_UNVERIFIED' : 'UNVERIFIED',
      scope_valid: true, diff_sha256: diff.sha256, diff_bytes: diff.bytes,
      ...diff, local_evidence: localEvidence };
  if (!diff.changed_files.length || diff.bytes === 0)
    return { ...diffEvidencedResult, outcome: 'ANTIGRAVITY_EDIT_NO_DIFF', cli_exit_code: evidencedResult.exit_code,
      exit_code: 47, coding_state: 'NO_DIFF', scope_valid: true,
      diff_sha256: diff.sha256, diff_bytes: diff.bytes, ...diff, local_evidence: localEvidence };
  if (evidencedResult.exit_code !== 0 || runEvidence.cli_status !== 'SUCCESS' ||
      runEvidence.file_change_tool_incomplete_count)
    return { ...diffEvidencedResult, outcome: 'ANTIGRAVITY_EDIT_PROCESS_FAILED_DIFF_PRESERVED',
      cli_exit_code: evidencedResult.exit_code, exit_code: -1, coding_state: 'DIFF_CAPTURED_UNVERIFIED',
      scope_valid: true, diff_sha256: diff.sha256, diff_bytes: diff.bytes,
      ...diff, local_evidence: localEvidence };
  if (runEvidence.file_change_tool_failed_count)
    return { ...diffEvidencedResult,
      outcome: 'ANTIGRAVITY_EDIT_DIFF_CAPTURED_UNVERIFIED_FILE_TOOL_FAILURES_RETAINED',
      cli_exit_code: evidencedResult.exit_code,
      coding_state: 'DIFF_CAPTURED_UNVERIFIED', scope_valid: true,
      diff_sha256: diff.sha256, diff_bytes: diff.bytes, ...diff, local_evidence: localEvidence };
  return { ...diffEvidencedResult, outcome: 'ANTIGRAVITY_EDIT_DIFF_CAPTURED_UNVERIFIED',
    coding_state: 'DIFF_CAPTURED_UNVERIFIED', scope_valid: true,
    diff_sha256: diff.sha256, diff_bytes: diff.bytes, ...diff, local_evidence: localEvidence };
}

export function nativePreflight(config, job, dependencies = {}) {
  const qualify = dependencies.qualifyOpenCodeV2 ?? qualifyOpenCodeV2;
  const readiness = dependencies.runAntigravityV2Readiness ?? runAntigravityV2Readiness;
  const cli = qualify();
  const localAppData = typeof dependencies.localAppData === 'string'
    ? dependencies.localAppData : process.env.LOCALAPPDATA;
  const antigravityBin = typeof localAppData === 'string' && isAbsolute(localAppData)
    ? join(localAppData, 'agy', 'bin', 'agy.exe') : '';
  const baseEnv = dependencies.baseEnv ?? process.env;
  let projectId = config.antigravity_cli_project_id;
  if (projectId === undefined || projectId === null) {
    const binding = (dependencies.resolveAntigravityProjectId ?? resolveAntigravityProjectId)(
      config.workspace, baseEnv);
    if (binding?.projectScopeEvidence === 'PROJECT_WORKSPACE_MATCHED') projectId = binding.projectId;
  }
  const antigravity = readiness(antigravityBin, config.workspace, undefined,
    baseEnv, undefined, projectId);
  const facts = {
    schema: 1, project_id: PROJECT, host: config.host, request_id: job.request_id,
    kind: 'native_preflight', source_sha: job.source_sha,
    node_version: process.version, platform: platform(), architecture: process.arch,
    opencode_v2_verified: cli.ready,
    native_executables_checked: cli.candidates_checked,
    model_allowlist_entries: Object.keys(config.allowed_models || {}).length,
    v2_model_execution_enabled: config.enable_v2_model_runs === true,
    cli_version: cli.version ?? 'NOT_FOUND_OR_WRONG_MAJOR', model_auth: 'NOT_TESTED',
    antigravity_v2: antigravity,
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
  if (job?.kind === 'antigravity_edit')
    return runAntigravityEdit(spec, config, job, attemptId, dependencies);
  const qualify = dependencies.qualifyOpenCodeV2 ?? qualifyOpenCodeV2;
  const readProviderAuth = dependencies.readV2ProviderAuth ?? readV2ProviderAuth;
  const runCaptured = dependencies.runCapturedProcess ?? runCapturedProcess;
  const editMode = job?.kind === 'opencode_edit';
  const waiting = (outcome, exit_code) => ({ outcome, exit_code,
    evidence_sha256: null, evidence_bytes: 0, eligibility_state: 'WAITING', model_invoked: false });
  if (!isOpenCodeExecutionKind(job?.kind))
    return { outcome: 'UNSUPPORTED_OPENCODE_JOB_KIND', exit_code: 41,
      evidence_sha256: null, evidence_bytes: 0 };
  if (config.enable_v2_model_runs !== true)
    return waiting('V2_MODEL_EXECUTION_NOT_YET_APPROVED', 44);
  if (!checkModelAuthorization(job, config))
    return waiting('MODEL_NOT_EXPLICITLY_ALLOWED', 42);
  const cli = qualify();
  if (!cli.ready) return waiting('OPENCODE_V2_CLI_NOT_QUALIFIED', 43);
  let providerAuth;
  try {
    providerAuth = readProviderAuth(cli.bin, job.model.split('/')[0], config.workspace);
  } catch { providerAuth = { status: 'AUTH_PROVIDER_METADATA_UNKNOWN' }; }
  // Only an exact, locally approved OpenCode free-model entry may run without
  // a provider auth record. Unknown auth metadata always remains WAITING; the
  // model stays pinned, so there is no paid fallback.
  const explicitlyApprovedUnauthenticatedFreeModel =
    providerAuth?.status === 'AUTH_PROVIDER_RECORD_ABSENT' &&
    hasExplicitUnauthenticatedFreeModelAuthorization(job, config);
  if (providerAuth?.status !== 'AUTH_PROVIDER_RECORD_PRESENT' &&
      !explicitlyApprovedUnauthenticatedFreeModel)
    return waiting(providerAuth?.status === 'AUTH_PROVIDER_RECORD_ABSENT'
      ? 'OPENCODE_V2_AUTH_NOT_READY' : 'OPENCODE_V2_AUTH_METADATA_UNKNOWN', 48);
  // V2, not V1: ordered permissions, shell/subagent, provider/model#variant.
  // Config is private, never echoed to the GitHub Issue; no shell expansion of prompts.
  let safePolicy;
  try {
    const policy = editMode ?
      buildV2ScopedEditConfig(config.workspace, job.edit_paths) : buildV2ReadOnlyConfig();
    safePolicy = JSON.stringify(policy);
    if (editMode) await assertEditWorkspaceReady(config, job, attemptId,
      dependencies.readGitProcessTree, dependencies.gitPlatform ?? platform());
  } catch (error) {
    return { outcome: `V2_EDIT_SCOPE_OR_SOURCE_${safeErrorCode(error, 'INVALID')}`, exit_code: 46,
      evidence_sha256: null, evidence_bytes: 0, coding_state: 'NOT_STARTED',
      eligibility_state: 'BLOCKED', model_invoked: false, scope_valid: false, external_effects: 'NONE' };
  }
  // V2 beta builds have ignored OPENCODE_CONFIG[_CONTENT] in some execution paths.
  // The documented project-local opencode.json is the authoritative V2 policy input.
  // Never overwrite unrelated project configuration or allow higher-priority .opencode.
  const configFile = join(config.workspace, 'opencode.json');
  const hadExistingPolicy = existsSync(configFile);
  if (existsSync(join(config.workspace, 'opencode.jsonc')) ||
      existsSync(join(config.workspace, '.opencode')))
    return waiting('V2_WORKSPACE_CONFIG_CONFLICT', 45);
  if (existsSync(configFile)) {
    if (readFileSync(configFile, 'utf8') !== safePolicy)
      return waiting('V2_WORKSPACE_CONFIG_UNKNOWN', 45);
  } else writeFileSync(configFile, safePolicy, { flag: 'wx', mode: 0o600 });
  if (readFileSync(configFile, 'utf8') !== safePolicy)
    return waiting('V2_WORKSPACE_CONFIG_READBACK_FAILED', 45);
  const args = editMode ? buildV2ScopedEditArgs(job, config.workspace, spec) :
    buildV2ReadOnlyArgs(job, config.workspace, spec);
  const outputStem = `output-${job.request_id}-${attemptId}`;
  const stdoutPath = join(config.state_dir, `${outputStem}.stdout.bin`);
  const stderrPath = join(config.state_dir, `${outputStem}.stderr.bin`);
  const childEnv = buildOpenCodeChildEnv(process.env);
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
      provider_authorization: explicitlyApprovedUnauthenticatedFreeModel
        ? 'EXPLICIT_LOCAL_UNAUTHENTICATED_FREE_MODEL_ALLOWLIST'
        : 'SAVED_PROVIDER_RECORD_PRESENT',
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
    state_dir: config.state_dir, job, attempt_id: attemptId,
    readProcessTree: dependencies.readGitProcessTree,
    platformName: dependencies.gitPlatform ?? platform() }); }
  catch (error) {
    const errorCode = safeErrorCode(error);
    return { ...evidencedResult,
      outcome: errorCode.startsWith('EDIT_PATH_PHYSICAL_')
        ? 'V2_EDIT_PHYSICAL_PATH_SCOPE_UNKNOWN' : `V2_EDIT_DIFF_CAPTURE_FAILED_${errorCode}`,
      source_diff_evidence: 'UNKNOWN',
      exit_code: -1, coding_state: 'UNKNOWN',
      ...(errorCode.startsWith('EDIT_PATH_PHYSICAL_') ? { scope_valid: false, external_effects: 'UNKNOWN' } : {}),
      local_evidence: { ...evidencedResult.local_evidence,
        edit_diff_error: errorCode.startsWith('EDIT_PATH_PHYSICAL_') ? errorCode : 'CAPTURE_FAILED' } };
  }
  if (diff.diff_capture_status === 'NOT_CAPTURED_PHYSICAL_SCOPE_UNVERIFIED')
    return { ...evidencedResult, outcome: 'V2_EDIT_PHYSICAL_PATH_SCOPE_UNKNOWN',
      exit_code: -1, coding_state: 'UNKNOWN', scope_valid: false, external_effects: 'UNKNOWN',
      source_diff_evidence: 'UNKNOWN',
      diff_sha256: null, diff_bytes: null, ...diff,
      local_evidence: { ...evidencedResult.local_evidence,
        source_diff_evidence: 'UNKNOWN', edit_diff: diff } };
  const localEvidence = { ...evidencedResult.local_evidence, edit_diff: diff };
  if (policyChanged || !diff.scope_valid)
    return { ...evidencedResult, outcome: policyChanged ? 'V2_EDIT_POLICY_CHANGED' : 'V2_EDIT_SCOPE_VIOLATION',
      cli_exit_code: processResult.exit_code, exit_code: 46, coding_state: 'REJECTED_SCOPE',
      scope_valid: false, source_diff_evidence: 'CAPTURED',
      diff_sha256: diff.sha256, diff_bytes: diff.bytes,
      ...diff, local_evidence: localEvidence };
  if (localEvidence.storage_error || localEvidence.capture_error || localEvidence.spawn_error ||
      localEvidence.process_error || localEvidence.stdin_error)
    return { ...evidencedResult,
      outcome: diff.changed_files.length ? 'V2_EDIT_EVIDENCE_CAPTURE_FAILED_DIFF_PRESERVED' :
        'V2_EDIT_EVIDENCE_CAPTURE_FAILED_NO_DIFF',
      cli_exit_code: processResult.exit_code, exit_code: -1,
      coding_state: diff.changed_files.length ? 'DIFF_CAPTURED_UNVERIFIED' : 'UNKNOWN',
      scope_valid: true, source_diff_evidence: 'CAPTURED',
      diff_sha256: diff.sha256, diff_bytes: diff.bytes,
      ...diff, local_evidence: localEvidence };
  if (!diff.changed_files.length || diff.bytes === 0)
    return { ...evidencedResult, outcome: 'V2_EDIT_NO_DIFF', cli_exit_code: evidencedResult.exit_code,
      exit_code: 47, coding_state: 'NO_DIFF', scope_valid: true,
      source_diff_evidence: 'CAPTURED', diff_sha256: diff.sha256, diff_bytes: diff.bytes, ...diff,
      local_evidence: localEvidence };
  if (evidencedResult.exit_code !== 0)
    return { ...evidencedResult, outcome: 'V2_EDIT_PROCESS_FAILED_DIFF_PRESERVED',
      cli_exit_code: evidencedResult.exit_code, coding_state: 'DIFF_CAPTURED_UNVERIFIED',
      scope_valid: true, source_diff_evidence: 'CAPTURED',
      diff_sha256: diff.sha256, diff_bytes: diff.bytes,
      ...diff, local_evidence: localEvidence };
  return { ...evidencedResult, outcome: 'V2_EDIT_DIFF_CAPTURED_UNVERIFIED',
    coding_state: 'DIFF_CAPTURED_UNVERIFIED', scope_valid: true, source_diff_evidence: 'CAPTURED',
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
    ...(state === 'WAITING' ? { eligibility_state: 'WAITING', model_invoked: false } : {}),
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
    ...(isModelExecutionKind(job.kind) ? { model: job.model, variant: job.variant,
      session_id: result?.session_id ?? null, session_started: result?.session_started ?? null,
      model_invoked: state === 'WAITING' ? false : result?.model_invoked ?? null,
      external_effects: result?.external_effects ?? 'UNKNOWN',
      source_diff_evidence: result?.source_diff_evidence ?? 'NOT_INSPECTED',
      task_acceptance: result?.task_acceptance ?? 'UNKNOWN',
      ...(job.kind === 'antigravity_edit' ? {
        permission_mode_evidence: result?.permission_mode_evidence ?? 'UNKNOWN',
        cli_version: result?.cli_version ?? null,
        cli_binary_sha256: result?.cli_binary_sha256 ?? null,
        cli_binary_integrity_evidence: result?.cli_binary_integrity_evidence ?? 'UNKNOWN',
        tool_policy_evidence: result?.tool_policy_evidence ?? 'UNKNOWN',
        forbidden_tool_execution_evidence: result?.forbidden_tool_execution_evidence ?? 'UNKNOWN',
        ...(Number.isSafeInteger(result?.tool_execution_failed_count) ? {
          tool_execution_failed_count: result.tool_execution_failed_count,
        } : {}),
        ...(Number.isSafeInteger(result?.tool_execution_incomplete_count) ? {
          tool_execution_incomplete_count: result.tool_execution_incomplete_count,
        } : {}),
        ...(Object.hasOwn(ANTIGRAVITY_RUN_DISPOSITIONS, result?.cli_status) ? {
          cli_status: result.cli_status,
           run_disposition: result.run_disposition } : {}) } : {}),
      provider_usage_evidence: result?.provider_usage_evidence ?? 'UNKNOWN',
      model_activity_evidence: result?.model_activity_evidence ?? 'UNKNOWN',
      token_usage: result?.token_usage ?? null,
      tool_execution_evidence: result?.tool_execution_evidence ?? 'UNKNOWN',
      tool_execution_count: result?.tool_execution_count ?? 0,
      file_change_tool_evidence: result?.file_change_tool_evidence ?? 'UNKNOWN',
      file_change_tool_completed_count: result?.file_change_tool_completed_count ?? 0,
      file_change_tool_failed_count: result?.file_change_tool_failed_count ?? 0,
      file_change_tool_incomplete_count: result?.file_change_tool_incomplete_count ?? 0,
      ...(job.kind === 'antigravity_edit' ? { file_change_target_evidence:
        result?.file_change_target_evidence ?? emptyAntigravityFileChangeTargetEvidence() } : {}),
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
      const reason = safeErrorCode(error, 'RECOVERY_TRIGGER_UNKNOWN_NO_REPLAY');
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
    const reason = safeErrorCode(error, 'RESULT_OR_RECEIPT_INVALID');
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
  const waitingReceipt = terminal?.state === 'WAITING' &&
    terminal.model_invoked === false && terminal.session_id === null &&
    terminal.session_started === null && terminal.evidence_sha256 === null &&
    terminal.evidence_bytes === 0 && terminal.diff_sha256 === null &&
    terminal.diff_bytes === null && terminal.scope_valid === null &&
    terminal.tool_execution_count === 0 &&
    parseReceipt(RECEIPT_MARKER + JSON.stringify(terminal)) !== null;
  const waitingLocalEvidence = !local || (!Array.isArray(local) && typeof local === 'object' &&
    Object.keys(local).every(key => key === 'executor_workspace_guard') &&
    (local.executor_workspace_guard === undefined ||
      local.executor_workspace_guard?.readback === 'COMPLETE'));
  // A preflight WAITING receipt has no stdout/stderr capture. The Executor may
  // add its completed workspace guard to local_evidence, which must not turn
  // that valid no-model record into a missing-capture failure.
  if (waitingReceipt && waitingLocalEvidence) return true;
  if (!local && terminal?.evidence_sha256 == null && terminal?.evidence_bytes === 0) return true;
  const outputCaptureFailed = Boolean(local &&
    (local.storage_error || local.capture_error || local.spawn_error || local.process_error || local.stdin_error) &&
    terminal?.state === 'BLOCKED' && /(?:FAILED|ERROR)/.test(terminal?.outcome || ''));
  if (outputCaptureFailed && (!isEditExecutionKind(terminal.kind) || terminal.diff_sha256 == null)) return true;
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
  if (isEditExecutionKind(terminal.kind) && terminal.diff_sha256 !== null) {
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
  const triggerPendingExecutor = adapters.triggerPendingExecutorAttempt ?? triggerPendingExecutorAttempt;
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
    const resolutionState = resolvedAttemptState(comments, s, me);
    const hasResolution = resolutionState !== null;
    const executor = isModelExecutionKind(s.kind) ? executorForJobKind(config, s.kind) : null;
    if (isModelExecutionKind(s.kind) && strictExecutorLaneRouting(config) && !executor) {
      if (!hasResolution || resolutionState === 'WAITING') blockedKinds.add(s.kind);
      log(`EXECUTOR_LANE_DESCRIPTOR_MISSING_${executorLaneForJobKind(s.kind)?.toUpperCase()}_` +
        `${s.request_id}_NO_REPLAY`);
      continue;
    }
    if (s.kind === 'codex_plan') {
      if (hasResolution) continue;
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
    const resultDir = isModelExecutionKind(s.kind) && executor ?
      resolveExecutorResultsDir(executor) : config.state_dir;
    const path = isModelExecutionKind(s.kind) && executor ?
      resolveExecutorResultPath(resultDir, s.request_id, s.attempt_id) :
      join(resultDir, `result-${s.request_id}-${s.attempt_id}.json`);
    if (hasResolution) {
      if (isModelExecutionKind(s.kind) && executor) {
        if (existsSync(path)) {
          let result;
          try { result = JSON.parse(readFileSync(path, 'utf8')); }
          catch (error) {
            blockedKinds.add(s.kind);
            log(`EXECUTOR_TERMINAL_EVIDENCE_UNREADABLE_${s.request_id}_${safeErrorCode(error)}_NO_REPLAY`);
            continue;
          }
          try { await verifyCapturedEvidence(resultDir, result); }
          catch (error) {
            blockedKinds.add(s.kind);
            log(`EXECUTOR_TERMINAL_CAPTURE_READBACK_UNKNOWN_${s.request_id}_${safeErrorCode(error)}_NO_CLEANUP`);
            continue;
          }
          if (executorProcessTerminationUnconfirmed(result)) {
            blockedKinds.add(s.kind);
            log(`EXECUTOR_PROCESS_TERMINATION_UNRESOLVED_${s.request_id}`);
            continue;
          }
        }
        try { cleanupExecutorAttempt(executor, s.attempt_id); }
        catch (error) {
          if (resolutionState === 'WAITING') {
            blockedKinds.add(s.kind);
            log(`EXECUTOR_WAITING_ATTEMPT_CLEANUP_UNKNOWN_${s.request_id}_` +
              `${safeErrorCode(error)}`);
          }
        }
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
        if (isModelExecutionKind(s.kind)) await verifyCapturedEvidence(resultDir, result);
      } catch (error) {
        if (isModelExecutionKind(s.kind)) blockedKinds.add(s.kind);
        log(`LOCAL_RESULT_RECONCILIATION_UNKNOWN_${s.request_id}_${safeErrorCode(error)}_NO_REPLAY`);
        continue;
      }
      if (isModelExecutionKind(s.kind) && executorProcessTerminationUnconfirmed(result)) {
        blockedKinds.add(s.kind);
        log(`EXECUTOR_PROCESS_TERMINATION_UNRESOLVED_${s.request_id}`);
        continue;
      }
      try { postReceipt(config, result.terminal, me); }
      catch (error) {
        if (isModelExecutionKind(s.kind)) blockedKinds.add(s.kind);
        log(`LOCAL_RESULT_RECEIPT_PUBLISH_UNKNOWN_${s.request_id}_` +
          `${safeErrorCode(error)}_NO_REPLAY`);
        continue;
      }
      if (isModelExecutionKind(s.kind) && executor) {
        try { cleanupExecutorAttempt(executor, s.attempt_id); }
        catch { /* exact result and receipt remain durable */ }
      }
      log(`RECOVERED_EXECUTOR_RESULT_${result.terminal.state}_${s.request_id}`);
      blockedKinds.add(s.kind);
      continue;
    }
    if (isModelExecutionKind(s.kind)) {
      blockedKinds.add(s.kind);
      if (isEditExecutionKind(s.kind) && executor) {
        const sources = comments.filter(comment => config.dispatchers.includes(comment.user?.login))
          .map(comment => ({ comment, job: parseJob(comment.body) }))
          .filter(item => item.job?.request_id === s.request_id && item.job.kind === s.kind &&
            item.job.host?.toUpperCase() === s.host.toUpperCase());
        if (sources.length !== 1) {
          log(`PENDING_EXECUTOR_SOURCE_UNKNOWN_${s.request_id}_NO_REPLAY`);
          continue;
        }
        const { comment: sourceComment, job: expectedJob } = sources[0];
        const editPathsHash = Array.isArray(expectedJob.edit_paths)
          ? digest(Buffer.from(JSON.stringify(expectedJob.edit_paths), 'utf8')) : null;
        const receiptMatches = expectedJob.source_sha === s.source_sha &&
          expectedJob.model === s.model && expectedJob.variant === s.variant &&
          editPathsHash !== null && editPathsHash === s.edit_paths_sha256 &&
          (expectedJob.source_pr ?? null) === (s.source_pr ?? null) &&
          (expectedJob.goal_comment_id ?? null) === (s.goal_comment_id ?? null) &&
          (expectedJob.goal_body_sha256 ?? null) === (s.goal_body_sha256 ?? null);
        if (!receiptMatches) {
          log(`PENDING_EXECUTOR_RECEIPT_SOURCE_MISMATCH_${s.request_id}_NO_REPLAY`);
          continue;
        }
        let latestSource;
        try { latestSource = await apiRead(`repos/${REPO}/issues/comments/${sourceComment.id}`); }
        catch {
          log(`PENDING_EXECUTOR_SOURCE_READBACK_UNKNOWN_${s.request_id}_NO_REPLAY`);
          continue;
        }
        if (latestSource?.body !== sourceComment.body ||
            !config.dispatchers.includes(latestSource?.user?.login)) {
          log(`PENDING_EXECUTOR_SOURCE_CHANGED_${s.request_id}_NO_REPLAY`);
          continue;
        }
        try {
          const triggered = triggerPendingExecutor(executor, s.attempt_id, { expectedJob });
          if (triggered?.outcome === 'EXECUTOR_PENDING_ATTEMPT_TRIGGERED_NOT_ACCEPTANCE')
            log(`PENDING_EXECUTOR_RETRIGGERED_${s.request_id}_${s.attempt_id}_NO_NEW_RECEIPT`);
          else log(`PENDING_EXECUTOR_RETRIGGER_NOT_CONFIRMED_${s.request_id}_NO_REPLAY`);
        } catch (error) {
          log(`PENDING_EXECUTOR_RETRIGGER_NOT_CONFIRMED_${s.request_id}_` +
            `${safeErrorCode(error)}_NO_REPLAY`);
        }
        continue;
      }
      log(`AMBIGUOUS_STARTED_${s.request_id}: NO_REEXECUTION`);
      continue;
    }
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
    } else {
      const scopedAction = codexScopedActionStatus(latestDirective.body);
      const policyFailure = codexGoalPolicyFailure(config.human_goal_codex_policy);
      if (!scopedAction.ready) {
        humanGoalWaitingReason ??= scopedAction.code;
        log(`${scopedAction.code}_${latestDirective.id}_NO_MODEL`);
      }
      if (policyFailure) {
        humanGoalWaitingReason ??= policyFailure;
        log(`${policyFailure}_${latestDirective.id}_NO_MODEL`);
      }
      if (scopedAction.ready && !policyFailure) {
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
    }
    if (legacyReceiptStatus === 'PRIOR_BODY_TERMINAL')
      log(`HUMAN_GOAL_PRIOR_BODY_TERMINAL_${latestDirective.id}_NEW_BODY_MAY_PROCEED`);
  }
  const candidateSourceShas = await readPinnedCandidateSources(comments,
    config.dispatchers, me, config.host, apiRead, log, [...blockedKinds],
    () => humanGoalComments ?? goalCommentsRead());
  const authorizedW1JobExists = comments.some(comment => {
    if (!config.dispatchers.includes(comment.user?.login)) return false;
    const job = parseJob(comment.body);
    return job?.kind === 'opencode_edit' && job.host.toUpperCase() === config.host.toUpperCase();
  });
  if (!authorizedW1JobExists) log('NO_AUTHORIZED_W1_JOB');
  for (const stale of staleCandidateSourceEntries(comments, config.dispatchers, me,
    config.host, candidateSourceShas)) {
    log(`STALE_CANDIDATE_SOURCE_${stale.request_id}_PR_${stale.source_pr}_` +
      `EXPECTED_SHA_${stale.expected_sha}_OBSERVED_SHA_${stale.observed_sha}_NO_DISPATCH`);
  }
  const selectNextCandidate = () => selectNextWithCodexClaim(comments.filter(comment => {
    const job = parseJob(comment.body);
    return !job || !skippedRequestIds.has(job.request_id);
  }), config.dispatchers, me, config.host, head, config.state_dir,
  [...blockedKinds], candidateSourceShas);
  let selected = selectNextCandidate();
  let next = selected.next;
  if (selected.unresolvedRequestId)
    log(`CODEX_LOCAL_CLAIM_UNRECONCILED_${selected.unresolvedRequestId}_NO_REPLAY`);
  let waitingEligibility = null;
  let preparedSourceBundle = null;
  let preparedExecutor = null;
  let preparedWorkspace = null;
  const preflightBlockers = new Map();
  while (next) {
    preparedSourceBundle = null;
    preparedExecutor = null;
    preparedWorkspace = null;
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
          reason = `CODEX_EXECUTOR_TASK_READBACK_${safeErrorCode(error)}`;
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
    } else if (isModelExecutionKind(next.job.kind)) {
      let reason = null;
      preparedExecutor = executorForJobKind(config, next.job.kind);
      if (next.job.kind === 'antigravity_edit' && !preparedExecutor)
        reason = executorRouteFailure(config, next.job.kind);
      if (next.job.kind === 'antigravity_edit') {
        if (!reason) reason = antigravityExecutionAuthorization(next.job, config);
        // CLI identity, OAuth, quota, project binding, and CLI settings belong
        // to the W2 Executor's Windows profile. Publisher-side preflight would
        // inspect the wrong SID and can falsely block an otherwise eligible lane.
      } else if (config.enable_v2_model_runs !== true) reason = 'MODEL_RUNS_NOT_ENABLED';
      if (!reason && !checkModelAuthorization(next.job, config)) reason = 'MODEL_NOT_EXPLICITLY_ALLOWED';
      if (!reason && !preparedExecutor) reason = executorRouteFailure(config, next.job.kind);
      if (!reason && next.job.kind === 'opencode_edit')
        reason = opencodeExecutorIsolationFailure(preparedExecutor);
      if (!reason) {
        try {
          // The OpenCode verifier's contract is throw-on-failure and return the
          // validated Task Scheduler readback on success; unlike the Codex
          // verifier, it does not expose a `ready` boolean.
          verifyExecutor(preparedExecutor);
        } catch (error) {
          reason = `EXECUTOR_TASK_${safeErrorCode(error)}`;
        }
      }
      if (!reason && next.job.kind === 'opencode_edit') {
        try {
          preparedWorkspace = (adapters.readExecutorWorkspace ?? readExecutorWorkspace)(
            preparedExecutor, { projectId: config.project_id, host: config.host });
        } catch (error) {
          reason = `EXECUTOR_WORKSPACE_${safeErrorCode(error, 'READBACK_UNKNOWN')}`;
        }
      }
      if (!reason && next.job.kind === 'opencode_edit') {
        try { buildV2ScopedEditConfig(preparedWorkspace, next.job.edit_paths); }
        catch (error) {
          reason = `EDIT_SCOPE_${safeErrorCode(error, 'INVALID')}`;
        }
      }
      if (!reason && isEditExecutionKind(next.job.kind) &&
          preparedExecutor.source_bundle_per_attempt !== true)
        reason = 'EXECUTOR_SOURCE_BUNDLE_PER_ATTEMPT_REQUIRED';
      if (!reason && preparedExecutor.source_bundle_per_attempt === true) {
        try {
          const bundle = createSourceBundle({ workspace: preparedWorkspace ?? config.workspace,
            descriptor: preparedExecutor, job: next.job, attemptId: randomUUID() });
          if (bundle.source_sha !== next.job.source_sha || !HASH.test(bundle.sha256 || ''))
            throw new Error('EXECUTOR_SOURCE_BUNDLE_IDENTITY_MISMATCH');
          preparedSourceBundle = { attempt_id: bundle.attempt_id, sha256: bundle.sha256 };
        } catch (error) {
          reason = `EXECUTOR_SOURCE_BUNDLE_${safeErrorCode(error)}`;
        }
      }
      if (reason) {
        const modelLane = next.job.kind === 'antigravity_edit' ? 'ANTIGRAVITY' : 'OPENCODE';
        preflightBlockers.set(next.job.request_id, reason);
        waitingEligibility ??= modelLane === 'ANTIGRAVITY' ? reason : `OPENCODE_${reason}`;
        log(`${modelLane}_LANE_WAITING_ELIGIBILITY_${reason}`);
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
  let observation;
  try {
    observation = await publishOperatorObservation(
      config, me, comments, head, adapters.observationDependencies, candidateSourceShas,
      Number.isSafeInteger(issue.comments) && issue.comments >= 0 ? issue.comments : null,
      preflightBlockers,
    );
  } catch (error) {
    // Status publishing failure must not block a valid queued task.
    const errorCode = safeErrorCode(error, 'OPERATOR_OBSERVATION_UPDATE_UNKNOWN');
    try {
      persistOperatorObservationDiagnostic(config, 'UNKNOWN', head, errorCode,
        error?.operator_identity);
    } catch {
      log('OPERATOR_OBSERVATION_DIAGNOSTIC_WRITE_FAILED');
    }
    log(`OPERATOR_OBSERVATION_UPDATE_UNKNOWN_${errorCode}`);
  }
  if (observation) {
    let errorCode = null;
    try {
      errorCode = persistOperatorObservationDiagnostic(
        config, observation.status, head, observation.error || observation.reason,
        observation.publisher_identity,
      );
    } catch {
      log('OPERATOR_OBSERVATION_DIAGNOSTIC_WRITE_FAILED');
    }
    if (observation.status === 'UPDATED') log('OPERATOR_OBSERVATION_UPDATED');
    else if (observation.status === 'NOT_SEEDED')
      log(`OPERATOR_OBSERVATION_NOT_SEEDED_${errorCode || 'OPERATOR_OBSERVATION_NOT_SEEDED'}`);
    else log(`OPERATOR_OBSERVATION_UPDATE_UNKNOWN_${errorCode || 'OPERATOR_OBSERVATION_UPDATE_UNKNOWN'}`);
  }
  if (!next) {
    const waitingReason = waitingEligibility ?? humanGoalWaitingReason;
    if (waitingReason) {
      log(`WAITING_ELIGIBILITY_${waitingReason}`);
      return { state: 'WAITING_ELIGIBILITY', reason: waitingReason };
    }
    log('NO_DELTA_NO_LLM');
    return { state: 'NO_DELTA', scope: 'FORMAL_WORK_QUEUE_ONLY',
      reason: 'NO_DISPATCHABLE_JOB', mission_complete: false };
  }
  const job = next.job;
  const discardPreparedSourceBundle = () => {
    if (!preparedSourceBundle) return;
    try { cleanupExecutorAttempt(preparedExecutor, preparedSourceBundle.attempt_id); }
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
  if (isModelExecutionKind(job.kind) || job.kind === 'codex_plan')
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
  const executorDispatch = isModelExecutionKind(job.kind);
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
    const dispatched = dispatchExecutor(preparedExecutor, {
      request_id: job.request_id, attempt_id: attemptId, source_sha: job.source_sha, job, spec,
      ...(preparedSourceBundle ? { source_bundle_sha256: preparedSourceBundle.sha256 } : {}),
    });
    log(`DISPATCHED_${job.request_id}_${dispatched.outcome}`);
    return { state: 'DISPATCHED', request_id: job.request_id, attempt_id: attemptId,
      outcome: dispatched.outcome };
  }
  let result;
  if (job.kind === 'ping') result = { outcome: 'BRIDGE_PING_OK_NOT_OS_ACCEPTANCE', exit_code: 0, evidence_sha256: null, evidence_bytes: 0 };
  else if (job.kind === 'native_preflight') result = nativePreflight(config, job,
  { runAntigravityV2Readiness: adapters.runAntigravityV2Readiness,
    qualifyOpenCodeV2: adapters.qualifyOpenCodeV2,
    localAppData: adapters.localAppData, baseEnv: adapters.baseEnv });
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
  main().catch(err => { console.error(`NATIVE_BRIDGE_BLOCKED: ${safeErrorCode(err)}`); process.exitCode = 2; });
}
