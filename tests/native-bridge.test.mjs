import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, chmodSync, readdirSync,
  existsSync, renameSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseJob, selectNext, parseReceipt, receipt, PROJECT, REPO, JOB_MARKER,
  RECEIPT_MARKER, checkModelAuthorization, findNativeCLI, terminalStateForResult,
  runWorker as executeWorker, main as runWorker, runPlan, writeReceipt, ISSUE_TITLE,
  createCandidateSourceBundle, REPO_ID,
  codexTerminalReceipt, dispatchCodexJob, selectNextWithCodexClaim,
  candidatePullRequestEligible, verifyGoalReference, verifyCapturedEvidence, verifyScopedEditEvidence }
  from '../native-bridge/worker.mjs';
import { OPERATOR_MARKER, encodeOperatorObservation, parseOperatorObservation }
  from '../native-bridge/operator-observation.mjs';
import { buildExecutorTaskXml, candidateBundlePath, candidateWorkspacePath, executorProcessPath,
  executorResultPath, makeExecutorManifest, readExecutorProcessEvidence, triggerPendingExecutorAttempt, getCurrentWindowsSid }
  from '../native-bridge/windows-executor.mjs';
import { executePendingManifest } from '../native-bridge/executor.mjs';
import { takeNextRequest } from '../native-bridge/codex-executor.mjs';

test('native task installer preserves the hidden waiting launcher and exit-code path', () => {
  const installer = readFileSync(new URL('../native-bridge/install.ps1', import.meta.url), 'utf8');
  assert.match(installer, /function Test-HiddenWorkerLauncher/,
    'the installer must validate, not replace, the existing HiddenWorker launcher');
  assert.match(installer, /shell\.Run\(commandLine, 0, True\)/,
    'the accepted launcher must hide the child window and wait for its exit');
  assert.match(installer, /WScript\.Quit rc/,
    'the accepted launcher must pass through the worker exit code');
  assert.match(installer,
    /New-ScheduledTaskAction -Execute \$wscript -Argument \$actionArgs -WorkingDirectory \$homeDir/,
    'the scheduled action must start Windows Script Host with the existing launcher');
  assert.doesNotMatch(installer, /New-ScheduledTaskAction -Execute \$node\b/,
    'a scheduled node.exe action can reintroduce a visible console window');
  const installStart = installer.indexOf("if ($Mode -eq 'Install') {");
  const launcherGate = installer.indexOf('Test-HiddenWorkerLauncher -Path $launcher', installStart);
  const firstWrite = installer.indexOf('New-Item -ItemType Directory', installStart);
  assert.ok(installStart >= 0 && launcherGate > installStart && firstWrite > launcherGate,
    'a missing or altered launcher must abort before the installer writes runtime files');
  assert.doesNotMatch(installer, /Copy-Item[^\r\n]*-Destination \$launcher/,
    'the installer must preserve, not replace, the existing launcher');
  assert.match(installer, /TASK_INSTALL_READBACK_MISMATCH/,
    'the installed action must be read back before reporting success');
});

test('shared Windows SID lookup uses hidden whoami and rejects unreadable identity', { skip: process.platform !== 'win32' }, () => {
  const calls = [];
  const sid = getCurrentWindowsSid({ systemRoot: 'C:\\Windows', execFile: (file, args, options) => {
    calls.push({ file, args, options });
    return '"DESKTOP\\synthetic","S-1-5-21-111-222-333-1001"\r\n';
  } });
  assert.equal(sid, 'S-1-5-21-111-222-333-1001');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'C:\\Windows\\System32\\whoami.exe');
  assert.deepEqual(calls[0].args, ['/user', '/fo', 'csv', '/nh']);
  assert.equal(calls[0].options.windowsHide, true);
  assert.throws(() => getCurrentWindowsSid({ systemRoot: 'C:\\Windows', execFile: () => 'identity unavailable' }),
    error => error.code === 'EXECUTOR_WINDOWS_IDENTITY_UNAVAILABLE');
});
const commit = 'a'.repeat(40); const hash = 'b'.repeat(64);
const TEST_HOST = 'PTYSD-TEST-HOST-01';
const mkjob = (opts = {}) => ({ schema: 1, project_id: PROJECT, host: TEST_HOST,
  request_id: 'PTYSD_NATIVE_PING_20261012', kind: 'ping', source_sha: commit,
  spec_path: null, spec_sha256: null, ...opts });
const encoded = o => JOB_MARKER + JSON.stringify(o);
const com = (id, body, login = 't14210184') => {
  const observation = parseOperatorObservation(body);
  return { id, body, user: { login }, ...(observation
    ? { updated_at: observation.published_at ?? observation.observed_at } : {}) };
};
const h = x => createHash('sha256').update(x).digest('hex');
const TEST_GOAL_BODY = '# V5.3-R4\nPTYSD_V53R4_DELETE_FIRST_AUTONOMY_GOAL_20261015\nAuthorized synthetic test scope.';
const TEST_GOAL_REF = { issue: 310, comment_id: 6188322050,
  marker: 'PTYSD_V53R4_DELETE_FIRST_AUTONOMY_GOAL_20261015', body_sha256: h(TEST_GOAL_BODY) };
const TEST_GOAL_COMMENT = { id: TEST_GOAL_REF.comment_id, body: TEST_GOAL_BODY,
  issue_url: `https://api.github.com/repos/${REPO}/issues/310`, user: { login: 'dispatcher' } };
const bindGoalJob = (job, candidatePr = 434) => ({ ...job, schema: 6,
  candidate_pr: candidatePr, goal_ref: TEST_GOAL_REF });
const testCandidatePull = (head = commit, base = commit, number = 434) => ({
  number, state: 'open', base: { ref: 'main', sha: base,
    repo: { id: REPO_ID, full_name: REPO } },
  head: { sha: head, repo: { id: REPO_ID, full_name: REPO } },
});
function legacyStoredPlanManifest(job, spec, attemptId) {
  return { schema: 1, kind: 'PTYSD_NATIVE_EXECUTOR_MANIFEST_V1',
    request_id: job.request_id, attempt_id: attemptId, source_sha: job.source_sha,
    spec_sha256: job.spec_sha256, job, spec };
}
function seededOperatorObservation(commentId, sequence, mainSha, at = Date.now()) {
  const timestamp = new Date(at).toISOString();
  return {
    schema: 1, project_id: PROJECT, repo: REPO, issue: 407,
    host_alias: 'win11-primary', snapshot_id: randomUUID(), sequence,
    observed_at: timestamp, published_at: timestamp,
    expires_at: new Date(at + 5 * 60_000).toISOString(),
    source: { kind: 'WIN11_NATIVE_TASK_READBACK', comment_id: commentId,
      issue_comments_observed_at: timestamp, main_sha: mainSha },
    windows: { status: 'FRESH', native_task: { enabled: true, state: 'Ready' },
      opencode_process_count: 0, runner_service_count: 0, runner_service_running: false },
    native_worker: { state: 'POLL_EXECUTED_TASK_TRIGGER_UNVERIFIED',
      current_task: null, latest_task: null, files_modified: 'UNPROVEN',
      remote_commit: null, pull_request: null, ci: 'UNKNOWN', next_owner: 'NO_CURRENT_TASK' },
    opencode_v2: { process_observed_at: timestamp, process_count: 0,
      active_session_count: null, active_session_state: 'UNKNOWN_NO_PASSIVE_API',
      task_binding: 'UNPROVEN', code_changes: 'UNPROVEN',
      remote_commit: null, pull_request: null, ci: 'UNKNOWN' },
    github: { observed_at: timestamp, main_sha: mainSha, issue_comments_count: 2,
      runner_registration: { status: 'UNKNOWN', count: null, observed_at: timestamp },
      organization_runner_registration: 'UNKNOWN_ORG_SCOPE_NOT_AVAILABLE',
      runner_service_count: 0, runner_service_running: false },
    monitor_candidate: null, incident: null,
  };
}

function makeObservationWorkerFixture({ ambiguousReadback = false, priorObservation = null,
  processCount = 0, job: suppliedJob = null, candidatePullRequest = null } = {}) {
  const root = mkdtempSync(join(homedir(), '.ptysd-worker-observation-'));
  const workspace = join(root, 'workspace');
  const stateDir = join(root, 'state');
  mkdirSync(workspace);
  mkdirSync(stateDir);
  const host = suppliedJob?.host ?? hostname().toUpperCase();
  const publisher = 'trusted-publisher';
  const observationId = 701;
  const job = suppliedJob ?? mkjob({ host, request_id: 'PTYSD_NATIVE_OBSERVE_PING_20261014' });
  const store = {
    next: 703,
    comments: [
      com(observationId, encodeOperatorObservation(
        priorObservation ?? seededOperatorObservation(observationId, 17, commit, Date.now() - 60_000),
      ), publisher),
      com(702, encoded(job), 't14210184'),
    ],
    patches: 0,
    posts: 0,
    failReadback: ambiguousReadback,
    now: Date.now(),
  };
  const config = { repo: REPO, project_id: PROJECT, host, issue: 407,
    workspace, state_dir: stateDir, dispatchers: ['t14210184'] };
  const api = uri => {
    if (uri === 'user') return { login: publisher };
    if (uri === `repos/${REPO}/issues/407`)
      return { title: ISSUE_TITLE, state: 'open' };
    if (uri === `repos/${REPO}/git/ref/heads/main`)
      return { object: { sha: commit } };
    if (uri === `repos/${REPO}/pulls/${job.candidate_pr}` && candidatePullRequest)
      return structuredClone(candidatePullRequest);
    const match = uri.match(/\/issues\/comments\/(\d+)$/);
    if (match) return store.comments.find(c => c.id === Number(match[1]));
    throw new Error(`UNEXPECTED_MOCK_API_ROUTE:${uri}`);
  };
  const observationDependencies = {
    now: () => new Date(store.now),
    collectWindowsObservation: () => ({ status: 'FRESH', observed_at: new Date(store.now).toISOString(),
      tasks_total: 2, legacy_monitor_registered: false, listener_2667: false,
      opencode_process_count: processCount, runner_service_count: 0, runner_service_running: false,
      native_task: { registered: true, enabled: true, state: 'Ready', last_run: null,
        last_result: '0x00000000', action_kind: 'WINDOWLESS_LAUNCHER',
        identity_class: 'INTERACTIVE_LIMITED', multiple_instances: 'IGNORENEW',
        trigger_interval_minutes: 5 } }),
    readRunnerRegistration: () => ({ total_count: 0 }),
    readComment: id => structuredClone(store.comments.find(c => c.id === id)),
    patchComment: (id, body) => {
      const comment = store.comments.find(c => c.id === id);
      if (!comment) throw new Error('MOCK_COMMENT_MISSING');
      comment.body = body;
      comment.updated_at = new Date(store.now + 2000).toISOString();
      store.patches++;
    },
    readComments: () => {
      if (store.failReadback) {
        store.failReadback = false;
        throw new Error('MOCK_READBACK_UNAVAILABLE_AFTER_PATCH');
      }
      return structuredClone(store.comments);
    },
  };
  const receiptWrites = [];
  const logs = [];
  const modelCalls = { count: 0 };
  const codexDispatchCalls = { count: 0 };
  const run = () => runWorker({
    config, api, issueComments: () => store.comments,
    observationDependencies,
    runPlan: async () => {
      modelCalls.count++;
      throw new Error('MODEL_EXECUTION_MUST_NOT_RUN_IN_NO_DELTA_FIXTURE');
    },
    dispatchCodexJob: () => {
      codexDispatchCalls.count++;
      throw new Error('CODEX_EXECUTOR_MUST_NOT_RUN_IN_NO_DELTA_FIXTURE');
    },
    writeReceipt: (_config, data, login) => {
      store.comments.push(com(store.next++, RECEIPT_MARKER + JSON.stringify(data), login));
      store.posts++;
      receiptWrites.push(data);
    },
    log: value => logs.push(value),
  });
  return { root, store, run, logs, receiptWrites, modelCalls, codexDispatchCalls, observationId,
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// These integration fixtures provide a POSIX shebang file named "gh".
// Windows PATH resolution can select the installed gh.exe instead, so keep
// those provider-facing scenarios in Linux CI and never contact live GitHub here.
const fakeShellIntegration = process.platform === 'win32' ? test.skip : test;

test('terminal state fails closed on capture/storage errors even when child exit is zero', () => {
  assert.equal(terminalStateForResult({ exit_code: 0, outcome: 'EVIDENCE_STORAGE_FAILED' }), 'BLOCKED');
  assert.equal(terminalStateForResult({ exit_code: 0, outcome: 'OUTPUT_CAPTURE_FAILED' }), 'BLOCKED');
  assert.equal(terminalStateForResult({ exit_code: 0, outcome: 'BRIDGE_PING_OK_NOT_OS_ACCEPTANCE' }), 'FINISHED');
  assert.equal(terminalStateForResult({ exit_code: 0, outcome: 'OPENCODE_V2_EXIT_0_UNTRUSTED' }), 'FINISHED');
  assert.equal(terminalStateForResult({ exit_code: 0 }), 'BLOCKED');
});

test('FINISHED is attempt lifecycle only and preserves an unverified semantic outcome', () => {
  const job = mkjob({ schema: 2, kind: 'opencode_plan', spec_path: 'native-bridge/tasks/review.md',
    spec_sha256: hash, model: 'opencode/spark', variant: 'high' });
  const result = { exit_code: 0, outcome: 'OPENCODE_V2_EXIT_0_UNTRUSTED',
    evidence_sha256: hash, evidence_bytes: 24 };
  const finalReceipt = receipt(job.request_id, '0'.repeat(8) + '-0000-4000-8000-000000000000',
    terminalStateForResult(result), job, result);
  assert.equal(finalReceipt.state, 'FINISHED');
  assert.equal(finalReceipt.outcome, 'OPENCODE_V2_EXIT_0_UNTRUSTED');
  assert.equal(Object.hasOwn(finalReceipt, 'accepted'), false);
});

test('read-only OpenCode plan requests are no longer dispatchable while their history remains readable', async () => {
  const job = { ...mkjob({ host: hostname().toUpperCase(), request_id: 'PTYSD_NATIVE_PLAN_RETIRED_20261016',
    kind: 'opencode_plan', spec_path: 'native-bridge/tasks/review.md',
    spec_sha256: hash }), schema: 2, model: 'opencode/spark', variant: 'high' };
  assert.equal(selectNext([com(9001, encoded(job), 't14210184')], ['t14210184'],
    'trusted-publisher', job.host, commit), null,
  'the read-only planning lane must not be selected as factory execution work');
  const oldReceipt = receipt(job.request_id, '00000000-0000-4000-8000-000000000002',
    'FINISHED', job, { exit_code: 0, outcome: 'OPENCODE_V2_EXIT_0_UNTRUSTED' });
  assert.equal(parseReceipt(RECEIPT_MARKER + JSON.stringify(oldReceipt)).kind, 'opencode_plan',
    'historical receipts remain parseable for audit and recovery');
  const fixture = makeObservationWorkerFixture({ job });
  try {
    await fixture.run();
    const observationComment = fixture.store.comments.find(c => c.body.startsWith(OPERATOR_MARKER));
    const observation = parseOperatorObservation(observationComment.body);
    assert.equal(observation.native_worker.latest_task.state, 'LEGACY_READONLY_NOT_DISPATCHED');
    assert.equal(observation.native_worker.current_task, null);
    assert.equal(observation.native_worker.next_owner, 'REPLACE_WITH_SCOPED_EDIT_TASK');
  } finally { fixture.cleanup(); }
});

test('Worker main publishes the seeded observation, verifies sequence readback, and preserves legal dispatch on ambiguity', async () => {
  const successful = makeObservationWorkerFixture();
  try {
    await successful.run();
    let observations = successful.store.comments.filter(c => c.body.startsWith(OPERATOR_MARKER));
    assert.equal(observations.length, 1);
    assert.equal(observations[0].id, successful.observationId);
    assert.equal(observations[0].user.login, 'trusted-publisher');
    let value = parseOperatorObservation(observations[0].body);
    assert.equal(value.sequence, 18);
    assert.equal(Object.hasOwn(value, 'published_at'), false,
      'new snapshots use GitHub comment updated_at instead of a client-authored timestamp');
    assert.equal(observations[0].updated_at, new Date(successful.store.now + 2000).toISOString(),
      'publication time comes from the GitHub comment readback');
    assert.ok(successful.logs.includes('OPERATOR_OBSERVATION_UPDATED'));
    assert.deepEqual(successful.receiptWrites.map(x => x.state), ['STARTED', 'FINISHED']);
    assert.equal(successful.store.patches, 1);
    assert.equal(successful.modelCalls.count, 0);
    assert.equal(successful.codexDispatchCalls.count, 0);

    successful.store.now += 60_000;
    let result = await successful.run();
    assert.equal(result.state, 'NO_DELTA');
    for (let tick = 1; tick < 10; tick++) {
      successful.store.now += 60_000;
      result = await successful.run();
      assert.equal(result.state, 'NO_DELTA');
    }
    observations = successful.store.comments.filter(c => c.body.startsWith(OPERATOR_MARKER));
    value = parseOperatorObservation(observations[0].body);
    assert.equal(observations.length, 1);
    assert.equal(observations[0].id, successful.observationId);
    assert.equal(value.sequence, 28);
    assert.equal(successful.receiptWrites.length, 2);
    assert.equal(successful.logs.filter(x => x === 'NO_DELTA_NO_LLM').length, 10);
    assert.equal(successful.modelCalls.count, 0,
      'ten source-only idle ticks must not invoke the model adapter');
    assert.equal(successful.codexDispatchCalls.count, 0,
      'ten source-only idle ticks must not start the Codex executor');
  } finally { successful.cleanup(); }

  const ambiguous = makeObservationWorkerFixture({ ambiguousReadback: true });
  try {
    await ambiguous.run();
    const observations = ambiguous.store.comments.filter(c => c.body.startsWith(OPERATOR_MARKER));
    assert.equal(observations.length, 1);
    assert.equal(observations[0].id, ambiguous.observationId);
    assert.equal(ambiguous.store.patches, 1);
    assert.ok(ambiguous.logs.includes('OPERATOR_OBSERVATION_UPDATE_UNKNOWN'));
    assert.ok(!ambiguous.logs.includes('OPERATOR_OBSERVATION_UPDATED'));
    assert.deepEqual(ambiguous.receiptWrites.map(x => x.state), ['STARTED', 'FINISHED'],
      'an ambiguous status readback must not block an otherwise valid ping dispatch');

    ambiguous.store.now += 60_000;
    await ambiguous.run();
    const recovered = ambiguous.store.comments.filter(c => c.body.startsWith(OPERATOR_MARKER));
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].id, ambiguous.observationId);
    assert.equal(parseOperatorObservation(recovered[0].body).sequence, 19);
    assert.equal(ambiguous.receiptWrites.length, 2,
      'reconciliation must not replay the completed task or create duplicate receipts');
    assert.ok(ambiguous.logs.includes('OPERATOR_OBSERVATION_UPDATED'));
    assert.equal(ambiguous.modelCalls.count, 0);
    assert.equal(ambiguous.codexDispatchCalls.count, 0,
      'observation recovery must not launch the Codex executor');
  } finally { ambiguous.cleanup(); }
});

test('Worker main isolates prior OpenCode and incident evidence from a fresh host snapshot', async () => {
  const staleAt = Date.now() - 24 * 60 * 60 * 1000;
  const stale = seededOperatorObservation(701, 17, commit, staleAt);
  stale.opencode_v2 = {
    installed_version: 'opencode v2.0.28', version_verified_at: new Date(staleAt).toISOString(),
    binary_sha256: hash, process_observed_at: new Date(staleAt).toISOString(), process_count: 1,
    active_session_count: 1, active_session_state: 'RUNNING',
    historical_sessions_count: 9, historical_sessions_observed_at: new Date(staleAt).toISOString(),
    task_binding: 'PROVEN', model_execution: 'PROVEN',
    activity_observed_at: new Date(staleAt).toISOString(),
    last_tool_activity_at: new Date(staleAt).toISOString(), task_id: 'OLD_W1_TASK_20261015',
    request_id: 'PTYSD_NATIVE_OLD_W1_20261015', attempt_id: 'old-attempt-identifier',
    code_changes: 'PROVEN', remote_commit: commit, pull_request: 'https://github.com/example/repo/pull/1',
    ci: 'SUCCESS',
  };
  stale.monitor_candidate = { pr_number: 434, head_sha: commit, ci_status: 'PASS', state: 'OLD_DRAFT' };
  stale.incident = { summary: 'Old incident summary', acceptance_cycles: 7 };
  const fixture = makeObservationWorkerFixture({ priorObservation: stale, processCount: 1 });
  try {
    await fixture.run();
    const observation = fixture.store.comments.find(c => c.body.startsWith(OPERATOR_MARKER));
    const value = parseOperatorObservation(observation.body);
    assert.equal(value.sequence, 18);
    assert.equal(value.opencode_v2.process_count, 1);
    assert.equal(value.opencode_v2.process_observed_at, new Date(fixture.store.now).toISOString());
    assert.equal(value.opencode_v2.active_session_state, 'UNKNOWN_NO_PASSIVE_API');
    assert.equal(value.opencode_v2.task_binding, 'UNPROVEN');
    assert.equal(value.opencode_v2.model_execution, 'UNPROVEN');
    assert.equal(value.opencode_v2.activity_observed_at, null);
    assert.equal(value.opencode_v2.last_tool_activity_at, null);
    assert.equal(value.opencode_v2.task_id, null);
    assert.equal(value.opencode_v2.request_id, null);
    assert.equal(value.opencode_v2.attempt_id, null);
    assert.equal(value.opencode_v2.remote_commit, null);
    assert.equal(value.opencode_v2.pull_request, null);
    assert.equal(value.opencode_v2.ci, 'UNKNOWN');
    assert.equal(Object.hasOwn(value, 'monitor_candidate'), false,
      'a retired candidate field with no current consumer must not be emitted');
    assert.equal(value.incident, null);
    assert.equal(value.historical_evidence.snapshot_id, stale.snapshot_id);
    assert.equal(value.historical_evidence.observed_at, stale.observed_at);
    assert.equal(value.historical_evidence.opencode_v2.model_execution, 'PROVEN');
    assert.equal(value.historical_evidence.incident.summary, 'Old incident summary');
    assert.equal(fixture.logs.includes('OPERATOR_OBSERVATION_UPDATED'), true);
    assert.equal(fixture.modelCalls.count, 0);
    assert.equal(fixture.codexDispatchCalls.count, 0);
  } finally { fixture.cleanup(); }
});

test('Worker observation recognizes an exact open PR candidate whose HEAD differs from main', async () => {
  const candidateSha = 'c'.repeat(40);
  const candidateJob = { ...mkjob({ host: hostname().toUpperCase(),
    request_id: 'PTYSD_NATIVE_EDIT_PR434_OBSERVATION', kind: 'opencode_edit',
    source_sha: candidateSha, spec_path: 'native-bridge/tasks/scoped-edit.md',
    spec_sha256: hash }), schema: 5, model: 'opencode/spark', variant: 'high',
    write_paths: ['README.md'], candidate_pr: 434 };
  const candidatePullRequest = {
    number: 434, state: 'open',
    base: { ref: 'main', sha: commit, repo: { id: REPO_ID, full_name: REPO } },
    head: { sha: candidateSha, repo: { id: REPO_ID, full_name: REPO } },
  };
  const fixture = makeObservationWorkerFixture({ job: candidateJob, candidatePullRequest });
  try {
    await fixture.run();
    const comment = fixture.store.comments.find(c => c.body.startsWith(OPERATOR_MARKER));
    const observation = parseOperatorObservation(comment.body);
    assert.equal(observation.native_worker.latest_task.state, 'QUEUED_NOT_STARTED');
    assert.equal(observation.native_worker.current_task.candidate_pr, 434);
    assert.equal(observation.native_worker.current_task.source_sha, candidateSha);
    assert.equal(fixture.modelCalls.count, 0);
    assert.equal(fixture.codexDispatchCalls.count, 0);
  } finally { fixture.cleanup(); }
});

test('candidate PR pin readback preserves the exact state of an already-started edit', async () => {
  const candidateSha = 'd'.repeat(40);
  const candidateJob = { ...mkjob({ host: hostname().toUpperCase(),
    request_id: 'PTYSD_NATIVE_EDIT_PR434_STARTED', kind: 'opencode_edit',
    source_sha: candidateSha, spec_path: 'native-bridge/tasks/scoped-edit.md',
    spec_sha256: hash }), schema: 5, model: 'opencode/spark', variant: 'high',
    write_paths: ['README.md'], candidate_pr: 434 };
  const candidatePullRequest = {
    number: 434, state: 'open',
    base: { ref: 'main', sha: commit, repo: { id: REPO_ID, full_name: REPO } },
    head: { sha: candidateSha, repo: { id: REPO_ID, full_name: REPO } },
  };
  const fixture = makeObservationWorkerFixture({ job: candidateJob, candidatePullRequest });
  try {
    const started = receipt(candidateJob.request_id, '00000000-0000-4000-8000-000000000001',
      'STARTED', candidateJob);
    fixture.store.comments.push(com(703, RECEIPT_MARKER + JSON.stringify(started), 'trusted-publisher'));
    await fixture.run();
    const comment = fixture.store.comments.find(c => c.body.startsWith(OPERATOR_MARKER));
    const observation = parseOperatorObservation(comment.body);
    assert.equal(observation.native_worker.latest_task.state, 'STARTED_UNVERIFIED');
    assert.equal(observation.native_worker.current_task.candidate_pr, 434);
    assert.equal(observation.native_worker.current_task.source_sha, candidateSha);
    assert.equal(fixture.modelCalls.count, 0);
    assert.equal(fixture.codexDispatchCalls.count, 0);
  } finally { fixture.cleanup(); }
});

