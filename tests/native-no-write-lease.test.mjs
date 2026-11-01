import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { hasVerifiedReadOnlyNoDiffAttempt, JOB_MARKER, parseJob, parseReceipt, PROJECT,
  receipt, RECEIPT_MARKER, selectNext } from '../native-bridge/worker.mjs';

const host = 'DESKTOP-1B6PD2P';
const workerLogin = 'wfvupu1212';
const dispatcher = 't14210184';
const goalBodySha = 'c'.repeat(64);
const sourceSha = 'a'.repeat(40);
const specSha = 'd'.repeat(64);
const sessionId = 'ses_no_write_lease_20261101';
const attemptId = '892a8350-2a18-4365-a441-57eba12915ac';
const paths = ['tests/native-bridge.test.mjs'];
const hash = value => createHash('sha256').update(value).digest('hex');
const emptySha = hash(Buffer.alloc(0));

function editJob(requestId, sourcePr, sha, editPaths = paths) {
  return { schema: 6, project_id: PROJECT, host, request_id: requestId, kind: 'opencode_edit',
    source_sha: sha, spec_path: 'native-bridge/tasks/no-write-lease-test.md', spec_sha256: specSha,
    model: 'opencode/deepseek-v4.1-flash-free', variant: null, edit_paths: editPaths,
    source_pr: sourcePr, goal_comment_id: 6188322050, goal_body_sha256: goalBodySha };
}

function attemptEvidence(job, { tool = 'read', toolStatus = 'completed', changedRoot = false,
  processState = 'DEAD', externalEffects = 'UNKNOWN', taskAcceptance = 'UNKNOWN' } = {}) {
  const events = [
    { type: 'step_start', sessionID: sessionId, part: { type: 'step-start', sessionID: sessionId } },
    { type: 'tool_use', sessionID: sessionId, part: { type: 'tool', tool,
      state: { status: toolStatus }, sessionID: sessionId } },
    { type: 'tool_use', sessionID: sessionId, part: { type: 'tool', tool: 'glob',
      state: { status: 'completed' }, sessionID: sessionId } },
    { type: 'text', sessionID: sessionId, part: { type: 'text', text: 'No source diff.' } },
    { type: 'step_finish', sessionID: sessionId, part: { type: 'step-finish', sessionID: sessionId } },
  ];
  const stdout = Buffer.from(`${events.map(event => JSON.stringify(event)).join('\n')}\n`, 'utf8');
  const stderr = Buffer.alloc(0);
  const separator = Buffer.from('\n--- STDERR ---\n', 'utf8');
  const changedFiles = [];
  const resultFields = {
    outcome: 'V2_EDIT_NO_DIFF', exit_code: 47,
    evidence_sha256: hash(Buffer.concat([stdout, separator])),
    evidence_bytes: stdout.length + separator.length,
    diff_sha256: emptySha, diff_bytes: 0, changed_files: changedFiles,
    coding_state: 'NO_DIFF', scope_valid: true, cli_exit_code: 1,
    model: job.model, variant: job.variant, model_invoked: true, session_started: true,
    session_id: sessionId, external_effects: externalEffects, task_acceptance: taskAcceptance,
    source_diff_evidence: 'CAPTURED', provider_usage_evidence: 'CONFIRMED',
    model_activity_evidence: 'CONFIRMED', tool_execution_evidence: 'OBSERVED',
    tool_execution_count: 2, file_change_tool_evidence: 'UNKNOWN',
    file_change_tool_completed_count: 0, file_change_tool_failed_count: 0,
    file_change_tool_incomplete_count: 0,
    local_evidence: { stdout_sha256: hash(stdout), stderr_sha256: hash(stderr) },
  };
  const terminal = receipt(job.request_id, attemptId, 'BLOCKED', job, resultFields);
  const changedCandidateRoot = changedRoot ? 'e'.repeat(64) : '4'.repeat(64);
  const result = {
    request_id: job.request_id,
    attempt_id: attemptId,
    terminal,
    local_evidence: {
      stdout_file: 'stdout.jsonl', stderr_file: 'stderr.bin',
      stdout_sha256: hash(stdout), stdout_bytes: stdout.length,
      stderr_sha256: hash(stderr), stderr_bytes: stderr.length,
      provider_authorization: 'EXPLICIT_LOCAL_UNAUTHENTICATED_FREE_MODEL_ALLOWLIST',
      process_tree_state: processState, termination_state: 'NOT_REQUESTED',
      opencode_run: { valid: true, reason: 'OPEN_CODE_FREE_USAGE_LIMIT_REACHED',
        event_count: events.length, stdout_bytes: stdout.length },
      executor_workspace_guard: {
        registered_root_identity_sha256: '1'.repeat(64),
        registered_root_state_sha256: '2'.repeat(64),
        candidate_root_identity_sha256: '3'.repeat(64),
        candidate_root_state_sha256: '4'.repeat(64),
        registered_root_after_sha256: '2'.repeat(64),
        candidate_root_after_sha256: changedCandidateRoot,
        readback: 'COMPLETE', registered_root_changed_paths: 0,
        candidate_root_changed_paths: changedRoot ? 1 : 0,
      },
      edit_diff: { file: 'empty.patch', sha256: emptySha, bytes: 0,
        changed_files: changedFiles, allowed_paths: [...job.edit_paths], scope_valid: true },
    },
  };
  return { terminal, result, stdout };
}

function comment(id, body, login = dispatcher) { return { id, body, user: { login } }; }

test('verified read-only no-diff evidence releases only the overlapping file lease', () => {
  const owner = editJob('W1_POLL_WAIT_REASON_20261101_27C8955C', 672, 'f'.repeat(40));
  const queued = editJob('W1_SCHEMA6_CROSS_PROCESS_RECEIPT_RECOVERY_20261101_296A23A4',
    679, sourceSha);
  const evidence = attemptEvidence(owner, { toolStatus: 'error' });
  const parsedReceipt = parseReceipt(`${RECEIPT_MARKER}${JSON.stringify(evidence.terminal)}`);
  assert.ok(parsedReceipt, 'fixture must be a valid official terminal receipt');
  const verified = hasVerifiedReadOnlyNoDiffAttempt(owner, parsedReceipt, evidence.result, evidence.stdout);
  assert.equal(verified, true);
  assert.equal(evidence.terminal.external_effects, 'UNKNOWN');
  assert.equal(evidence.terminal.task_acceptance, 'UNKNOWN');

  const comments = [comment(1, `${JOB_MARKER}${JSON.stringify(owner)}`),
    comment(2, `${JOB_MARKER}${JSON.stringify(queued)}`),
    comment(3, `${RECEIPT_MARKER}${JSON.stringify(evidence.terminal)}`)];
  const sourceHeads = new Map([[679, sourceSha]]);
  assert.equal(selectNext(comments, [dispatcher], workerLogin, host, sourceSha, [], sourceHeads), null,
    'an UNKNOWN external effect keeps the file lease until complete local no-write evidence is read');
  const leaseKey = `${owner.request_id}\0${attemptId}`;
  assert.equal(selectNext(comments, [dispatcher], workerLogin, host, sourceSha, [], sourceHeads,
    new Set([leaseKey]))?.job.request_id, queued.request_id,
  'only the separately verified no-write evidence releases the same-path lease');
  assert.equal(selectNext(comments, [dispatcher], workerLogin, host, sourceSha, [], sourceHeads,
    new Set([`${owner.request_id}\0different-attempt`])), null,
  'a different attempt identity cannot release the lease');
  const started = receipt(owner.request_id, attemptId, 'STARTED', owner);
  assert.equal(selectNext([...comments, comment(4, `${RECEIPT_MARKER}${JSON.stringify(started)}`)],
    [dispatcher], workerLogin, host, sourceSha, [], sourceHeads, new Set([leaseKey])), null,
  'a caller-supplied key cannot release a lease after a later STARTED receipt');
  const changedTerminal = { ...evidence.terminal, outcome: 'OTHER_TERMINAL' };
  const changedReceipt = parseReceipt(`${RECEIPT_MARKER}${JSON.stringify(changedTerminal)}`);
  const changedComments = [comments[0], comments[1],
    comment(3, `${RECEIPT_MARKER}${JSON.stringify(changedReceipt)}`)];
  assert.equal(selectNext(changedComments, [dispatcher], workerLogin, host, sourceSha, [], sourceHeads,
    new Set([leaseKey])), null,
  'a caller-supplied key cannot release a different terminal receipt');
});

test('no-write reconciliation fails closed on mutation tools, changed roots, live processes, or changed receipt identity', () => {
  const job = editJob('W1_NO_WRITE_EVIDENCE_NEGATIVE_20261101', 672, 'f'.repeat(40));
  const cases = [
    attemptEvidence(job, { tool: 'write' }),
    attemptEvidence(job, { tool: 'edit' }),
    attemptEvidence(job, { changedRoot: true }),
    attemptEvidence(job, { processState: 'ORPHAN_POSSIBLE' }),
    attemptEvidence(job, { externalEffects: 'NONE' }),
    attemptEvidence(job, { taskAcceptance: 'ACCEPTED' }),
  ];
  for (const evidence of cases) {
    const parsed = parseReceipt(`${RECEIPT_MARKER}${JSON.stringify(evidence.terminal)}`);
    assert.equal(hasVerifiedReadOnlyNoDiffAttempt(job, parsed, evidence.result, evidence.stdout), false);
  }
  const good = attemptEvidence(job);
  const wrongIdentity = { ...parseReceipt(`${RECEIPT_MARKER}${JSON.stringify(good.terminal)}`),
    attempt_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
  assert.equal(hasVerifiedReadOnlyNoDiffAttempt(job, wrongIdentity, good.result, good.stdout), false);
});