test('receipt write reconciles POST-success/readback-failure without posting a duplicate', () => {
  const job = mkjob();
  const attemptId = 'e416334f-404c-4e61-9b0e-f9283ee07013';
  const terminal = receipt(job.request_id, attemptId, 'FINISHED', job, {
    outcome: 'BRIDGE_PING_OK_NOT_OS_ACCEPTANCE', exit_code: 0,
  });
  const comments = [];
  let postCalls = 0;
  let failAfterPost = true;
  const dependencies = {
    readComments: () => {
      if (postCalls && failAfterPost) {
        failAfterPost = false;
        throw new Error('MOCK_REMOTE_READBACK_FAILED');
      }
      return structuredClone(comments);
    },
    postComment: body => {
      postCalls++;
      comments.push(com(1, body, 'worker'));
    },
  };
  assert.throws(() => writeReceipt({}, terminal, 'worker', dependencies),
    /RECEIPT_WRITE_AMBIGUOUS_NO_EXECUTION/);
  assert.equal(comments.length, 1);
  assert.equal(writeReceipt({}, terminal, 'worker', dependencies).status, 'ALREADY_PRESENT');
  assert.equal(postCalls, 1);
  assert.equal(comments.filter(c => parseReceipt(c.body)?.attempt_id === attemptId).length, 1);

  const conflicting = { ...terminal, outcome: 'DIFFERENT_ORIGINAL_CONTENT' };
  let conflictPosts = 0;
  assert.throws(() => writeReceipt({}, conflicting, 'worker', {
    readComments: () => comments,
    postComment: () => conflictPosts++,
  }), /RECEIPT_IDENTITY_CONFLICT/);
  assert.equal(conflictPosts, 0);
});

test('strict exact job contract rejects injection, cross-project, unknown keys and paths', () => {
  assert.deepEqual(parseJob(encoded(mkjob())), mkjob());
  assert.equal(parseJob(encoded(mkjob({ project_id: 'HANYAO' }))), null);
  assert.equal(selectNext([com(1,encoded(mkjob({ host:'OTHER-PC' })))],['t14210184'],'worker',TEST_HOST),null);
  assert.equal(parseJob(encoded(mkjob({ kind: 'shell' }))), null);
  assert.equal(parseJob(encoded({ ...mkjob(), command: 'Remove-Item C:\\' })), null);
  assert.equal(parseJob(encoded(mkjob({ kind: 'opencode_plan', spec_path: '../secrets', spec_sha256: hash }))), null);
  assert.equal(parseJob(encoded(mkjob({ kind: 'opencode_plan', spec_path: 'native-bridge/tasks/review.md', spec_sha256: hash }))),null);
  const modelJob = { ...mkjob(), schema: 2, kind: 'opencode_plan', spec_path:'native-bridge/tasks/review.md',
    spec_sha256: hash, model:'opencode/spark', variant:'high' };
  assert.equal(parseJob(encoded(modelJob)).kind, 'opencode_plan');
  assert.equal(parseJob(encoded({...modelJob, model:'https://wrong'})),null);
  assert.equal(parseJob(encoded({...modelJob, variant:'unverified'})).variant,'unverified');
  assert.equal(checkModelAuthorization({...modelJob, variant:'unverified'}, {allowed_models:{'opencode/spark':['high']}}),false);
  assert.equal(parseJob(encoded({...modelJob, shell:'pwsh'})),null);
  assert.equal(parseJob(encoded(mkjob({kind:'native_preflight'}))).kind,'native_preflight');
  assert.equal(parseJob(encoded(mkjob({kind:'native_v2_qualify'}))).kind,'native_v2_qualify');
  assert.equal(parseJob(encoded(mkjob({kind:'native_v2_qualify',spec_path:'tasks/other.md'}))),null);
  assert.equal(checkModelAuthorization(modelJob,{ allowed_models:{ 'opencode/spark':['high'] } }),false,
    'legacy read-only plans are never authorized to invoke a model');
  const editJob={...mkjob({request_id:'PTYSD_NATIVE_EDIT_CONTRACT_20261015',kind:'opencode_edit',
    spec_path:'native-bridge/tasks/scoped-edit.md',spec_sha256:hash}),schema:4,
    model:'opencode/spark',variant:'high',write_paths:['README.md']};
  assert.equal(parseJob(encoded(editJob)).kind,'opencode_edit');
  assert.equal(parseJob(encoded({...editJob,write_paths:['../outside.txt']})),null);
  assert.equal(parseJob(encoded({...editJob,write_paths:['README.md','readme.md']})),null);
  const broadPaths=Array.from({length:80},(_,index)=>
    `native-bridge/reviewed-${String(index).padStart(3,'0')}-${'x'.repeat(90)}.mjs`);
  const broadEditJob={...editJob,write_paths:broadPaths};
  assert.ok(encoded(broadEditJob).length>5000,'regression fixture exceeds the former task body ceiling');
  assert.equal(parseJob(encoded(broadEditJob)).kind,'opencode_edit',
    'valid exact OpenCode scopes are not rejected by a local serialized-size ceiling');
  assert.equal(selectNext([com(900,encoded(broadEditJob))],['t14210184'],'worker',
    broadEditJob.host,commit).job.write_paths.length,broadPaths.length,
    'the native dispatcher can select the complete reviewed OpenCode scope');
  const broadEditReceipt=receipt(broadEditJob.request_id,'00000000-0000-4000-8000-000000000008',
    'FINISHED',broadEditJob,{changed_paths:broadPaths,diff_sha256:hash});
  assert.ok((RECEIPT_MARKER+JSON.stringify(broadEditReceipt)).length>12000,
    'regression fixture exceeds the former terminal receipt body ceiling');
  assert.deepEqual(parseReceipt(RECEIPT_MARKER+JSON.stringify(broadEditReceipt)),broadEditReceipt);
  assert.equal(checkModelAuthorization(editJob,{allowed_models:{'opencode/spark':['high']},
    allowed_edit_models:{'opencode/spark':['high']},enable_v2_edit_runs:false}),false);
  assert.equal(checkModelAuthorization(editJob,{allowed_edit_models:{'opencode/spark':['high']},
    enable_v2_edit_runs:true}),false,
    'a legacy edit without the current Human GOAL binding cannot authorize a model run');
  const goalBody='# V5.3-R4\nPTYSD_V53R4_DELETE_FIRST_AUTONOMY_GOAL_20261015\nAuthorized context.';
  const boundEditJob={...editJob,schema:6,candidate_pr:434,goal_ref:{issue:310,comment_id:6188322050,
    marker:'PTYSD_V53R4_DELETE_FIRST_AUTONOMY_GOAL_20261015',body_sha256:h(goalBody)}};
  assert.equal(checkModelAuthorization(boundEditJob,{allowed_edit_models:{'opencode/spark':['high']},
    enable_v2_edit_runs:true}),true,
    'only a Human-GOAL-bound, candidate-PR edit with an exact model variant can authorize');
  const editStart=receipt(editJob.request_id,'00000000-0000-4000-8000-000000000004','STARTED',editJob);
  assert.deepEqual(parseReceipt(RECEIPT_MARKER+JSON.stringify(editStart)),editStart);
  assert.equal(parseReceipt(RECEIPT_MARKER+JSON.stringify({...editStart,changed_paths:['package.json']})),null);
  assert.equal(parseJob('garbage'), null);
});

test('unbundled scoped OpenCode edit manifests are rejected before executor dispatch', () => {
  const spec='Edit only README.md from the exact source revision.';
  const job=bindGoalJob({...mkjob({host:hostname().toUpperCase(),request_id:'PTYSD_NATIVE_EDIT_NO_BUNDLE_20261016',
    kind:'opencode_edit',spec_path:'native-bridge/tasks/scoped-edit.md',spec_sha256:h(spec)}),
    model:'opencode/spark',variant:'high',write_paths:['README.md']});
  assert.throws(()=>makeExecutorManifest(job,spec,'00000000-0000-4000-8000-000000000004'),/EXECUTOR_EDIT_SOURCE_BUNDLE_REQUIRED/,
    'a scoped path list cannot substitute for an isolated, immutable source worktree');
});

test('an unbound legacy OpenCode edit cannot dispatch and does not starve an independent ping', async () => {
  const root=mkdtempSync(join(homedir(),'.ptysd-opencode-unbound-goal-'));
  try {
    const workspace=join(root,'workspace'),stateDir=join(root,'state');
    const manifestDir=join(root,'manifests'),resultsDir=join(root,'results');
    mkdirSync(workspace);mkdirSync(stateDir);mkdirSync(manifestDir);mkdirSync(resultsDir);
    mkdirSync(join(manifestDir,'candidate-bundles'));
    const spec='Edit only README.md from the exact reviewed source.';
    const host=hostname().toUpperCase();
    const edit={...mkjob({host,request_id:'PTYSD_NATIVE_EDIT_UNBOUND_GOAL_20261016',
      kind:'opencode_edit',spec_path:'native-bridge/tasks/scoped-edit.md',spec_sha256:h(spec)}),
      schema:4,model:'opencode/spark',variant:'high',write_paths:['README.md']};
    const ping=mkjob({host,request_id:'PTYSD_NATIVE_PING_AFTER_UNBOUND_EDIT_20261016'});
    const comments=[com(1,encoded(edit),'dispatcher'),com(2,encoded(ping),'dispatcher')];
    const executor={task_name:'\\PTYSD\\OpenCodeExecutor',user_sid:'S-1-5-21-100-200-300-1001',
      publisher_sid:'S-1-5-21-100-200-300-1002',node_bin:'C:\\Node\\node.exe',
      script_path:'C:\\PTYSD\\executor.mjs',config_path:'C:\\PTYSD\\executor.json',
      manifest_dir:manifestDir,results_dir:resultsDir,working_directory:'C:\\PTYSD'};
    const writes=[];let dispatches=0,bundleBuilds=0;
    const result=await executeWorker({repo:REPO,project_id:PROJECT,host,issue:101,workspace,state_dir:stateDir,
      dispatchers:['dispatcher'],enable_v2_edit_runs:true,allowed_edit_models:{'opencode/spark':['high']},executor},{
      apiRead(endpoint) {
        if(endpoint==='user')return {login:'worker'};
        if(endpoint.endsWith('/issues/101'))return {title:ISSUE_TITLE,state:'open'};
        if(endpoint.includes('/git/ref/heads/main'))return {object:{sha:commit}};
        if(endpoint.includes('/contents/'))return {encoding:'base64',content:Buffer.from(spec).toString('base64')};
        const match=endpoint.match(/\/issues\/comments\/(\d+)$/);
        if(match)return comments.find(item=>item.id===Number(match[1]));
        throw new Error(`UNEXPECTED_UNBOUND_GOAL_API:${endpoint}`);
      },
      commentsRead:()=>comments,
      writeReceipt:(_config,data,login)=>{
        writes.push(data);
        comments.push(com(comments.length+1,RECEIPT_MARKER+JSON.stringify(data),login));
      },
      qualifyOpenCodeV2:()=>({ready:true}),
      assertExecutorTaskReady:()=>({ready:true}),
      createCandidateSourceBundle:()=>{bundleBuilds++;return {source_sha:commit,sha256:'f'.repeat(64)};},
      dispatchToExecutor:()=>{dispatches++;return {outcome:'EXECUTOR_TASK_DISPATCHED_NOT_ACCEPTANCE'};},
      runPlan:()=>{throw new Error('MODEL_MUST_NOT_RUN_INLINE');},
      log:()=>{},
    });
    assert.equal(result.state,'FINISHED');
    assert.equal(result.request_id,ping.request_id);
    assert.equal(bundleBuilds,0,'a task without a current Human GOAL binding is rejected before bundle creation');
    assert.equal(dispatches,0,'an unbound legacy write job cannot reach the executor');
    assert.deepEqual(writes.map(item=>[item.request_id,item.state]),[
      [ping.request_id,'STARTED'],[ping.request_id,'FINISHED'],
    ]);
    assert.equal(writes.some(item=>item.request_id===edit.request_id),false,
      'the rejected edit remains available for a correctly bound replacement');
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('authorized OpenCode edit jobs are handed to the existing isolated executor and never run inline', async () => {
  const root=mkdtempSync(join(homedir(),'.ptysd-opencode-edit-dispatch-'));
  try {
    const workspace=join(root,'workspace'),stateDir=join(root,'state');
    const manifestDir=join(root,'manifests'),resultsDir=join(root,'results');
    mkdirSync(workspace); mkdirSync(stateDir); mkdirSync(manifestDir); mkdirSync(resultsDir);
    mkdirSync(join(manifestDir,'candidate-bundles'));
    const spec='Change only the listed source file and report the diff.';
    const job=bindGoalJob({...mkjob({host:hostname().toUpperCase(),request_id:'PTYSD_NATIVE_EDIT_ROUTE_20261015',
      kind:'opencode_edit',spec_path:'native-bridge/tasks/scoped-edit.md',spec_sha256:h(spec)}),
      model:'opencode/spark',variant:'high',write_paths:['README.md']});
    const comments=[com(1,encoded(job),'dispatcher')];
    const executor={task_name:'\\PTYSD\\OpenCodeExecutor',user_sid:'S-1-5-21-100-200-300-1001',
      publisher_sid:'S-1-5-21-100-200-300-1002',node_bin:'C:\\Node\\node.exe',
      script_path:'C:\\PTYSD\\executor.mjs',config_path:'C:\\PTYSD\\executor.json',
      manifest_dir:manifestDir,results_dir:resultsDir,
      working_directory:'C:\\PTYSD'};
    let dispatched=null,inlineCalls=0,nextId=2;
    const workerConfig={repo:REPO,project_id:PROJECT,host:hostname().toUpperCase(),issue:101,
      workspace,state_dir:stateDir,dispatchers:['dispatcher'],enable_v2_edit_runs:true,
      allowed_edit_models:{'opencode/spark':['high']},executor};
    const workerAdapters={
      apiRead(endpoint) {
        if(endpoint==='user') return {login:'worker'};
        if(endpoint.endsWith('/issues/101')) return {title:ISSUE_TITLE,state:'open'};
        if(endpoint.includes('/git/ref/heads/main')) return {object:{sha:commit}};
        if(endpoint.endsWith('/pulls/434')) return testCandidatePull();
        if(endpoint.endsWith(`/issues/comments/${TEST_GOAL_REF.comment_id}`)) return TEST_GOAL_COMMENT;
        if(endpoint.includes('/contents/')) return {encoding:'base64',content:Buffer.from(spec).toString('base64')};
        const match=endpoint.match(/\/issues\/comments\/(\d+)$/);
        if(match) return comments.find(item=>item.id===Number(match[1]));
        throw new Error(`UNEXPECTED_EDIT_ROUTE_API:${endpoint}`);
      },
      commentsRead:()=>comments,
      goalCommentsRead:()=>[TEST_GOAL_COMMENT],
      writeReceipt(_config,data,login) { comments.push(com(nextId++,RECEIPT_MARKER+JSON.stringify(data),login)); },
      qualifyOpenCodeV2:()=>({ready:true}),
      createCandidateSourceBundle:({job:bundleJob,executor:bundleExecutor,attemptId})=>{
        const bytes=Buffer.from('immutable test source bundle');
        writeFileSync(candidateBundlePath(bundleExecutor.manifest_dir,attemptId),bytes,{flag:'wx'});
        return {source_sha:bundleJob.source_sha,sha256:h(bytes)};
      },
      assertExecutorTaskReady:()=>({ready:true}),
      dispatchToExecutor:(_descriptor,manifest)=>{
        dispatched=manifest;
        const stored=makeExecutorManifest(manifest.job,manifest.spec,manifest.attempt_id,
          manifest.source_bundle_sha256);
        writeFileSync(join(manifestDir,`${manifest.attempt_id}.pending.json`),JSON.stringify(stored),{flag:'wx'});
        return {outcome:'EXECUTOR_TASK_DISPATCHED_NOT_ACCEPTANCE'};
      },
      runPlan:()=>{inlineCalls++;throw new Error('MODEL_MUST_NOT_RUN_IN_DISPATCHER');},
      log:()=>{},
    };
    const result=await executeWorker(workerConfig,workerAdapters);
    assert.equal(result.state,'WAITING_EXECUTOR_START_EVIDENCE');
    assert.equal(dispatched.job.kind,'opencode_edit');
    assert.deepEqual(dispatched.job.write_paths,['README.md']);
    assert.equal(dispatched.spec,spec);
    assert.equal(dispatched.source_bundle_sha256,h(Buffer.from('immutable test source bundle')));
    assert.equal(inlineCalls,0);
    assert.equal(comments.filter(item=>parseReceipt(item.body)?.request_id===job.request_id).length,0,
      'a queued manifest without a process-spawn record must not publish STARTED');
    const attemptId=dispatched.attempt_id;
    const manifestPath=join(manifestDir,`${attemptId}.pending.json`);
    const manifestBytes=readFileSync(manifestPath);
    const ping=mkjob({host:hostname().toUpperCase(),request_id:'PTYSD_NATIVE_PING_DURING_EXECUTOR_WAIT_20261016'});
    comments.push(com(nextId++,encoded(ping),'dispatcher'));
    const retriggered=[];
    const pingResult=await executeWorker(workerConfig,{...workerAdapters,
      triggerPendingExecutorAttempt:(_descriptor,id)=>{
        retriggered.push(id);return {outcome:'EXECUTOR_PENDING_ATTEMPT_TRIGGERED_NOT_ACCEPTANCE'};
      }});
    assert.equal(pingResult.state,'FINISHED','a pending OpenCode attempt must not starve an independent ping');
    assert.deepEqual(retriggered,[attemptId],'the same pending attempt is reevaluated without creating a new one');
    assert.equal(readFileSync(manifestPath).equals(manifestBytes),true);
    assert.equal(comments.filter(item=>parseReceipt(item.body)?.request_id===job.request_id).length,0);

    const runningPath=join(manifestDir,`${attemptId}.running.json`);
    renameSync(manifestPath,runningPath);
    const pingWithoutProcessProof=mkjob({host:hostname().toUpperCase(),
      request_id:'PTYSD_NATIVE_PING_DURING_UNKNOWN_EXECUTOR_START_20261016'});
    comments.push(com(nextId++,encoded(pingWithoutProcessProof),'dispatcher'));
    const unknownStart=await executeWorker(workerConfig,workerAdapters);
    assert.equal(unknownStart.state,'FINISHED',
      'a running manifest without a bound OS process record must leave independent work runnable');
    assert.equal(comments.filter(item=>parseReceipt(item.body)?.request_id===job.request_id).length,0,
      'running mailbox state alone is not proof that the model process started');
    writeFileSync(executorProcessPath(resultsDir,attemptId),JSON.stringify({
      schema:1,kind:'PTYSD_NATIVE_EXECUTOR_PROCESS_V1',request_id:job.request_id,
      attempt_id:attemptId,source_sha:job.source_sha,spec_sha256:job.spec_sha256,
      manifest_sha256:h(manifestBytes),job_sha256:h(JSON.stringify(job)),
      process_id:7318,process_created_at:'2026-10-16T00:00:00.000Z',
      observed_at:'2026-10-16T00:00:00.100Z',
    }),{flag:'wx'});
    const confirmed=await executeWorker(workerConfig,workerAdapters);
    assert.equal(confirmed.state,'NO_DELTA');
    const editReceipts=comments.filter(item=>parseReceipt(item.body)?.request_id===job.request_id)
      .map(item=>parseReceipt(item.body));
    assert.deepEqual(editReceipts.map(item=>[item.attempt_id,item.state]),[[attemptId,'STARTED']],
      'STARTED is published only after process evidence matches the exact running manifest');
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('OpenCode PR-pinned dispatch refuses STARTED if the trusted job comment changes during launch', async () => {
  const root=mkdtempSync(join(homedir(),'.ptysd-opencode-pr-pin-'));
  try {
    const workspace=join(root,'workspace'),stateDir=join(root,'state');
    mkdirSync(workspace); mkdirSync(stateDir);
    const spec='Change only the listed source file and report the diff.';
    const goalBody='# V5.3-R4\nPTYSD_V53R4_DELETE_FIRST_AUTONOMY_GOAL_20261015\nAuthorized source-work context.';
    const goalRef={issue:310,comment_id:6188322050,
      marker:'PTYSD_V53R4_DELETE_FIRST_AUTONOMY_GOAL_20261015',body_sha256:h(goalBody)};
    const mainSha='a'.repeat(40),candidateSha='d'.repeat(40),prNumber=434;
    const job={...mkjob({host:hostname().toUpperCase(),request_id:'PTYSD_NATIVE_EDIT_PR434_20261016',
      kind:'opencode_edit',source_sha:candidateSha,spec_path:'native-bridge/tasks/scoped-edit.md',
      spec_sha256:h(spec)}),schema:6,model:'opencode/spark',variant:'high',
      write_paths:['README.md'],candidate_pr:prNumber,goal_ref:goalRef};
    const pullRequest={number:prNumber,state:'open',base:{ref:'main',sha:mainSha,
      repo:{id:1352411536,full_name:REPO}},head:{sha:candidateSha,
      repo:{id:1352411536,full_name:REPO}}};
    const comments=[com(1,encoded(job),'dispatcher')];
    const executor={task_name:'\\PTYSD\\OpenCodeExecutor',user_sid:'S-1-5-21-100-200-300-1001',
      publisher_sid:'S-1-5-21-100-200-300-1002',node_bin:'C:\\Node\\node.exe',
      script_path:'C:\\PTYSD\\executor.mjs',config_path:'C:\\PTYSD\\executor.json',
      manifest_dir:'C:\\PTYSD\\manifests',results_dir:'C:\\PTYSD\\results',
      working_directory:'C:\\PTYSD'};
    let prReads=0,bundleBuilds=0,dispatched=null,nextId=2;
    const result=await executeWorker({repo:REPO,project_id:PROJECT,host:hostname().toUpperCase(),issue:101,
      workspace,state_dir:stateDir,dispatchers:['dispatcher'],enable_v2_edit_runs:true,
      allowed_edit_models:{'opencode/spark':['high']},executor},{
      apiRead(endpoint) {
        if(endpoint==='user') return {login:'worker'};
        if(endpoint.endsWith('/issues/101')) return {title:ISSUE_TITLE,state:'open'};
        if(endpoint.includes('/git/ref/heads/main')) return {object:{sha:mainSha}};
        if(endpoint.endsWith(`/pulls/${prNumber}`)) { prReads++; return pullRequest; }
        if(endpoint.endsWith(`/issues/comments/${goalRef.comment_id}`)) return {
          id:goalRef.comment_id,
          issue_url:`https://api.github.com/repos/${REPO}/issues/${goalRef.issue}`,
          user:{login:'dispatcher'},body:goalBody,
        };
        if(endpoint.includes('/contents/')) return {encoding:'base64',content:Buffer.from(spec).toString('base64')};
        const match=endpoint.match(/\/issues\/comments\/(\d+)$/);
        if(match) return comments.find(item=>item.id===Number(match[1]));
        throw new Error(`UNEXPECTED_CANDIDATE_PIN_API:${endpoint}`);
      },
      commentsRead:()=>comments,
      goalCommentsRead:()=>[{id:goalRef.comment_id,issue_url:`https://api.github.com/repos/${REPO}/issues/310`,
        user:{login:'dispatcher'},body:goalBody}],
      writeReceipt(_config,data,login) { comments.push(com(nextId++,RECEIPT_MARKER+JSON.stringify(data),login)); },
      qualifyOpenCodeV2:()=>({ready:true}),
      assertExecutorTaskReady:()=>({ready:true}),
      inspectOpenCodeExecutorAttempt:(_descriptor,expected={})=>expected.job ? {state:'STARTED'} : {state:'EMPTY'},
      dispatchToExecutor:(_descriptor,manifest)=>{
        dispatched=manifest;
        comments[0].body=encoded({...job,write_paths:['README.md','OTHER.md']});
        return {outcome:'EXECUTOR_TASK_DISPATCHED_NOT_ACCEPTANCE'};
      },
      createCandidateSourceBundle:({job:bundleJob})=>{
        bundleBuilds++;
        assert.equal(bundleJob.source_sha,candidateSha);
        return {source_sha:candidateSha,sha256:'f'.repeat(64)};
      },
      runPlan:()=>{throw new Error('MODEL_MUST_NOT_RUN_IN_DISPATCHER');},
      log:()=>{},
    });
    assert.equal(result.state,'UNKNOWN_EXECUTOR_START_SOURCE_READBACK');
    assert.equal(prReads,3,'the PR head is read at selection, before bundling, and after bundling');
    assert.equal(bundleBuilds,1);
    assert.equal(dispatched.job.source_sha,candidateSha);
    assert.equal(dispatched.job.candidate_pr,prNumber);
    assert.deepEqual(dispatched.job.goal_ref,goalRef);
    assert.equal(dispatched.source_bundle_sha256,'f'.repeat(64));
    assert.equal(comments.some(item=>parseReceipt(item.body)?.request_id===job.request_id),false,
      'process evidence cannot authorize a STARTED receipt after the pinned source job changes');
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('source-bound OpenCode job requires a read-back of the exact trusted Human GOAL comment', () => {
  const goalBody='# V5.3-R4\nPTYSD_V53R4_DELETE_FIRST_AUTONOMY_GOAL_20261015\nAuthorized source-work context.';
  const goalRef={issue:310,comment_id:6188322050,
    marker:'PTYSD_V53R4_DELETE_FIRST_AUTONOMY_GOAL_20261015',body_sha256:h(goalBody)};
  const job={...mkjob({request_id:'PTYSD_GOAL_BOUND_EDIT_20261016',kind:'opencode_edit',
    spec_path:'native-bridge/tasks/scoped-edit.md',spec_sha256:hash}),schema:6,
    model:'opencode/spark',variant:'high',write_paths:['README.md'],candidate_pr:434,goal_ref:goalRef};
  assert.deepEqual(parseJob(encoded(job)),job);
  for(const goal of [
    {...goalRef,issue:311},
    {...goalRef,comment_id:0},
    {...goalRef,marker:'UNRELATED_COMMENT'},
    {...goalRef,body_sha256:'bad'},
    {...goalRef,extra:'not-in-the-contract'},
  ]) assert.equal(parseJob(encoded({...job,goal_ref:goal})),null);
  const comment={id:goalRef.comment_id,
    issue_url:`https://api.github.com/repos/${REPO}/issues/${goalRef.issue}`,
    user:{login:'dispatcher'},body:goalBody};
  const read=(value, goals=[comment])=>verifyGoalReference(job,['dispatcher'],uri=>{
    assert.equal(uri,`repos/${REPO}/issues/comments/${goalRef.comment_id}`);
    return value;
  },()=>goals);
  assert.deepEqual(read(comment),{valid:true,reason:null});
  assert.equal(read(comment,[comment,{...comment,id:goalRef.comment_id+1,body:goalBody+' revised'}]).reason,
    'GOAL_COMMENT_SUPERSEDED');
  assert.equal(verifyGoalReference(job,['dispatcher'],()=>comment,()=>{throw new Error('network unavailable');}).reason,
    'LATEST_GOAL_READBACK_UNKNOWN');
  assert.equal(verifyGoalReference(job,['dispatcher'],()=>comment,()=>null).reason,
    'LATEST_GOAL_READBACK_UNKNOWN');
  assert.equal(read({...comment,user:{login:'outsider'}}).reason,'GOAL_COMMENT_IDENTITY_MISMATCH');
  assert.equal(read({...comment,issue_url:`https://api.github.com/repos/${REPO}/issues/311`}).reason,
    'GOAL_COMMENT_IDENTITY_MISMATCH');
  assert.equal(read({...comment,body:goalBody+' changed'}).reason,'GOAL_COMMENT_CONTENT_MISMATCH');
  assert.equal(verifyGoalReference(job,['dispatcher'],()=>{throw new Error('network unavailable');},()=>[comment]).reason,
    'GOAL_COMMENT_READBACK_UNKNOWN');
});

test('candidate OpenCode edit waits for unavailable Human GOAL readback without starving an independent ping', async () => {
  const root=mkdtempSync(join(homedir(),'.ptysd-opencode-goal-readback-'));
  try {
    const workspace=join(root,'workspace'),stateDir=join(root,'state');
    mkdirSync(workspace);mkdirSync(stateDir);
    const goalBody='# V5.3-R4\nPTYSD_V53R4_DELETE_FIRST_AUTONOMY_GOAL_20261015\nAuthorized context.';
    const goalRef={issue:310,comment_id:6188322050,
      marker:'PTYSD_V53R4_DELETE_FIRST_AUTONOMY_GOAL_20261015',body_sha256:h(goalBody)};
    const goalComment={id:goalRef.comment_id,body:goalBody,
      issue_url:`https://api.github.com/repos/${REPO}/issues/310`,user:{login:'dispatcher'}};
    const mainSha='a'.repeat(40),candidateSha='d'.repeat(40),prNumber=434;
    const spec='Edit only README.md.';
    const job={...mkjob({host:hostname().toUpperCase(),request_id:'PTYSD_GOAL_READBACK_WAIT_20261016',
      kind:'opencode_edit',source_sha:candidateSha,spec_path:'native-bridge/tasks/scoped-edit.md',
      spec_sha256:h(spec)}),schema:6,model:'opencode/spark',variant:'high',
      write_paths:['README.md'],candidate_pr:prNumber,goal_ref:goalRef};
    const ping=mkjob({host:hostname().toUpperCase(),request_id:'PTYSD_PING_AFTER_GOAL_READBACK_WAIT_20261016'});
    const pr={number:prNumber,state:'open',base:{ref:'main',sha:mainSha,
      repo:{id:REPO_ID,full_name:REPO}},head:{sha:candidateSha,
      repo:{id:REPO_ID,full_name:REPO}}};
    const comments=[com(1,encoded(job),'dispatcher'),com(2,encoded(ping),'dispatcher')];
    const executor={task_name:'\\PTYSD\\OpenCodeExecutor',user_sid:'S-1-5-21-100-200-300-1001',
      publisher_sid:'S-1-5-21-100-200-300-1002',node_bin:'C:\\Node\\node.exe',
      script_path:'C:\\PTYSD\\executor.mjs',config_path:'C:\\PTYSD\\executor.json',
      manifest_dir:join(root,'manifests'),results_dir:join(root,'results'),working_directory:root};
    let dispatches=0,bundleBuilds=0,goalReads=0; const receiptWrites=[],logs=[];
    const result=await executeWorker({repo:REPO,project_id:PROJECT,host:hostname().toUpperCase(),issue:101,
      workspace,state_dir:stateDir,dispatchers:['dispatcher'],enable_v2_edit_runs:true,
      allowed_edit_models:{'opencode/spark':['high']},executor}, {
      apiRead(endpoint) {
        if(endpoint==='user') return {login:'worker'};
        if(endpoint.endsWith('/issues/101')) return {title:ISSUE_TITLE,state:'open'};
        if(endpoint.includes('/git/ref/heads/main')) return {object:{sha:mainSha}};
        if(endpoint.endsWith(`/pulls/${prNumber}`)) return pr;
        if(endpoint.includes('/contents/')) return {encoding:'base64',content:Buffer.from(spec).toString('base64')};
        if(endpoint.endsWith(`/issues/comments/${goalRef.comment_id}`)) {
          goalReads++;
          throw new Error('temporary final readback failure');
        }
        const match=endpoint.match(/\/issues\/comments\/(\d+)$/);
        if(match) return comments.find(item=>item.id===Number(match[1]));
        throw new Error(`UNEXPECTED_GOAL_MISMATCH_API:${endpoint}`);
      },
      commentsRead:()=>comments,
      goalCommentsRead:()=>[goalComment],
      writeReceipt:(_config,data,login)=>{
        receiptWrites.push(data);
        comments.push(com(comments.length+1,RECEIPT_MARKER+JSON.stringify(data),login));
      },
      qualifyOpenCodeV2:()=>({ready:true}),
      assertExecutorTaskReady:()=>({ready:true}),
      inspectOpenCodeExecutorAttempt:(_descriptor,expected={})=>expected.job ? {state:'STARTED'} : {state:'EMPTY'},
      createCandidateSourceBundle:()=>{bundleBuilds++;return {source_sha:candidateSha,sha256:'f'.repeat(64)};},
      dispatchToExecutor:()=>{dispatches++;return {outcome:'EXECUTOR_TASK_DISPATCHED_NOT_ACCEPTANCE'};},
      runPlan:()=>{throw new Error('MODEL_MUST_NOT_RUN_IN_DISPATCHER');},
      log:value=>logs.push(value),
    });
    assert.equal(result.state,'FINISHED','a transiently unverifiable edit must not starve independent ping work');
    assert.equal(result.request_id,ping.request_id);
    assert.ok(logs.some(line=>line.includes(`HUMAN_GOAL_REFERENCE_WAITING_GOAL_COMMENT_READBACK_UNKNOWN_${job.request_id}_NO_START`)));
    assert.equal(goalReads,1,'the GOAL is read at the final pre-dispatch boundary');
    assert.equal(bundleBuilds,1,'only the isolated candidate bundle was prepared before the failed final readback');
    assert.equal(dispatches,0);
    assert.deepEqual(receiptWrites.map(item=>[item.request_id,item.state]),[
      [ping.request_id,'STARTED'],[ping.request_id,'FINISHED'],
    ]);
    assert.equal(receiptWrites.some(item=>item.request_id===job.request_id),false,
      'a GOAL readback mismatch never starts or terminally consumes the edit request');
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('candidate OpenCode edit is not dispatched after its bound Human GOAL is superseded', async () => {
  const root=mkdtempSync(join(homedir(),'.ptysd-opencode-goal-superseded-'));
  try {
    const workspace=join(root,'workspace'),stateDir=join(root,'state');
    mkdirSync(workspace);mkdirSync(stateDir);
    const oldBody='# V5.3-R4\nPTYSD_V53R4_DELETE_FIRST_AUTONOMY_GOAL_20261015\nOld authorized scope.';
    const latestBody='# V5.3-R4\nPTYSD_V53R4_DELETE_FIRST_AUTONOMY_GOAL_20261015\nUpdated authorized scope.';
    const goalRef={issue:310,comment_id:6188322050,
      marker:'PTYSD_V53R4_DELETE_FIRST_AUTONOMY_GOAL_20261015',body_sha256:h(oldBody)};
    const oldGoal={id:goalRef.comment_id,body:oldBody,
      issue_url:`https://api.github.com/repos/${REPO}/issues/310`,user:{login:'dispatcher'}};
    const latestGoal={...oldGoal,id:goalRef.comment_id+1,body:latestBody};
    const mainSha='a'.repeat(40),candidateSha='d'.repeat(40),prNumber=434;
    const spec='Edit only README.md.';
    const job={...mkjob({host:hostname().toUpperCase(),request_id:'PTYSD_GOAL_SUPERSEDED_20261017',
      kind:'opencode_edit',source_sha:candidateSha,spec_path:'native-bridge/tasks/scoped-edit.md',
      spec_sha256:h(spec)}),schema:6,model:'opencode/spark',variant:'high',
      write_paths:['README.md'],candidate_pr:prNumber,goal_ref:goalRef};
    const ping=mkjob({host:hostname().toUpperCase(),request_id:'PTYSD_PING_AFTER_GOAL_SUPERSEDED_20261017'});
    const pr={number:prNumber,state:'open',base:{ref:'main',sha:mainSha,
      repo:{id:REPO_ID,full_name:REPO}},head:{sha:candidateSha,
      repo:{id:REPO_ID,full_name:REPO}}};
    const comments=[com(1,encoded(job),'dispatcher'),com(2,encoded(ping),'dispatcher')];
    const executor={task_name:'\\PTYSD\\OpenCodeExecutor',user_sid:'S-1-5-21-100-200-300-1001',
      publisher_sid:'S-1-5-21-100-200-300-1002',node_bin:'C:\\Node\\node.exe',
      script_path:'C:\\PTYSD\\executor.mjs',config_path:'C:\\PTYSD\\executor.json',
      manifest_dir:join(root,'manifests'),results_dir:join(root,'results'),working_directory:root};
    let dispatches=0,bundleBuilds=0,goalReferenceReads=0;const receiptWrites=[],logs=[];
    const result=await executeWorker({repo:REPO,project_id:PROJECT,host:hostname().toUpperCase(),issue:101,
      workspace,state_dir:stateDir,dispatchers:['dispatcher'],enable_v2_edit_runs:true,
      allowed_edit_models:{'opencode/spark':['high']},executor},{
      apiRead(endpoint){
        if(endpoint==='user')return {login:'worker'};
        if(endpoint.endsWith('/issues/101'))return {title:ISSUE_TITLE,state:'open'};
        if(endpoint.includes('/git/ref/heads/main'))return {object:{sha:mainSha}};
        if(endpoint.endsWith(`/pulls/${prNumber}`))return pr;
        if(endpoint.includes('/contents/'))return {encoding:'base64',content:Buffer.from(spec).toString('base64')};
        if(endpoint.endsWith(`/issues/comments/${goalRef.comment_id}`)){goalReferenceReads++;return oldGoal;}
        const match=endpoint.match(/\/issues\/comments\/(\d+)$/);
        if(match)return comments.find(item=>item.id===Number(match[1]));
        throw new Error(`UNEXPECTED_GOAL_MISMATCH_API:${endpoint}`);
      },
      commentsRead:()=>comments,
      goalCommentsRead:()=>[oldGoal,latestGoal],
      writeReceipt:(_config,data,login)=>{
        receiptWrites.push(data);
        comments.push(com(comments.length+1,RECEIPT_MARKER+JSON.stringify(data),login));
      },
      qualifyOpenCodeV2:()=>({ready:true}),
      assertExecutorTaskReady:()=>({ready:true}),
      inspectOpenCodeExecutorAttempt:(_descriptor,expected={})=>expected.job?{state:'STARTED'}:{state:'EMPTY'},
      createCandidateSourceBundle:()=>{bundleBuilds++;return {source_sha:candidateSha,sha256:'f'.repeat(64)};},
      dispatchToExecutor:()=>{dispatches++;return {outcome:'EXECUTOR_TASK_DISPATCHED_NOT_ACCEPTANCE'};},
      runPlan:()=>{throw new Error('MODEL_MUST_NOT_RUN_IN_DISPATCHER');},
      log:value=>logs.push(value),
    });
    assert.equal(result.state,'FINISHED','a superseded model job must not starve independent ping work');
    assert.equal(result.request_id,ping.request_id);
    assert.ok(logs.some(line=>line.includes(`HUMAN_GOAL_REFERENCE_WAITING_GOAL_COMMENT_SUPERSEDED_${job.request_id}_NO_START`)));
    assert.equal(goalReferenceReads,0,'a stale GOAL reference is rejected before exact-comment dispatch readback');
    assert.equal(bundleBuilds,1,'the temporary source bundle is removed after the final GOAL check fails');
    assert.equal(dispatches,0);
    assert.deepEqual(receiptWrites.map(item=>[item.request_id,item.state]),[
      [ping.request_id,'STARTED'],[ping.request_id,'FINISHED'],
    ]);
    assert.equal(receiptWrites.some(item=>item.request_id===job.request_id),false,
      'a superseded GOAL never starts or terminally consumes the old edit request');
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('OpenCode edit source bundles pin main or PR commits without changing the source worktree', () => {
  const root=mkdtempSync(join(homedir(),'.ptysd-candidate-bundle-'));
  try {
    const workspace=join(root,'source'),manifestDir=join(root,'inbox');
    mkdirSync(workspace);mkdirSync(manifestDir);
    const git=args=>execFileSync('git',['-C',workspace,...args],{
      encoding:'utf8',windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
    git(['init']);
    writeFileSync(join(workspace,'README.md'),'candidate source\n');
    git(['add','README.md']);
    git(['-c','user.name=PTYSD test','-c','user.email=ptysd-test@example.invalid','commit','-m','candidate']);
    const sourceSha=git(['rev-parse','HEAD']).trim();
    const job={...mkjob({request_id:'PTYSD_NATIVE_BUNDLE_CANDIDATE_20261016',kind:'opencode_edit',
      source_sha:sourceSha}),schema:5,model:'opencode/spark',variant:'high',write_paths:['README.md'],candidate_pr:434};
    const attemptId='11111111-1111-4111-8111-111111111141';
    const bundle=createCandidateSourceBundle({workspace,executor:{manifest_dir:manifestDir},job,attemptId});
    const bundlePath=join(manifestDir,'candidate-bundles',`${attemptId}.bundle`);
    assert.equal(bundle.source_sha,sourceSha);
    assert.match(bundle.sha256,/^[a-f0-9]{64}$/);
    assert.equal(createHash('sha256').update(readFileSync(bundlePath)).digest('hex'),bundle.sha256);
    execFileSync('git',['-C',workspace,'bundle','verify',bundlePath],{
      encoding:'utf8',windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
    assert.equal(git(['status','--porcelain']).trim(),'');
    assert.throws(()=>createCandidateSourceBundle({workspace,executor:{manifest_dir:manifestDir},job,attemptId}),
      /CANDIDATE_SOURCE_BUNDLE_ALREADY_EXISTS_NO_OVERWRITE/);

    const {candidate_pr:_candidatePr,...mainEdit}={...job,schema:4,
      request_id:'PTYSD_NATIVE_BUNDLE_MAIN_EDIT_20261016'};
    const mainAttempt='11111111-1111-4111-8111-111111111142';
    const mainBundle=createCandidateSourceBundle({workspace,executor:{manifest_dir:manifestDir},
      job:mainEdit,attemptId:mainAttempt});
    const mainBundlePath=join(manifestDir,'candidate-bundles',`${mainAttempt}.bundle`);
    assert.equal(mainBundle.source_sha,sourceSha);
    assert.equal(createHash('sha256').update(readFileSync(mainBundlePath)).digest('hex'),mainBundle.sha256);
    execFileSync('git',['-C',workspace,'bundle','verify',mainBundlePath],{
      encoding:'utf8',windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
    assert.equal(git(['status','--porcelain']).trim(),'');
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('a PR head change before dispatch produces no STARTED receipt or executor call', async () => {
  const root=mkdtempSync(join(homedir(),'.ptysd-opencode-pr-pin-race-'));
  try {
    const workspace=join(root,'workspace'),stateDir=join(root,'state');
    mkdirSync(workspace); mkdirSync(stateDir);
    const candidateSha='d'.repeat(40),mainSha='a'.repeat(40),spec='public fixture';
    const job={...bindGoalJob(mkjob({host:hostname().toUpperCase(),request_id:'PTYSD_NATIVE_EDIT_PR_RACE_20261016',
      kind:'opencode_edit',source_sha:candidateSha,spec_path:'native-bridge/tasks/scoped-edit.md',
      spec_sha256:h(spec)})),model:'opencode/spark',variant:'high',write_paths:['README.md']};
    const pinned={number:434,state:'open',base:{ref:'main',sha:mainSha,repo:{id:1352411536,full_name:REPO}},
      head:{sha:candidateSha,repo:{id:1352411536,full_name:REPO}}};
    let prReads=0,bundleBuilds=0,receipts=0,dispatches=0;
    const executor={task_name:'\\PTYSD\\OpenCodeExecutor',user_sid:'S-1-5-21-100-200-300-1001',
      publisher_sid:'S-1-5-21-100-200-300-1002',node_bin:'C:\\Node\\node.exe',
      script_path:'C:\\PTYSD\\executor.mjs',config_path:'C:\\PTYSD\\executor.json',
      manifest_dir:'C:\\PTYSD\\manifests',results_dir:'C:\\PTYSD\\results',working_directory:'C:\\PTYSD'};
    const result=await executeWorker({repo:REPO,project_id:PROJECT,host:hostname().toUpperCase(),issue:101,
      workspace,state_dir:stateDir,dispatchers:['dispatcher'],enable_v2_edit_runs:true,
      allowed_edit_models:{'opencode/spark':['high']},executor},{
      apiRead(endpoint) {
        if(endpoint==='user') return {login:'worker'};
        if(endpoint.endsWith('/issues/101')) return {title:ISSUE_TITLE,state:'open'};
        if(endpoint.endsWith(`/issues/comments/${TEST_GOAL_REF.comment_id}`)) return TEST_GOAL_COMMENT;
        if(endpoint.includes('/git/ref/heads/main')) return {object:{sha:mainSha}};
        if(endpoint.endsWith('/pulls/434')) return ++prReads===1 ? pinned : {...pinned,
          head:{...pinned.head,sha:'e'.repeat(40)}};
        throw new Error(`UNEXPECTED_CANDIDATE_RACE_API:${endpoint}`);
      },
      commentsRead:()=>[com(1,encoded(job),'dispatcher')],
      inspectOpenCodeExecutorAttempt:()=>({state:'EMPTY'}),
      createCandidateSourceBundle:()=>{bundleBuilds++;return {source_sha:candidateSha,sha256:'f'.repeat(64)};},
      qualifyOpenCodeV2:()=>({ready:true}),assertExecutorTaskReady:()=>({ready:true}),
      writeReceipt:()=>{receipts++;},dispatchToExecutor:()=>{dispatches++;return {outcome:'DISPATCHED'};},log:()=>{},
    });
    assert.equal(result.state,'CANDIDATE_PR_PIN_CHANGED_NO_START');
    assert.equal(prReads,2);
    assert.equal(bundleBuilds,0);
    assert.equal(receipts,0);
    assert.equal(dispatches,0);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('a main advancement between PR selection and dispatch leaves candidate work pending', async () => {
  const root=mkdtempSync(join(homedir(),'.ptysd-opencode-pr-main-race-'));
  try {
    const workspace=join(root,'workspace'),stateDir=join(root,'state');
    mkdirSync(workspace);mkdirSync(stateDir);
    const oldMain='a'.repeat(40),newMain='b'.repeat(40),candidateSha='d'.repeat(40),spec='public fixture';
    const job={...bindGoalJob(mkjob({host:hostname().toUpperCase(),request_id:'PTYSD_NATIVE_EDIT_MAIN_RACE_20261016',
      kind:'opencode_edit',source_sha:candidateSha,spec_path:'native-bridge/tasks/scoped-edit.md',
      spec_sha256:h(spec)})),model:'opencode/spark',variant:'high',write_paths:['README.md']};
    const pinned={number:434,state:'open',base:{ref:'main',sha:oldMain,repo:{id:1352411536,full_name:REPO}},
      head:{sha:candidateSha,repo:{id:1352411536,full_name:REPO}}};
    let mainReads=0,receipts=0,dispatches=0;
    const result=await executeWorker({repo:REPO,project_id:PROJECT,host:hostname().toUpperCase(),issue:101,
      workspace,state_dir:stateDir,dispatchers:['dispatcher'],enable_v2_edit_runs:true,
      allowed_edit_models:{'opencode/spark':['high']},executor:{task_name:'\\PTYSD\\OpenCodeExecutor',
        user_sid:'S-1-5-21-100-200-300-1001',publisher_sid:'S-1-5-21-100-200-300-1002',
        node_bin:'C:\\Node\\node.exe',script_path:'C:\\PTYSD\\executor.mjs',
        config_path:'C:\\PTYSD\\executor.json',manifest_dir:'C:\\PTYSD\\manifests',
        results_dir:'C:\\PTYSD\\results',working_directory:'C:\\PTYSD'}},{
      apiRead(endpoint){
        if(endpoint==='user')return {login:'worker'};
        if(endpoint.endsWith('/issues/101'))return {title:ISSUE_TITLE,state:'open'};
        if(endpoint.endsWith(`/issues/comments/${TEST_GOAL_REF.comment_id}`))return TEST_GOAL_COMMENT;
        if(endpoint.includes('/git/ref/heads/main'))return {object:{sha:++mainReads===1?oldMain:newMain}};
        if(endpoint.endsWith('/pulls/434'))return pinned;
        if(endpoint.includes('/contents/'))return {encoding:'base64',content:Buffer.from(spec).toString('base64')};
        const match=endpoint.match(/\/issues\/comments\/(\d+)$/);
        if(match)return {id:Number(match[1]),body:encoded(job),user:{login:'dispatcher'}};
        throw new Error(`UNEXPECTED_MAIN_RACE_API:${endpoint}`);
      },
      commentsRead:()=>[com(1,encoded(job),'dispatcher')],
      inspectOpenCodeExecutorAttempt:()=>({state:'EMPTY'}),
      qualifyOpenCodeV2:()=>({ready:true}),assertExecutorTaskReady:()=>({ready:true}),
      writeReceipt:()=>{receipts++;},dispatchToExecutor:()=>{dispatches++;return {outcome:'DISPATCHED'};},log:()=>{},
    });
    assert.equal(result.state,'CANDIDATE_PR_PIN_CHANGED_NO_START');
    assert.equal(mainReads,3,'main is read at selection and bracketed around the dispatch-time PR readback');
    assert.equal(receipts,0);
    assert.equal(dispatches,0);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('OpenCode edit work stays queued without explicit write authorization and executor configuration', async () => {
  const root=mkdtempSync(join(homedir(),'.ptysd-opencode-edit-blocked-'));
  try {
    const workspace=join(root,'workspace'),stateDir=join(root,'state');
    mkdirSync(workspace); mkdirSync(stateDir);
    const job={...mkjob({host:hostname().toUpperCase(),request_id:'PTYSD_NATIVE_EDIT_BLOCKED_20261015',
      kind:'opencode_edit',spec_path:'native-bridge/tasks/scoped-edit.md',spec_sha256:hash}),
      schema:4,model:'opencode/spark',variant:'high',write_paths:['README.md']};
    const comments=[com(1,encoded(job),'dispatcher')];
    let receipts=0,modelCalls=0;
    const result=await executeWorker({repo:REPO,project_id:PROJECT,host:hostname().toUpperCase(),issue:101,
      workspace,state_dir:stateDir,dispatchers:['dispatcher']},{
      apiRead(endpoint) {
        if(endpoint==='user') return {login:'worker'};
        if(endpoint.endsWith('/issues/101')) return {title:ISSUE_TITLE,state:'open'};
        if(endpoint.includes('/git/ref/heads/main')) return {object:{sha:commit}};
        const match=endpoint.match(/\/issues\/comments\/(\d+)$/);
        if(match) return comments.find(item=>item.id===Number(match[1]));
        throw new Error(`UNEXPECTED_BLOCKED_EDIT_API:${endpoint}`);
      },
      commentsRead:()=>comments,
      writeReceipt:()=>{receipts++;},
      runPlan:()=>{modelCalls++;throw new Error('UNAUTHORIZED_MODEL_MUST_NOT_RUN');},
      log:()=>{},
    });
    assert.equal(result.state,'WAITING');
    assert.equal(result.request_id,job.request_id);
    assert.equal(result.model_invoked,false);
    assert.equal(receipts,0);
    assert.equal(modelCalls,0);
    assert.equal(comments.length,1,'blocked edit remains pending without an execution receipt');
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('authorized OpenCode edits wait without receipts or dispatch when the executor is not configured', async () => {
  const root=mkdtempSync(join(process.cwd(),'.ptysd-opencode-edit-no-executor-'));
  try {
    const workspace=join(root,'workspace'),stateDir=join(root,'state');
    mkdirSync(workspace); mkdirSync(stateDir);
    const host=hostname().toUpperCase();
    const job=bindGoalJob({...mkjob({host,request_id:'PTYSD_NATIVE_EDIT_NO_EXECUTOR_20261016',
      kind:'opencode_edit',spec_path:'native-bridge/tasks/scoped-edit.md',spec_sha256:hash}),
      model:'opencode/spark',variant:'high',write_paths:['README.md']});
    const comments=[com(1,encoded(job),'dispatcher')];
    const receiptWrites=[];
    const calls={modelPlan:0,executorDispatch:0};
    const workerConfig={repo:REPO,project_id:PROJECT,host,issue:101,workspace,state_dir:stateDir,
      dispatchers:['dispatcher'],enable_v2_edit_runs:true,
      allowed_edit_models:{'opencode/spark':['high']}};
    assert.equal(checkModelAuthorization(job,workerConfig),true,
      'the edit model and variant are explicitly authorized');
    const result=await executeWorker(workerConfig,{
      apiRead(endpoint) {
        if(endpoint==='user') return {login:'worker'};
        if(endpoint.endsWith('/issues/101')) return {title:ISSUE_TITLE,state:'open'};
        if(endpoint.includes('/git/ref/heads/main')) return {object:{sha:commit}};
        if(endpoint.endsWith('/pulls/434')) return testCandidatePull();
        const match=endpoint.match(/\/issues\/comments\/(\d+)$/);
        if(match) return comments.find(item=>item.id===Number(match[1]));
        throw new Error(`UNEXPECTED_EDIT_NO_EXECUTOR_API:${endpoint}`);
      },
      commentsRead:()=>comments,
      writeReceipt:(_config,data,login)=>{
        receiptWrites.push(data);
        comments.push(com(comments.length+1,RECEIPT_MARKER+JSON.stringify(data),login));
      },
      runPlan:()=>{calls.modelPlan++;throw new Error('MODEL_PLAN_MUST_NOT_RUN');},
      dispatchToExecutor:()=>{calls.executorDispatch++;throw new Error('EXECUTOR_MUST_NOT_DISPATCH');},
      log:()=>{},
    });
    assert.equal(result.state,'WAITING');
    assert.equal(result.request_id,job.request_id);
    assert.equal(result.reason,'EXECUTOR_NOT_CONFIGURED');
    assert.equal(result.model_invoked,false);
    assert.deepEqual(calls,{modelPlan:0,executorDispatch:0});
    assert.deepEqual(receiptWrites,[],'waiting writes neither STARTED nor terminal receipts');
    assert.deepEqual(comments.filter(item=>parseReceipt(item.body)?.request_id===job.request_id),[],
      'the authorized edit remains queued without any execution receipt');
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('missing OpenCode CLI qualification is recoverable WAITING before any model invocation', async () => {
  const root = mkdtempSync(join(homedir(), '.ptysd-opencode-cli-waiting-'));
  try {
    const workspace = join(root, 'workspace');
    const stateDir = join(root, 'state');
    mkdirSync(workspace); mkdirSync(stateDir);
    const spec = 'Inspect a harmless public fixture.';
    const job = bindGoalJob({ ...mkjob({ host: hostname().toUpperCase(),
      request_id: 'PTYSD_NATIVE_CLI_WAITING_20261015', kind: 'opencode_edit',
      spec_path: 'native-bridge/tasks/scoped-edit.md', spec_sha256: h(spec) }),
      model: 'opencode/spark', variant: 'high', write_paths: ['README.md'] });
    const executorRuntime = { user_sid: 'S-1-5-21-100-200-300-1001',
      publisher_sid: 'S-1-5-21-100-200-300-1002' };
    let modelProcesses = 0;
    const result = await runPlan(spec, { workspace, state_dir: stateDir, host: hostname().toUpperCase(),
      enable_v2_edit_runs: true, allowed_edit_models: { 'opencode/spark': ['high'] },
      executor_runtime: executorRuntime }, job,
    '11111111-1111-4111-8111-111111111121', {
      currentSid: () => executorRuntime.user_sid,
      qualifyOpenCodeV2: () => ({ ready: false }),
      runCapturedProcess: () => { modelProcesses++; throw new Error('MODEL_MUST_NOT_START'); },
    });
    assert.equal(result.outcome, 'OPENCODE_V2_CLI_NOT_QUALIFIED');
    assert.equal(result.eligibility_state, 'WAITING');
    assert.equal(result.model_invoked, false);
    assert.equal(modelProcesses, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('retired read-only OpenCode plans are rejected before authentication, CLI, or workspace writes', async () => {
  const root = mkdtempSync(join(homedir(), '.ptysd-opencode-plan-retired-'));
  try {
    const workspace = join(root, 'workspace');
    const stateDir = join(root, 'state');
    mkdirSync(workspace); mkdirSync(stateDir);
    const spec = 'Inspect a public fixture without editing it.';
    const job = { ...mkjob({ host: hostname().toUpperCase(),
      request_id: 'PTYSD_NATIVE_READONLY_PLAN_RETIRED_20261016', kind: 'opencode_plan',
      spec_path: 'native-bridge/tasks/readonly-host-inventory.md', spec_sha256: h(spec) }),
      schema: 2, model: 'opencode/spark', variant: 'high' };
    const calls = { qualify: 0, auth: 0, spawn: 0 };
    await assert.rejects(runPlan(spec, { workspace, state_dir: stateDir, host: hostname().toUpperCase(),
      enable_v2_model_runs: true, allowed_models: { 'opencode/spark': ['high'] } }, job,
    '11111111-1111-4111-8111-111111111132', {
      qualifyOpenCodeV2: () => { calls.qualify++; return { ready: true, bin: 'C:\\OpenCode\\opencode-cli.exe' }; },
      readV2AuthReadiness: () => { calls.auth++; return { status: 'SAVED_ACCOUNT_RECORDS_PRESENT', saved_account_count: 1 }; },
      runCapturedProcess: async () => { calls.spawn++; return { exit_code: 0,
        outcome: 'OPENCODE_V2_EXIT_0_UNTRUSTED', evidence_sha256: null, evidence_bytes: 0,
        local_evidence: { process_id: null, spawn_error: null } }; },
    }), error => error.code === 'OPENCODE_READONLY_PLAN_RETIRED');
    assert.deepEqual(calls, { qualify: 0, auth: 0, spawn: 0 });
    assert.equal(existsSync(join(workspace, 'opencode.json')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('OpenCode records a fresh OS process-tree readback after the CLI root exits', async () => {
  const root=mkdtempSync(join(homedir(),'.ptysd-opencode-tree-readback-'));
  try {
    const workspace=join(root,'workspace'),stateDir=join(root,'state');
    mkdirSync(workspace);mkdirSync(stateDir);
    const spec='Inspect this harmless public fixture.';
    const job=bindGoalJob({...mkjob({request_id:'PTYSD_OPENCODE_TREE_READBACK_20261016',kind:'opencode_edit',
      spec_path:'native-bridge/tasks/scoped-edit.md',spec_sha256:hash}),
      model:'opencode/spark',variant:'high',write_paths:['README.md']});
    const executorRuntime={user_sid:'S-1-5-21-100-200-300-1001',
      publisher_sid:'S-1-5-21-100-200-300-1002'};
    let readbackPid=null;
    const result=await runPlan(spec,{workspace,state_dir:stateDir,host:hostname().toUpperCase(),
      enable_v2_edit_runs:true,allowed_edit_models:{'opencode/spark':['high']},
      executor_runtime:executorRuntime},job,
    '11111111-1111-4111-8111-111111111131',{
      currentSid:()=>executorRuntime.user_sid,
      qualifyOpenCodeV2:()=>({ready:true,bin:'C:\\OpenCode\\opencode-cli.exe'}),
      readV2AuthReadiness:()=>({status:'SAVED_ACCOUNT_RECORDS_PRESENT',saved_account_count:1}),
      runCapturedProcess:async(_bin,_args,options)=>{
        writeFileSync(options.stdoutPath,`${JSON.stringify({type:'text',sessionID:'ses_abcdefgh12345678',
          part:{type:'text',text:'must be ignored after capture error'}})}\n`);
        return {outcome:'OPENCODE_V2_EXIT_0_UNTRUSTED',exit_code:0,
          local_evidence:{process_id:7331,process_tree_state:'NOT_CHECKED',termination_state:'NOT_REQUESTED',
            capture_error:'OUTPUT_PIPE_UNAVAILABLE'}};
      },
      readProcessTree:pid=>{readbackPid=pid;return {state:'DEAD',root_pid:pid,process_ids:[],
        observed_at:'2026-10-16T00:00:00.000Z',error:null};},
    });
    assert.equal(readbackPid,7331);
    assert.equal(result.local_evidence.process_tree_state,'DEAD');
    assert.equal(result.local_evidence.process_tree_readback.error,null);
    assert.equal(result.model_invoked,undefined,
      'unknown or corrupt CLI output is not proof that the model was or was not called');
    assert.equal(result.session_id,null,
      'captured bytes are discarded when the output capture reports an error');
    assert.equal(result.provider_usage_evidence,'UNKNOWN');
    assert.equal(result.local_evidence.opencode_jsonl_state,'UNKNOWN');
    assert.equal(JSON.stringify(result).includes('must be ignored after capture error'),false);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('OpenCode does not return a writable attempt until a fresh OS readback confirms the process tree is dead', async () => {
  const root=mkdtempSync(join(homedir(),'.ptysd-opencode-tree-wait-'));
  try {
    const workspace=join(root,'workspace'),stateDir=join(root,'state');
    mkdirSync(workspace);mkdirSync(stateDir);
    const spec='Edit only a harmless public fixture.';
    const job=bindGoalJob({...mkjob({request_id:'PTYSD_OPENCODE_TREE_WAIT_20261016',kind:'opencode_edit',
      spec_path:'native-bridge/tasks/scoped-edit.md',spec_sha256:h(spec)}),
      model:'opencode/spark',variant:'high',write_paths:['README.md']});
    const executorRuntime={user_sid:'S-1-5-21-100-200-300-1001',
      publisher_sid:'S-1-5-21-100-200-300-1002'};
    const readbacks=[]; const waits=[];
    const result=await runPlan(spec,{workspace,state_dir:stateDir,host:hostname().toUpperCase(),
      enable_v2_edit_runs:true,allowed_edit_models:{'opencode/spark':['high']},
      executor_runtime:executorRuntime},job,
    '11111111-1111-4111-8111-111111111133',{
      currentSid:()=>executorRuntime.user_sid,
      qualifyOpenCodeV2:()=>({ready:true,bin:'C:\\OpenCode\\opencode-cli.exe'}),
      readV2AuthReadiness:()=>({status:'SAVED_ACCOUNT_RECORDS_PRESENT',saved_account_count:1}),
      runCapturedProcess:async()=>({outcome:'OPENCODE_V2_EXIT_0_UNTRUSTED',exit_code:0,
        local_evidence:{process_id:7332,process_tree_state:'ALIVE',termination_state:'ORPHAN_POSSIBLE'}}),
      readProcessTree:pid=>{
        readbacks.push(pid);
        if(readbacks.length===1) throw Object.assign(new Error('readback unavailable'),{code:'ACCESS_DENIED'});
        return readbacks.length===2
          ? {state:'ALIVE',root_pid:pid,process_ids:[7333],observed_at:'2026-10-16T00:00:01.000Z',error:null}
          : {state:'DEAD',root_pid:pid,process_ids:[],observed_at:'2026-10-16T00:00:02.000Z',error:null};
      },
      wait:async milliseconds=>{waits.push(milliseconds);},
    });
    assert.deepEqual(readbacks,[7332,7332,7332]);
    assert.deepEqual(waits,[1000,1000]);
    assert.equal(result.local_evidence.process_tree_state,'DEAD');
    assert.equal(result.local_evidence.process_tree_readback.process_ids.length,0);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('OpenCode preserves UNKNOWN without polling when native process-tree readback is unavailable', async () => {
  const root=mkdtempSync(join(homedir(),'.ptysd-opencode-tree-unavailable-'));
  try {
    const workspace=join(root,'workspace'),stateDir=join(root,'state');
    mkdirSync(workspace);mkdirSync(stateDir);
    const spec='Edit only a harmless public fixture.';
    const job=bindGoalJob({...mkjob({request_id:'PTYSD_OPENCODE_TREE_UNAVAILABLE_20261016',kind:'opencode_edit',
      spec_path:'native-bridge/tasks/scoped-edit.md',spec_sha256:h(spec)}),
      model:'opencode/spark',variant:'high',write_paths:['README.md']});
    const executorRuntime={user_sid:'S-1-5-21-100-200-300-1001',
      publisher_sid:'S-1-5-21-100-200-300-1002'};
    let waits=0;
    const result=await runPlan(spec,{workspace,state_dir:stateDir,host:hostname().toUpperCase(),
      enable_v2_edit_runs:true,allowed_edit_models:{'opencode/spark':['high']},
      executor_runtime:executorRuntime},job,
    '11111111-1111-4111-8111-111111111134',{
      platformName:'linux',
      currentSid:()=>executorRuntime.user_sid,
      qualifyOpenCodeV2:()=>({ready:true,bin:'C:\\OpenCode\\opencode-cli.exe'}),
      readV2AuthReadiness:()=>({status:'SAVED_ACCOUNT_RECORDS_PRESENT',saved_account_count:1}),
      runCapturedProcess:async()=>({outcome:'OPENCODE_V2_EXIT_0_UNTRUSTED',exit_code:0,
        local_evidence:{process_id:2147483647,process_tree_state:'UNKNOWN',termination_state:'ORPHAN_POSSIBLE'}}),
      wait:async()=>{waits++;throw new Error('must not poll without native process-tree support');},
    });
    assert.equal(waits,0);
    assert.equal(result.local_evidence.process_tree_state,'UNKNOWN');
    assert.equal(result.local_evidence.process_tree_readback.error,'PROCESS_TREE_QUERY_UNAVAILABLE');
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('OpenCode edit stays WAITING without edit authorization, lets ping run, and retries the same request after recovery', async () => {
  const root=mkdtempSync(join(homedir(),'.ptysd-opencode-edit-waiting-'));
  try {
    const workspace=join(root,'workspace'),stateDir=join(root,'state');
    mkdirSync(workspace);mkdirSync(stateDir);
    const host=hostname().toUpperCase();
    const spec='Edit only the exact reviewed path and return a diff.';
    const edit=bindGoalJob({...mkjob({host,request_id:'PTYSD_NATIVE_EDIT_WAITING_RECOVERY_20261016',
      kind:'opencode_edit',spec_path:'native-bridge/tasks/scoped-edit.md',spec_sha256:h(spec)}),
      model:'opencode/spark',variant:'high',write_paths:['README.md']});
    const ping=mkjob({host,request_id:'PTYSD_NATIVE_PING_DURING_EDIT_WAIT_20261016'});
    const comments=[com(1,encoded(edit),'dispatcher')];
    const waitingWrites=[],waitingLogs=[]; let nextId=2;
    const apiRead=endpoint=>{
      if(endpoint==='user') return {login:'worker'};
      if(endpoint.endsWith('/issues/101')) return {title:ISSUE_TITLE,state:'open'};
      if(endpoint.includes('/git/ref/heads/main')) return {object:{sha:commit}};
      if(endpoint.endsWith('/pulls/434')) return testCandidatePull();
      if(endpoint.endsWith(`/issues/comments/${TEST_GOAL_REF.comment_id}`)) return TEST_GOAL_COMMENT;
      if(endpoint.includes('/contents/')) return {encoding:'base64',content:Buffer.from(spec).toString('base64')};
      const match=endpoint.match(/\/issues\/comments\/(\d+)$/);
      if(match) return comments.find(item=>item.id===Number(match[1]));
      throw new Error(`UNEXPECTED_EDIT_WAIT_API:${endpoint}`);
    };
    const runUnqualifiedTick=()=>executeWorker({repo:REPO,project_id:PROJECT,host,issue:101,
      workspace,state_dir:stateDir,dispatchers:['dispatcher'],enable_v2_edit_runs:true,
      allowed_edit_models:{'opencode/spark':['low']}},{
      apiRead,commentsRead:()=>comments,
      goalCommentsRead:()=>[TEST_GOAL_COMMENT],
      writeReceipt:(_config,data,login)=>{
        waitingWrites.push(data); comments.push(com(nextId++,RECEIPT_MARKER+JSON.stringify(data),login));
      },
      runPlan:()=>{throw new Error('EDIT_MUST_NOT_RUN_WHILE_WAITING');},
      log:value=>waitingLogs.push(value),
    });
    const firstWaiting=await runUnqualifiedTick();
    assert.equal(firstWaiting.state,'WAITING');
    assert.equal(firstWaiting.request_id,edit.request_id);
    assert.equal(firstWaiting.model_invoked,false);
    assert.equal(comments.length,1,'first ineligible tick leaves the same formal request queued');
    assert.equal(waitingWrites.length,0,'waiting does not publish STARTED or terminal receipts');

    comments.push(com(2,encoded(ping),'dispatcher'));
    const waiting=await runUnqualifiedTick();
    assert.equal(waiting.request_id,ping.request_id,
      'a recoverably unavailable edit lane must not starve independent work');
    assert.ok(waitingLogs.includes('OPENCODE_EDIT_LANE_WAITING_EXPLICIT_MODEL_AUTH'));
    assert.equal(waitingWrites.some(item=>item.request_id===edit.request_id),false,
      'the unqualified edit request has no STARTED or terminal receipt across waiting ticks');
    assert.deepEqual(waitingWrites.map(item=>[item.request_id,item.state]),[
      [ping.request_id,'STARTED'],[ping.request_id,'FINISHED'],
    ]);
    const executor={task_name:'\\PTYSD\\OpenCodeExecutor',user_sid:'S-1-5-21-100-200-300-1001',
      publisher_sid:'S-1-5-21-100-200-300-1002',node_bin:'C:\\Node\\node.exe',
      script_path:'C:\\PTYSD\\executor.mjs',config_path:'C:\\PTYSD\\executor.json',
      manifest_dir:'C:\\PTYSD\\manifests',results_dir:'C:\\PTYSD\\results',
      working_directory:'C:\\PTYSD'};
    const resumedWrites=[],dispatches=[];
    const resumed=await executeWorker({repo:REPO,project_id:PROJECT,host,issue:101,
      workspace,state_dir:stateDir,dispatchers:['dispatcher'],enable_v2_edit_runs:true,
      allowed_edit_models:{'opencode/spark':['high']},executor},{
      apiRead,commentsRead:()=>comments,
      goalCommentsRead:()=>[TEST_GOAL_COMMENT],
      writeReceipt:(_config,data,login)=>{
        resumedWrites.push(data); comments.push(com(nextId++,RECEIPT_MARKER+JSON.stringify(data),login));
      },
      createCandidateSourceBundle:({job:bundleJob})=>({source_sha:bundleJob.source_sha,sha256:'c'.repeat(64)}),
      qualifyOpenCodeV2:()=>({ready:true}),
      assertExecutorTaskReady:()=>({ready:true}),
      inspectOpenCodeExecutorAttempt:(_descriptor,expected={})=>expected.job ? {state:'STARTED'} : {state:'EMPTY'},
      dispatchToExecutor:(_descriptor,manifest)=>{
        dispatches.push(manifest); return {outcome:'EXECUTOR_TASK_DISPATCHED_NOT_ACCEPTANCE'};
      },
      runPlan:()=>{throw new Error('EDIT_MUST_USE_ISOLATED_EXECUTOR');},
      log:()=>{},
    });
    assert.equal(resumed.state,'DISPATCHED');
    assert.equal(dispatches.length,1);
    assert.equal(dispatches[0].job.request_id,edit.request_id,
      'the same legal request is retried after its execution eligibility is restored');
    assert.deepEqual(resumedWrites.map(item=>[item.request_id,item.state]),[[edit.request_id,'STARTED']]);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('legacy read-only OpenCode plan is not newly dispatched and does not starve an independent ping', async () => {
  const root=mkdtempSync(join(homedir(),'.ptysd-opencode-plan-waiting-'));
  try {
    const workspace=join(root,'workspace'),stateDir=join(root,'state');
    mkdirSync(workspace);mkdirSync(stateDir);
    const spec='# Waiting task becomes eligible without changing its identity.\n';
    const plan={...mkjob({host:hostname().toUpperCase(),request_id:'PTYSD_NATIVE_PLAN_WAITING_AUTH_20261015',
      kind:'opencode_plan',spec_path:'native-bridge/tasks/readonly-host-inventory.md',spec_sha256:h(spec)}),
      schema:2,model:'opencode/spark',variant:'high'};
    const ping=mkjob({host:hostname().toUpperCase(),request_id:'PTYSD_NATIVE_PING_AFTER_PLAN_WAIT_20261015'});
    const comments=[com(1,encoded(plan)),com(2,encoded(ping))];
    const writes=[],logs=[]; let nextId=3;
    const result=await executeWorker({repo:REPO,project_id:PROJECT,host:hostname().toUpperCase(),issue:101,
      workspace,state_dir:stateDir,dispatchers:['t14210184'],
      allowed_models:{'opencode/spark':['high']},enable_v2_model_runs:false},{
      apiRead(endpoint) {
        if(endpoint==='user') return {login:'worker'};
        if(endpoint.endsWith('/issues/101')) return {title:ISSUE_TITLE,state:'open'};
        if(endpoint.includes('/git/ref/heads/main')) return {object:{sha:commit}};
        if(endpoint.includes('/contents/')) return {encoding:'base64',content:Buffer.from(spec).toString('base64')};
        const match=endpoint.match(/\/issues\/comments\/(\d+)$/);
        if(match) return comments.find(item=>item.id===Number(match[1]));
        throw new Error(`UNEXPECTED_PLAN_WAIT_API:${endpoint}`);
      },
      commentsRead:()=>comments,
      writeReceipt:(_config,data,login)=>{
        writes.push(data); comments.push(com(nextId++,RECEIPT_MARKER+JSON.stringify(data),login));
      },
      runPlan:()=>{throw new Error('MODEL_MUST_NOT_RUN_WITHOUT_AUTHORIZATION');},
      log:value=>logs.push(value),
    });
    assert.equal(result.state,'FINISHED');
    assert.equal(result.request_id,ping.request_id);
    assert.equal(logs.some(value => value.startsWith('OPENCODE_PLAN_LANE_WAITING')),false,
      'legacy read-only plans are excluded before model-eligibility checks');
    assert.equal(writes.some(item=>item.request_id===plan.request_id),false,
      'missing eligibility must not create STARTED or terminal receipts');
    assert.deepEqual(writes.map(item=>[item.request_id,item.state]),[
      [ping.request_id,'STARTED'],[ping.request_id,'FINISHED'],
    ]);

  } finally {rmSync(root,{recursive:true,force:true});}
});

test('recovered OpenCode terminal continues to an independent ping in the same dispatcher tick', async () => {
  const root=mkdtempSync(join(homedir(),'.ptysd-opencode-recovered-independent-'));
  try {
    const workspace=join(root,'workspace'),stateDir=join(root,'state');
    mkdirSync(workspace);mkdirSync(stateDir);
    const host=hostname().toUpperCase();
    const attemptId='11111111-1111-4111-8111-111111111113';
    const plan={...mkjob({host,request_id:'PTYSD_NATIVE_PLAN_RECOVERED_20261015',
      kind:'opencode_plan',spec_path:'native-bridge/tasks/readonly-host-inventory.md',spec_sha256:hash}),
      schema:2,model:'opencode/spark',variant:'high'};
    const started=receipt(plan.request_id,attemptId,'STARTED',plan);
    const stdout=Buffer.from('completed executor output\n');
    const stderr=Buffer.from('');
    const separator=Buffer.from('\n--- STDERR ---\n');
    const stdoutFile=`output-${plan.request_id}-${attemptId}.stdout.bin`;
    const stderrFile=`output-${plan.request_id}-${attemptId}.stderr.bin`;
    writeFileSync(join(stateDir,stdoutFile),stdout);
    writeFileSync(join(stateDir,stderrFile),stderr);
    const terminal=receipt(plan.request_id,attemptId,'FINISHED',plan,
      {outcome:'OPENCODE_V2_PLAN_EXIT_0_UNVERIFIED',exit_code:0,
        evidence_sha256:h(Buffer.concat([stdout,separator,stderr])),
        evidence_bytes:stdout.length+separator.length+stderr.length});
    const resultPath=join(stateDir,`result-${plan.request_id}-${attemptId}.json`);
    writeFileSync(resultPath,JSON.stringify({request_id:plan.request_id,attempt_id:attemptId,
      terminal,local_evidence:{stdout_file:stdoutFile,stderr_file:stderrFile,
        stdout_sha256:h(stdout),stdout_bytes:stdout.length,stderr_sha256:h(stderr),stderr_bytes:stderr.length,
        process_tree_state:'DEAD'}}));
    const ping=mkjob({host,request_id:'PTYSD_NATIVE_PING_AFTER_PLAN_RECOVERY_20261015'});
    const comments=[com(1,encoded(plan)),com(2,RECEIPT_MARKER+JSON.stringify(started),'worker'),
      com(3,encoded(ping))];
    const writes=[],logs=[];
    const result=await executeWorker({repo:REPO,project_id:PROJECT,host,issue:101,
      workspace,state_dir:stateDir,dispatchers:['t14210184']},{
      apiRead(endpoint) {
        if(endpoint==='user') return {login:'worker'};
        if(endpoint.endsWith('/issues/101')) return {title:ISSUE_TITLE,state:'open'};
        if(endpoint.includes('/git/ref/heads/main')) return {object:{sha:commit}};
        const match=endpoint.match(/\/issues\/comments\/(\d+)$/);
        if(match) return comments.find(item=>item.id===Number(match[1]));
        throw new Error(`UNEXPECTED_PLAN_RECOVERY_API:${endpoint}`);
      },
      commentsRead:()=>comments,
      writeReceipt:(_config,data)=>writes.push(data),
      runPlan:()=>{throw new Error('INDEPENDENT_PING_MUST_NOT_INVOKE_MODEL');},
      log:value=>logs.push(value),
    });
    assert.equal(result.state,'FINISHED');
    assert.equal(result.request_id,ping.request_id);
    assert.ok(logs.includes(`RECOVERED_TERMINAL_${plan.request_id}`));
    assert.deepEqual(writes.map(item=>[item.kind,item.state]),[
      ['opencode_plan','FINISHED'],['ping','STARTED'],['ping','FINISHED'],
    ]);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('corrupt or hash-mismatched local OpenCode results stay unknown without starving ping or deleting evidence', async () => {
  for (const corruption of ['malformed-json', 'captured-hash-mismatch']) {
    const root=mkdtempSync(join(homedir(),`.ptysd-opencode-result-${corruption}-`));
    try {
      const workspace=join(root,'workspace'),stateDir=join(root,'state');
      const manifestDir=join(root,'executor-inbox'),resultsDir=join(root,'executor-results');
      for (const path of [workspace,stateDir,manifestDir,resultsDir]) mkdirSync(path);
      const host=hostname().toUpperCase();
      const attemptId='11111111-1111-4111-8111-111111111141';
      const plan={...mkjob({host,request_id:`PTYSD_NATIVE_BAD_RESULT_${corruption.toUpperCase()}_20261016`,
        kind:'opencode_plan',spec_path:'native-bridge/tasks/readonly-host-inventory.md',spec_sha256:hash}),
        schema:2,model:'opencode/spark',variant:'high'};
      const started=receipt(plan.request_id,attemptId,'STARTED',plan);
      const path=executorResultPath(resultsDir,plan.request_id,attemptId);
      let originalResultBytes;
      if (corruption==='malformed-json') {
        originalResultBytes='{ truncated executor result';
      } else {
        const stdout=Buffer.from('captured executor output\n');
        const stderr=Buffer.from('');
        const separator=Buffer.from('\n--- STDERR ---\n');
        const stdoutFile=`output-${plan.request_id}-${attemptId}.stdout.bin`;
        const stderrFile=`output-${plan.request_id}-${attemptId}.stderr.bin`;
        writeFileSync(join(resultsDir,stdoutFile),stdout);
        writeFileSync(join(resultsDir,stderrFile),stderr);
        const terminal=receipt(plan.request_id,attemptId,'FINISHED',plan,{
          outcome:'OPENCODE_V2_EXIT_0_UNVERIFIED',exit_code:0,
          evidence_sha256:h(Buffer.concat([stdout,separator,stderr])),
          evidence_bytes:stdout.length+separator.length+stderr.length,
        });
        originalResultBytes=JSON.stringify({request_id:plan.request_id,attempt_id:attemptId,terminal,
          process_tree_state:'DEAD',local_evidence:{stdout_file:stdoutFile,stdout_sha256:'0'.repeat(64),
            stdout_bytes:stdout.length,stderr_file:stderrFile,stderr_sha256:h(stderr),stderr_bytes:stderr.length,
            storage_error:null,capture_error:null,spawn_error:null}});
      }
      writeFileSync(path,originalResultBytes,{flag:'wx'});
      const pendingManifest=join(manifestDir,`${attemptId}.running.json`);
      const originalManifestBytes='original attempt manifest; preserve while result is unknown';
      writeFileSync(pendingManifest,originalManifestBytes,{flag:'wx'});
      const ping=mkjob({host,request_id:`PTYSD_NATIVE_PING_AFTER_BAD_RESULT_${corruption.toUpperCase()}_20261016`});
      const comments=[com(1,encoded(plan),'dispatcher'),com(2,RECEIPT_MARKER+JSON.stringify(started),'worker'),
        com(3,encoded(ping),'dispatcher')];
      const writes=[],logs=[];
      let nextId=4,dispatches=0,triggers=0;
      const executor={task_name:'\\PTYSD\\OpenCodeExecutor',user_sid:'S-1-5-21-100-200-300-1001',
        publisher_sid:'S-1-5-21-100-200-300-1002',node_bin:join(root,'node.exe'),
        script_path:join(root,'executor.mjs'),config_path:join(root,'executor.json'),
        manifest_dir:manifestDir,results_dir:resultsDir,working_directory:workspace};
      const result=await executeWorker({repo:REPO,project_id:PROJECT,host,issue:101,workspace,state_dir:stateDir,
        dispatchers:['dispatcher'],executor,enable_v2_model_runs:true,
        allowed_models:{'opencode/spark':['high']}},{
        apiRead(endpoint) {
          if(endpoint==='user') return {login:'worker'};
          if(endpoint.endsWith('/issues/101')) return {title:ISSUE_TITLE,state:'open'};
          if(endpoint.includes('/git/ref/heads/main')) return {object:{sha:commit}};
          const match=endpoint.match(/\/issues\/comments\/(\d+)$/);
          if(match) return comments.find(item=>item.id===Number(match[1]));
          throw new Error(`UNEXPECTED_BAD_RESULT_API:${endpoint}`);
        },
        commentsRead:()=>comments,
        executorResultsDir:()=>resultsDir,
        inspectOpenCodeExecutorAttempt:()=>({state:'EMPTY'}),
        assertExecutorTaskReady:()=>{throw new Error('BAD_RESULT_MUST_NOT_START_MODEL');},
        triggerPendingExecutorAttempt:()=>{triggers++;throw new Error('BAD_RESULT_MUST_NOT_RETRIGGER');},
        dispatchToExecutor:()=>{dispatches++;throw new Error('BAD_RESULT_MUST_NOT_DISPATCH');},
        writeReceipt:(_config,data,login)=>{
          writes.push(data);comments.push(com(nextId++,RECEIPT_MARKER+JSON.stringify(data),login));
        },
        log:value=>logs.push(value),
      });
      assert.equal(result.state,'FINISHED',`${corruption}: independent ping should finish`);
      assert.equal(result.request_id,ping.request_id);
      assert.deepEqual(writes.map(item=>[item.request_id,item.kind,item.state]),[
        [ping.request_id,'ping','STARTED'],[ping.request_id,'ping','FINISHED'],
      ]);
      assert.equal(comments.filter(item=>parseReceipt(item.body)?.request_id===plan.request_id).length,1,
        `${corruption}: do not append a duplicate terminal receipt`);
      assert.match(logs.join('\n'),new RegExp(`LOCAL_RESULT_RECONCILIATION_UNKNOWN_${plan.request_id}_.*_NO_REPLAY`));
      assert.equal(dispatches,0);
      assert.equal(triggers,0);
      assert.equal(readFileSync(path,'utf8'),originalResultBytes,
        `${corruption}: retain the original executor result bytes for readback`);
      assert.equal(readFileSync(pendingManifest,'utf8'),originalManifestBytes,
        `${corruption}: preserve the existing attempt manifest`);
    } finally {rmSync(root,{recursive:true,force:true});}
  }
});

test('terminal OpenCode receipt without local process evidence preserves the attempt and skips conflicting edits', async () => {
  const root=mkdtempSync(join(homedir(),'.ptysd-opencode-terminal-missing-result-'));
  try {
    const workspace=join(root,'workspace'),stateDir=join(root,'state');
    const manifestDir=join(root,'executor-inbox'),resultsDir=join(root,'executor-results');
    for(const path of [workspace,stateDir,manifestDir,resultsDir])mkdirSync(path);
    const host=hostname().toUpperCase();
    const attemptId='11111111-1111-4111-8111-111111111140';
    const oldEdit={...mkjob({host,request_id:'PTYSD_NATIVE_EDIT_TERMINAL_MISSING_20261016',
      kind:'opencode_edit',spec_path:'native-bridge/tasks/scoped-edit.md',spec_sha256:hash}),
      schema:4,model:'opencode/spark',variant:'high',write_paths:['README.md']};
    const started=receipt(oldEdit.request_id,attemptId,'STARTED',oldEdit);
    const terminal=receipt(oldEdit.request_id,attemptId,'BLOCKED',oldEdit,
      {outcome:'OPENCODE_EDIT_INTERRUPTED_UNVERIFIED',exit_code:1});
    const runningPath=join(manifestDir,`${attemptId}.running.json`);
    const processPath=executorProcessPath(resultsDir,attemptId);
    writeFileSync(runningPath,'attempt still requires OS reconciliation');
    writeFileSync(processPath,'bound PID and creation-time evidence');
    const nextEdit={...oldEdit,request_id:'PTYSD_NATIVE_EDIT_NEXT_AFTER_UNKNOWN_20261016'};
    const ping=mkjob({host,request_id:'PTYSD_NATIVE_PING_AFTER_UNKNOWN_EDIT_20261016'});
    const comments=[com(1,encoded(oldEdit),'dispatcher'),
      com(2,RECEIPT_MARKER+JSON.stringify(started),'worker'),
      com(3,RECEIPT_MARKER+JSON.stringify(terminal),'worker'),
      com(4,encoded(nextEdit),'dispatcher'),com(5,encoded(ping),'dispatcher')];
    let nextId=6,executorReadbacks=0,modelDispatches=0;
    const writes=[],logs=[];
    const executor={task_name:'\\PTYSD\\OpenCodeExecutor',
      user_sid:'S-1-5-21-100-200-300-1001',publisher_sid:'S-1-5-21-100-200-300-1002',
      node_bin:join(root,'node.exe'),script_path:join(root,'executor.mjs'),
      config_path:join(root,'executor.json'),manifest_dir:manifestDir,
      results_dir:resultsDir,working_directory:workspace};
    const result=await executeWorker({repo:REPO,project_id:PROJECT,host,issue:101,
      workspace,state_dir:stateDir,dispatchers:['dispatcher'],executor,
      enable_v2_edit_runs:true,allowed_edit_models:{'opencode/spark':['high']}},{
      apiRead(endpoint) {
        if(endpoint==='user')return {login:'worker'};
        if(endpoint.endsWith('/issues/101'))return {title:ISSUE_TITLE,state:'open'};
        if(endpoint.includes('/git/ref/heads/main'))return {object:{sha:commit}};
        const match=endpoint.match(/\/issues\/comments\/(\d+)$/);
        if(match)return comments.find(item=>item.id===Number(match[1]));
        throw new Error(`UNEXPECTED_MISSING_RESULT_API:${endpoint}`);
      },
      commentsRead:()=>comments,
      writeReceipt:(_config,data,login)=>{
        writes.push(data);comments.push(com(nextId++,RECEIPT_MARKER+JSON.stringify(data),login));
      },
      executorResultsDir:()=>resultsDir,
      assertExecutorTaskReady:()=>{executorReadbacks++;throw new Error('CONFLICTING_EDIT_MUST_NOT_BE_CHECKED');},
      qualifyOpenCodeV2:()=>({ready:true}),
      dispatchToExecutor:()=>{modelDispatches++;throw new Error('CONFLICTING_EDIT_MUST_NOT_DISPATCH');},
      log:value=>logs.push(value),
    });
    assert.equal(result.state,'FINISHED');
    assert.equal(result.request_id,ping.request_id);
    assert.equal(executorReadbacks,0,'missing local terminal evidence blocks the shared editable lane');
    assert.equal(modelDispatches,0);
    assert.equal(existsSync(runningPath),true,'the running attempt must remain for OS process-tree readback');
    assert.equal(existsSync(processPath),true,'PID/creation-time evidence must not be cleaned without readback');
    assert.ok(logs.some(value=>value.includes('TERMINAL_RESULT_MISSING')));
    assert.deepEqual(writes.map(item=>[item.kind,item.state]),[['ping','STARTED'],['ping','FINISHED']]);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('pending OpenCode STARTED attempt retries the same manifest and lets an independent ping run', async () => {
  const root=mkdtempSync(join(homedir(),'.ptysd-opencode-pending-retry-'));
  try {
    const workspace=join(root,'workspace'),stateDir=join(root,'state');
    const manifestDir=join(root,'executor-inbox'),resultsDir=join(root,'executor-results');
    for(const path of [workspace,stateDir,manifestDir,resultsDir])mkdirSync(path);
    const host=hostname().toUpperCase(),attemptId='11111111-1111-4111-8111-111111111115';
    const spec='Inspect only this public fixture.';
    const opencodeJob={...mkjob({host,request_id:'PTYSD_OPEN_CODE_PENDING_RETRY_20261015',
      kind:'opencode_plan',spec_path:'native-bridge/tasks/readonly-host-inventory.md',spec_sha256:h(spec)}),
      schema:2,model:'opencode/spark',variant:'high'};
    const manifest=legacyStoredPlanManifest(opencodeJob,spec,attemptId);
    const manifestPath=join(manifestDir,`${attemptId}.pending.json`);
    const manifestBytes=JSON.stringify(manifest);
    writeFileSync(manifestPath,manifestBytes,{flag:'wx'});
    const started=receipt(opencodeJob.request_id,attemptId,'STARTED',opencodeJob);
    const ping=mkjob({host,request_id:'PTYSD_PING_DURING_PENDING_RETRY_20261015'});
    const comments=[com(1,encoded(opencodeJob)),com(2,RECEIPT_MARKER+JSON.stringify(started),'worker'),
      com(3,encoded(ping))];
    const executor={task_name:'\\PTYSD\\OpenCodeExecutor',user_sid:'S-1-5-21-100-200-300-1001',
      publisher_sid:'S-1-5-21-100-200-300-1002',node_bin:'C:\\Node\\node.exe',
      script_path:'C:\\PTYSD\\executor.mjs',config_path:'C:\\PTYSD\\executor.json',
      manifest_dir:manifestDir,results_dir:resultsDir,working_directory:'C:\\PTYSD'};
    const config={repo:REPO,project_id:PROJECT,host,issue:101,workspace,state_dir:stateDir,
      dispatchers:['t14210184'],allowed_models:{'opencode/spark':['high']},
      enable_v2_model_runs:true,executor};
    const triggers=[],writes=[],logs=[];
    const result=await executeWorker(config,{
      apiRead(uri){
        if(uri==='user')return {login:'worker'};
        if(uri.endsWith('/issues/101'))return {title:ISSUE_TITLE,state:'open'};
        if(uri.includes('/git/ref/heads/main'))return {object:{sha:commit}};
        if(uri.includes('/contents/'))return {encoding:'base64',content:Buffer.from(spec).toString('base64')};
        const match=uri.match(/\/issues\/comments\/(\d+)$/);
        if(match)return comments.find(item=>item.id===Number(match[1]));
        throw new Error(`UNEXPECTED_PENDING_RETRY_API:${uri}`);
      },
      commentsRead:()=>comments,
      executorManifestDir:()=>manifestDir,
      executorResultsDir:()=>resultsDir,
      triggerPendingExecutorAttempt:(_descriptor,id)=>{triggers.push(id);return {outcome:'EXECUTOR_PENDING_ATTEMPT_TRIGGERED_NOT_ACCEPTANCE'};},
      dispatchToExecutor:()=>{throw new Error('RETRY_MUST_NOT_CREATE_A_NEW_MANIFEST');},
      writeReceipt:(_config,data,login)=>{writes.push(data);comments.push(com(4+writes.length,
        RECEIPT_MARKER+JSON.stringify(data),login));},
      runPlan:()=>{throw new Error('INDEPENDENT_PING_MUST_NOT_RUN_A_MODEL');},
      log:value=>logs.push(value),
    });
    assert.equal(result.request_id,ping.request_id);
    assert.deepEqual(triggers,[attemptId]);
    assert.deepEqual(writes.map(item=>[item.kind,item.state]),[['ping','STARTED'],['ping','FINISHED']]);
    assert.equal(comments.filter(item=>parseReceipt(item.body)?.request_id===opencodeJob.request_id).length,1,
      'retry reuses the original STARTED receipt and attempt id');
    assert.equal(readFileSync(manifestPath,'utf8'),manifestBytes);
    assert.ok(logs.includes(`RETRIGGERED_PENDING_EXECUTOR_${opencodeJob.request_id}_${attemptId}`));

    const runningPath=join(manifestDir,`${attemptId}.running.json`);
    renameSync(manifestPath,runningPath);
    writeFileSync(executorProcessPath(resultsDir,attemptId),JSON.stringify({
      schema:1,kind:'PTYSD_NATIVE_EXECUTOR_PROCESS_V1',request_id:opencodeJob.request_id,
      attempt_id:attemptId,source_sha:opencodeJob.source_sha,spec_sha256:opencodeJob.spec_sha256,
      manifest_sha256:h(Buffer.from(manifestBytes)),job_sha256:h(JSON.stringify(opencodeJob)),
      process_id:7318,process_created_at:'2026-10-16T00:00:00.000Z',
      observed_at:'2026-10-16T00:00:00.100Z',
    }),{flag:'wx'});
    const recoveryLogs=[];
    const recovered=await executeWorker(config,{
      apiRead(uri){
        if(uri==='user')return {login:'worker'};
        if(uri.endsWith('/issues/101'))return {title:ISSUE_TITLE,state:'open'};
        if(uri.includes('/git/ref/heads/main'))return {object:{sha:commit}};
        if(uri.includes('/contents/'))return {encoding:'base64',content:Buffer.from(spec).toString('base64')};
        const match=uri.match(/\/issues\/comments\/(\d+)$/);
        if(match)return comments.find(item=>item.id===Number(match[1]));
        throw new Error(`UNEXPECTED_RUNNING_RECOVERY_API:${uri}`);
      },
      commentsRead:()=>comments,
      executorManifestDir:()=>manifestDir,
      executorResultsDir:()=>resultsDir,
      triggerPendingExecutorAttempt:(_descriptor,id)=>{
        assert.equal(id,attemptId);
        return {outcome:'EXECUTOR_RUNNING_ATTEMPT_RECOVERY_TRIGGERED_NOT_ACCEPTANCE'};
      },
      dispatchToExecutor:()=>{throw new Error('RUNNING_ATTEMPT_MUST_NOT_CREATE_A_NEW_MANIFEST');},
      writeReceipt:()=>{throw new Error('RECOVERY_TRIGGER_MUST_NOT_POST_A_SECOND_RECEIPT');},
      runPlan:()=>{throw new Error('RUNNING_ATTEMPT_MUST_NOT_REPLAY_MODEL');},
      log:value=>recoveryLogs.push(value),
    });
    assert.equal(recovered.state,'NO_DELTA');
    assert.ok(recoveryLogs.includes(`RETRIGGERED_INTERRUPTED_EXECUTOR_RECOVERY_${opencodeJob.request_id}_${attemptId}`));
    assert.equal(readFileSync(runningPath,'utf8'),manifestBytes,
      'the exact running manifest remains the same attempt during recovery');
    assert.equal(comments.filter(item=>parseReceipt(item.body)?.request_id===opencodeJob.request_id).length,1,
      'recovery trigger does not publish a duplicate start or terminal receipt');
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('a dead interrupted OpenCode edit is reconciled from its exact running attempt without model replay', async () => {
  const root=mkdtempSync(join(homedir(),'.ptysd-opencode-reboot-recovery-'));
  try {
    const workspace=join(root,'dispatcher-workspace'),manifestDir=join(root,'executor-inbox');
    const resultsDir=join(root,'executor-results'),attemptId='11111111-1111-4111-8111-111111111116';
    mkdirSync(workspace);mkdirSync(manifestDir);mkdirSync(resultsDir);
    const candidateRoot=join(resultsDir,'candidate-workspaces');mkdirSync(candidateRoot);
    const candidate=candidateWorkspacePath(resultsDir,attemptId);mkdirSync(candidate);
    writeFileSync(join(candidate,'README.md'),'before\n');
    execFileSync('git',['-C',candidate,'init','--quiet'],{windowsHide:true,shell:false});
    execFileSync('git',['-C',candidate,'config','user.email','test@example.invalid'],{windowsHide:true,shell:false});
    execFileSync('git',['-C',candidate,'config','user.name','PTYSD recovery test'],{windowsHide:true,shell:false});
    execFileSync('git',['-C',candidate,'add','README.md'],{windowsHide:true,shell:false});
    execFileSync('git',['-C',candidate,'commit','--quiet','-m','recovery fixture'],{windowsHide:true,shell:false});
    const sourceSha=execFileSync('git',['-C',candidate,'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true,shell:false}).trim();
    const host=hostname().toUpperCase(),spec='Make one bounded, public README improvement.';
    const job={...bindGoalJob({schema:4,project_id:PROJECT,host,request_id:'PTYSD_OPEN_CODE_REBOOT_RECOVERY_20261016',
      kind:'opencode_edit',source_sha:sourceSha,spec_path:'native-bridge/tasks/scoped-edit.md',
      spec_sha256:h(spec),model:'opencode/spark',variant:'high',write_paths:['README.md']}),
      candidate_pr:434};
    const manifest=makeExecutorManifest(job,spec,attemptId,'c'.repeat(64));
    const manifestBytes=Buffer.from(JSON.stringify(manifest));
    writeFileSync(join(manifestDir,`${attemptId}.running.json`),manifestBytes,{flag:'wx'});
    writeFileSync(join(candidate,'README.md'),'partially edited before reboot\n');
    const createdAt='2026-10-16T00:00:00.000Z';
    writeFileSync(executorProcessPath(resultsDir,attemptId),JSON.stringify({
      schema:1,kind:'PTYSD_NATIVE_EXECUTOR_PROCESS_V1',request_id:job.request_id,
      attempt_id:attemptId,source_sha:job.source_sha,spec_sha256:job.spec_sha256,
      manifest_sha256:h(manifestBytes),job_sha256:h(JSON.stringify(job)),process_id:7316,
      process_created_at:createdAt,observed_at:'2026-10-16T00:00:00.100Z',
    }),{flag:'wx'});
    const stdout=Buffer.from('partial tool output\n'),stderr=Buffer.from('');
    writeFileSync(join(resultsDir,`output-${job.request_id}-${attemptId}.stdout.bin`),stdout,{flag:'wx'});
    writeFileSync(join(resultsDir,`output-${job.request_id}-${attemptId}.stderr.bin`),stderr,{flag:'wx'});
    const descriptor={task_name:'\\PTYSD\\OpenCodeExecutor',user_sid:'S-1-5-21-100-200-300-1001',
      publisher_sid:'S-1-5-21-100-200-300-1002',node_bin:'C:\\Node\\node.exe',
      script_path:'C:\\PTYSD\\executor.mjs',config_path:'C:\\PTYSD\\executor.json',
      manifest_dir:manifestDir,results_dir:resultsDir,working_directory:'C:\\PTYSD'};
    const unresolved=await executePendingManifest({
      platformName:'win32',config:{project_id:PROJECT,host,state_dir:resultsDir,workspace,
        executor_runtime:{user_sid:descriptor.user_sid,publisher_sid:descriptor.publisher_sid,
          manifest_dir:manifestDir,results_dir:resultsDir}},manifestDir,
      currentSid:()=>descriptor.user_sid,
      readProcessTree:pid=>({state:'ALIVE',root_pid:pid,process_ids:[pid],root_created_at:createdAt,
        observed_at:'2026-10-16T00:04:00.000Z',error:null}),
      execute:()=>{throw new Error('LIVE_PROCESS_MUST_NOT_BE_REPLAYED');},
    });
    assert.equal(unresolved.outcome,'EXECUTOR_RECOVERY_UNRESOLVED');
    assert.equal(unresolved.reason,'PROCESS_TREE_ALIVE');
    assert.equal(existsSync(executorResultPath(resultsDir,job.request_id,attemptId)),false,
      'an alive process keeps the exact attempt unresolved');
    const result=await executePendingManifest({
      platformName:'win32',config:{project_id:PROJECT,host,state_dir:resultsDir,workspace,
        executor_runtime:{user_sid:descriptor.user_sid,publisher_sid:descriptor.publisher_sid,
          manifest_dir:manifestDir,results_dir:resultsDir}},manifestDir,
      currentSid:()=>descriptor.user_sid,
      readProcessTree:pid=>({state:'DEAD',root_pid:pid,process_ids:[],root_created_at:createdAt,
        observed_at:'2026-10-16T00:05:00.000Z',error:null}),
      execute:()=>{throw new Error('INTERRUPTED_MODEL_MUST_NOT_BE_REPLAYED');},
    });
    assert.equal(result.terminal_state,'BLOCKED');
    const local=JSON.parse(readFileSync(result.result_path,'utf8'));
    assert.equal(local.terminal.outcome,'EXECUTOR_INTERRUPTED_AFTER_PROCESS_START_UNVERIFIED');
    assert.equal(local.terminal.exit_code,-1);
    assert.deepEqual(local.terminal.changed_paths,['README.md']);
    assert.equal(local.local_evidence.process_tree_state,'DEAD');
    assert.equal(local.local_evidence.capture_complete,false);
    assert.equal(local.local_evidence.process_id,7316);
    assert.equal(local.diff_evidence.sha256,h(readFileSync(join(resultsDir,local.diff_evidence.file))));
    await verifyCapturedEvidence(resultsDir,local);
    await verifyScopedEditEvidence(resultsDir,local,local.terminal);
    assert.equal(readFileSync(join(candidate,'README.md'),'utf8'),'partially edited before reboot\n',
      'recovery preserves actual partial workspace changes for review');
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('running OpenCode attempts are retriggered only after matching process evidence reads DEAD', () => {
  const root=mkdtempSync(join(homedir(),'.ptysd-opencode-running-trigger-'));
  try {
    const manifestDir=join(root,'manifests'),resultsDir=join(root,'results');
    mkdirSync(manifestDir);mkdirSync(resultsDir);
    const attemptId='11111111-1111-4111-8111-111111111117';
    const createdAt='2026-10-16T00:00:00.000Z';
    const spec='exact approved spec';
    const job=bindGoalJob({schema:4,project_id:PROJECT,host:hostname().toUpperCase(),
      request_id:'PTYSD_OPEN_CODE_RUNNING_TRIGGER_20261016',kind:'opencode_edit',source_sha:commit,
      spec_path:'native-bridge/tasks/scoped-edit.md',spec_sha256:h(spec),
      model:'opencode/spark',variant:'high',write_paths:['README.md']});
    const manifest=makeExecutorManifest(job,spec,attemptId,'c'.repeat(64));
    const bytes=Buffer.from(JSON.stringify(manifest));
    writeFileSync(join(manifestDir,`${attemptId}.running.json`),bytes,{flag:'wx'});
    writeFileSync(executorProcessPath(resultsDir,attemptId),JSON.stringify({
      schema:1,kind:'PTYSD_NATIVE_EXECUTOR_PROCESS_V1',request_id:job.request_id,
      attempt_id:attemptId,source_sha:job.source_sha,spec_sha256:job.spec_sha256,
      manifest_sha256:h(bytes),job_sha256:h(JSON.stringify(job)),process_id:7317,
      process_created_at:createdAt,observed_at:'2026-10-16T00:00:00.100Z',
    }),{flag:'wx'});
    const descriptor={task_name:'\\PTYSD\\OpenCodeExecutor',user_sid:'S-1-5-21-100-200-300-1001',
      publisher_sid:'S-1-5-21-100-200-300-1002',node_bin:'C:\\Node\\node.exe',
      script_path:'C:\\PTYSD\\executor.mjs',config_path:'C:\\PTYSD\\executor.json',
      manifest_dir:manifestDir,results_dir:resultsDir,working_directory:'C:\\PTYSD'};
    const xml=buildExecutorTaskXml(descriptor); let triggers=0;
    for(const state of ['ALIVE','UNKNOWN']) {
      assert.throws(()=>triggerPendingExecutorAttempt(descriptor,attemptId,{
        currentSid:()=>descriptor.publisher_sid,readTaskXml:()=>xml,expectedJob:job,
        readProcessTree:pid=>({state,root_pid:pid,process_ids:state==='ALIVE'?[pid]:[],
          root_created_at:createdAt,observed_at:'2026-10-16T00:05:00.000Z',error:state==='UNKNOWN'?'READBACK_FAILED':null}),
        runTask:()=>{triggers++;},
      }),error=>error.code==='EXECUTOR_PROCESS_TREE_UNRESOLVED');
    }
    assert.equal(triggers,0,'alive or unknown execution must not trigger another attempt');
    const triggered=triggerPendingExecutorAttempt(descriptor,attemptId,{
      currentSid:()=>descriptor.publisher_sid,readTaskXml:()=>xml,expectedJob:job,
      readProcessTree:pid=>({state:'DEAD',root_pid:pid,process_ids:[],root_created_at:null,
        observed_at:'2026-10-16T00:05:00.000Z',error:null}),
      runTask:()=>{triggers++;},
    });
    assert.equal(triggered.outcome,'EXECUTOR_RUNNING_ATTEMPT_RECOVERY_TRIGGERED_NOT_ACCEPTANCE');
    assert.equal(triggers,1);
    const reusedPid=triggerPendingExecutorAttempt(descriptor,attemptId,{
      currentSid:()=>descriptor.publisher_sid,readTaskXml:()=>xml,expectedJob:job,
      readProcessTree:pid=>({state:'ALIVE',root_pid:pid,process_ids:[pid],
        root_created_at:'2026-10-16T00:06:00.000Z',observed_at:'2026-10-16T00:06:01.000Z',error:null}),
      runTask:()=>{triggers++;},
    });
    assert.equal(reusedPid.outcome,'EXECUTOR_RUNNING_ATTEMPT_RECOVERY_TRIGGERED_NOT_ACCEPTANCE',
      'a reused PID with a different verified creation time and no descendants is not the old attempt');
    assert.equal(triggers,2);
    assert.throws(()=>triggerPendingExecutorAttempt(descriptor,attemptId,{
      currentSid:()=>descriptor.publisher_sid,readTaskXml:()=>xml,expectedJob:job,
      readProcessTree:pid=>({state:'ALIVE',root_pid:pid,process_ids:[pid,9910],
        root_created_at:'2026-10-16T00:06:00.000Z',observed_at:'2026-10-16T00:06:01.000Z',error:null}),
      runTask:()=>{triggers++;},
    }),error=>error.code==='EXECUTOR_PROCESS_TREE_UNRESOLVED',
    'a reused PID with possible descendants remains ambiguous');
    assert.equal(triggers,2);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('executor durably binds the spawned OpenCode PID and creation time to the running manifest', async () => {
  const root=mkdtempSync(join(homedir(),'.ptysd-opencode-process-evidence-'));
  try {
    const workspace=join(root,'workspace'),manifestDir=join(root,'manifests'),resultsDir=join(root,'results');
    for(const path of [workspace,manifestDir,resultsDir])mkdirSync(path);
    const attemptId='11111111-1111-4111-8111-111111111118';
    const spec='approved, read-only historical fixture';
    const job={...mkjob({host:hostname().toUpperCase(),request_id:'PTYSD_OPEN_CODE_PROCESS_EVIDENCE_20261016',
      kind:'opencode_plan',spec_path:'native-bridge/tasks/readonly-host-inventory.md',spec_sha256:h(spec)}),
      schema:2,model:'opencode/spark',variant:'high'};
    const manifest=legacyStoredPlanManifest(job,spec,attemptId);
    const manifestBytes=Buffer.from(JSON.stringify(manifest));
    writeFileSync(join(manifestDir,`${attemptId}.pending.json`),manifestBytes,{flag:'wx'});
    const descriptor={user_sid:'S-1-5-21-100-200-300-1001',publisher_sid:'S-1-5-21-100-200-300-1002'};
    const processCreatedAt='2026-10-16T00:00:00.000Z';
    const result=await executePendingManifest({
      platformName:'win32',config:{project_id:PROJECT,host:job.host,state_dir:resultsDir,workspace,
        executor_runtime:{...descriptor,manifest_dir:manifestDir,results_dir:resultsDir}},manifestDir,
      currentSid:()=>descriptor.user_sid,
      execute:async(_spec,_config,_job,_attempt,dependencies)=>{
        assert.equal(dependencies.onProcessSpawn(8123,{state:'ALIVE',root_pid:8123,
          process_ids:[8123],root_created_at:processCreatedAt,error:null}),true);
        return {outcome:'SYNTHETIC_EXECUTOR_FAILURE',exit_code:1,
          evidence_sha256:null,evidence_bytes:0,local_evidence:{process_id:8123,process_tree_state:'DEAD'}};
      },
    });
    assert.equal(result.terminal_state,'BLOCKED');
    const evidence=readExecutorProcessEvidence(resultsDir,manifest,manifestBytes).record;
    assert.deepEqual([evidence.request_id,evidence.attempt_id,evidence.source_sha,evidence.process_id],
      [job.request_id,attemptId,job.source_sha,8123]);
    assert.equal(evidence.process_created_at,processCreatedAt);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('OpenCode V2 edit execution requires separate executor identity and uses only the scoped-write profile', async () => {
  const root=mkdtempSync(join(homedir(),'.ptysd-opencode-edit-profile-'));
  try {
    const workspace=join(root,'workspace'),stateDir=join(root,'state');
    mkdirSync(workspace);mkdirSync(stateDir);writeFileSync(join(workspace,'README.md'),'original\n');
    const job=bindGoalJob({project_id:PROJECT,host:hostname().toUpperCase(),
      request_id:'PTYSD_NATIVE_EDIT_PROFILE_20261015',kind:'opencode_edit',source_sha:commit,
      spec_path:'native-bridge/tasks/scoped-edit.md',spec_sha256:hash,
      model:'opencode/spark',variant:'high',write_paths:['README.md']});
    const config={workspace,state_dir:stateDir,enable_v2_edit_runs:true,
      allowed_edit_models:{'opencode/spark':['high']},
      executor_runtime:{user_sid:'S-1-5-21-100-200-300-1001',publisher_sid:'S-1-5-21-100-200-300-1002'}};
    let qualifyCalls=0,captured=null;
    const blocked=await runPlan('scoped task', {...config,enable_v2_edit_runs:false},job,
      '00000000-0000-4000-8000-000000000005',{
        qualifyOpenCodeV2:()=>{qualifyCalls++;throw new Error('MUST_NOT_PROBE_CLI');},
      });
    assert.equal(blocked.exit_code,44);
    assert.equal(qualifyCalls,0,'disabled edit jobs do not invoke even a model CLI preflight');
    let taskkillCalls=0,rootKillCalls=0,treeReadbacks=0,persistedProcessIdentity=null;
    const processCreatedAt='2026-10-16T00:00:00.000Z';
    const unapprovedCredentialKeys=['OPENAI_API_KEY','CODEX_API_KEY','CODEX_ACCESS_TOKEN',
      'ANTHROPIC_API_KEY','AWS_SECRET_ACCESS_KEY','OPENCODE_API_KEY','NODE_OPTIONS',
      'GH_TOKEN','GITHUB_TOKEN','GH_ENTERPRISE_TOKEN','OPENCODE_CONFIG_CONTENT',
      'OPENCODE_CONFIG','OPENCODE_CONFIG_DIR','OPENCODE_PERMISSION','HTTP_PROXY','HTTPS_PROXY',
      'PTYSD_TEST_UNKNOWN_PROVIDER_SECRET'];
    const priorCredentials=new Map(unapprovedCredentialKeys.map(key=>[key,process.env[key]]));
    for(const key of unapprovedCredentialKeys) process.env[key]=`UNAPPROVED_${key}`;
    let result;
    try {
      result=await runPlan('scoped task',config,job,'00000000-0000-4000-8000-000000000006',{
      currentSid:()=>config.executor_runtime.user_sid,
      qualifyOpenCodeV2:()=>({ready:true,bin:'C:\\OpenCode\\opencode.exe',version:'2.0.28'}),
      readV2AuthReadiness:()=>({status:'SAVED_ACCOUNT_RECORDS_PRESENT',saved_account_count:1}),
      runCapturedProcess:async(bin,args,options)=>{captured={bin,args,options};
        assert.equal(options.onSpawn(9876),true,'spawn is recorded before the executor proceeds');
        const sessionID='ses_1234567890abcdef';
        writeFileSync(options.stdoutPath,[
          {type:'step_start',sessionID},
          {type:'text',sessionID,part:{type:'text',text:'synthetic model output'}},
          {type:'tool_use',sessionID,part:{type:'tool',tool:'edit',callID:'edit-1',state:{status:'completed'}}},
          {type:'step_finish',sessionID,part:{type:'step-finish',tokens:{input:9,output:2,reasoning:0,cache:{read:1,write:0}}}},
        ].map(event=>JSON.stringify(event)).join('\n')+'\n');
        return {outcome:'OPENCODE_EDIT_CLI_EXIT_0_UNVERIFIED',exit_code:0,
          evidence_sha256:'d'.repeat(64),evidence_bytes:19,
          local_evidence:{stdout_sha256:'a'.repeat(64),stderr_sha256:'b'.repeat(64),
            storage_error:null,capture_error:null}};},
      onProcessSpawn:(pid,identity)=>{persistedProcessIdentity={pid,identity};return true;},
      runTaskkill:()=>{taskkillCalls++;const error=new Error('synthetic tree kill failure');error.code='EACCES';throw error;},
      readProcessTree:pid=>{treeReadbacks++;return {state:'ALIVE',root_pid:pid,process_ids:[pid,9877],
        root_created_at:processCreatedAt,observed_at:processCreatedAt,error:null};},
      platformName:'win32',
      });
    } finally {
      for(const key of unapprovedCredentialKeys) {
        const prior=priorCredentials.get(key);
        if(prior===undefined) delete process.env[key]; else process.env[key]=prior;
      }
    }
    assert.equal(result.outcome,'OPENCODE_EDIT_CLI_EXIT_0_UNVERIFIED');
    assert.equal(result.session_id,'ses_1234567890abcdef');
    assert.equal(result.session_started,true);
    assert.equal(result.provider_usage_evidence,'CONFIRMED');
    assert.equal(result.model_activity_evidence,'CONFIRMED');
    assert.equal(result.tool_execution_evidence,'OBSERVED');
    assert.equal(result.tool_execution_count,1);
    assert.equal(result.file_change_tool_evidence,'COMPLETED');
    assert.deepEqual(result.token_usage,{input_tokens:9,output_tokens:2,
      cached_input_tokens:1,reasoning_output_tokens:0});
    assert.equal(result.local_evidence.opencode_jsonl_state,'PARSED');
    assert.equal(JSON.stringify(result).includes('synthetic model output'),false,
      'model text is never copied into structured result evidence');
    const published=receipt(job.request_id,'00000000-0000-4000-8000-000000000008',
      'FINISHED',job,result);
    assert.equal(published.session_id,result.session_id);
    assert.equal(published.provider_usage_evidence,'CONFIRMED');
    assert.equal(published.stdout_sha256,'a'.repeat(64));
    assert.ok(parseReceipt(RECEIPT_MARKER+JSON.stringify(published)),
      'the public receipt validates the parsed, non-content execution evidence');
    assert.equal(parseReceipt(RECEIPT_MARKER+JSON.stringify({...published,
      provider_usage_evidence:'UNKNOWN',model_activity_evidence:'UNKNOWN',token_usage:null})),null,
    'a receipt cannot claim model invocation without usage or model activity evidence');
    assert.equal(parseReceipt(RECEIPT_MARKER+JSON.stringify({...published,session_id:null})),null,
      'a receipt cannot claim a started session without its session ID');
    assert.equal(captured.args[captured.args.indexOf('--agent')+1],'ptysd-scoped-write');
    assert.equal(captured.args.includes('ptysd-readonly'),false);
    assert.equal(captured.args[captured.args.indexOf('--model')+1],'opencode/spark#high');
    assert.equal(captured.options.env.PATH,process.env.PATH);
    assert.equal(captured.options.env.SYSTEMROOT,process.env.SYSTEMROOT);
    assert.equal(captured.options.env.APPDATA,process.env.APPDATA);
    assert.equal(captured.options.env.LOCALAPPDATA,process.env.LOCALAPPDATA);
    assert.equal(captured.options.env.HOME,process.env.USERPROFILE,
      'OpenCode resolves its own account under the verified Executor profile');
    const policy=JSON.parse(readFileSync(join(workspace,'opencode.json'),'utf8'));
    const editPolicy=policy.agents['ptysd-scoped-write'].permissions;
    assert.deepEqual(editPolicy.filter(item=>item.action==='edit').map(item=>item.resource),
      [join(workspace,'README.md').replaceAll('\\','/')]);
    assert.ok(editPolicy.some(item=>item.action==='*'&&item.effect==='deny'));
    assert.equal(captured.options.cwd,workspace);
    assert.equal(persistedProcessIdentity.pid,9876);
    assert.equal(persistedProcessIdentity.identity.root_created_at,processCreatedAt);
    for(const key of ['GH_TOKEN','GITHUB_TOKEN','GH_ENTERPRISE_TOKEN','OPENCODE_CONFIG_CONTENT',
      ...unapprovedCredentialKeys])
      assert.equal(Object.hasOwn(captured.options.env,key),false,`${key} is not inherited by model process`);
    const syntheticChild={pid:9876,exitCode:null,signalCode:null,kill(){rootKillCalls++;}};
    assert.deepEqual(captured.options.terminate(syntheticChild),{
      rootOnly:true,processTreeState:'ALIVE',error:'TASKKILL_TREE_FAILED'});
    assert.deepEqual([taskkillCalls,rootKillCalls,treeReadbacks],[1,1,2],
      'OpenCode cleanup uses the same shared hidden native tree termination and readback path');
    const wrongIdentity=await runPlan('scoped task',config,job,'00000000-0000-4000-8000-000000000007',{
      currentSid:()=>config.executor_runtime.publisher_sid,
      qualifyOpenCodeV2:()=>{throw new Error('IDENTITY_MISMATCH_MUST_BLOCK_BEFORE_CLI');},
    });
    assert.equal(wrongIdentity.outcome,'V2_EDIT_EXECUTOR_IDENTITY_NOT_VERIFIED');
  } finally {rmSync(root,{recursive:true,force:true});}
});
test('only allowlisted sender and host are eligible, completed/started jobs never rerun', () => {
  const a = encoded(mkjob());
  const state = [com(1,a,'outsider'), com(2,a)];
  assert.equal(selectNext(state, ['t14210184'], 'worker', TEST_HOST).id, 2);
  assert.equal(selectNext(state, ['t14210184'], 'worker', 'OTHER-HOST'), null);
  const start = receipt(mkjob().request_id,'00000000-0000-0000-0000-000000000000','STARTED',mkjob());
  assert.ok(parseReceipt(RECEIPT_MARKER + JSON.stringify(start)));
  state.push(com(3,RECEIPT_MARKER+JSON.stringify(start),'worker'));
  assert.equal(selectNext(state,['t14210184'],'worker',TEST_HOST),null);
});
test('stale unsigned job does not starve newer exact-main job', () => {
  const first=mkjob({request_id:'PTYSD_NATIVE_OLD_20261012',source_sha:'a'.repeat(40)});
  const second=mkjob({request_id:'PTYSD_NATIVE_NEW_20261012',source_sha:'c'.repeat(40)});
  const s=[com(1,encoded(first)),com(2,encoded(second))];
  assert.equal(selectNext(s,['t14210184'],'worker',TEST_HOST,'c'.repeat(40)).id,2);
});
test('candidate PR work is eligible only when its immutable head and main base still match', () => {
  const mainSha='c'.repeat(40), candidateSha='d'.repeat(40);
  const candidate={...mkjob({request_id:'PTYSD_NATIVE_EDIT_PR434_20261016',kind:'opencode_edit',
    source_sha:candidateSha,spec_path:'native-bridge/tasks/scoped-edit.md',spec_sha256:hash}),
    schema:5,model:'opencode/spark',variant:'high',write_paths:['README.md'],candidate_pr:434};
  assert.equal(parseJob(encoded(candidate)).candidate_pr,434);
  assert.equal(parseJob(encoded({...candidate,candidate_pr:0})),null);
  assert.equal(parseJob(encoded({...candidate,kind:'ping'})),null);
  const pinned={number:434,state:'open',base:{ref:'main',sha:mainSha,
    repo:{id:1352411536,full_name:REPO}},head:{sha:candidateSha,
    repo:{id:1352411536,full_name:REPO}}};
  assert.equal(candidatePullRequestEligible(candidate,mainSha,pinned),true);
  for(const changed of [
    {...pinned,state:'closed'},
    {...pinned,head:{...pinned.head,sha:'e'.repeat(40)}},
    {...pinned,base:{...pinned.base,sha:'f'.repeat(40)}},
    {...pinned,base:{...pinned.base,ref:'release'}},
    {...pinned,head:{...pinned.head,repo:{id:7,full_name:'fork/ptysd-autonomous-factory'}}},
    {...pinned,base:{...pinned.base,repo:{id:7,full_name:'other/ptysd-autonomous-factory'}}},
  ]) assert.equal(candidatePullRequestEligible(candidate,mainSha,changed),false);
  const comments=[com(990,encoded(candidate))];
  assert.equal(selectNext(comments,['t14210184'],'worker',candidate.host,mainSha),null,
    'an unvalidated PR number cannot bypass the current-main SHA check');
  assert.equal(selectNext(comments,['t14210184'],'worker',candidate.host,mainSha,[],
    new Set([`434:${candidateSha}`]))?.job.candidate_pr,434,
    'only a separately read-back exact PR pin may select a non-main SHA');
});
test('corrupt per-attempt result is isolated and does not starve an independent ping', async () => {
  const home=mkdtempSync(join(homedir(),'.ptysd-native-reconcile-'));
  try {
    const workspace=join(home,'workspace'),stateDir=join(home,'state');
    mkdirSync(workspace); mkdirSync(stateDir);
    const attemptId='11111111-1111-4111-8111-111111111111';
    const requestId='PTYSD_NATIVE_CORRUPT_PLAN_20261015';
    const plan={...mkjob({host:hostname().toUpperCase(),request_id:requestId,kind:'opencode_plan',
      spec_path:'native-bridge/tasks/readonly-host-inventory.md',spec_sha256:hash}),
      schema:2,model:'opencode/spark',variant:'high'};
    const ping=mkjob({host:hostname().toUpperCase(),request_id:'PTYSD_NATIVE_INDEPENDENT_PING_20261015'});
    const start=receipt(requestId,attemptId,'STARTED',plan);
    const terminal=receipt(requestId,attemptId,'BLOCKED',plan,
      {outcome:'EVIDENCE_STORAGE_FAILED',exit_code:1,evidence_sha256:null,evidence_bytes:0});
    const cases=[false,true];
    for (const hasTerminal of cases) {
      const comments=[com(1,encoded(plan)),com(2,RECEIPT_MARKER+JSON.stringify(start),'worker')];
      if (hasTerminal) comments.push(com(3,RECEIPT_MARKER+JSON.stringify(terminal),'worker'));
      comments.push(com(4,encoded(ping)));
      const resultPath=join(stateDir,`result-${requestId}-${attemptId}.json`);
      writeFileSync(resultPath,'{"truncated":', 'utf8');
      const logs=[]; let nextId=comments.length+1;
      const executor={task_name:'\\PTYSD\\OpenCodeExecutor',user_sid:'S-1-5-21-100-200-300-1001',
        publisher_sid:'S-1-5-21-100-200-300-1002',node_bin:'C:\\Node\\node.exe',
        script_path:'C:\\PTYSD\\executor.mjs',config_path:'C:\\PTYSD\\executor.json',
        manifest_dir:'C:\\PTYSD\\manifests',results_dir:'C:\\PTYSD\\results',
        working_directory:'C:\\PTYSD'};
      const result=await executeWorker({repo:REPO,project_id:PROJECT,host:hostname().toUpperCase(),issue:101,
        workspace,state_dir:stateDir,dispatchers:['t14210184'],executor,
        enable_v2_model_runs:true,allowed_models:{'opencode/spark':['high']}},{
        apiRead(endpoint) {
          if (endpoint==='user') return {login:'worker'};
          if (endpoint.endsWith('/issues/101')) return {title:'[PTYSD-NATIVE] OpenCode dispatch and receipts',state:'open'};
          if (endpoint.includes('/git/ref/heads/main')) return {object:{sha:commit}};
          const match=endpoint.match(/\/issues\/comments\/(\d+)$/);
          if (match) return comments.find(item=>item.id===Number(match[1]));
          throw new Error(`UNEXPECTED_TEST_API_${endpoint}`);
        },
        commentsRead:()=>comments,
        writeReceipt(_config,data,login) { comments.push(com(nextId++,RECEIPT_MARKER+JSON.stringify(data),login)); },
        executorResultsDir:()=>stateDir,
        executorResultPath:()=>resultPath,
        runPlan:()=>{ throw new Error('TEST_MUST_NOT_START_A_MODEL'); },
        log:value=>logs.push(value),
      });
      assert.equal(result.state,'FINISHED');
      assert.equal(result.request_id,ping.request_id);
      assert.ok(logs.some(value=>/NO_REPLAY/.test(value)),logs.join(' | '));
      assert.equal(comments.filter(item=>parseReceipt(item.body)?.request_id===requestId &&
        parseReceipt(item.body)?.state!=='STARTED').length,hasTerminal?1:0);
      assert.equal(parseReceipt(comments.at(-1).body)?.request_id,ping.request_id);
      rmSync(resultPath,{force:true});
    }
  } finally { rmSync(home,{recursive:true,force:true}); }
});
test('native CLI probe is bounded; no shell wrapper is treated as executable', () => {
  const empty=findNativeCLI({PATH:'/this/directory/does/not/exist'},false);
  assert.equal(empty.bin,null);
  assert.equal(empty.hasWrapper,false);
});
test('duplicate changed dispatch same request ID is blocked', () => {
  const a = encoded(mkjob()), b = encoded(mkjob({ source_sha: 'c'.repeat(40) }));
  assert.equal(selectNext([com(1,a),com(2,b)],['t14210184'],'worker',TEST_HOST),null);
});
fakeShellIntegration('worker integration: GitHub queued ping -> start + terminal with same-source readback; no delta zero LLM', () => {
  // The only mocked surfaces are gh and opencode binaries. No GitHub or Windows host is contacted.
  const home = mkdtempSync(join(homedir(), '.ptysd-native-test-'));
  try {
    const bin = join(home,'bin'), work=join(home,'workspace'), state=join(home,'state');
    mkdirSync(bin); mkdirSync(work); mkdirSync(state);
    const fakeGh = join(bin,'gh');
    const mock = join(home,'mock.json');
    const job=mkjob({ host: hostname().toUpperCase() });
    writeFileSync(mock,JSON.stringify({ main:commit, user:'win11-worker', issue:101,
      comments:[com(1, encoded(job))], next:2, spec:''}));
    writeFileSync(fakeGh, `#!/usr/bin/env node\nconst fs=require('fs');const a=process.argv.slice(2);const p=process.env.MOCK_GH_STATE;const x=JSON.parse(fs.readFileSync(p,'utf8'));if(a[0]==='api'){if(a[1]==='user')console.log(JSON.stringify({login:x.user}));else if(a[1].includes('/git/ref/heads/main'))console.log(JSON.stringify({object:{sha:x.main}}));else if(a[1].includes('/issues/comments/')){console.log(JSON.stringify(x.comments.find(c=>c.id===Number(a[1].split('/').pop()))));}else if(a[1].includes('/issues/101/comments'))console.log(JSON.stringify([x.comments]));else if(a[1].endsWith('/issues/101'))console.log(JSON.stringify({title:'[PTYSD-NATIVE] OpenCode dispatch and receipts',state:'open'}));else if(a[1].includes('/contents/'))console.log(JSON.stringify({encoding:'base64',content:Buffer.from(x.spec).toString('base64')}));else process.exit(20);}else if(a[0]==='issue'&&a[1]==='comment'){const fn=a[a.indexOf('--body-file')+1];x.comments.push({id:x.next++,body:fs.readFileSync(fn,'utf8'),user:{login:x.user}});fs.writeFileSync(p,JSON.stringify(x));console.log('posted');}else process.exit(21);\n`);
    chmodSync(fakeGh,0o755);
    writeFileSync(join(bin,'opencode'),'#!/bin/sh\necho UNEXPECTED_OPEN_CODE >&2\nexit 88\n');
    chmodSync(join(bin,'opencode'),0o755);
    const config=join(home,'config.json');
    writeFileSync(config,JSON.stringify({ repo:REPO,project_id:PROJECT,host:hostname().toUpperCase(),issue:101,workspace:work,state_dir:state,dispatchers:['t14210184'],allowed_models:{'opencode/spark':['high']}, enable_v2_model_runs:true }));
    const env={...process.env, PATH:`${bin}:${process.env.PATH}`,MOCK_GH_STATE:mock};
    const path=resolve('native-bridge/worker.mjs');
    const first=spawnSync(process.execPath,[path,'--config',config],{cwd:resolve('.'),env,encoding:'utf8',timeout:15000});
    assert.equal(first.status,0,first.stderr);
    assert.match(first.stdout,/FINISHED_PTYSD_NATIVE_PING/);
    const m=JSON.parse(readFileSync(mock,'utf8'));
    assert.equal(m.comments.length,3);
    assert.equal(parseReceipt(m.comments[1].body).state,'STARTED');
    assert.equal(parseReceipt(m.comments[2].body).state,'FINISHED');
    assert.equal(parseReceipt(m.comments[2].body).outcome,'BRIDGE_PING_OK_NOT_OS_ACCEPTANCE');
    const second=spawnSync(process.execPath,[path,'--config',config],{cwd:resolve('.'),env,encoding:'utf8',timeout:15000});
    assert.equal(second.status,0,second.stderr);
    assert.match(second.stdout,/NO_DELTA_NO_LLM/);
    assert.equal(JSON.parse(readFileSync(mock,'utf8')).comments.length,3);
    // A legacy read-only plan remains visible for history but cannot create an execution attempt.
    const plan='review README only';
    m.spec=plan;
    const planJob={...mkjob({ host:hostname().toUpperCase(),request_id:'PTYSD_NATIVE_PLAN_20261012',
      kind:'opencode_plan',spec_path:'native-bridge/tasks/readonly-host-inventory.md',spec_sha256:h(plan)}),schema:2,model:'opencode/spark',variant:'high'};
    m.comments.push(com(m.next++,encoded(planJob))); writeFileSync(mock,JSON.stringify(m));
    const run=spawnSync(process.execPath,[path,'--config',config],{cwd:resolve('.'),env,encoding:'utf8',timeout:15000});
    assert.equal(run.status,0,run.stderr);
    assert.match(run.stdout,/NO_DELTA_NO_LLM/,
      'retired read-only plans are excluded before dispatch and do not create receipts or model calls');
    const m2=JSON.parse(readFileSync(mock,'utf8'));
    assert.equal(m2.comments.length,m.comments.length,'retired read-only plans do not create an attempt or receipt');
    assert.equal(readdirSync(work).includes('opencode.json'),false,'the dispatcher must not start inline model work');
    // A crashed model attempt is ambiguous, but independent native probes continue.
    const orphan={...planJob,request_id:'PTYSD_NATIVE_ORPHAN_20261013'};
    const orphanStart=receipt(orphan.request_id,'00000000-0000-0000-0000-000000000001','STARTED',orphan);
    m2.comments.push(com(m2.next++,encoded(orphan)));
    m2.comments.push(com(m2.next++,RECEIPT_MARKER+JSON.stringify(orphanStart),'win11-worker'));
    m2.comments.push(com(m2.next++,encoded(mkjob({host:hostname().toUpperCase(),
      request_id:'PTYSD_NATIVE_INDEPENDENT_20261013'}))));
    writeFileSync(mock,JSON.stringify(m2));
    const independent=spawnSync(process.execPath,[path,'--config',config],{cwd:resolve('.'),
      env,encoding:'utf8',timeout:15000});
    assert.equal(independent.status,0,independent.stderr);
    assert.match(independent.stdout,/AMBIGUOUS_STARTED_PTYSD_NATIVE_ORPHAN_20261013/);
    assert.match(independent.stdout,/FINISHED_PTYSD_NATIVE_INDEPENDENT_20261013/);
    const after=JSON.parse(readFileSync(mock,'utf8'));
    assert.equal(parseReceipt(after.comments.at(-1).body).state,'FINISHED');
    assert.equal(after.comments.filter(x=>x.body.startsWith(RECEIPT_MARKER) &&
      parseReceipt(x.body)?.request_id===orphan.request_id).length,1);
  } finally { rmSync(home,{recursive:true,force:true}); }
});

// No real GitHub host, Windows service or model API is invoked in these tests.
fakeShellIntegration('no-LLM preflight yields a terminal receipt and local evidence hash', () => {
  const home=mkdtempSync(join(homedir(), '.ptysd-preflight-test-'));
  try {
    const bin=join(home,'bin'), work=join(home,'work'), state=join(home,'state');
    mkdirSync(bin); mkdirSync(work); mkdirSync(state);
    const mock=join(home,'mock.json');
    const job=mkjob({kind:'native_preflight',host:hostname().toUpperCase(),request_id:'PTYSD_NATIVE_PROBE_20261012'});
    writeFileSync(mock,JSON.stringify({main:commit,user:'win11-worker',issue:101,comments:[com(1,encoded(job))],next:2,spec:''}));
    const fakeGh=join(bin,'gh');
    writeFileSync(fakeGh, `#!/usr/bin/env node
const fs=require('fs');const a=process.argv.slice(2);const p=process.env.MOCK_GH_STATE;const x=JSON.parse(fs.readFileSync(p,'utf8'));if(a[0]==='api'){if(a[1]==='user')console.log(JSON.stringify({login:x.user}));else if(a[1].includes('/git/ref/heads/main'))console.log(JSON.stringify({object:{sha:x.main}}));else if(a[1].includes('/issues/comments/'))console.log(JSON.stringify(x.comments.find(c=>c.id===Number(a[1].split('/').pop()))));else if(a[1].includes('/issues/101/comments'))console.log(JSON.stringify([x.comments]));else if(a[1].endsWith('/issues/101'))console.log(JSON.stringify({title:'[PTYSD-NATIVE] OpenCode dispatch and receipts',state:'open'}));else process.exit(20);}else if(a[0]==='issue'&&a[1]==='comment'){x.comments.push({id:x.next++,body:fs.readFileSync(a[a.indexOf('--body-file')+1],'utf8'),user:{login:x.user}});fs.writeFileSync(p,JSON.stringify(x));}else process.exit(21);
`);
    chmodSync(fakeGh,0o755);
    const config=join(home,'config.json');
    writeFileSync(config,JSON.stringify({repo:REPO,project_id:PROJECT,host:hostname().toUpperCase(),issue:101,workspace:work,state_dir:state,dispatchers:['t14210184']}));
    const runner=resolve('native-bridge/worker.mjs');
    const env={...process.env,PATH:`${bin}:${process.env.PATH}`,MOCK_GH_STATE:mock};
    const res=spawnSync(process.execPath,[runner,'--config',config],{cwd:resolve('.'),env,encoding:'utf8',timeout:15000});
    assert.equal(res.status,0,res.stderr);
    assert.match(res.stdout,/FINISHED_PTYSD_NATIVE_PROBE_20261012/);
    const c=JSON.parse(readFileSync(mock,'utf8')).comments;
    assert.equal(c.length,3);
    const receipt=parseReceipt(c[2].body);
    assert.equal(receipt.state,'FINISHED');
    assert.equal(receipt.kind,'native_preflight');
    assert.match(receipt.evidence_sha256,/^[a-f0-9]{64}$/);
    assert.equal(c[2].body.includes(home),false);
    assert.equal(c[2].body.includes('secret'),false);
  } finally {rmSync(home,{recursive:true,force:true});}
});

fakeShellIntegration('V2 metadata task completes source-pinned GitHub receipts without model inference or credential leak', () => {
  const home=mkdtempSync(join(homedir(), '.ptysd-v2-meta-test-'));
  try {
    const bin=join(home,'bin'), work=join(home,'work'), state=join(home,'state');
    mkdirSync(bin);mkdirSync(work);mkdirSync(state);
    const mock=join(home,'mock.json'), seen=join(home,'calls.txt');
    const job=mkjob({kind:'native_v2_qualify',host:hostname().toUpperCase(),
      request_id:'PTYSD_NATIVE_V2_META_20261013'});
    writeFileSync(mock,JSON.stringify({main:commit,user:'worker',issue:101,
      comments:[com(1,encoded(job))],next:2,spec:''}));
    const ghScript = [
      '#!/usr/bin/env node',
      'const fs=require("fs"),a=process.argv.slice(2),p=process.env.MOCK_GH_STATE,x=JSON.parse(fs.readFileSync(p,"utf8"));',
      'if(a[0]==="api"){if(a[1]==="user")console.log(JSON.stringify({login:x.user}));',
      'else if(a[1].includes("/git/ref/heads/main"))console.log(JSON.stringify({object:{sha:x.main}}));',
      'else if(a[1].includes("/issues/comments/"))console.log(JSON.stringify(x.comments.find(c=>c.id===Number(a[1].split("/").pop()))));',
      'else if(a[1].includes("/issues/101/comments"))console.log(JSON.stringify([x.comments]));',
      'else if(a[1].endsWith("/issues/101"))console.log(JSON.stringify({title:"[PTYSD-NATIVE] OpenCode dispatch and receipts",state:"open"}));',
      'else process.exit(20);}else if(a[0]==="issue"&&a[1]==="comment"){x.comments.push({id:x.next++,body:fs.readFileSync(a[a.indexOf("--body-file")+1],"utf8"),user:{login:x.user}});fs.writeFileSync(p,JSON.stringify(x));}else process.exit(21);'
    ].join('\n')+'\n';
    writeFileSync(join(bin,'gh'),ghScript);chmodSync(join(bin,'gh'),0o755);
    const opencodeScript=[
      '#!/usr/bin/env node',
      'const fs=require("fs"),a=process.argv.slice(2);fs.appendFileSync(process.env.PROBE_CALLS,a.join(" ")+"\\n");',
      'if(a.length===1&&a[0]==="--version")console.log("opencode v2.0.27");',
      'else if(a[0]==="auth"&&a[1]==="list")console.log(JSON.stringify([{provider:"opencode",token:"PRIVATE_TOKEN_CANARY"}]));',
      'else if(a[0]==="models")console.log("opencode/spark-free");',
      'else process.exit(89);'
    ].join('\n')+'\n';
    writeFileSync(join(bin,'opencode'),opencodeScript);chmodSync(join(bin,'opencode'),0o755);
    const config=join(home,'config.json'),runner=resolve('native-bridge/worker.mjs');
    writeFileSync(config,JSON.stringify({repo:REPO,project_id:PROJECT,
      host:hostname().toUpperCase(),issue:101,workspace:work,state_dir:state,
      dispatchers:['t14210184']}));
    const env={...process.env,PATH:bin+':'+process.env.PATH,MOCK_GH_STATE:mock,PROBE_CALLS:seen};
    const first=spawnSync(process.execPath,[runner,'--config',config],{cwd:resolve('.'),
      env,encoding:'utf8',timeout:15000});
    assert.equal(first.status,0,first.stderr);
    assert.match(first.stdout,/FINISHED_PTYSD_NATIVE_V2_META_20261013/);
    const c=JSON.parse(readFileSync(mock,'utf8')).comments;
    assert.equal(c.length,3);
    const end=parseReceipt(c.at(-1).body);
    assert.equal(end.state,'FINISHED');
    assert.equal(end.outcome,'V2_ZERO_TOKEN_METADATA_ONLY_NOT_MODEL_ACCEPTANCE');
    assert.match(end.evidence_sha256,/^[a-f0-9]{64}$/);
    assert.ok(!c.at(-1).body.includes('PRIVATE_TOKEN_CANARY'));
    const e=readdirSync(state).find(x=>x.startsWith('native-evidence-'));
    assert.ok(e);
    const facts=JSON.parse(readFileSync(join(state,e),'utf8'));
    assert.equal(facts.auth_metadata.saved_account_count,1);
    assert.equal(facts.model_catalog.catalog_count,1);
    assert.equal(facts.inference_executed,false);
    assert.ok(!JSON.stringify(facts).includes('PRIVATE_TOKEN_CANARY'));
    const calls=readFileSync(seen,'utf8').trim().split('\n');
    assert.deepEqual(calls,['--version','auth list --format json','models']);
    const second=spawnSync(process.execPath,[runner,'--config',config],{cwd:resolve('.'),
      env,encoding:'utf8',timeout:15000});
    assert.equal(second.status,0,second.stderr);
    assert.match(second.stdout,/NO_DELTA_NO_LLM/);
    assert.equal(readFileSync(seen,'utf8').trim().split('\n').length,3);
  }finally{rmSync(home,{recursive:true,force:true});}
});

test('receipt identity rejects foreign project and wrong source cannot mask current job', () => {
  const job=mkjob(), start=receipt(job.request_id,'00000000-0000-0000-0000-000000000002','STARTED',job);
  assert.equal(parseReceipt(RECEIPT_MARKER+JSON.stringify({...start,project_id:'OTHER'})),null);
  assert.equal(parseReceipt(RECEIPT_MARKER+JSON.stringify({...start,source_sha:'x'.repeat(40)})),null);
  const other={...start,source_sha:'c'.repeat(40)};
  const state=[com(1,encoded(job)),com(2,RECEIPT_MARKER+JSON.stringify(other),'worker')];
  assert.equal(selectNext(state,['t14210184'],'worker',job.host,job.source_sha)?.id,1);
});

test('Worker routes an authorized Codex job through the isolated executor adapter without invoking a model inline', async () => {
  const root = mkdtempSync(join(homedir(), '.ptysd-codex-worker-route-'));
  try {
    const workspace = join(root, 'workspace');
    const stateDir = join(root, 'state');
    const codexSpool = join(root, 'codex-spool');
    mkdirSync(workspace); mkdirSync(stateDir); mkdirSync(codexSpool);
    const host = hostname().toUpperCase();
    const spec = '# Synthetic source-only task\nNo model execution is allowed in this test.\n';
    const codexJob = { schema: 3, project_id: PROJECT, host,
      request_id: 'PTYSD_CODEX_DISPATCH_TEST_20261015', kind: 'codex_plan',
      source_sha: commit, spec_path: 'native-bridge/tasks/codex-review.md',
      spec_sha256: h(spec), model: 'gpt-6.1-sol', reasoning_effort: 'medium',
      write_paths: ['native-bridge/sample.mjs'] };
    const comment = com(9001, encoded(codexJob));
    const comments = [comment];
    const config = { repo: REPO, project_id: PROJECT, host, issue: 407,
      workspace, state_dir: stateDir, codex_spool: codexSpool,
      dispatchers: ['t14210184'], github_transport_verified: true,
      codex_cli_qualified: true, codex_login_verified: true,
      enable_codex_model_runs: true, codex_usage_authorized: true,
      codex_sandbox_boundary: 'VERIFIED_WORKSPACE_ONLY',
      publisher_identity_sid: 'S-1-5-21-1000', executor_identity_sid: 'S-1-5-21-2000',
      codex_executor_task: 'PTYSD-Codex-Executor',
      codex_executor_task_user: TEST_HOST+'\\PTYSDCODEXEXEC',
      codex_executor_wscript_path: 'C:\\Windows\\System32\\wscript.exe',
      codex_executor_launcher_path: 'C:\\ProgramData\\PTYSDNativeBridge\\HiddenCodexExecutor.vbs',
      codex_executor_node_path: 'C:\\Program Files\\nodejs\\node.exe',
      codex_executor_script_path: 'C:\\ProgramData\\PTYSDNativeBridge\\codex-executor.mjs',
      codex_executor_config_path: 'C:\\ProgramData\\PTYSDNativeBridge\\executor-config.json',
      codex_executor_working_directory: 'C:\\ProgramData\\PTYSDNativeBridge\\CodexSpool',
      allowed_codex_models: { 'gpt-6.1-sol': ['medium'] } };
    const apiRead = uri => {
      if (uri === 'user') return { login: 'worker' };
      if (uri === `repos/${REPO}/issues/407`) return { title: ISSUE_TITLE, state: 'open' };
      if (uri === `repos/${REPO}/git/ref/heads/main`) return { object: { sha: commit } };
      if (uri === `repos/${REPO}/issues/comments/${comment.id}`) return comment;
      if (uri === `repos/${REPO}/contents/${codexJob.spec_path}?ref=${commit}`)
        return { encoding: 'base64', content: Buffer.from(spec).toString('base64') };
      throw new Error(`UNEXPECTED_MOCK_API_ROUTE:${uri}`);
    };
    const calls = { bundle: 0, start: 0, trigger: 0, inline: 0 };
    const result = await executeWorker(config, {
      apiRead, commentsRead: () => comments,
      assertCodexExecutorTaskReady: () => ({ ready: true }),
      writeReceipt: () => { throw new Error('GENERIC_RECEIPT_PATH_MUST_NOT_RUN'); },
      runPlan: () => { calls.inline++; throw new Error('MODEL_MUST_NOT_RUN_INLINE'); },
      codexDispatchOptions: {
        createBundle: async path => { calls.bundle++; writeFileSync(path, 'synthetic immutable bundle'); },
        publishStarted: async data => {
          calls.start++;
          comments.push(com(9002, RECEIPT_MARKER + JSON.stringify(data), 'worker'));
        },
        trigger: () => { calls.trigger++; },
      },
      log: () => {},
    });
    assert.equal(result.state, 'CODEX_EXECUTOR_REQUESTED');
    assert.equal(calls.bundle, 1);
    assert.equal(calls.start, 1);
    assert.equal(calls.trigger, 1, 'only the injected synthetic trigger runs');
    assert.equal(calls.inline, 0, 'the five-minute dispatcher never runs a model inline');
    const started = parseReceipt(comments.at(-1).body);
    assert.equal(started.kind, 'codex_plan');
    assert.equal(started.state, 'STARTED');
    assert.equal(started.outcome, 'CODEX_EXECUTOR_DISPATCH_ACK_NOT_ACCEPTANCE');
    assert.equal(started.task_fingerprint?.length, 64);
    assert.equal(comments.filter(item => parseReceipt(item.body)?.request_id === codexJob.request_id).length, 1);

    const lockDir = join(codexSpool, 'locks');
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'executor.active'), JSON.stringify({ schema: 1,
      pid: 98765, phase: 'MODEL_RUNNING' }));
    comments.push(com(9004, RECEIPT_MARKER + JSON.stringify({ ...started,
      state: 'BLOCKED', outcome: 'CODEX_SPAWN_FAILED' }), 'worker'));
    const pendingJob = { ...codexJob, request_id: 'PTYSD_CODEX_ACTIVE_LOCK_GUARD_20261015' };
    const pendingComment = com(9003, encoded(pendingJob));
    comments.push(pendingComment);
    const lockLogs = [];
    const guarded = await executeWorker(config, {
      apiRead: uri => {
        if (uri === 'user') return { login: 'worker' };
        if (uri === `repos/${REPO}/issues/407`) return { title: ISSUE_TITLE, state: 'open' };
        if (uri === `repos/${REPO}/git/ref/heads/main`) return { object: { sha: commit } };
        const match = uri.match(/\/issues\/comments\/(\d+)$/);
        if (match) return comments.find(item => item.id === Number(match[1]));
        if (uri === `repos/${REPO}/contents/${pendingJob.spec_path}?ref=${commit}`)
          return { encoding: 'base64', content: Buffer.from(spec).toString('base64') };
        throw new Error(`UNEXPECTED_MOCK_API_ROUTE:${uri}`);
      },
      commentsRead: () => comments,
      dispatchCodexJob: () => { throw new Error('ACTIVE_EXECUTOR_MUST_NOT_BE_TRIGGERED_AGAIN'); },
      runPlan: () => { throw new Error('ACTIVE_LOCK_GUARD_MUST_NOT_RUN_A_MODEL'); },
      writeReceipt: () => { throw new Error('ACTIVE_LOCK_GUARD_MUST_NOT_WRITE_A_RECEIPT'); },
      log: value => lockLogs.push(value),
    });
    assert.equal(guarded.state, 'NO_DELTA');
    assert.ok(lockLogs.includes('CODEX_EXECUTOR_SPOOL_OR_OWNER_NOT_READY'), lockLogs.join('\n'));
    assert.equal(comments.filter(item => parseReceipt(item.body)?.request_id === pendingJob.request_id).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('live Codex Task mismatch blocks only that lane and leaves an independent ping eligible', async () => {
  const root = mkdtempSync(join(homedir(), '.ptysd-codex-task-readback-'));
  try {
    const workspace = join(root, 'workspace');
    const stateDir = join(root, 'state');
    const codexSpool = join(root, 'codex-spool');
    mkdirSync(workspace); mkdirSync(stateDir); mkdirSync(codexSpool);
    const host = hostname().toUpperCase();
    const spec = '# Task readback blocks only the Codex lane.\n';
    const codexJob = { schema: 3, project_id: PROJECT, host,
      request_id: 'PTYSD_CODEX_TASK_MISMATCH_20261015', kind: 'codex_plan',
      source_sha: commit, spec_path: 'native-bridge/tasks/codex-review.md',
      spec_sha256: h(spec), model: 'gpt-6.1-sol', reasoning_effort: 'medium',
      write_paths: ['native-bridge/sample.mjs'] };
    const codexComment = com(9051, encoded(codexJob));
    const pingJob = mkjob({ host, request_id: 'PTYSD_PING_AFTER_CODEX_TASK_MISMATCH_20261015' });
    const pingComment = com(9052, encoded(pingJob));
    const comments = [codexComment, pingComment];
    const config = { repo: REPO, project_id: PROJECT, host, issue: 407,
      workspace, state_dir: stateDir, codex_spool: codexSpool,
      dispatchers: ['t14210184'], github_transport_verified: true,
      codex_cli_qualified: true, codex_login_verified: true,
      enable_codex_model_runs: true, codex_usage_authorized: true,
      codex_sandbox_boundary: 'VERIFIED_WORKSPACE_ONLY',
      publisher_identity_sid: 'S-1-5-21-1000', executor_identity_sid: 'S-1-5-21-2000',
      codex_executor_task: 'PTYSD-Codex-Executor',
      codex_executor_task_user: TEST_HOST+'\\PTYSDCODEXEXEC',
      codex_executor_wscript_path: 'C:\\Windows\\System32\\wscript.exe',
      codex_executor_launcher_path: 'C:\\ProgramData\\PTYSDNativeBridge\\HiddenCodexExecutor.vbs',
      codex_executor_node_path: 'C:\\Program Files\\nodejs\\node.exe',
      codex_executor_script_path: 'C:\\ProgramData\\PTYSDNativeBridge\\codex-executor.mjs',
      codex_executor_config_path: 'C:\\ProgramData\\PTYSDNativeBridge\\executor-config.json',
      codex_executor_working_directory: 'C:\\ProgramData\\PTYSDNativeBridge\\CodexSpool',
      allowed_codex_models: { 'gpt-6.1-sol': ['medium'] } };
    const apiRead = uri => {
      if (uri === 'user') return { login: 'worker' };
      if (uri === `repos/${REPO}/issues/407`) return { title: ISSUE_TITLE, state: 'open' };
      if (uri === `repos/${REPO}/git/ref/heads/main`) return { object: { sha: commit } };
      if (uri === `repos/${REPO}/issues/comments/${codexComment.id}`) return codexComment;
      if (uri === `repos/${REPO}/issues/comments/${pingComment.id}`) return pingComment;
      if (uri === `repos/${REPO}/contents/${codexJob.spec_path}?ref=${commit}`)
        return { encoding: 'base64', content: Buffer.from(spec).toString('base64') };
      throw new Error(`UNEXPECTED_MOCK_API_ROUTE:${uri}`);
    };
    const writes = [];
    const logs = [];
    const result = await executeWorker(config, {
      apiRead, commentsRead: () => comments,
      assertCodexExecutorTaskReady: () => { throw Object.assign(new Error('TASK_DISABLED'), {
        code: 'CODEX_EXECUTOR_TASK_DISABLED' }); },
      writeReceipt: (_config, data, login) => {
        writes.push(data);
        comments.push(com(9060 + writes.length, RECEIPT_MARKER + JSON.stringify(data), login));
      },
      dispatchCodexJob: () => { throw new Error('INVALID_TASK_MUST_NOT_DISPATCH_CODEX'); },
      runPlan: () => { throw new Error('PING_MUST_NOT_INVOKE_A_MODEL'); },
      log: value => logs.push(value),
    });
    assert.equal(result.request_id, pingJob.request_id);
    assert.ok(writes.length > 0 && writes.every(item => item.kind === 'ping'));
    assert.equal(comments.filter(item => parseReceipt(item.body)?.request_id === codexJob.request_id).length, 0);
    assert.ok(logs.some(value => value.includes('CODEX_EXECUTOR_TASK_READBACK_FAILED_CODEX_EXECUTOR_TASK_DISABLED')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('corrupt Codex attempt remains UNKNOWN and does not starve a separate Worker ping', async () => {
  const root = mkdtempSync(join(homedir(), '.ptysd-codex-corrupt-worker-'));
  try {
    const workspace = join(root, 'workspace');
    const stateDir = join(root, 'state');
    const codexSpool = join(root, 'codex-spool');
    const resultDir = join(codexSpool, 'results');
    mkdirSync(workspace); mkdirSync(stateDir); mkdirSync(resultDir, { recursive: true });
    const host = hostname().toUpperCase();
    const codexJob = { schema: 3, project_id: PROJECT, host,
      request_id: 'PTYSD_CODEX_CORRUPT_ATTEMPT_20261015', kind: 'codex_plan',
      source_sha: commit, spec_path: 'native-bridge/tasks/codex-review.md',
      spec_sha256: hash, model: 'gpt-6.1-sol', reasoning_effort: 'medium',
      write_paths: ['native-bridge/sample.mjs'] };
    const attemptId = '11111111-1111-4111-8111-111111111111';
    const started = { ...receipt(codexJob.request_id, attemptId, 'STARTED', codexJob),
      task_fingerprint: hash };
    const codexComment = com(9101, encoded(codexJob));
    const pingJob = mkjob({ host, request_id: 'PTYSD_NATIVE_INDEPENDENT_PING_20261015' });
    const comments = [codexComment,
      com(9102, RECEIPT_MARKER + JSON.stringify(started), 'worker'),
      com(9103, encoded(pingJob))];
    writeFileSync(join(resultDir, `${codexJob.request_id}-${attemptId}.json`), '{ broken result');
    const config = { repo: REPO, project_id: PROJECT, host, issue: 407,
      workspace, state_dir: stateDir, codex_spool: codexSpool,
      dispatchers: ['t14210184'] };
    const apiRead = uri => {
      if (uri === 'user') return { login: 'worker' };
      if (uri === `repos/${REPO}/issues/407`) return { title: ISSUE_TITLE, state: 'open' };
      if (uri === `repos/${REPO}/git/ref/heads/main`) return { object: { sha: commit } };
      if (uri === `repos/${REPO}/issues/comments/${codexComment.id}`) return codexComment;
      if (uri === `repos/${REPO}/issues/comments/${9103}`) return comments[2];
      throw new Error(`UNEXPECTED_MOCK_API_ROUTE:${uri}`);
    };
    const writes = [];
    const logs = [];
    const result = await executeWorker(config, {
      apiRead, commentsRead: () => comments,
      writeReceipt: (_config, data, login) => {
        writes.push(data);
        comments.push(com(9104 + writes.length, RECEIPT_MARKER + JSON.stringify(data), login));
      },
      dispatchCodexJob: () => { throw new Error('CORRUPT_CODEX_ATTEMPT_MUST_NOT_REDISPATCH'); },
      runPlan: () => { throw new Error('PING_MUST_NOT_INVOKE_MODEL'); },
      log: value => logs.push(value),
    });
    assert.equal(result.request_id, pingJob.request_id);
    assert.deepEqual(writes.map(item => item.kind), ['ping', 'ping']);
    assert.equal(comments.filter(item => parseReceipt(item.body)?.request_id === codexJob.request_id).length, 1);
    assert.ok(logs.some(value => value.includes('UNKNOWN_NO_REPLAY')));
    assert.ok(!logs.some(value => value.includes('RECOVERED_CODEX_TERMINAL')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('recovered Codex terminal continues to an independent ping in the same dispatcher tick', async () => {
  const root = mkdtempSync(join(homedir(), '.ptysd-codex-recovered-independent-'));
  try {
    const workspace = join(root, 'workspace');
    const stateDir = join(root, 'state');
    const spoolDir = join(root, 'spool');
    mkdirSync(workspace); mkdirSync(stateDir); mkdirSync(spoolDir);
    const host = hostname().toUpperCase();
    const attemptId = '11111111-1111-4111-8111-111111111112';
    const codexJob = { schema: 3, project_id: PROJECT, host,
      request_id: 'PTYSD_CODEX_RECOVERED_20261015', kind: 'codex_plan',
      source_sha: commit, spec_path: 'native-bridge/tasks/codex-review.md',
      spec_sha256: hash, model: 'gpt-6.1-sol', reasoning_effort: 'medium',
      write_paths: ['native-bridge/sample.mjs'] };
    const started = { ...receipt(codexJob.request_id, attemptId, 'STARTED', codexJob),
      task_fingerprint: hash };
    const pingJob = mkjob({ host, request_id: 'PTYSD_PING_AFTER_CODEX_RECOVERY_20261015' });
    const comments = [com(9201, encoded(codexJob)),
      com(9202, RECEIPT_MARKER + JSON.stringify(started), 'worker'),
      com(9203, encoded(pingJob))];
    const config = { repo: REPO, project_id: PROJECT, host, issue: 407,
      workspace, state_dir: stateDir, codex_spool: spoolDir,
      dispatchers: ['t14210184'] };
    const resultBytes = JSON.stringify({ schema: 1, kind: 'codex_plan',
      request_id: codexJob.request_id, attempt_id: attemptId, source_sha: commit,
      fingerprint: hash, exit_code: 0, outcome: 'CODEX_CLI_EXIT_0_UNVERIFIED',
      session_id: 'session_12345678', session_started: true,
      provider_usage_evidence: 'CONFIRMED', model_activity_evidence: 'CONFIRMED',
      tool_execution_evidence: 'OBSERVED', tool_execution_count: 1,
      token_usage: { input_tokens: 3, output_tokens: 2, cached_input_tokens: 0, reasoning_output_tokens: 0 },
      process_tree_state: 'DEAD', diff_sha256: null,
      stdout_sha256: hash, stderr_sha256: hash, stdout_bytes: 0, stderr_bytes: 0,
      model_invoked: true, changed_paths: [], out_of_scope_paths: [],
      tests: 'NOT_RUN', pr_url: null });
    const apiRead = uri => {
      if (uri === 'user') return { login: 'worker' };
      if (uri === `repos/${REPO}/issues/407`) return { title: ISSUE_TITLE, state: 'open' };
      if (uri === `repos/${REPO}/git/ref/heads/main`) return { object: { sha: commit } };
      const match = uri.match(/\/issues\/comments\/(\d+)$/);
      if (match) return comments.find(item => item.id === Number(match[1]));
      throw new Error(`UNEXPECTED_MOCK_API_ROUTE:${uri}`);
    };
    const writes = [];
    const logs = [];
    const runResult = await executeWorker(config, {
      apiRead, commentsRead: () => comments,
      codexReconcileDependencies: {
        exists: () => true,
        read: () => resultBytes,
        writeReceiptOnce: async (_config, data, login) => {
          writes.push(data);
          comments.push(com(9204, RECEIPT_MARKER + JSON.stringify(data), login));
        },
      },
      writeReceipt: (_config, data, login) => {
        writes.push(data);
        comments.push(com(9205 + writes.length, RECEIPT_MARKER + JSON.stringify(data), login));
      },
      dispatchCodexJob: () => { throw new Error('RECOVERED_ATTEMPT_MUST_NOT_REDISPATCH'); },
      runPlan: () => { throw new Error('INDEPENDENT_PING_MUST_NOT_INVOKE_MODEL'); },
      log: value => logs.push(value),
    });
    assert.equal(runResult.request_id, pingJob.request_id);
    assert.deepEqual(writes.map(item => [item.kind, item.state]), [
      ['codex_plan', 'FINISHED'], ['ping', 'STARTED'], ['ping', 'FINISHED'],
    ]);
    assert.equal(comments.filter(item => parseReceipt(item.body)?.request_id === codexJob.request_id).length, 2,
      'reconciliation writes one terminal receipt and does not create a second attempt');
    assert.ok(logs.includes(`RECOVERED_CODEX_TERMINAL_${codexJob.request_id}`));
    assert.ok(logs.includes(`FINISHED_${pingJob.request_id}_BRIDGE_PING_OK_NOT_OS_ACCEPTANCE`));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Codex terminal receipt keeps exit-zero execution explicitly unverified', () => {
  const taskSourceRef = { issue: 310, comment_id: 31002, author: 't14210184', body_sha256: hash };
  const started = { schema: 1, project_id: PROJECT, host: TEST_HOST,
    request_id: 'PTYSD_CODEX_TERMINAL_TEST_20261015', kind: 'codex_plan',
    source_sha: commit, attempt_id: '11111111-1111-4111-8111-111111111111',
    state: 'STARTED', model: 'gpt-6.1-sol', reasoning_effort: 'medium',
    task_fingerprint: hash, task_source_ref: taskSourceRef };
  const result = { schema: 1, kind: 'codex_plan', request_id: started.request_id,
    attempt_id: started.attempt_id, source_sha: commit, exit_code: 0,
    fingerprint: hash, session_id: 'session_12345678', session_started: true,
    provider_usage_evidence: 'CONFIRMED', model_activity_evidence: 'CONFIRMED',
    tool_execution_evidence: 'OBSERVED', tool_execution_count: 1,
    file_change_tool_evidence: 'COMPLETED', file_change_tool_completed_count: 1,
    file_change_tool_failed_count: 0, file_change_tool_incomplete_count: 0,
    process_tree_state: 'DEAD', diff_sha256: null,
    stdout_sha256: hash, stderr_sha256: hash, outcome: 'CODEX_CLI_EXIT_0_UNVERIFIED',
    model_invoked: true, changed_paths: [], out_of_scope_paths: [], pr_url: null, tests: 'NOT_RUN' };
  const terminal = codexTerminalReceipt(started, result);
  assert.equal(terminal.state, 'FINISHED');
  assert.equal(terminal.outcome, 'CODEX_CLI_EXIT_0_UNVERIFIED');
  assert.equal(terminal.file_change_tool_evidence, 'COMPLETED');
  assert.equal(terminal.file_change_tool_completed_count, 1);
  assert.deepEqual(terminal.task_source_ref, taskSourceRef,
    'the terminal receipt must retain its original #310 task provenance');
  assert.equal(parseReceipt(RECEIPT_MARKER + JSON.stringify(terminal)).file_change_tool_evidence,
    'COMPLETED', 'the existing receipt carries tool-write evidence separately from diff and CI');
  assert.equal(Object.hasOwn(terminal, 'accepted'), false);
  assert.equal(parseReceipt(RECEIPT_MARKER + JSON.stringify({ ...terminal,
    file_change_tool_completed_count: -1 })), null,
  'invalid file-change evidence must not be accepted as a valid receipt');
  const incomplete = codexTerminalReceipt(started, { ...result, outcome: 'EVIDENCE_STORAGE_FAILED' });
  assert.equal(incomplete.state, 'BLOCKED');
});

function makeIssue310TaskFixture({ taskCommentOverrides = {}, taskReadback = null } = {}) {
  const root = mkdtempSync(join(homedir(), '.ptysd-issue310-task-'));
  const workspace = join(root, 'workspace');
  const stateDir = join(root, 'state');
  const manifestDir = join(root, 'manifests');
  const resultsDir = join(root, 'results');
  mkdirSync(workspace); mkdirSync(stateDir); mkdirSync(manifestDir); mkdirSync(resultsDir);
  mkdirSync(join(manifestDir, 'candidate-bundles'));
  const host = hostname().toUpperCase();
  const mainSha = 'c'.repeat(40);
  const candidateSha = 'd'.repeat(40);
  const spec = 'Edit only the reviewed file and return a diff.';
  const job = bindGoalJob({ ...mkjob({ host,
    request_id: 'PTYSD_ISSUE310_STRUCTURED_TASK_20261017', kind: 'opencode_edit',
    source_sha: candidateSha, spec_path: 'native-bridge/tasks/scoped-edit.md', spec_sha256: h(spec) }),
    model: 'opencode/spark', variant: 'high', write_paths: ['README.md'] }, 434);
  const taskBody = encoded(job);
  const taskComment = { ...com(31001, taskBody, 'dispatcher'),
    issue_url: `https://api.github.com/repos/${REPO}/issues/310`, ...taskCommentOverrides };
  const comments = [];
  const executor = { task_name: '\\PTYSD\\OpenCodeExecutor', user_sid: 'S-1-5-21-100-200-300-1001',
    publisher_sid: 'S-1-5-21-100-200-300-1002', node_bin: 'C:\\Node\\node.exe',
    script_path: 'C:\\PTYSD\\executor.mjs', config_path: 'C:\\PTYSD\\executor.json',
    manifest_dir: manifestDir, results_dir: resultsDir, working_directory: 'C:\\PTYSD' };
  const config = { repo: REPO, project_id: PROJECT, host, issue: 407,
    workspace, state_dir: stateDir, dispatchers: ['dispatcher'], enable_v2_edit_runs: true,
    allowed_edit_models: { 'opencode/spark': ['high'] }, executor };
  const dispatches = [];
  const writes = [];
  const recoveryTriggers = [];
  let nextCommentId = 32000;
  const adapters = {
    apiRead(endpoint) {
      if (endpoint === 'user') return { login: 'worker' };
      if (endpoint.endsWith('/issues/407')) return { title: ISSUE_TITLE, state: 'open' };
      if (endpoint.includes('/git/ref/heads/main')) return { object: { sha: mainSha } };
      if (endpoint.endsWith('/pulls/434')) return testCandidatePull(candidateSha, mainSha, 434);
      if (endpoint.endsWith(`/issues/comments/${TEST_GOAL_REF.comment_id}`)) return TEST_GOAL_COMMENT;
      if (endpoint.endsWith(`/issues/comments/${taskComment.id}`))
        return typeof taskReadback === 'function'
          ? taskReadback({ endpoint, comment: taskComment, dispatches })
          : taskReadback ?? taskComment;
      if (endpoint.includes('/contents/')) return { encoding: 'base64', content: Buffer.from(spec).toString('base64') };
      const match = endpoint.match(/\/issues\/comments\/(\d+)$/);
      if (match) return comments.find(item => item.id === Number(match[1]));
      throw new Error(`UNEXPECTED_ISSUE310_TASK_API:${endpoint}`);
    },
    commentsRead: () => comments,
    goalCommentsRead: () => [TEST_GOAL_COMMENT, taskComment],
    writeReceipt(receiptConfig, data, login) {
      assert.equal(receiptConfig.issue, 407, 'the only receipt destination remains Issue #407');
      writes.push(data);
      comments.push(com(nextCommentId++, RECEIPT_MARKER + JSON.stringify(data), login));
    },
    qualifyOpenCodeV2: () => ({ ready: true }),
    assertExecutorTaskReady: () => ({ ready: true }),
    inspectOpenCodeExecutorAttempt: (_descriptor, expected = {}) => expected.job
      ? { state: 'STARTED' } : { state: 'EMPTY' },
    createCandidateSourceBundle: ({ job: sourceJob }) => ({ source_sha: sourceJob.source_sha, sha256: 'f'.repeat(64) }),
    dispatchToExecutor: (_descriptor, manifest) => {
      dispatches.push(manifest);
      return { outcome: 'EXECUTOR_TASK_DISPATCHED_NOT_ACCEPTANCE' };
    },
    triggerPendingExecutorAttempt: (_descriptor, attemptId) => {
      recoveryTriggers.push(attemptId);
      return { outcome: 'EXECUTOR_PENDING_ATTEMPT_TRIGGERED_NOT_ACCEPTANCE' };
    },
    runPlan: () => { throw new Error('DISPATCHER_MUST_NOT_RUN_MODEL_INLINE'); },
    log: () => {},
  };
  return { root, config, adapters, job, taskComment, comments, dispatches, writes, recoveryTriggers };
}

test('Issue #310 accepts only an exact structured task and publishes its receipt once to #407', async () => {
  const f = makeIssue310TaskFixture();
  try {
    const sourceRef = { issue: 310, comment_id: f.taskComment.id, author: 'dispatcher',
      body_sha256: h(f.taskComment.body) };
    const first = await executeWorker(f.config, f.adapters);
    assert.equal(first.state, 'DISPATCHED');
    assert.equal(f.dispatches.length, 1);
    assert.equal(f.dispatches[0].job.request_id, f.job.request_id);
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].state, 'STARTED');
    assert.deepEqual(f.writes[0].task_source_ref, sourceRef);
    assert.equal(parseReceipt(RECEIPT_MARKER + JSON.stringify(f.writes[0])).task_source_ref.comment_id,
      f.taskComment.id);

    const second = await executeWorker(f.config, f.adapters);
    assert.equal(second.state, 'NO_DELTA');
    assert.equal(f.dispatches.length, 1, 'the same #310 task cannot create a second executor attempt');
    assert.equal(f.writes.filter(item => item.request_id === f.job.request_id).length, 1);
    assert.ok(f.recoveryTriggers.every(id => id === f.writes[0].attempt_id),
      'recovery may only refer to the exact already-started attempt');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('Issue #310 structured Codex jobs use the existing executor and bind their #407 receipt to the source', async () => {
  const root = mkdtempSync(join(homedir(), '.ptysd-issue310-codex-'));
  try {
    const workspace = join(root, 'workspace'); const stateDir = join(root, 'state');
    const codexSpool = join(root, 'codex-spool');
    mkdirSync(workspace); mkdirSync(stateDir); mkdirSync(codexSpool);
    const host = hostname().toUpperCase();
    const spec = '# Synthetic read-only source task\nNo actual model runs in this test.\n';
    const job = { schema: 3, project_id: PROJECT, host,
      request_id: 'PTYSD_ISSUE310_CODEX_SOURCE_BINDING_20261017', kind: 'codex_plan',
      source_sha: commit, spec_path: 'native-bridge/tasks/codex-review.md',
      spec_sha256: h(spec), model: 'gpt-6.1-sol', reasoning_effort: 'medium',
      write_paths: ['native-bridge/sample.mjs'] };
    const taskComment = { ...com(31002, encoded(job), 't14210184'),
      issue_url: `https://api.github.com/repos/${REPO}/issues/310` };
    const comments = []; let nextId = 41002;
    const config = { repo: REPO, project_id: PROJECT, host, issue: 407,
      workspace, state_dir: stateDir, codex_spool: codexSpool,
      dispatchers: ['t14210184'], github_transport_verified: true,
      codex_cli_qualified: true, codex_login_verified: true,
      enable_codex_model_runs: true, codex_usage_authorized: true,
      codex_sandbox_boundary: 'VERIFIED_WORKSPACE_ONLY',
      publisher_identity_sid: 'S-1-5-21-1000', executor_identity_sid: 'S-1-5-21-2000',
      codex_executor_task: 'PTYSD-Codex-Executor',
      codex_executor_task_user: `${TEST_HOST}\\PTYSDCODEXEXEC`,
      codex_executor_wscript_path: 'C:\\Windows\\System32\\wscript.exe',
      codex_executor_launcher_path: 'C:\\ProgramData\\PTYSDNativeBridge\\HiddenCodexExecutor.vbs',
      codex_executor_node_path: 'C:\\Program Files\\nodejs\\node.exe',
      codex_executor_script_path: 'C:\\ProgramData\\PTYSDNativeBridge\\codex-executor.mjs',
      codex_executor_config_path: 'C:\\ProgramData\\PTYSDNativeBridge\\executor-config.json',
      codex_executor_working_directory: 'C:\\ProgramData\\PTYSDNativeBridge\\CodexSpool',
      allowed_codex_models: { 'gpt-6.1-sol': ['medium'] } };
    const calls = { bundle: 0, start: [], trigger: 0, inline: 0 };
    const apiRead = uri => {
      if (uri === 'user') return { login: 'worker' };
      if (uri === `repos/${REPO}/issues/407`) return { title: ISSUE_TITLE, state: 'open' };
      if (uri === `repos/${REPO}/git/ref/heads/main`) return { object: { sha: commit } };
      if (uri === `repos/${REPO}/issues/comments/${taskComment.id}`) return taskComment;
      if (uri === `repos/${REPO}/contents/${job.spec_path}?ref=${commit}`)
        return { encoding: 'base64', content: Buffer.from(spec).toString('base64') };
      throw new Error(`UNEXPECTED_ISSUE310_CODEX_API:${uri}`);
    };
    const result = await executeWorker(config, {
      apiRead, commentsRead: () => comments, goalCommentsRead: () => [taskComment],
      assertCodexExecutorTaskReady: () => ({ ready: true }),
      writeReceipt: () => { throw new Error('GENERIC_RECEIPT_PATH_MUST_NOT_RUN'); },
      runPlan: () => { calls.inline++; throw new Error('MODEL_MUST_NOT_RUN_INLINE'); },
      codexDispatchOptions: {
        createBundle: async path => { calls.bundle++; writeFileSync(path, 'synthetic immutable bundle'); },
        publishStarted: async data => {
          calls.start.push(data);
          comments.push(com(nextId++, RECEIPT_MARKER + JSON.stringify(data), 'worker'));
        },
        trigger: () => { calls.trigger++; },
      },
      log: () => {},
    });
    assert.equal(result.state, 'CODEX_EXECUTOR_REQUESTED');
    assert.equal(calls.bundle, 1);
    assert.equal(calls.start.length, 1);
    assert.equal(calls.trigger, 1, 'only the injected synthetic executor trigger runs');
    assert.equal(calls.inline, 0, 'the dispatcher never invokes Codex inline');
    const expectedSource = { issue: 310, comment_id: taskComment.id,
      author: 't14210184', body_sha256: h(taskComment.body) };
    assert.deepEqual(calls.start[0].task_source_ref, expectedSource);
    assert.equal(parseReceipt(comments.at(-1).body).task_source_ref.comment_id, taskComment.id);
    const merged = [...comments, { ...taskComment, task_source_ref: expectedSource }];
    assert.equal(selectNext(merged, ['t14210184'], 'worker', host, commit), null,
      'the #407 STARTED receipt suppresses redispatch of the same #310 task');

    taskComment.body += '\nEdited after the executor request was queued.';
    const recovered = await executeWorker(config, {
      apiRead, commentsRead: () => comments, goalCommentsRead: () => [taskComment],
      assertCodexExecutorTaskReady: () => ({ ready: true }),
      codexDispatchOptions: {
        trigger: () => { calls.trigger++; },
      },
      runPlan: () => { calls.inline++; throw new Error('MODEL_MUST_NOT_RUN_INLINE'); },
      log: () => {},
    });
    assert.equal(recovered.state, 'NO_DELTA');
    assert.equal(calls.trigger, 1, 'a changed #310 source cannot authorize recovery retrigger');
    assert.equal(takeNextRequest(codexSpool), null,
      'recovery cancellation prevents another task trigger from consuming the stale request');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Codex executor is not triggered when #310 changes after STARTED readback', async () => {
  const root = mkdtempSync(join(homedir(), '.ptysd-codex-source-race-'));
  try {
    const stateDir = join(root, 'state'); const spoolDir = join(root, 'spool');
    mkdirSync(stateDir); mkdirSync(spoolDir);
    const spec = 'synthetic spec';
    const job = { schema: 3, project_id: PROJECT, host: TEST_HOST,
      request_id: 'PTYSD_CODEX_SOURCE_RACE_20261017', kind: 'codex_plan', source_sha: commit,
      spec_path: 'native-bridge/tasks/codex-review.md', spec_sha256: h(spec),
      model: 'gpt-6.1-sol', reasoning_effort: 'medium', write_paths: ['native-bridge/sample.mjs'] };
    const taskSourceRef = { issue: 310, comment_id: 31003, author: 't14210184', body_sha256: hash };
    let sourceStillMatches = true; let triggers = 0; const receipts = [];
    const result = await dispatchCodexJob({ config: { state_dir: stateDir, codex_spool: spoolDir },
      job, spec, workerLogin: 'worker', taskSourceRef,
      verifyTaskSource: () => sourceStillMatches,
      createBundle: async path => writeFileSync(path, 'synthetic bundle bytes'),
      publishStarted: async data => {
        receipts.push(data);
        if (data.state === 'STARTED') sourceStillMatches = false;
      },
      trigger: () => { triggers++; },
    });
    assert.equal(result.state, 'CODEX_TASK_SOURCE_CHANGED_NO_TRIGGER');
    assert.equal(triggers, 0);
    const requestPath = join(spoolDir, 'requests',
      `${job.request_id}-${receipts[0].attempt_id}.json`);
    const cancellation = JSON.parse(readFileSync(`${requestPath}.cancelled`, 'utf8'));
    assert.equal(cancellation.reason, 'SOURCE_CHANGED_BEFORE_EXECUTOR_TRIGGER');
    assert.equal(takeNextRequest(spoolDir), null,
      'the durable cancellation marker prevents a later unrelated trigger from consuming the stale request');
    assert.deepEqual(receipts.map(value => value.state), ['STARTED'],
      'keep the attempt unresolved so later executor ticks cannot consume a stale queued request');
    assert.equal(receipts[0].task_source_ref.comment_id, taskSourceRef.comment_id);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Issue #310 wrong-author, wrong-issue, or edited task readback never dispatches', async () => {
  for (const overrides of [
    { user: { login: 'untrusted' } },
    { issue_url: `https://api.github.com/repos/${REPO}/issues/311` },
  ]) {
    const f = makeIssue310TaskFixture({ taskCommentOverrides: overrides });
    try {
      const result = await executeWorker(f.config, f.adapters);
      assert.equal(result.state, 'NO_DELTA');
      assert.equal(f.dispatches.length, 0);
      assert.equal(f.writes.length, 0);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
  const changed = makeIssue310TaskFixture();
  try {
    await assert.rejects(executeWorker(changed.config, { ...changed.adapters,
      apiRead(endpoint) {
        if (endpoint.endsWith(`/issues/comments/${changed.taskComment.id}`))
          return { ...changed.taskComment, body: `${changed.taskComment.body} edited` };
        return changed.adapters.apiRead(endpoint);
      } }), error => error.message === 'DISPATCH_COMMENT_CHANGED');
  } finally {
    assert.equal(changed.dispatches.length, 0);
    assert.equal(changed.writes.length, 0);
    rmSync(changed.root, { recursive: true, force: true });
  }
});

test('Issue #310 prose is not an executable task', async () => {
  const f = makeIssue310TaskFixture({ taskCommentOverrides: {
    body: 'Please run this task now and modify the repository.' } });
  try {
    const result = await executeWorker(f.config, f.adapters);
    assert.equal(result.state, 'NO_DELTA');
    assert.equal(f.dispatches.length, 0);
    assert.equal(f.writes.length, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('Issue #310 mutation after executor start publishes no STARTED receipt and cannot replay', async () => {
  let dispatched = false;
  const f = makeIssue310TaskFixture({ taskReadback: ({ comment }) => dispatched
    ? { ...comment, body: `${comment.body} edited after start` } : comment });
  const dispatchToExecutor = f.adapters.dispatchToExecutor;
  f.adapters.dispatchToExecutor = (...args) => {
    const result = dispatchToExecutor(...args);
    dispatched = true;
    return result;
  };
  try {
    const first = await executeWorker(f.config, f.adapters);
    assert.equal(first.state, 'UNKNOWN_EXECUTOR_START_SOURCE_READBACK');
    assert.equal(f.dispatches.length, 1, 'the executor was launched once before the source race was observed');
    assert.equal(f.writes.some(item => item.request_id === f.job.request_id && item.state === 'STARTED'), false,
      'no public STARTED receipt may be written after source readback changes');

    await assert.rejects(executeWorker(f.config, f.adapters),
      error => error.message === 'DISPATCH_COMMENT_CHANGED');
    assert.equal(f.dispatches.length, 1, 'an uncertain process start must not be replayed');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('Issue #310 read failure does not starve an independent #407 ping', async () => {
  const root = mkdtempSync(join(homedir(), '.ptysd-issue310-read-failure-'));
  try {
    const workspace = join(root, 'workspace'); const stateDir = join(root, 'state');
    mkdirSync(workspace); mkdirSync(stateDir);
    const ping = mkjob({ host: hostname().toUpperCase(), request_id: 'PTYSD_407_PING_DURING_310_FAILURE_20261017' });
    const comments = [com(1, encoded(ping), 'dispatcher')];
    const writes = []; const logs = [];
    const result = await executeWorker({ repo: REPO, project_id: PROJECT, host: ping.host,
      issue: 407, workspace, state_dir: stateDir, dispatchers: ['dispatcher'] }, {
      apiRead(endpoint) {
        if (endpoint === 'user') return { login: 'worker' };
        if (endpoint.endsWith('/issues/407')) return { title: ISSUE_TITLE, state: 'open' };
        if (endpoint.includes('/git/ref/heads/main')) return { object: { sha: commit } };
        const match = endpoint.match(/\/issues\/comments\/(\d+)$/);
        if (match) return comments.find(item => item.id === Number(match[1]));
        throw new Error(`UNEXPECTED_ISSUE310_FAILURE_API:${endpoint}`);
      },
      commentsRead: () => comments,
      goalCommentsRead: () => { throw new Error('SIMULATED_ISSUE310_API_UNAVAILABLE'); },
      writeReceipt: (_config, data) => writes.push(data),
      runPlan: () => { throw new Error('NO_MODEL_CALL_EXPECTED'); },
      log: value => logs.push(value),
    });
    assert.equal(result.state, 'FINISHED');
    assert.equal(result.request_id, ping.request_id);
    assert.ok(logs.includes('HUMAN_TASK_DISCOVERY_READ_UNKNOWN'));
    assert.deepEqual(writes.map(item => [item.request_id, item.state]), [
      [ping.request_id, 'STARTED'], [ping.request_id, 'FINISHED'],
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a #407 receipt with no matching #310 source identity suppresses a colliding task', () => {
  const job = bindGoalJob({ ...mkjob({ host: TEST_HOST,
    request_id: 'PTYSD_ISSUE310_SOURCE_COLLISION_20261017', kind: 'opencode_edit',
    spec_path: 'native-bridge/tasks/scoped-edit.md', spec_sha256: hash }),
    model: 'opencode/spark', variant: 'high', write_paths: ['README.md'] }, 434);
  const body = encoded(job);
  const sourceRef = { issue: 310, comment_id: 31001, author: 'dispatcher', body_sha256: h(body) };
  const source = { ...com(31001, body, 'dispatcher'), issue_url: `https://api.github.com/repos/${REPO}/issues/310`,
    task_source_ref: sourceRef };
  const startedWithoutSource = receipt(job.request_id, '11111111-1111-4111-8111-111111111111',
    'STARTED', job);
  const comments = [source, com(40701, RECEIPT_MARKER + JSON.stringify(startedWithoutSource), 'worker')];
  assert.equal(selectNext(comments, ['dispatcher'], 'worker', TEST_HOST, commit, [],
    new Set([`434:${job.source_sha}`])), null,
  'an older receipt for the same request from another source cannot authorize replay');
  const boundStarted = receipt(job.request_id, '22222222-2222-4222-8222-222222222222',
    'STARTED', job, null, sourceRef);
  assert.deepEqual(parseReceipt(RECEIPT_MARKER + JSON.stringify(boundStarted)).task_source_ref, sourceRef);
  assert.equal(parseReceipt(RECEIPT_MARKER + JSON.stringify({ ...boundStarted,
    task_source_ref: { ...sourceRef, issue: 311 } })), null);
});
