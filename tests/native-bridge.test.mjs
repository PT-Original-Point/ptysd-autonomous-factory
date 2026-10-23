import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, chmodSync, readdirSync, existsSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseJob, selectNext, parseReceipt, receipt, PROJECT, REPO, JOB_MARKER,
  RECEIPT_MARKER, checkModelAuthorization, terminalStateForResult,
  runWorker as runWorkerImplementation, main as runWorker, writeReceipt, ISSUE_TITLE, guardConfig,
  runPlan as executeOpenCodeTask, verifyCapturedEvidence, antigravityExecutionAuthorization,
  captureScopedEditDiff,
  codexTerminalReceipt, selectNextWithCodexClaim, readPinnedCandidateSources, executorForJobKind,
  publishOperatorObservation, buildOpenCodeChildEnv, nativePreflight } from '../native-bridge/worker.mjs';
import { OPERATOR_MARKER, OPERATOR_COMMENT_ID, encodeOperatorObservation, parseOperatorObservation }
  from '../native-bridge/operator-observation.mjs';
import { makeCodexExecutorRequest, codexScopedActionStatus }
  from '../native-bridge/codex-continuation.mjs';
import { ANTIGRAVITY_V2_MODEL, buildAntigravityChildEnvironment, buildNativeChildEnvironment }
  from '../native-bridge/v2-readiness.mjs';

const commit = 'a'.repeat(40); const hash = 'b'.repeat(64);
const humanGoalBody = `<!-- PTYSD_V53R4_DELETE_FIRST_AUTONOMY_GOAL_20261015 -->\nCandidate task linkage fixture; this text is provenance only.`;
const humanGoalComment = (overrides = {}) => ({ id: 6188322050,
  issue_url: `https://api.github.com/repos/${REPO}/issues/310`,
  user: { login: 't14210184' }, body: humanGoalBody, ...overrides });
const withHumanGoal = job => ({ ...job, schema: 6, goal_comment_id: 6188322050,
  goal_body_sha256: h(humanGoalBody) });
const mkjob = (opts = {}) => ({ schema: 1, project_id: PROJECT, host: 'DESKTOP-1B6PD2P',
  request_id: 'PTYSD_NATIVE_PING_20261012', kind: 'ping', source_sha: commit,
  spec_path: null, spec_sha256: null, ...opts });
const encoded = o => JOB_MARKER + JSON.stringify(o);
const com = (id, body, login = 't14210184') => ({ id, body, user: { login } });
const h = x => createHash('sha256').update(x).digest('hex');
const executeWorker = (config, adapters = {}) => runWorkerImplementation(config,
  { goalCommentsRead: () => [], ...adapters });
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

function executorDescriptorForLane(lane, userSuffix) {
  const root = `C:\\PTYSD\\${lane}`;
  return {
    task_name: `\\PTYSD\\${lane}Executor`,
    user_sid: `S-1-5-21-100-200-300-${userSuffix}`,
    publisher_sid: 'S-1-5-21-100-200-300-1002',
    wscript_path: 'C:\\Windows\\System32\\wscript.exe',
    launcher_path: 'C:\\PTYSD\\HiddenExecutor.vbs',
    node_bin: 'C:\\Node\\node.exe',
    script_path: 'C:\\PTYSD\\executor.mjs',
    config_path: `${root}\\executor.json`,
    manifest_dir: `${root}\\manifests`,
    results_dir: `${root}\\results`,
    working_directory: `${root}\\work`,
    source_bundle_per_attempt: true,
  };
}

test('model Executor routing isolates W1 and W2 identities, tasks, manifests and workspaces', () => {
  const root = mkdtempSync(join(homedir(), '.ptysd-executor-lane-routing-'));
  try {
    const workspace = join(root, 'workspace');
    const stateDir = join(root, 'state');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    const opencode = executorDescriptorForLane('OpenCode', 1001);
    const antigravity = executorDescriptorForLane('Antigravity', 1003);
    const base = { repo: REPO, project_id: PROJECT, host: hostname().toUpperCase(), issue: 407,
      workspace, state_dir: stateDir, dispatchers: ['t14210184'] };
    const config = guardConfig({ ...base, executors: { opencode, antigravity } });

    assert.equal(executorForJobKind(config, 'opencode_plan'), opencode);
    assert.equal(executorForJobKind(config, 'opencode_edit'), opencode);
    assert.equal(executorForJobKind(config, 'antigravity_edit'), antigravity);
    assert.equal(executorForJobKind({ executors: { opencode } }, 'antigravity_edit'), null,
      'an explicit but missing W2 route must not fall back to W1');
    assert.equal(executorForJobKind({ executor: opencode }, 'opencode_edit'), opencode,
      'the unmarked legacy descriptor remains assigned to OpenCode');
    assert.equal(executorForJobKind({ executor: opencode }, 'antigravity_edit'), null,
      'an unmarked legacy descriptor is never assumed to be a W2 executor');
    assert.equal(executorForJobKind({ executor: opencode, enable_antigravity_model_runs: true },
      'antigravity_edit'), null,
    'enabling W2 does not infer that a legacy W1 identity is safe for W2');
    assert.equal(executorForJobKind({ executor: opencode, executor_lane: 'antigravity' },
      'antigravity_edit'), opencode,
    'a legacy descriptor can serve W2 only when explicitly lane-bound');
    assert.equal(executorForJobKind({ executor: opencode, executor_lane: 'antigravity' },
      'opencode_edit'), null);
    assert.equal(executorForJobKind({ executor: opencode, executor_lane: 'opencode' }, 'antigravity_edit'), null,
      'a legacy descriptor explicitly assigned to W1 cannot execute W2 jobs');
    assert.equal(executorForJobKind({ executor: opencode, executor_lane: 'opencode' }, 'opencode_edit'), opencode);
    assert.equal(executorForJobKind({ executor: opencode, enable_v2_model_runs: true,
      enable_antigravity_model_runs: true }, 'antigravity_edit'), null,
    'a shared legacy descriptor cannot serve both enabled Worker lanes');
    assert.equal(executorForJobKind(config, 'ping'), null);

    assert.throws(() => guardConfig({ ...base, executor: opencode,
      executors: { opencode, antigravity } }), /EXECUTOR_ROUTING_CONFIG_AMBIGUOUS/);
    assert.throws(() => guardConfig({ ...base, executor: opencode, executor_lane: 'codex' }),
      /EXECUTOR_LANE_CONFIG_INVALID/);
    assert.throws(() => guardConfig({ ...base, executor: opencode, executor_lane: 'opencode',
      executors: { opencode, antigravity } }), /EXECUTOR_ROUTING_CONFIG_AMBIGUOUS/);
    assert.throws(() => guardConfig({ ...base, executors: { opencode,
      antigravity: { ...antigravity, user_sid: opencode.user_sid } } }),
    /EXECUTOR_LANE_IDENTITY_COLLISION/);
    assert.throws(() => guardConfig({ ...base, executors: { opencode,
      antigravity: { ...antigravity, manifest_dir: opencode.results_dir } } }),
    /EXECUTOR_LANE_PATH_COLLISION/);
    assert.throws(() => guardConfig({ ...base, executors: { opencode,
      antigravity: { ...antigravity, task_name: opencode.task_name } } }),
    /EXECUTOR_LANE_TASK_COLLISION/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function makeObservationWorkerFixture({ ambiguousReadback = false, priorObservation = null,
  priorObservationBody = null,
  readCommentFailure = null, readCommentsFailure = null, patchCommentFailure = null,
  seededObservation = true,
  collectWindowsFailure = null, windowsObservation = null, goalComments = [], taskComments = [], candidatePulls = {}, configOverrides = {} } = {}) {
  const root = mkdtempSync(join(homedir(), '.ptysd-worker-observation-'));
  const workspace = join(root, 'workspace');
  const stateDir = join(root, 'state');
  mkdirSync(workspace);
  mkdirSync(stateDir);
  const host = hostname().toUpperCase();
  const publisher = 'trusted-publisher';
  const observationId = OPERATOR_COMMENT_ID;
  let pendingReadCommentsFailure = readCommentsFailure;
  const job = mkjob({ host, request_id: 'PTYSD_NATIVE_OBSERVE_PING_20261014' });
  const store = {
    next: 703,
    comments: [
      ...(seededObservation ? [{ ...com(observationId, priorObservationBody || encodeOperatorObservation(
        priorObservation || seededOperatorObservation(observationId, 17, commit, Date.now() - 60_000),
      ), publisher), updated_at: new Date(Date.now() - 60_000).toISOString() }] : []),
      com(702, encoded(job), 't14210184'),
      ...taskComments,
    ],
    patches: 0,
    posts: 0,
    failReadback: ambiguousReadback,
    now: Date.now(),
  };
  const config = { repo: REPO, project_id: PROJECT, host, issue: 407,
    workspace, state_dir: stateDir, dispatchers: ['t14210184'], ...configOverrides };
  const api = uri => {
    if (uri === 'user') return { login: publisher };
    if (uri === `repos/${REPO}/issues/407`)
      return { title: ISSUE_TITLE, state: 'open' };
    if (uri === `repos/${REPO}/git/ref/heads/main`)
      return { object: { sha: commit } };
    const pullMatch = uri.match(new RegExp(`^repos/${REPO}/pulls/(\\d+)$`));
    if (pullMatch) {
      const pull = candidatePulls[Number(pullMatch[1])];
      if (!pull) throw new Error(`MOCK_PULL_MISSING:${pullMatch[1]}`);
      return structuredClone(pull);
    }
    const match = uri.match(/\/issues\/comments\/(\d+)$/);
    if (match) return store.comments.find(c => c.id === Number(match[1])) ||
      goalComments.find(c => c.id === Number(match[1]));
    throw new Error(`UNEXPECTED_MOCK_API_ROUTE:${uri}`);
  };
  const observationDependencies = {
    now: () => new Date(store.now),
    collectWindowsObservation: () => {
      if (collectWindowsFailure) throw collectWindowsFailure;
      return windowsObservation || ({ status: 'FRESH', observed_at: new Date(store.now).toISOString(),
        tasks_total: 2, legacy_monitor_registered: false, listener_2667: false,
        opencode_process_count: 0, runner_service_count: 0, runner_service_running: false,
        native_task: { registered: true, enabled: true, state: 'Ready', last_run: null,
          last_result: '0x00000000', action_kind: 'WINDOWLESS_LAUNCHER',
          identity_class: 'INTERACTIVE_LIMITED', multiple_instances: 'IGNORENEW',
          trigger_interval_minutes: 5 } });
    },
    readRunnerRegistration: () => ({ total_count: 0 }),
    readComment: id => {
      if (readCommentFailure) throw readCommentFailure;
      return structuredClone(store.comments.find(c => c.id === id));
    },
    patchComment: (id, body) => {
      if (patchCommentFailure) { store.patches++; throw patchCommentFailure; }
      const comment = store.comments.find(c => c.id === id);
      if (!comment) throw new Error('MOCK_COMMENT_MISSING');
      comment.body = body;
      const observation = parseOperatorObservation(body);
      comment.updated_at = new Date(Date.parse(observation.observed_at) + 1000).toISOString();
      store.patches++;
    },
    readComments: () => {
      if (store.failReadback) {
        store.failReadback = false;
        throw new Error('MOCK_READBACK_UNAVAILABLE_AFTER_PATCH');
      }
      if (pendingReadCommentsFailure) {
        const failure = pendingReadCommentsFailure;
        pendingReadCommentsFailure = null;
        throw failure;
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
    goalCommentsRead: () => goalComments,
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

test('Worker records next-owner classification failures by stage and continues independent work', async () => {
  const fixture = makeObservationWorkerFixture({
    windowsObservation: { status: 'FRESH', observed_at: new Date().toISOString() },
  });
  const diagnosticPath = join(fixture.root, 'state', 'operator-observation-last-error.json');
  try {
    await fixture.run();
    const diagnostic = JSON.parse(readFileSync(diagnosticPath, 'utf8'));
    assert.equal(diagnostic.status, 'UNKNOWN');
    assert.equal(diagnostic.error_code, 'OPERATOR_OBSERVATION_NEXT_OWNER_UNKNOWN');
    assert.deepEqual(fixture.receiptWrites.map(entry => entry.state), ['STARTED', 'FINISHED']);
    assert.equal(fixture.modelCalls.count, 0);
    assert.equal(fixture.store.patches, 0);
  } finally { fixture.cleanup(); }
});
test('Worker records a phase-specific OS observation error and continues independent work', async () => {
  const fixture = makeObservationWorkerFixture({
    collectWindowsFailure: Object.assign(new Error('C:\\sensitive\\local\\path'), { code: 'EACCES' }),
  });
  const diagnosticPath = join(fixture.root, 'state', 'operator-observation-last-error.json');
  try {
    await fixture.run();
    const diagnostic = JSON.parse(readFileSync(diagnosticPath, 'utf8'));
    assert.equal(diagnostic.status, 'UNKNOWN');
    assert.equal(diagnostic.error_code, 'OPERATOR_OBSERVATION_WINDOWS_READBACK_EACCES');
    assert.deepEqual(fixture.receiptWrites.map(entry => entry.state), ['STARTED', 'FINISHED']);
    assert.equal(fixture.modelCalls.count, 0);
    assert.equal(fixture.store.patches, 0);
    assert.ok(!JSON.stringify(diagnostic).includes('sensitive'));
  } finally { fixture.cleanup(); }
});
test('Worker repairs an existing observation with null published_at in place', async () => {
  const prior = { ...seededOperatorObservation(OPERATOR_COMMENT_ID, 17, commit, Date.now() - 60_000),
    published_at: null,
    runtime_deployment: {
      status: 'MANIFEST_MATCHED',
      observed_at: new Date(Date.now() - 60_000).toISOString(),
      source_main_sha: commit,
      deployment_pr: 419,
      deployment_pr_head: commit,
      bundle_sha256: hash,
      component_sha256: {
        'worker.mjs': hash,
        'operator-observation.mjs': hash,
        'codex-continuation.mjs': hash,
        'safe-error-code.mjs': hash,
      },
    } };
  const priorBody = OPERATOR_MARKER + JSON.stringify(prior);
  const parsedLegacy = parseOperatorObservation(priorBody);
  assert.equal(parsedLegacy.runtime_deployment.status, 'UNKNOWN');
  assert.equal(parsedLegacy.runtime_deployment.reason_code, 'RUNTIME_FILES_UNAVAILABLE');
  assert.deepEqual(Object.values(parsedLegacy.runtime_deployment.component_sha256),
    Array(8).fill(null), 'a legacy four-file manifest cannot claim the current eight-file runtime');
  const fixture = makeObservationWorkerFixture({
    priorObservationBody: priorBody,
  });
  try {
    await fixture.run();
    const observations = fixture.store.comments.filter(c => c.body.startsWith(OPERATOR_MARKER));
    assert.equal(observations.length, 1);
    assert.equal(observations[0].id, OPERATOR_COMMENT_ID);
    const value = parseOperatorObservation(observations[0].body);
    assert.equal(value.sequence, 18);
    assert.equal(value.published_at, undefined);
    assert.equal(value.runtime_deployment.status, 'UNKNOWN');
    assert.equal(fixture.store.patches, 1);
    assert.equal(fixture.modelCalls.count, 0);
  } finally { fixture.cleanup(); }
});

test('Worker preserves the invalid observation reason and continues independent ping work', async () => {
  const invalid = { ...seededOperatorObservation(OPERATOR_COMMENT_ID, 17, commit), schema: 2 };
  const fixture = makeObservationWorkerFixture({
    priorObservationBody: OPERATOR_MARKER + JSON.stringify(invalid),
  });
  const diagnosticPath = join(fixture.root, 'state', 'operator-observation-last-error.json');
  try {
    await fixture.run();
    const diagnostic = JSON.parse(readFileSync(diagnosticPath, 'utf8'));
    assert.equal(diagnostic.status, 'UNKNOWN');
    assert.equal(diagnostic.error_code, 'OPERATOR_INVALID_OBSERVATION');
    assert.deepEqual(fixture.receiptWrites.map(entry => entry.state), ['STARTED', 'FINISHED']);
    assert.equal(fixture.modelCalls.count, 0);
    assert.equal(fixture.store.patches, 0, 'an invalid observation is never overwritten');
  } finally { fixture.cleanup(); }
});

test('Worker main publishes the seeded observation, verifies sequence readback, and preserves legal dispatch on ambiguity', async () => {
  const successful = makeObservationWorkerFixture();
  const diagnosticPath = join(successful.root, 'state', 'operator-observation-last-error.json');
  try {
    await successful.run();
    assert.equal(existsSync(diagnosticPath), false);
    let observations = successful.store.comments.filter(c => c.body.startsWith(OPERATOR_MARKER));
    assert.equal(observations.length, 1);
    assert.equal(observations[0].id, successful.observationId);
    assert.equal(observations[0].user.login, 'trusted-publisher');
    let value = parseOperatorObservation(observations[0].body);
    assert.equal(value.sequence, 18);
    assert.equal(value.published_at, undefined);
    assert.equal(Date.parse(observations[0].updated_at), Date.parse(value.observed_at) + 1000,
      'the published timestamp is the provider readback, not the local observation time');
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
      assert.equal(result.scope, 'FORMAL_WORK_QUEUE_ONLY');
      assert.equal(result.mission_complete, false,
        'an empty formal queue does not close the Human mission');
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
    assert.ok(successful.logs.includes('NO_AUTHORIZED_W1_JOB'),
      'absence of a W1 job is reported separately from model eligibility');
    assert.ok(!successful.logs.some(x => x.startsWith('OPENCODE_LANE_WAITING_ELIGIBILITY_')),
      'no W1 job must not be misreported as a model login or qualification failure');
  } finally { successful.cleanup(); }

  const ambiguous = makeObservationWorkerFixture({ ambiguousReadback: true });
  const ambiguousDiagnosticPath = join(ambiguous.root, 'state', 'operator-observation-last-error.json');
  try {
    await ambiguous.run();
    assert.equal(existsSync(ambiguousDiagnosticPath), true);
    const diagnostic = JSON.parse(readFileSync(ambiguousDiagnosticPath, 'utf8'));
    assert.deepEqual(Object.keys(diagnostic).sort(),
      ['error_code', 'observed_at', 'publisher_identity', 'schema', 'source_sha', 'status'].sort());
    assert.equal(diagnostic.status, 'UNKNOWN');
    assert.equal(diagnostic.source_sha, commit);
    assert.equal(diagnostic.error_code, 'OPERATOR_COMMENT_UPDATE_READBACK_FAILED');
    assert.deepEqual(diagnostic.publisher_identity, {
      publisher_login: 'trusted-publisher', comment_author_login: 'trusted-publisher',
    });
    assert.ok(!JSON.stringify(diagnostic).includes('MOCK_READBACK_UNAVAILABLE_AFTER_PATCH'));
    const observations = ambiguous.store.comments.filter(c => c.body.startsWith(OPERATOR_MARKER));
    assert.equal(observations.length, 1);
    assert.equal(observations[0].id, ambiguous.observationId);
    assert.equal(ambiguous.store.patches, 1);
    assert.ok(ambiguous.logs.includes(
      'OPERATOR_OBSERVATION_UPDATE_UNKNOWN_OPERATOR_COMMENT_UPDATE_READBACK_FAILED'));
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
    assert.equal(existsSync(ambiguousDiagnosticPath), false,
      'a verified same-comment recovery clears the prior local failure diagnostic');
    assert.equal(ambiguous.modelCalls.count, 0);
    assert.equal(ambiguous.codexDispatchCalls.count, 0,
      'observation recovery must not launch the Codex executor');
  } finally { ambiguous.cleanup(); }

  const unseeded = makeObservationWorkerFixture({ seededObservation: false });
  const unseededDiagnosticPath = join(unseeded.root, 'state', 'operator-observation-last-error.json');
  try {
    const result = await unseeded.run();
    assert.equal(result.state, 'FINISHED', 'missing monitor seed must not block independent dispatch');
    assert.ok(unseeded.logs.includes('OPERATOR_OBSERVATION_NOT_SEEDED_OPERATOR_OBSERVATION_NOT_SEEDED'));
    assert.deepEqual(unseeded.receiptWrites.map(value => value.state), ['STARTED', 'FINISHED']);
    assert.equal(unseeded.modelCalls.count, 0);
    const diagnostic = JSON.parse(readFileSync(unseededDiagnosticPath, 'utf8'));
    assert.equal(diagnostic.status, 'NOT_SEEDED');
    assert.equal(diagnostic.error_code, 'OPERATOR_OBSERVATION_NOT_SEEDED');
    assert.equal(diagnostic.source_sha, commit);
  } finally { unseeded.cleanup(); }
});

test('Worker reports the failing observation API stage without persisting provider error text', async () => {
  const readFailure = Object.assign(new Error('provider request failed'), {
    stderr: Buffer.from('HTTP 403: Bearer must never be persisted'),
  });
  const prewrite = makeObservationWorkerFixture({ readCommentFailure: readFailure });
  const prewritePath = join(prewrite.root, 'state', 'operator-observation-last-error.json');
  try {
    await prewrite.run();
    const diagnostic = JSON.parse(readFileSync(prewritePath, 'utf8'));
    assert.equal(diagnostic.error_code, 'OPERATOR_COMMENT_PREWRITE_READ_HTTP_403');
    assert.equal(prewrite.store.patches, 0);
    assert.equal(prewrite.store.comments.filter(c => c.body.startsWith(OPERATOR_MARKER)).length, 1);
    assert.deepEqual(prewrite.receiptWrites.map(value => value.state), ['STARTED', 'FINISHED'],
      'a publisher read failure does not block the independent ping task');
    assert.ok(!JSON.stringify(diagnostic).includes('Bearer'));
    assert.equal(prewrite.modelCalls.count, 0);
  } finally { prewrite.cleanup(); }

  const patchFailure = Object.assign(new Error('Bearer must never be persisted'), { status: 403 });
  const patch = makeObservationWorkerFixture({ patchCommentFailure: patchFailure });
  const patchPath = join(patch.root, 'state', 'operator-observation-last-error.json');
  try {
    await patch.run();
    const diagnostic = JSON.parse(readFileSync(patchPath, 'utf8'));
    assert.equal(diagnostic.error_code, 'OPERATOR_COMMENT_PATCH_HTTP_403');
    assert.equal(patch.store.patches, 1);
    assert.equal(patch.store.comments.filter(c => c.body.startsWith(OPERATOR_MARKER)).length, 1);
    assert.equal(parseOperatorObservation(
      patch.store.comments.find(c => c.body.startsWith(OPERATOR_MARKER)).body).sequence, 17,
    'a rejected PATCH does not advance the authoritative observation');
    assert.deepEqual(patch.receiptWrites.map(value => value.state), ['STARTED', 'FINISHED'],
      'a publisher write failure does not block independent valid work');
    assert.ok(!JSON.stringify(diagnostic).includes('Bearer'));
    assert.equal(patch.modelCalls.count, 0);
  } finally { patch.cleanup(); }

  const readbackFailure = Object.assign(new Error('provider readback failed'), {
    status: 403, stderr: Buffer.from('HTTP 403: Bearer must never be persisted'),
  });
  const readback = makeObservationWorkerFixture({ readCommentsFailure: readbackFailure });
  const readbackPath = join(readback.root, 'state', 'operator-observation-last-error.json');
  try {
    await readback.run();
    const diagnostic = JSON.parse(readFileSync(readbackPath, 'utf8'));
    assert.equal(diagnostic.error_code, 'OPERATOR_COMMENT_UPDATE_READBACK_HTTP_403');
    assert.equal(readback.store.patches, 1);
    assert.equal(readback.store.comments.filter(c => c.body.startsWith(OPERATOR_MARKER)).length, 1);
    assert.equal(parseOperatorObservation(
      readback.store.comments.find(c => c.body.startsWith(OPERATOR_MARKER)).body).sequence, 18,
    'a readback failure after PATCH does not erase the provider-side update');
    assert.deepEqual(readback.receiptWrites.map(value => value.state), ['STARTED', 'FINISHED'],
      'an observation readback failure does not block independent valid work');
    assert.ok(!JSON.stringify(diagnostic).includes('Bearer'));
    assert.equal(readback.modelCalls.count, 0);

    readback.store.now += 60_000;
    await readback.run();
    assert.equal(readback.store.comments.filter(c => c.body.startsWith(OPERATOR_MARKER)).length, 1,
      'retry reconciles the same comment instead of creating a duplicate');
    assert.equal(parseOperatorObservation(
      readback.store.comments.find(c => c.body.startsWith(OPERATOR_MARKER)).body).sequence, 19);
    assert.deepEqual(readback.receiptWrites.map(value => value.state), ['STARTED', 'FINISHED'],
      'recovery does not replay the already completed ping');
    assert.equal(existsSync(readbackPath), false);
  } finally { readback.cleanup(); }
});

test('Worker recognizes the two trusted Human R4 directive markers without starting a model', async () => {
  const directives = [
    { id: 6232811908, marker: 'PTYSD_V53R4_DUAL_AUDIT_RECONCILIATION_R2_20261017' },
    { id: 6233118477, marker: 'PTYSD_V53R4_W1_W2_CLI_ONLY_SYNC_FIRST_ROUTING_20261017' },
  ];
  for (const { id, marker } of directives) {
    const comment = humanGoalComment({ id, body: `# Human directive\n<!-- ${marker} -->` });
    const fixture = makeObservationWorkerFixture({ goalComments: [comment] });
    try {
      await fixture.run();
      assert.ok(fixture.logs.includes(`HUMAN_GOAL_SCOPED_ACTION_MISSING_${id}_NO_MODEL`),
        'a trusted goal without a scoped Codex action is explicitly rejected');
      assert.ok(fixture.logs.includes(`HUMAN_GOAL_CODEX_POLICY_NOT_CONFIGURED_${id}_NO_MODEL`),
        `the latest trusted Human marker ${marker} must be discovered`);
      assert.equal(fixture.modelCalls.count, 0,
        'marker discovery alone must not invoke a Codex model');
      assert.equal(fixture.codexDispatchCalls.count, 0,
        'marker discovery alone must not start an executor');
    } finally { fixture.cleanup(); }
  }
});

test('a scoped-action omission is reported even when an explicit Codex policy exists', async () => {
  const id = 6233999101;
  const comment = humanGoalComment({ id,
    body: '# Human directive\n<!-- PTYSD_V53R4_CODEX_DIRECTIVE_20261021 -->\nNo scoped next action.' });
  const fixture = makeObservationWorkerFixture({ goalComments: [comment], configOverrides: {
    human_goal_codex_policy: { enabled: true, model: 'gpt-6.1-sol', reasoning_effort: 'medium',
      write_paths: ['native-bridge/worker.mjs'] },
  } });
  try {
    const result = await fixture.run();
    assert.equal(result.state, 'FINISHED',
      'the scoped Human directive is rejected without starving the independent ping');
    assert.ok(fixture.logs.includes(`HUMAN_GOAL_SCOPED_ACTION_MISSING_${id}_NO_MODEL`));
    assert.ok(!fixture.logs.includes(`HUMAN_GOAL_CODEX_POLICY_NOT_CONFIGURED_${id}_NO_MODEL`));
    assert.equal(fixture.modelCalls.count, 0);
    assert.equal(fixture.codexDispatchCalls.count, 0);
    assert.deepEqual(fixture.receiptWrites.map(value => value.kind), ['ping', 'ping']);
  } finally { fixture.cleanup(); }
});

test('stale W2 candidate source is reported with both SHAs while an independent ping still runs', async () => {
  const host = hostname().toUpperCase();
  const expectedSha = 'c'.repeat(40), observedSha = 'd'.repeat(40);
  const w2Job = withHumanGoal({ schema: 6, project_id: PROJECT, host,
    request_id: 'PTYSD_W2_STALE_SOURCE_20261021', kind: 'antigravity_edit',
    source_sha: expectedSha, spec_path: 'native-bridge/tasks/w2-quota-canary.md',
    spec_sha256: hash, model: ANTIGRAVITY_V2_MODEL, variant: 'high',
    edit_paths: ['src/w2-quota-canary.mjs'], source_pr: 461 });
  const w2Comment = { ...com(6188322051, encoded(w2Job)),
    issue_url: `https://api.github.com/repos/${REPO}/issues/310` };
  const sameRepo = { id: 1352411536, full_name: REPO };
  const pull = { number: 461, state: 'open',
    base: { ref: 'main', repo: sameRepo }, head: { sha: observedSha, repo: sameRepo } };
  const fixture = makeObservationWorkerFixture({
    goalComments: [humanGoalComment(), w2Comment], candidatePulls: { 461: pull },
  });
  try {
    const result = await fixture.run();
    assert.equal(result.state, 'FINISHED', 'the independent zero-model ping remains runnable');
    assert.ok(fixture.logs.includes(`STALE_CANDIDATE_SOURCE_${w2Job.request_id}_PR_461_` +
      `EXPECTED_SHA_${expectedSha}_OBSERVED_SHA_${observedSha}_NO_DISPATCH`));
    assert.deepEqual(fixture.receiptWrites.map(value => value.kind), ['ping', 'ping']);
    assert.equal(fixture.modelCalls.count, 0);
    assert.equal(fixture.codexDispatchCalls.count, 0);
  } finally { fixture.cleanup(); }
});

test('closed candidate PR is reported as non-dispatchable with its observed SHA', async () => {
  const host = hostname().toUpperCase();
  const expectedSha = 'c'.repeat(40), observedSha = 'd'.repeat(40);
  const w2Job = withHumanGoal({ schema: 6, project_id: PROJECT, host,
    request_id: 'PTYSD_W2_CLOSED_SOURCE_20261021', kind: 'antigravity_edit',
    source_sha: expectedSha, spec_path: 'native-bridge/tasks/w2-quota-canary.md',
    spec_sha256: hash, model: ANTIGRAVITY_V2_MODEL, variant: 'high',
    edit_paths: ['src/w2-quota-canary.mjs'], source_pr: 461 });
  const w2Comment = { ...com(6188322051, encoded(w2Job)),
    issue_url: `https://api.github.com/repos/${REPO}/issues/310` };
  const sameRepo = { id: 1352411536, full_name: REPO };
  const pull = { number: 461, state: 'closed',
    base: { ref: 'main', repo: sameRepo }, head: { sha: observedSha, repo: sameRepo } };
  const fixture = makeObservationWorkerFixture({
    goalComments: [humanGoalComment(), w2Comment], candidatePulls: { 461: pull },
  });
  try {
    const result = await fixture.run();
    assert.equal(result.state, 'FINISHED', 'a rejected candidate does not block an independent ping');
    assert.ok(fixture.logs.includes(`CANDIDATE_SOURCE_NOT_DISPATCHABLE_${w2Job.request_id}_PR_461_` +
      `REASON_PR_NOT_OPEN_EXPECTED_SHA_${expectedSha}_OBSERVED_SHA_${observedSha}_NO_DISPATCH`));
    assert.deepEqual(fixture.receiptWrites.map(value => value.kind), ['ping', 'ping']);
    assert.equal(fixture.modelCalls.count, 0);
  } finally { fixture.cleanup(); }
});

test('an unresolved W2 STARTED attempt is not replayed after its pinned source drifts', () => {
  const host = 'DESKTOP-1B6PD2P';
  const w2Job = withHumanGoal({ schema: 6, project_id: PROJECT, host,
    request_id: 'PTYSD_W2_UNKNOWN_EFFECT_20261021', kind: 'antigravity_edit',
    source_sha: 'c'.repeat(40), spec_path: 'native-bridge/tasks/w2-quota-canary.md',
    spec_sha256: hash, model: ANTIGRAVITY_V2_MODEL, variant: 'high',
    edit_paths: ['src/w2-quota-canary.mjs'], source_pr: 461 });
  const attemptId = '33333333-3333-4333-8333-333333333333';
  const started = receipt(w2Job.request_id, attemptId, 'STARTED', w2Job);
  const task = com(1, encoded(w2Job));
  const unresolved = com(2, RECEIPT_MARKER + JSON.stringify(started), 'worker');
  const ping = com(3, encoded(mkjob({ host, request_id: 'PTYSD_INDEPENDENT_PING_20261021' })));
  const next = selectNext([task, unresolved, ping], ['t14210184'], 'worker', host, commit, [],
    new Map([[461, 'd'.repeat(40)]]));
  assert.equal(next?.id, ping.id,
    'unknown W2 external effects remain protected while an unrelated READY job proceeds');
});

test('fresh OS publication does not carry stale W1 activity or incident state into the new snapshot', async () => {
  const staleAt = Date.now() - 24 * 60 * 60 * 1000;
  const prior = seededOperatorObservation(OPERATOR_COMMENT_ID, 17, commit, staleAt);
  prior.opencode_v2 = {
    installed_version: 'opencode v2.0.27', process_count: 1,
    process_observed_at: new Date(staleAt).toISOString(), active_session_count: 1,
    active_session_state: 'RUNNING_VERIFIED', task_binding: 'PROVEN',
    activity_observed_at: new Date(staleAt).toISOString(), task_id: 'W1_OLD_TASK',
    code_changes: 'CODING_PASS', remote_commit: 'c'.repeat(40),
    pull_request: 'https://github.com/PT-Original-Point/ptysd-autonomous-factory/pull/1',
    ci: 'success',
  };
  prior.monitor_candidate = { state: 'ACTIVE', observed_at: new Date(staleAt).toISOString() };
  prior.incident = { state: 'OPEN', observed_at: new Date(staleAt).toISOString() };
  const fixture = makeObservationWorkerFixture({ priorObservation: prior });
  try {
    await fixture.run();
    const comment = fixture.store.comments.find(item => item.body.startsWith(OPERATOR_MARKER));
    const fresh = parseOperatorObservation(comment.body);
    assert.equal(fresh.opencode_v2.process_count, 0);
    assert.equal(fresh.opencode_v2.active_session_count, null);
    assert.equal(fresh.opencode_v2.active_session_state, 'UNKNOWN_NO_PASSIVE_API');
    assert.equal(fresh.opencode_v2.task_binding, 'UNPROVEN');
    assert.equal(fresh.opencode_v2.code_changes, 'UNPROVEN');
    assert.equal(fresh.opencode_v2.task_id, undefined,
      'a new OS poll cannot refresh a previous W1 task identity');
    assert.equal(fresh.opencode_v2.activity_observed_at, undefined,
      'old model activity must retain no fresh top-level snapshot binding');
    assert.equal(fresh.opencode_v2.installed_version, undefined,
      'an old CLI preflight must not be republished as a current process observation');
    assert.equal(fresh.monitor_candidate, null);
    assert.equal(fresh.incident, null);
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
  assert.equal(selectNext([com(1,encoded(mkjob({ host:'OTHER-PC' })))],['t14210184'],'worker','DESKTOP-1B6PD2P'),null);
  assert.equal(parseJob(encoded(mkjob({ kind: 'shell' }))), null);
  assert.equal(parseJob(encoded({ ...mkjob(), command: 'Remove-Item C:\\' })), null);
  assert.equal(parseJob(encoded(mkjob({ kind: 'opencode_plan', spec_path: '../secrets', spec_sha256: hash }))), null);
  assert.equal(parseJob(encoded(mkjob({ kind: 'opencode_plan', spec_path: 'native-bridge/tasks/review.md', spec_sha256: hash }))),null);
  const modelJob = { ...mkjob(), schema: 2, kind: 'opencode_plan', spec_path:'native-bridge/tasks/review.md',
    spec_sha256: hash, model:'opencode/spark', variant:'high' };
  assert.equal(parseJob(encoded(modelJob)).kind, 'opencode_plan');
  const editJob = { ...modelJob, schema:4, kind:'opencode_edit',
    edit_paths:['src/worker.mjs','tests/worker.test.mjs'] };
  assert.deepEqual(parseJob(encoded(editJob)), editJob,
    'the trusted task schema carries the exact writable file set');
  assert.ok(checkModelAuthorization(editJob,{allowed_models:{'opencode/spark':['high']}}));
  const antigravityJob=withHumanGoal({...editJob,schema:6,kind:'antigravity_edit',
    model:ANTIGRAVITY_V2_MODEL,variant:'high',source_pr:448});
  assert.deepEqual(parseJob(encoded(antigravityJob)),antigravityJob,
    'W2 accepts only the exact schema-6 pinned model and Human-bound candidate task');
  assert.ok(checkModelAuthorization(antigravityJob,
    {allowed_models:{[ANTIGRAVITY_V2_MODEL]:['high']}}));
  assert.equal(parseJob(encoded({...antigravityJob,model:'gemini-3.8-flash-medium'})),null);
  assert.equal(parseJob(encoded({...antigravityJob,variant:'medium'})),null);
  const w2Request='PTYSD_ANTIGRAVITY_WAIT_REEVALUATE_20261018';
  const waitingJob={...antigravityJob,request_id:w2Request};
  const w2Attempt='22222222-2222-4222-8222-222222222222';
  const w2Started=receipt(w2Request,w2Attempt,'STARTED',waitingJob);
  const w2Waiting=receipt(w2Request,w2Attempt,'WAITING',waitingJob,{
    outcome:'ANTIGRAVITY_EXECUTION_ATTESTATION_UNKNOWN',exit_code:48,model_invoked:false});
  const w2Comments=[com(410,encoded(waitingJob)),com(411,RECEIPT_MARKER+JSON.stringify(w2Started),'worker'),
    com(412,RECEIPT_MARKER+JSON.stringify(w2Waiting),'worker')];
  assert.equal(parseReceipt(w2Comments[2].body)?.state,'WAITING');
  assert.equal(selectNext(w2Comments,['t14210184'],'worker',waitingJob.host,null,[],
    new Map([[waitingJob.source_pr,waitingJob.source_sha]]))?.id,410,
    'a no-model W2 authorization wait leaves the same task eligible for later reevaluation');
  assert.equal(parseReceipt(RECEIPT_MARKER+JSON.stringify({...w2Waiting,outcome:'UNKNOWN_WAIT'})),null);
  assert.equal(parseJob(encoded({...editJob,edit_paths:['../secrets.txt']})),null);
  assert.equal(parseJob(encoded({...editJob,edit_paths:['src/worker.mjs','src/worker.mjs']})),null);
  assert.equal(parseJob(encoded({...editJob,edit_paths:['.github/workflows/ci.yml']})),null);
  assert.equal(parseJob(encoded({...modelJob, model:'https://wrong'})),null);
  assert.equal(parseJob(encoded({...modelJob, variant:'unverified'})).variant,'unverified');
  assert.equal(checkModelAuthorization({...modelJob, variant:'unverified'}, {allowed_models:{'opencode/spark':['high']}}),false);
  assert.equal(parseJob(encoded({...modelJob, shell:'pwsh'})),null);
  assert.equal(parseJob(encoded(mkjob({kind:'native_preflight'}))).kind,'native_preflight');
  assert.equal(parseJob(encoded(mkjob({kind:'native_v2_qualify'}))).kind,'native_v2_qualify');
  assert.equal(parseJob(encoded(mkjob({kind:'native_v2_qualify',spec_path:'tasks/other.md'}))),null);
  assert.ok(checkModelAuthorization(modelJob,{ allowed_models:{ 'opencode/spark':['high'] } }));
  assert.ok(!checkModelAuthorization(modelJob, {allowed_models:{}}));
  assert.equal(parseJob('garbage'), null);
});

test('native Issue comments accept the GitHub-sized body boundary and reject larger bodies', () => {
  const exactBody = encoded(mkjob()).padEnd(65_536, ' ');
  assert.equal(exactBody.length, 65_536);
  assert.equal(parseJob(exactBody).request_id, mkjob().request_id);
  assert.equal(parseJob(`${exactBody} `), null);

  const receipt = { schema: 1, project_id: PROJECT, host: 'DESKTOP-1B6PD2P',
    request_id: 'PTYSD_NATIVE_EDIT_BOUNDARY_20261016', kind: 'opencode_edit',
    source_sha: commit, state: 'FINISHED',
    attempt_id: 'e416334f-404c-4e61-9b0e-f9283ee07013', diagnostic: '' };
  const exactReceipt = (RECEIPT_MARKER + JSON.stringify(receipt)).padEnd(65_536, ' ');
  assert.equal(exactReceipt.length, 65_536);
  assert.deepEqual(parseReceipt(exactReceipt), JSON.parse(exactReceipt.slice(RECEIPT_MARKER.length)));
  assert.equal(parseReceipt(`${exactReceipt} `), null);
});

test('candidate edit jobs are runnable only from the exact open same-repository PR head', async () => {
  const candidate = withHumanGoal({ schema:5, project_id:PROJECT, host:'DESKTOP-1B6PD2P',
    request_id:'PTYSD_OPEN_EDIT_PR_PIN_20261016', kind:'opencode_edit', source_sha:commit,
    spec_path:'native-bridge/tasks/review.md', spec_sha256:hash,
    model:'opencode/spark', variant:'high', edit_paths:['native-bridge/worker.mjs'], source_pr:437 });
  const body=encoded(candidate), comments=[com(10,body,'t14210184')];
  assert.deepEqual(parseJob(body),candidate);
  const unbound = { ...candidate, schema: 5 };
  delete unbound.goal_comment_id; delete unbound.goal_body_sha256;
  assert.ok(parseJob(encoded(unbound)), 'old candidate messages remain parseable for history');
  assert.equal(selectNext([com(9,encoded(unbound),'t14210184')],['t14210184'],'worker',candidate.host,
    'c'.repeat(40),[],new Map([[437,commit]])),null,
  'candidate work without a byte-pinned Human GOAL remains historical-only');
  assert.equal(selectNext(comments,['t14210184'],'worker',candidate.host,
    'c'.repeat(40),[]),null);
  const pull={number:437,state:'open',base:{ref:'main',repo:{id:1352411536,full_name:REPO}},
    head:{sha:commit,repo:{id:1352411536,full_name:REPO}}};
  const goal=humanGoalComment();
  let calls=[];
  const sources=await readPinnedCandidateSources(comments,['t14210184'],'worker',candidate.host,
    path=>{calls.push(path);return path.endsWith('/6188322050')?goal:pull;},undefined,[],()=>[goal]);
  assert.deepEqual(calls,[`repos/${REPO}/issues/comments/6188322050`,`repos/${REPO}/pulls/437`]);
  assert.equal(sources.get(437),commit);
  assert.equal(selectNext(comments,['t14210184'],'worker',candidate.host,
    'c'.repeat(40),[],sources).job.request_id,candidate.request_id);

  calls=[];
  const changedHead=await readPinnedCandidateSources(comments,['t14210184'],'worker',candidate.host,
    path=>{calls.push(path);return path.endsWith('/6188322050')?goal:
      {...pull,head:{...pull.head,sha:'d'.repeat(40)}};},undefined,[],()=>[goal]);
  assert.equal(changedHead.get(437),'d'.repeat(40),
    'a verified PR read records its actual head even when the queued job is stale');
  assert.equal(selectNext(comments,['t14210184'],'worker',candidate.host,
    'c'.repeat(40),[],changedHead),null);

  calls=[];
  const forked=await readPinnedCandidateSources(comments,['t14210184'],'worker',candidate.host,
    path=>{calls.push(path);return path.endsWith('/6188322050')?goal:
      {...pull,head:{...pull.head,repo:{id:9,full_name:'attacker/fork'}}};},undefined,[],()=>[goal]);
  assert.equal(forked.size,0,'a same-named or forked repository is not an authorized candidate source');
  const goalErrors=[]; let untrustedPrReads=0;
  const noGoal=await readPinnedCandidateSources(comments,['t14210184'],'worker',candidate.host,
    path=>{if(path.endsWith('/6188322050'))throw new Error('goal read denied');
      untrustedPrReads++;return pull;},message=>goalErrors.push(message),[],()=>[goal]);
  assert.equal(noGoal.size,0);
  assert.equal(untrustedPrReads,0,'candidate PR read is skipped when the GOAL source is unknown');
  assert.ok(goalErrors.includes('HUMAN_GOAL_READBACK_UNKNOWN_6188322050'));
  const latestGoalErrors=[]; let latestGoalDependentReads=0;
  const unavailableLatestGoal=await readPinnedCandidateSources(comments,['t14210184'],'worker',candidate.host,
    ()=>{latestGoalDependentReads++;return pull;},message=>latestGoalErrors.push(message),[],
    ()=>{throw new Error('simulated latest GOAL read failure');});
  assert.equal(unavailableLatestGoal.size,0);
  assert.equal(latestGoalDependentReads,0,'an unknown latest GOAL prevents pinned-comment and PR reads');
  assert.ok(latestGoalErrors.includes('HUMAN_GOAL_LATEST_READBACK_UNKNOWN'));
  calls=[];
  const started=receipt(candidate.request_id,randomUUID(),'STARTED',candidate);
  const parsedStart=parseReceipt(RECEIPT_MARKER+JSON.stringify(started));
  assert.equal(parsedStart.goal_comment_id,6188322050);
  assert.equal(parsedStart.goal_body_sha256,h(humanGoalBody));
  const alreadyStarted=[...comments,com(11,RECEIPT_MARKER+JSON.stringify(started),'worker')];
  const noRepeat=await readPinnedCandidateSources(alreadyStarted,['t14210184'],'worker',candidate.host,
    path=>{calls.push(path);return pull;});
  assert.equal(noRepeat.size,0);
  assert.equal(calls.length,0,'an already claimed attempt does not trigger repeated PR lookups');

  for (const badGoal of [
    humanGoalComment({ user: { login: 'untrusted' } }),
    humanGoalComment({ body: `${humanGoalBody} edited` }),
    humanGoalComment({ issue_url: `https://api.github.com/repos/${REPO}/issues/311` }),
  ]) {
    const rejected=await readPinnedCandidateSources(comments,['t14210184'],'worker',candidate.host,
      path=>path.endsWith('/6188322050')?badGoal:pull,undefined,[],()=>[badGoal]);
    assert.equal(rejected.size,0,'wrong author, modified bytes, or another issue cannot authorize a candidate');
  }
});

test('candidate observation distinguishes unknown PR readback from stale and current source', async () => {
  const host='DESKTOP-1B6PD2P', dispatcher='dispatcher', publisher='publisher';
  const candidate=withHumanGoal({schema:5,project_id:PROJECT,host,request_id:'PTYSD_OBSERVE_CANDIDATE_20261016',
    kind:'opencode_edit',source_sha:commit,spec_path:'native-bridge/tasks/review.md',
    spec_sha256:hash,model:'opencode/spark',variant:'high',edit_paths:['native-bridge/worker.mjs'],
    source_pr:437});
  const jobComment=com(702,encoded(candidate),dispatcher);
  const goal=humanGoalComment({user:{login:dispatcher}});
  const pull={number:437,state:'open',base:{ref:'main',repo:{id:1352411536,full_name:REPO}},
    head:{sha:commit,repo:{id:1352411536,full_name:REPO}}};
  const currentTime=Date.now();
  async function publish(candidateSourceShas, receiptState = null) {
    const priorTime=currentTime-60_000;
    const prior=seededOperatorObservation(OPERATOR_COMMENT_ID,17,'c'.repeat(40),priorTime);
    const observationComment={id:OPERATOR_COMMENT_ID,user:{login:publisher},
      body:encodeOperatorObservation(prior),updated_at:new Date(priorTime).toISOString()};
    const comments=[observationComment,jobComment];
    if(receiptState) comments.push(com(703,RECEIPT_MARKER+JSON.stringify(
      receipt(candidate.request_id,randomUUID(),receiptState,candidate)),publisher));
    const config={repo:REPO,project_id:PROJECT,host,issue:407,dispatchers:[dispatcher],state_dir:'unused'};
    const dependencies={
      now:()=>new Date(currentTime),
      collectWindowsObservation:()=>({status:'FRESH',observed_at:new Date(currentTime).toISOString(),
        tasks_total:2,legacy_monitor_registered:false,listener_2667:false,opencode_process_count:0,
        runner_service_count:0,runner_service_running:false,native_task:{registered:true,enabled:true,
          state:'READY',last_run:null,last_result:'0x00000000',action_kind:'WINDOWLESS_LAUNCHER',
          identity_class:'INTERACTIVE_LIMITED',multiple_instances:'IGNORENEW',trigger_interval_minutes:5}}),
      readRunnerRegistration:()=>({total_count:0}),
      readComment:id=>structuredClone(comments.find(c=>c.id===id)),
      patchComment:(id,body)=>{
        const comment=comments.find(c=>c.id===id);
        comment.body=body;
        comment.updated_at=new Date(currentTime+1000).toISOString();
      },
      readComments:()=>structuredClone(comments),
    };
    const result=await publishOperatorObservation(config,publisher,comments,'c'.repeat(40),
      dependencies,candidateSourceShas);
    assert.equal(result.status,'UPDATED');
    return result.observation.native_worker;
  }

  const readErrors=[];
  const unknownShas=await readPinnedCandidateSources([jobComment],[dispatcher],publisher,host,
    async path=>{if(path.endsWith('/6188322050'))return goal;
      throw new Error('simulated PR API failure');},message=>readErrors.push(message),[],()=>[goal]);
  assert.equal(unknownShas.size,0);
  assert.ok(readErrors.includes('CANDIDATE_PR_READBACK_UNKNOWN_437'));
  const unknown=await publish(unknownShas);
  assert.equal(unknown.latest_task.state,'SOURCE_UNKNOWN');
  assert.equal(unknown.latest_task.source_pr,437);
  assert.equal(unknown.current_task,null);
  assert.equal(unknown.next_owner,'VERIFY_CANDIDATE_SOURCE');

  const staleShas=await readPinnedCandidateSources([jobComment],[dispatcher],publisher,host,
    async path=>path.endsWith('/6188322050')?goal:{...pull,head:{...pull.head,sha:'d'.repeat(40)}},undefined,[],()=>[goal]);
  const stale=await publish(staleShas);
  assert.equal(stale.latest_task.state,'STALE_SOURCE');
  assert.equal(stale.latest_task.source_pr,437);
  assert.equal(stale.current_task,null);
  assert.equal(stale.next_owner,'VERIFY_CANDIDATE_SOURCE');

  const currentShas=await readPinnedCandidateSources([jobComment],[dispatcher],publisher,host,
    async path=>path.endsWith('/6188322050')?goal:pull,undefined,[],()=>[goal]);
  const current=await publish(currentShas);
  assert.equal(current.latest_task.state,'QUEUED_NOT_STARTED');
  assert.equal(current.latest_task.source_pr,437);
  assert.equal(current.current_task.request_id,candidate.request_id);
  assert.equal(current.next_owner,'NATIVE_WORKER');

  for (const state of ['STARTED','FINISHED']) {
    const attemptComments=[jobComment,com(703,RECEIPT_MARKER+JSON.stringify(
      receipt(candidate.request_id,randomUUID(),state,candidate)),publisher)];
    let repeatedReads=0;
    const attemptSourceShas=await readPinnedCandidateSources(attemptComments,[dispatcher],publisher,host,
      async()=>{repeatedReads++;throw new Error('receipt-bound attempts do not need a PR reread');});
    assert.equal(repeatedReads,0);
    assert.equal(attemptSourceShas.size,0);
    const observed=await publish(attemptSourceShas,state);
    assert.equal(observed.latest_task.state,state==='STARTED'
      ? 'STARTED_UNVERIFIED' : 'FINISHED_NOT_ACCEPTANCE');
    assert.equal(state==='STARTED' ? observed.current_task?.request_id : observed.current_task,
      state==='STARTED' ? candidate.request_id : null);
  }
});

test('operator observation publishes the single seeded comment with role-separated identity and conservative W1/W2/W3 records', async () => {
  const host = 'DESKTOP-1B6PD2P';
  const actor = 't14210184';
  const commentAuthor = 'wfvupu1212';
  const now = Date.now();
  const prior = seededOperatorObservation(OPERATOR_COMMENT_ID, 2, 'c'.repeat(40), now - 60_000);
  const observationComment = { id: OPERATOR_COMMENT_ID, user: { login: commentAuthor },
    body: encodeOperatorObservation(prior), updated_at: new Date(now - 50_000).toISOString() };
  const w2Job = withHumanGoal({ schema: 6, project_id: PROJECT, host,
    request_id: 'PTYSD_W2_OBSERVATION_STALE_20261021', kind: 'antigravity_edit',
    source_sha: 'c'.repeat(40), spec_path: 'native-bridge/tasks/w2-quota-canary.md',
    spec_sha256: hash, model: ANTIGRAVITY_V2_MODEL, variant: 'high',
    edit_paths: ['src/w2-quota-canary.mjs'], source_pr: 461 });
  const jobComment = { ...com(702, encoded(w2Job), actor),
    issue_url: `https://api.github.com/repos/${REPO}/issues/310` };
  const comments = [observationComment, jobComment];
  const config = { repo: REPO, project_id: PROJECT, host, issue: 407,
    dispatchers: [actor], state_dir: 'unused' };
  const dependencies = {
    now: () => new Date(now),
    collectWindowsObservation: () => ({ status: 'FRESH', observed_at: new Date(now).toISOString(),
      native_task: { registered: true, enabled: true, state: 'READY' } }),
    readRunnerRegistration: () => ({ total_count: 0 }),
    readComment: id => structuredClone(comments.find(item => item.id === id)),
    patchComment: (id, body) => {
      const target = comments.find(item => item.id === id);
      assert.equal(id, OPERATOR_COMMENT_ID);
      target.body = body;
      target.updated_at = new Date(now + 1_000).toISOString();
    },
    readComments: () => structuredClone(comments),
  };
  const result = await publishOperatorObservation(config, actor, comments, 'e'.repeat(40),
    dependencies, new Map([[461, 'd'.repeat(40)]]));

  assert.equal(result.status, 'UPDATED');
  assert.deepEqual(result.publisher_identity, {
    publisher_login: actor, comment_author_login: commentAuthor,
  });
  assert.equal(result.comment_id, OPERATOR_COMMENT_ID);
  assert.equal(comments.filter(item => item.body.startsWith(OPERATOR_MARKER)).length, 1);
  assert.equal(result.observation.sequence, 3);
  assert.equal(result.observation.publisher_login, actor);
  assert.equal(result.observation.comment_author_login, commentAuthor);
  assert.deepEqual(result.observation.workers.map(worker => worker.worker_id), ['W1', 'W2', 'W3']);
  const w1 = result.observation.workers.find(worker => worker.worker_id === 'W1');
  assert.equal(w1.status, 'UNKNOWN');
  assert.equal(w1.blocker_code, 'NO_AUTHORIZED_W1_JOB');
  const w2 = result.observation.workers.find(worker => worker.worker_id === 'W2');
  assert.equal(w2.status, 'BLOCKED');
  assert.equal(w2.task_id, w2Job.request_id);
  assert.equal(w2.task_state, 'STALE_SOURCE');
  assert.equal(w2.blocker_code, 'STALE_CANDIDATE_SOURCE');
  assert.equal(w2.task_source_sha, 'c'.repeat(40));
  assert.equal(w2.source_pr, 461);
  const w3 = result.observation.workers.find(worker => worker.worker_id === 'W3');
  assert.equal(w3.status, 'UNKNOWN');
  assert.equal(w3.blocker_code, 'W3_ZERO_RISK_HANDOFF_NOT_IN_NATIVE_SNAPSHOT');
});

test('operator observation blocks one request ID reused across W1 and W2 task kinds', async () => {
  const host = 'DESKTOP-1B6PD2P';
  const actor = 't14210184';
  const now = Date.now();
  const observationComment = { id: OPERATOR_COMMENT_ID, user: { login: 'wfvupu1212' },
    body: encodeOperatorObservation(seededOperatorObservation(OPERATOR_COMMENT_ID, 2, 'c'.repeat(40), now - 60_000)),
    updated_at: new Date(now - 50_000).toISOString() };
  const requestId = 'PTYSD_SHARED_W1_W2_REQUEST_20261021';
  const w1Job = withHumanGoal({ schema: 6, project_id: PROJECT, host, request_id: requestId,
    kind: 'opencode_edit', source_sha: 'd'.repeat(40),
    spec_path: 'native-bridge/tasks/w1-shared-id.md', spec_sha256: hash,
    model: 'opencode/deepseek-v4.1-flash-free', variant: 'free',
    edit_paths: ['src/w1-shared-id.mjs'], source_pr: 461 });
  const w2Job = withHumanGoal({ schema: 6, project_id: PROJECT, host, request_id: requestId,
    kind: 'antigravity_edit', source_sha: 'd'.repeat(40),
    spec_path: 'native-bridge/tasks/w2-shared-id.md', spec_sha256: hash,
    model: ANTIGRAVITY_V2_MODEL, variant: 'high',
    edit_paths: ['src/w2-shared-id.mjs'], source_pr: 461 });
  const comments = [observationComment,
    { ...com(722, encoded(w1Job), actor), issue_url: `https://api.github.com/repos/${REPO}/issues/310` },
    { ...com(723, encoded(w2Job), actor), issue_url: `https://api.github.com/repos/${REPO}/issues/310` },
  ];
  const config = { repo: REPO, project_id: PROJECT, host, issue: 407,
    dispatchers: [actor], state_dir: 'unused' };
  const result = await publishOperatorObservation(config, actor, comments, 'e'.repeat(40), {
    now: () => new Date(now),
    collectWindowsObservation: () => ({ status: 'FRESH', native_task: { enabled: true } }),
    readRunnerRegistration: () => ({ total_count: 0 }),
    readComment: id => structuredClone(comments.find(item => item.id === id)),
    patchComment: (id, body) => {
      const target = comments.find(item => item.id === id);
      target.body = body;
      target.updated_at = new Date(now + 1_000).toISOString();
    },
    readComments: () => structuredClone(comments),
  }, new Map([[461, 'd'.repeat(40)]]));

  for (const workerId of ['W1', 'W2']) {
    const worker = result.observation.workers.find(item => item.worker_id === workerId);
    assert.equal(worker.status, 'BLOCKED');
    assert.equal(worker.task_id, requestId);
    assert.equal(worker.task_state, 'AMBIGUOUS_DUPLICATE');
    assert.equal(worker.blocker_code, 'DUPLICATE_TASK_REQUEST_AMBIGUOUS');
  }
});

test('operator observation publisher rejects an untrusted actor without modifying the seeded comment', async () => {
  const now = Date.now();
  const comment = { id: OPERATOR_COMMENT_ID, user: { login: 'wfvupu1212' },
    body: encodeOperatorObservation(seededOperatorObservation(OPERATOR_COMMENT_ID, 2, 'c'.repeat(40), now - 60_000)),
    updated_at: new Date(now - 50_000).toISOString() };
  let patches = 0;
  await assert.rejects(publishOperatorObservation({ repo: REPO, project_id: PROJECT,
    host: 'DESKTOP-1B6PD2P', issue: 407, dispatchers: [], state_dir: 'unused' },
  'untrusted-actor', [comment], 'e'.repeat(40), {
    now: () => new Date(now),
    collectWindowsObservation: () => ({ status: 'FRESH' }),
    patchComment: () => { patches++; },
  }), /OPERATOR_PUBLISHER_IDENTITY_NOT_AUTHORIZED/);
  assert.equal(patches, 0);
  assert.equal(comment.body.includes('"sequence":2'), true);
});

test('operator observation publisher will not adopt an untrusted replacement for the pinned official comment', async () => {
  const now = Date.now();
  const comment = { id: 99, user: { login: 'untrusted-seeder' },
    body: encodeOperatorObservation(seededOperatorObservation(99, 2, 'c'.repeat(40), now - 60_000)),
    updated_at: new Date(now - 50_000).toISOString() };
  let reads = 0;
  let patches = 0;
  await assert.rejects(publishOperatorObservation({ repo: REPO, project_id: PROJECT,
    host: 'DESKTOP-1B6PD2P', issue: 407, dispatchers: ['trusted-dispatcher'], state_dir: 'unused' },
  'trusted-dispatcher', [comment], 'e'.repeat(40), {
    now: () => new Date(now),
    collectWindowsObservation: () => ({ status: 'FRESH', observed_at: new Date(now).toISOString(),
      tasks_total: 2, legacy_monitor_registered: false, listener_2667: false,
      opencode_process_count: 0, runner_service_count: 0, runner_service_running: false,
      native_task: { registered: true, enabled: true, state: 'READY', last_run: null,
        last_result: '0x00000000', action_kind: 'WINDOWLESS_LAUNCHER',
        identity_class: 'INTERACTIVE_LIMITED', multiple_instances: 'IGNORENEW',
        trigger_interval_minutes: 5 } }),
    readRunnerRegistration: () => ({ total_count: 0 }),
    readComment: async () => { reads++; return structuredClone(comment); },
    patchComment: async () => { patches++; },
    readComments: async () => [comment],
  }), /OPERATOR_COMMENT_ID_MISMATCH/);
  assert.equal(reads, 0, 'the publisher must reject the replacement before remote read or write');
  assert.equal(patches, 0, 'the publisher must never update an untrusted replacement comment');
});

test('Issue #310 structured candidate task dispatches through the existing Executor and receipts stay on #407', async () => {
  const root=mkdtempSync(join(homedir(),'.ptysd-edit-dispatch-test-'));
  try {
    const workspace=join(root,'workspace'),stateDir=join(root,'state');
    mkdirSync(join(workspace,'src'),{recursive:true}); mkdirSync(stateDir);
    writeFileSync(join(workspace,'src','worker.mjs'),'export const state = "base";\n');
    const host=hostname().toUpperCase();
    const spec='Edit only src/worker.mjs and return the resulting diff.';
    const job=withHumanGoal({schema:5,project_id:PROJECT,host,request_id:'PTYSD_OPEN_EDIT_DISPATCH_20261016',
      kind:'opencode_edit',source_sha:commit,spec_path:'native-bridge/tasks/edit-worker.md',
      spec_sha256:h(spec),model:'opencode/spark',variant:'high',edit_paths:['src/worker.mjs'],source_pr:437});
    const goalTaskComment={...com(10,encoded(job),'t14210184'),
      issue_url:`https://api.github.com/repos/${REPO}/issues/310`};
    const untrustedJob={...job,request_id:'PTYSD_UNTRUSTED_GOAL_TASK_20261017'};
    const wrongIssueJob={...job,request_id:'PTYSD_WRONG_ISSUE_TASK_20261017'};
    const untrustedGoalTask={...com(11,encoded(untrustedJob),'untrusted'),
      issue_url:`https://api.github.com/repos/${REPO}/issues/310`};
    const wrongIssueTask={...com(12,encoded(wrongIssueJob),'t14210184'),
      issue_url:`https://api.github.com/repos/${REPO}/issues/311`};
    const receiptComments=[];
    const executor={task_name:'\\PTYSD\\OpenCodeExecutor',user_sid:'S-1-5-21-100-200-300-1001',
      publisher_sid:'S-1-5-21-100-200-300-1002',
      wscript_path:'C:\\Windows\\System32\\wscript.exe',
      launcher_path:'C:\\PTYSD\\HiddenCodexExecutor.vbs',node_bin:'C:\\Node\\node.exe',
      script_path:'C:\\PTYSD\\executor.mjs',config_path:'C:\\PTYSD\\executor.json',
      manifest_dir:join(root,'manifests'),results_dir:join(root,'results'),
      working_directory:root,source_bundle_per_attempt:true};
    const config={repo:REPO,project_id:PROJECT,host,issue:407,workspace,state_dir:stateDir,
      dispatchers:['t14210184'],executors:{opencode:executor,
        antigravity:executorDescriptorForLane('Antigravity',1003)},enable_v2_model_runs:true,
      allowed_models:{'opencode/spark':['high']}};
    let bundleCalls=0,dispatchCalls=0,modelCalls=0,candidatePrReads=0,posted=[];
    const result=await executeWorker(config,{
      goalCommentsRead:()=>[humanGoalComment(),goalTaskComment,untrustedGoalTask,wrongIssueTask],
      apiRead(uri){
        if(uri==='user')return {login:'worker'};
        if(uri===`repos/${REPO}/issues/407`)return {title:ISSUE_TITLE,state:'open'};
        if(uri===`repos/${REPO}/git/ref/heads/main`)return {object:{sha:commit}};
        if(uri===`repos/${REPO}/issues/comments/6188322050`)return humanGoalComment();
        if(uri===`repos/${REPO}/pulls/437`){candidatePrReads++;return {number:437,state:'open',
          base:{ref:'main',repo:{id:1352411536,full_name:REPO}},
          head:{sha:commit,repo:{id:1352411536,full_name:REPO}}};}
        if(uri===`repos/${REPO}/issues/comments/10`)return goalTaskComment;
        if(uri.startsWith(`repos/${REPO}/contents/`))return {encoding:'base64',content:Buffer.from(spec).toString('base64')};
        throw new Error(`UNEXPECTED_TEST_API_${uri}`);
      },
      commentsRead:()=>receiptComments,
      assertExecutorTaskReady:descriptor=>{assert.equal(descriptor,executor);return {ready:true};},
      createExecutorSourceBundle:({descriptor,job:sourceJob,attemptId})=>{
        assert.equal(descriptor,executor,'W1 source bundles must use the OpenCode descriptor');
        bundleCalls++; assert.equal(sourceJob.kind,'opencode_edit'); assert.equal(sourceJob.source_pr,437);
        return {attempt_id:attemptId,source_sha:sourceJob.source_sha,sha256:'c'.repeat(64)};
      },
      dispatchToExecutor:(descriptor,manifest)=>{
        assert.equal(descriptor,executor,'W1 dispatch must not cross into the W2 task or SID');
        dispatchCalls++; assert.equal(manifest.job.kind,'opencode_edit'); assert.equal(manifest.job.source_pr,437);
        assert.deepEqual(manifest.job.edit_paths,['src/worker.mjs']);
        assert.equal(manifest.source_bundle_sha256,'c'.repeat(64));
        return {outcome:'SYNTHETIC_DISPATCH_ACK_NOT_EXECUTION'};
      },
      writeReceipt(receiptConfig,data,login){
        assert.equal(receiptConfig.issue,407,'the existing #407 comment stream remains the receipt authority');
        posted.push({data,login});
      },
      runPlan:()=>{modelCalls++;throw new Error('DISPATCHER_MUST_NOT_RUN_MODEL_INLINE');},
      observationDependencies:{collectWindowsObservation:()=>({status:'UNKNOWN'})},
    });
    assert.equal(result.state,'DISPATCHED');
    assert.equal(result.request_id,job.request_id);
    assert.equal(bundleCalls,1); assert.equal(dispatchCalls,1); assert.equal(modelCalls,0);
    assert.equal(candidatePrReads,2,'read the exact PR head for selection and again before dispatch');
    assert.equal(posted.length,1);
    assert.equal(posted[0].data.state,'STARTED');
    assert.equal(posted[0].data.kind,'opencode_edit');
    assert.equal(posted[0].login,'worker');

    // A separate local claim store ensures this replay is stopped by the
    // durable #407 receipt merged with the #310 candidate stream.
    const replayStateDir=join(root,'replay-state'); mkdirSync(replayStateDir);
    receiptComments.push(com(13,RECEIPT_MARKER+JSON.stringify(posted[0].data),'worker'));
    const replay=await executeWorker({...config,state_dir:replayStateDir},{
      goalCommentsRead:()=>[humanGoalComment(),goalTaskComment,untrustedGoalTask,wrongIssueTask],
      apiRead(uri){
        if(uri==='user')return {login:'worker'};
        if(uri===`repos/${REPO}/issues/407`)return {title:ISSUE_TITLE,state:'open'};
        if(uri===`repos/${REPO}/git/ref/heads/main`)return {object:{sha:commit}};
        if(uri===`repos/${REPO}/issues/comments/6188322050`)return humanGoalComment();
        if(uri===`repos/${REPO}/pulls/437`)return {number:437,state:'open',
          base:{ref:'main',repo:{id:1352411536,full_name:REPO}},
          head:{sha:commit,repo:{id:1352411536,full_name:REPO}}};
        if(uri===`repos/${REPO}/issues/comments/10`)return goalTaskComment;
        if(uri.startsWith(`repos/${REPO}/contents/`))return {encoding:'base64',content:Buffer.from(spec).toString('base64')};
        throw new Error(`UNEXPECTED_REPLAY_TEST_API_${uri}`);
      },
      commentsRead:()=>receiptComments,
      assertExecutorTaskReady:()=>{throw new Error('DUPLICATE_MUST_NOT_REACH_EXECUTOR_PREFLIGHT');},
      createExecutorSourceBundle:()=>{bundleCalls++;throw new Error('DUPLICATE_MUST_NOT_PREPARE_SOURCE');},
      dispatchToExecutor:()=>{dispatchCalls++;throw new Error('DUPLICATE_MUST_NOT_DISPATCH');},
      writeReceipt:(_receiptConfig,data,login)=>posted.push({data,login}),
      runPlan:()=>{modelCalls++;throw new Error('DISPATCHER_MUST_NOT_RUN_MODEL_INLINE');},
      observationDependencies:{collectWindowsObservation:()=>({status:'UNKNOWN'})},
    });
    assert.notEqual(replay.state,'DISPATCHED');
    assert.equal(bundleCalls,1);
    assert.equal(dispatchCalls,1);
    assert.equal(modelCalls,0);
    assert.equal(posted.length,1,'an existing #407 STARTED receipt must not be reposted');
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('trusted W2 waits without authorization, keeps ping moving, then dispatches the same candidate through the existing Executor', async () => {
  const root=mkdtempSync(join(homedir(),'.ptysd-antigravity-dispatch-test-'));
  try {
    const workspace=join(root,'workspace'),stateDir=join(root,'state');
    mkdirSync(join(workspace,'src'),{recursive:true}); mkdirSync(stateDir);
    const host=hostname().toUpperCase(),spec='Edit only src/worker.mjs in the isolated candidate workspace.';
    const job=withHumanGoal({schema:6,project_id:PROJECT,host,
      request_id:'PTYSD_ANTIGRAVITY_DISPATCH_20261018',kind:'antigravity_edit',source_sha:commit,
      spec_path:'native-bridge/tasks/w2-edit.md',spec_sha256:h(spec),model:ANTIGRAVITY_V2_MODEL,
      variant:'high',edit_paths:['src/worker.mjs'],source_pr:448});
    const jobComment={...com(410,encoded(job),'t14210184'),
      issue_url:`https://api.github.com/repos/${REPO}/issues/310`};
    const pingJob=mkjob({host,request_id:'PTYSD_PING_DURING_W2_WAIT_20261018'});
    const pingComment={...com(411,encoded(pingJob),'t14210184'),
      issue_url:`https://api.github.com/repos/${REPO}/issues/310`};
    const comments=[jobComment,pingComment];
    const attestation={model:ANTIGRAVITY_V2_MODEL,entitlement:'VERIFIED',
      cost:'NO_ADDITIONAL_CHARGE',observed_at:new Date().toISOString()};
    const policyConfig={enable_antigravity_model_runs:true,antigravity_execution_attestation:attestation,
      antigravity_cli_project_id:'b8fbf647-6c41-4932-9d0a-8a7af257a27a'};
    assert.equal(antigravityExecutionAuthorization(job,policyConfig,Date.now()),null);
    assert.equal(antigravityExecutionAuthorization(job,{...policyConfig,antigravity_cli_project_id:undefined},Date.now()),
      null, 'native project discovery performs the workspace binding after policy authorization');
    assert.equal(antigravityExecutionAuthorization(job,{...policyConfig,antigravity_cli_project_id:'bad'},Date.now()),
      'ANTIGRAVITY_PROJECT_SCOPE_UNVERIFIED', 'an invalid explicit ID remains fail-closed');
    assert.equal(antigravityExecutionAuthorization(job,{...policyConfig,
      antigravity_execution_attestation:{...attestation,observed_at:new Date(Date.now()-6*60_000).toISOString()}},
    Date.now()),null,'durable Human policy does not expire at the five-minute L0 interval');
    assert.equal(antigravityExecutionAuthorization(job,{...policyConfig,
      antigravity_execution_attestation:{...attestation,observed_at:new Date(Date.now()+60_000).toISOString()}},
    Date.now()),'ANTIGRAVITY_EXECUTION_ATTESTATION_UNKNOWN',
    'future-dated policy evidence remains invalid');
    const executor=executorDescriptorForLane('Antigravity',1003);
    const config={repo:REPO,project_id:PROJECT,host,issue:407,workspace,state_dir:stateDir,
      dispatchers:['t14210184'],executors:{opencode:executorDescriptorForLane('OpenCode',1001),
        antigravity:executor},enable_antigravity_model_runs:false,
      antigravity_cli_project_id:undefined};
    let bundles=0,dispatches=0,inlineRuns=0,prReads=0,readinessCalls=0,nextReceiptId=420;
    const posted=[],logs=[];
    const adapters={
      goalCommentsRead:()=>[humanGoalComment(),...comments],
      apiRead(uri){
        if(uri==='user')return {login:'worker'};
        if(uri===`repos/${REPO}/issues/407`)return {title:ISSUE_TITLE,state:'open'};
        if(uri===`repos/${REPO}/git/ref/heads/main`)return {object:{sha:commit}};
        if(uri===`repos/${REPO}/issues/comments/6188322050`)return humanGoalComment();
        if(uri===`repos/${REPO}/pulls/448`){prReads++;return {number:448,state:'open',
          base:{ref:'main',repo:{id:1352411536,full_name:REPO}},
          head:{sha:commit,repo:{id:1352411536,full_name:REPO}}};}
        const commentMatch=uri.match(new RegExp(`^repos/${REPO.replaceAll('/','\\/')}/issues/comments/(\\d+)$`));
        if(commentMatch)return comments.find(item=>item.id===Number(commentMatch[1]));
        if(uri.startsWith(`repos/${REPO}/contents/`))
          return {encoding:'base64',content:Buffer.from(spec).toString('base64')};
        throw new Error(`UNEXPECTED_W2_TEST_API_${uri}`);
      },
      commentsRead:()=>comments,assertExecutorTaskReady(descriptor){
        assert.equal(descriptor,executor,'W2 readiness must check the W2 Task Scheduler identity');
        return {ready:true};
      },
      localAppData:root,
      resolveAntigravityProjectId(directory){
        assert.equal(directory,workspace);
        return {projectId:'b8fbf647-6c41-4932-9d0a-8a7af257a27a',
          projectScopeEvidence:'PROJECT_WORKSPACE_MATCHED'};
      },
      runAntigravityV2Readiness(bin,cwd,_runner,_env,_signatureVerifier,projectId){
        readinessCalls++;
        assert.equal(bin,join(root,'agy','bin','agy.exe'));
        assert.equal(cwd,workspace);
        assert.equal(projectId,'b8fbf647-6c41-4932-9d0a-8a7af257a27a');
        // The Publisher's profile is deliberately not logged in. Only the
        // separately scheduled W2 Executor may inspect its own CLI identity.
        return {status:'CLI_AND_PINNED_MODEL_CATALOGED_NOT_EXECUTION_AUTH',
          model:ANTIGRAVITY_V2_MODEL,signature_verified:true,issues:[],
          project_scope_evidence:'PROJECT_WORKSPACE_MATCHED',
          effective_config_evidence:'EFFECTIVE_CONFIG_VERIFIED_NO_MODEL',
          tool_policy_evidence:'W2_NONFILE_ACTIONS_DENIED',
          credit_fallback_setting:'CREDIT_FALLBACK_DISABLED',authentication_checked:true,
          authentication_evidence:'LOGIN_REQUIRED',
          gemini_aggregate_quota:{status:'GEMINI_AGGREGATE_QUOTA_READ',
            source:'GEMINI_MODELS_AGGREGATE',weekly_remaining_percent:95,five_hour_remaining_percent:99}};
      },
      createExecutorSourceBundle({descriptor,job:sourceJob,attemptId}){
        assert.equal(descriptor,executor,'W2 source bundles must use the W2 manifest root');
        bundles++; assert.equal(sourceJob.kind,'antigravity_edit');
        assert.equal(sourceJob.model,ANTIGRAVITY_V2_MODEL); assert.equal(sourceJob.variant,'high');
        return {attempt_id:attemptId,source_sha:sourceJob.source_sha,sha256:'d'.repeat(64)};
      },
      dispatchToExecutor(descriptor,manifest){
        assert.equal(descriptor,executor,'W2 dispatch must not use the W1 task or SID');
        dispatches++; assert.equal(manifest.job.kind,'antigravity_edit');
        assert.equal(manifest.job.source_pr,448); assert.equal(manifest.source_bundle_sha256,'d'.repeat(64));
        return {outcome:'SYNTHETIC_DISPATCH_ACK_NOT_EXECUTION'};
      },
      writeReceipt(receiptConfig,data){
        assert.equal(receiptConfig.issue,407); posted.push(data);
        comments.push(com(nextReceiptId++,RECEIPT_MARKER+JSON.stringify(data),'worker'));
      },
      runPlan(){inlineRuns++;throw new Error('W2_MODEL_MUST_RUN_ONLY_IN_EXECUTOR');},
      observationDependencies:{collectWindowsObservation:()=>({status:'UNKNOWN'})},
      log:value=>logs.push(value),
    };
    const first=await executeWorker(config,adapters);
    assert.equal(first.state,'FINISHED');
    assert.equal(first.request_id,pingJob.request_id,
      'a W2 task waiting for authorization cannot starve an independent ping');
    assert.equal(posted.filter(item=>item.request_id===job.request_id).length,0,
      'do not publish STARTED while W2 execution authorization is absent');
    assert.equal(bundles,0); assert.equal(dispatches,0); assert.equal(inlineRuns,0);

    const second=await executeWorker(config,adapters);
    assert.equal(second.state,'WAITING_ELIGIBILITY');
    assert.equal(second.reason,'ANTIGRAVITY_MODEL_RUNS_NOT_ENABLED');
    assert.equal(posted.filter(item=>item.request_id===job.request_id).length,0,
      'the same unstarted W2 request remains eligible for reevaluation');

    config.enable_antigravity_model_runs=true;
    const unattested=await executeWorker(config,adapters);
    assert.equal(unattested.state,'WAITING_ELIGIBILITY');
    assert.equal(unattested.reason,'ANTIGRAVITY_EXECUTION_ATTESTATION_UNKNOWN',
      'the documented no-G1 default must not prove login, entitlement, or total cost');
    assert.equal(readinessCalls,0,'execution authorization is required before readiness can lead to dispatch');
    assert.equal(posted.filter(item=>item.request_id===job.request_id).length,0,
      'missing execution attestation must not publish STARTED');
    assert.equal(bundles,0); assert.equal(dispatches,0); assert.equal(inlineRuns,0);

    Object.assign(config,{enable_antigravity_model_runs:true,
      antigravity_execution_attestation:attestation,allowed_models:{[ANTIGRAVITY_V2_MODEL]:['high']}});
    const w2Executor=config.executors.antigravity;
    const w1Executor=config.executors.opencode;
    delete config.executors;
    config.executor=w1Executor;
    const independentPing=mkjob({host,request_id:'PTYSD_PING_WITHOUT_W2_EXECUTOR_20261018'});
    comments.push({...com(412,encoded(independentPing),'t14210184'),
      issue_url:`https://api.github.com/repos/${REPO}/issues/310`});
    const missingW2Executor=await executeWorker(config,adapters);
    assert.equal(missingW2Executor.state,'FINISHED');
    assert.equal(missingW2Executor.request_id,independentPing.request_id,
      'missing W2 identity does not starve an independent authorized ping');
    assert.ok(logs.some(value=>value.includes('ANTIGRAVITY_LANE_WAITING_ELIGIBILITY_EXECUTOR_NOT_CONFIGURED_FOR_ANTIGRAVITY')),
      logs.join('\n'));
    assert.equal(posted.filter(item=>item.request_id===job.request_id).length,0,
      'missing lane routing must not publish STARTED or claim the W2 task');
    assert.equal(bundles,0); assert.equal(dispatches,0); assert.equal(readinessCalls,0);
    delete config.executor;
    config.executors={opencode:w1Executor,antigravity:w2Executor};

    const authorizedPrReadsBefore=prReads;
    const result=await executeWorker(config,adapters);
    assert.equal(result.state,'DISPATCHED');
    assert.equal(result.request_id,job.request_id);
    assert.equal(bundles,1); assert.equal(dispatches,1); assert.equal(inlineRuns,0);
    assert.equal(prReads-authorizedPrReadsBefore,2,
      'the authorized attempt verifies its pinned candidate before dispatch and at final readback');
    assert.equal(readinessCalls,0,
      'Publisher must not inspect Antigravity login, quota, or settings under its own Windows identity');
    const w2Receipts=posted.filter(item=>item.request_id===job.request_id);
    assert.equal(w2Receipts.length,1); assert.equal(w2Receipts[0].state,'STARTED');
    assert.equal(w2Receipts[0].kind,'antigravity_edit');
    assert.equal(w2Receipts[0].model,ANTIGRAVITY_V2_MODEL);
    assert.ok(logs.filter(value=>value.includes('ANTIGRAVITY_LANE_WAITING_ELIGIBILITY_ANTIGRAVITY_MODEL_RUNS_NOT_ENABLED')).length>=2);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('candidate PR head drift at final readback prevents STARTED and Executor dispatch', async () => {
  const root=mkdtempSync(join(homedir(),'.ptysd-edit-pr-drift-test-'));
  try {
    const workspace=join(root,'workspace'),stateDir=join(root,'state');
    mkdirSync(join(workspace,'src'),{recursive:true}); mkdirSync(stateDir);
    const host=hostname().toUpperCase();
    const spec='Edit only src/worker.mjs for this synthetic PR-pinned test.';
    const job=withHumanGoal({schema:5,project_id:PROJECT,host,request_id:'PTYSD_OPEN_EDIT_PR_DRIFT_20261016',
      kind:'opencode_edit',source_sha:commit,spec_path:'native-bridge/tasks/edit-worker.md',
      spec_sha256:h(spec),model:'opencode/spark',variant:'high',edit_paths:['src/worker.mjs'],source_pr:437});
    const comments=[com(12,encoded(job),'t14210184')];
    const executor={task_name:'\\PTYSD\\OpenCodeExecutor',user_sid:'S-1-5-21-100-200-300-1001',
      publisher_sid:'S-1-5-21-100-200-300-1002',
      wscript_path:'C:\\Windows\\System32\\wscript.exe',
      launcher_path:'C:\\PTYSD\\HiddenCodexExecutor.vbs',node_bin:'C:\\Node\\node.exe',
      script_path:'C:\\PTYSD\\executor.mjs',config_path:'C:\\PTYSD\\executor.json',
      manifest_dir:join(root,'manifests'),results_dir:join(root,'results'),
      working_directory:root,source_bundle_per_attempt:true};
    const config={repo:REPO,project_id:PROJECT,host,issue:407,workspace,state_dir:stateDir,
      dispatchers:['t14210184'],executor,enable_v2_model_runs:true,
      allowed_models:{'opencode/spark':['high']}};
    const prHeads=[commit,'d'.repeat(40)]; let prReads=0,bundleCalls=0,dispatchCalls=0,posted=[];
    const logs=[];
    const result=await executeWorker(config,{
      goalCommentsRead:()=>[humanGoalComment()],
      apiRead(uri){
        if(uri==='user')return {login:'worker'};
        if(uri===`repos/${REPO}/issues/407`)return {title:ISSUE_TITLE,state:'open'};
        if(uri===`repos/${REPO}/git/ref/heads/main`)return {object:{sha:commit}};
        if(uri===`repos/${REPO}/issues/comments/6188322050`)return humanGoalComment();
        if(uri===`repos/${REPO}/pulls/437`)return {number:437,state:'open',
          base:{ref:'main',repo:{id:1352411536,full_name:REPO}},
          head:{sha:prHeads[prReads++],repo:{id:1352411536,full_name:REPO}}};
        if(uri===`repos/${REPO}/issues/comments/12`)return comments[0];
        if(uri.startsWith(`repos/${REPO}/contents/`))return {encoding:'base64',content:Buffer.from(spec).toString('base64')};
        throw new Error(`UNEXPECTED_TEST_API_${uri}`);
      },
      commentsRead:()=>comments,
      assertExecutorTaskReady:()=>({ready:true}),
      createExecutorSourceBundle:({job:sourceJob,attemptId})=>{
        bundleCalls++; return {attempt_id:attemptId,source_sha:sourceJob.source_sha,sha256:'c'.repeat(64)};
      },
      dispatchToExecutor:()=>{dispatchCalls++;return {outcome:'SHOULD_NOT_DISPATCH'};},
      writeReceipt(_config,data){posted.push(data);},
      observationDependencies:{collectWindowsObservation:()=>({status:'UNKNOWN'})},
      log:value=>logs.push(value),
    });
    assert.equal(prReads,2);
    assert.equal(result.state,'STALE_CANDIDATE_SOURCE');
    assert.equal(bundleCalls,1);
    assert.equal(dispatchCalls,0);
    assert.equal(posted.length,0,'a stale candidate is rejected before publishing STARTED');
    assert.ok(logs.includes('CANDIDATE_PR_HEAD_OR_BASE_CHANGED_437_NO_DISPATCH'));
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('edited Human GOAL bytes at final readback prevent a candidate dispatch', async () => {
  const root=mkdtempSync(join(homedir(),'.ptysd-human-goal-drift-test-'));
  try {
    const workspace=join(root,'workspace'),stateDir=join(root,'state');
    mkdirSync(join(workspace,'src'),{recursive:true}); mkdirSync(stateDir);
    writeFileSync(join(workspace,'src','worker.mjs'),'export const value = 1;\n');
    const host=hostname().toUpperCase();
    const spec='Synthetic pinned edit scope; no model is run by this test.';
    const job=withHumanGoal({schema:5,project_id:PROJECT,host,
      request_id:'PTYSD_OPEN_EDIT_GOAL_DRIFT_20261017',kind:'opencode_edit',source_sha:commit,
      spec_path:'native-bridge/tasks/edit-worker.md',spec_sha256:h(spec),model:'opencode/spark',
      variant:'high',edit_paths:['src/worker.mjs'],source_pr:437});
    const comments=[com(10,encoded(job),'t14210184')];
    const executor={task_name:'\\PTYSD\\OpenCodeExecutor',user_sid:'S-1-5-21-100-200-300-1001',
      publisher_sid:'S-1-5-21-100-200-300-1002',
      wscript_path:'C:\\Windows\\System32\\wscript.exe',
      launcher_path:'C:\\PTYSD\\HiddenCodexExecutor.vbs',node_bin:'C:\\Node\\node.exe',
      script_path:'C:\\PTYSD\\executor.mjs',config_path:'C:\\PTYSD\\executor.json',
      manifest_dir:join(root,'manifests'),results_dir:join(root,'results'),
      working_directory:root,source_bundle_per_attempt:true};
    const config={repo:REPO,project_id:PROJECT,host,issue:407,workspace,state_dir:stateDir,
      dispatchers:['t14210184'],executor,enable_v2_model_runs:true,
      allowed_models:{'opencode/spark':['high']}};
    let goalReads=0,bundleCalls=0,dispatchCalls=0,posted=[];
    const pull={number:437,state:'open',base:{ref:'main',repo:{id:1352411536,full_name:REPO}},
      head:{sha:commit,repo:{id:1352411536,full_name:REPO}}};
    const result=await executeWorker(config,{
      goalCommentsRead:()=>[humanGoalComment()],
      apiRead(uri){
        if(uri==='user')return {login:'worker'};
        if(uri===`repos/${REPO}/issues/407`)return {title:ISSUE_TITLE,state:'open'};
        if(uri===`repos/${REPO}/git/ref/heads/main`)return {object:{sha:commit}};
        if(uri===`repos/${REPO}/issues/comments/6188322050`){
          goalReads++;
          return goalReads===1?humanGoalComment():humanGoalComment({body:`${humanGoalBody} changed`});
        }
        if(uri===`repos/${REPO}/pulls/437`)return pull;
        if(uri===`repos/${REPO}/issues/comments/10`)return comments[0];
        if(uri.startsWith(`repos/${REPO}/contents/`))return {encoding:'base64',content:Buffer.from(spec).toString('base64')};
        throw new Error(`UNEXPECTED_TEST_API:${uri}`);
      },
      commentsRead:()=>comments,
      assertExecutorTaskReady:()=>({ready:true}),
      createExecutorSourceBundle:({job:sourceJob,attemptId})=>{
        bundleCalls++; return {attempt_id:attemptId,source_sha:sourceJob.source_sha,sha256:'c'.repeat(64)};
      },
      dispatchToExecutor:()=>{dispatchCalls++;return {outcome:'SHOULD_NOT_DISPATCH'};},
      writeReceipt(_config,data){posted.push(data);},
      observationDependencies:{collectWindowsObservation:()=>({status:'UNKNOWN'})},
      log:()=>{},
    });
    assert.equal(goalReads,2,'pin is read during selection and immediately before dispatch');
    assert.equal(result.state,'STALE_HUMAN_GOAL');
    assert.equal(bundleCalls,1);
    assert.equal(dispatchCalls,0);
    assert.equal(posted.length,0,'a changed Human GOAL cannot publish STARTED');
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('a newer trusted Human GOAL supersedes a queued candidate before dispatch', async () => {
  const root=mkdtempSync(join(homedir(),'.ptysd-human-goal-supersede-test-'));
  try {
    const workspace=join(root,'workspace'),stateDir=join(root,'state');
    mkdirSync(join(workspace,'src'),{recursive:true}); mkdirSync(stateDir);
    writeFileSync(join(workspace,'src','worker.mjs'),'export const value = 1;\n');
    const host=hostname().toUpperCase();
    const spec='Synthetic pinned edit scope; no model is run by this test.';
    const job=withHumanGoal({schema:5,project_id:PROJECT,host,
      request_id:'PTYSD_OPEN_EDIT_GOAL_SUPERSEDED_20261017',kind:'opencode_edit',source_sha:commit,
      spec_path:'native-bridge/tasks/edit-worker.md',spec_sha256:h(spec),model:'opencode/spark',
      variant:'high',edit_paths:['src/worker.mjs'],source_pr:437});
    const comments=[com(10,encoded(job),'t14210184')];
    const oldGoal=humanGoalComment();
    const newerGoal=humanGoalComment({id:6188322051,
      body:'PTYSD_V53R4_DELETE_FIRST_AUTONOMY_GOAL_20261017\nNew trusted candidate direction.'});
    const executor={task_name:'\\PTYSD\\OpenCodeExecutor',user_sid:'S-1-5-21-100-200-300-1001',
      publisher_sid:'S-1-5-21-100-200-300-1002',
      wscript_path:'C:\\Windows\\System32\\wscript.exe',
      launcher_path:'C:\\PTYSD\\HiddenCodexExecutor.vbs',node_bin:'C:\\Node\\node.exe',
      script_path:'C:\\PTYSD\\executor.mjs',config_path:'C:\\PTYSD\\executor.json',
      manifest_dir:join(root,'manifests'),results_dir:join(root,'results'),
      working_directory:root,source_bundle_per_attempt:true};
    const config={repo:REPO,project_id:PROJECT,host,issue:407,workspace,state_dir:stateDir,
      dispatchers:['t14210184'],executor,enable_v2_model_runs:true,
      allowed_models:{'opencode/spark':['high']}};
    let latestGoalReads=0,pinnedGoalReads=0,bundleCalls=0,dispatchCalls=0,posted=[];
    const pull={number:437,state:'open',base:{ref:'main',repo:{id:1352411536,full_name:REPO}},
      head:{sha:commit,repo:{id:1352411536,full_name:REPO}}};
    const result=await executeWorker(config,{
      goalCommentsRead(){
        latestGoalReads++;
        return latestGoalReads===1?[oldGoal]:[oldGoal,newerGoal];
      },
      apiRead(uri){
        if(uri==='user')return {login:'worker'};
        if(uri===`repos/${REPO}/issues/407`)return {title:ISSUE_TITLE,state:'open'};
        if(uri===`repos/${REPO}/git/ref/heads/main`)return {object:{sha:commit}};
        if(uri===`repos/${REPO}/issues/comments/6188322050`){pinnedGoalReads++;return oldGoal;}
        if(uri===`repos/${REPO}/pulls/437`)return pull;
        if(uri===`repos/${REPO}/issues/comments/10`)return comments[0];
        if(uri.startsWith(`repos/${REPO}/contents/`))return {encoding:'base64',content:Buffer.from(spec).toString('base64')};
        throw new Error(`UNEXPECTED_TEST_API:${uri}`);
      },
      commentsRead:()=>comments,
      assertExecutorTaskReady:()=>({ready:true}),
      createExecutorSourceBundle:({job:sourceJob,attemptId})=>{
        bundleCalls++; return {attempt_id:attemptId,source_sha:sourceJob.source_sha,sha256:'c'.repeat(64)};
      },
      dispatchToExecutor:()=>{dispatchCalls++;return {outcome:'SHOULD_NOT_DISPATCH'};},
      writeReceipt(_config,data){posted.push(data);},
      observationDependencies:{collectWindowsObservation:()=>({status:'UNKNOWN'})},
      log:()=>{},
    });
    assert.equal(latestGoalReads,2,'latest trusted GOAL is checked at selection and immediately before dispatch');
    assert.equal(pinnedGoalReads,1,'superseded jobs are rejected before rereading the old pinned comment');
    assert.equal(result.state,'STALE_HUMAN_GOAL');
    assert.equal(bundleCalls,1);
    assert.equal(dispatchCalls,0);
    assert.equal(posted.length,0,'a superseded GOAL cannot publish STARTED or invoke the executor');
  } finally { rmSync(root,{recursive:true,force:true}); }
});

// Adapter-level simulation only: this test does not launch Task Scheduler, Codex CLI, or a model.
test('Worker requests one executor-adapter dispatch for the exact trusted Issue #310 directive', async () => {
  const root=mkdtempSync(join(homedir(),'.ptysd-human-goal-intake-'));
  try {
    const workspace=join(root,'workspace'), stateDir=join(root,'state'), codexSpool=join(root,'spool');
    mkdirSync(workspace); mkdirSync(stateDir); mkdirSync(codexSpool);
    const host=hostname().toUpperCase();
    const marker='PTYSD_V53R4_P0_ISSUE310_407_CODEX_DELIVERY_RECOVERY_20261016';
    const prior={id:6218136570,issue_url:`https://api.github.com/repos/${REPO}/issues/310`,
      user:{login:'t14210184'},body:'Earlier directive\nPTYSD_V53R4_P0_ISSUE310_407_CODEX_DELIVERY_RECOVERY_20261016\nEarlier bytes.'};
    const directive={id:6219236273,issue_url:`https://api.github.com/repos/${REPO}/issues/310`,
      user:{login:'t14210184'},body:`# P0\n${marker}\nBind this exact source and perform one bounded source-only unit.\n\n` +
        '**Codex 下一動作**：Perform this bounded source-only unit within the pinned write paths.\n'};
    const untrusted={id:6219999999,issue_url:`https://api.github.com/repos/${REPO}/issues/310`,
      user:{login:'untrusted'},body:`${marker}\nDo not accept this author.`};
    const ordinary={id:6220000000,issue_url:`https://api.github.com/repos/${REPO}/issues/310`,
      user:{login:'t14210184'},body:'Ordinary prose without a PTYSD V5.3-R4 directive marker.'};
    const statusReport={id:6229979682,issue_url:`https://api.github.com/repos/${REPO}/issues/310`,
      user:{login:'t14210184'},body:'PTYSD_V53R4_BOOTSTRAP_READBACK_DELTA_20261017\nStatus report only; no dispatch requested.'};
    const goalComments=[humanGoalComment(),prior,directive,untrusted,ordinary,statusReport];
    const spec='# Source-only Human goal execution\nChoose one bounded source task.\n';
    const policy={enabled:true,model:'gpt-6.1-sol',reasoning_effort:'medium',
      write_paths:['native-bridge/worker.mjs','tests/native-bridge.test.mjs']};
    const config={repo:REPO,project_id:PROJECT,host,issue:407,workspace,state_dir:stateDir,
      codex_spool:codexSpool,dispatchers:['t14210184'],human_goal_codex_policy:policy,
      github_transport_verified:true,codex_cli_qualified:true,codex_login_verified:true,
      enable_codex_model_runs:true,codex_usage_authorized:true,
      codex_sandbox_boundary:'VERIFIED_EXACT_PATH_PERMISSION_PROFILE',publisher_identity_sid:'S-1-5-21-1000',
      executor_identity_sid:'S-1-5-21-2000',codex_executor_task:'PTYSD-Codex-Executor',
      codex_executor_task_user:'DESKTOP-1B6PD2P\\PTYSDCODEXEXEC',
      codex_executor_wscript_path:'C:\\Windows\\System32\\wscript.exe',
      codex_executor_launcher_path:'C:\\ProgramData\\PTYSDNativeBridge\\HiddenCodexExecutor.vbs',
      codex_executor_node_path:'C:\\Program Files\\nodejs\\node.exe',
      codex_executor_script_path:'C:\\ProgramData\\PTYSDNativeBridge\\codex-executor.mjs',
      codex_executor_config_path:'C:\\ProgramData\\PTYSDNativeBridge\\executor-config.json',
      codex_executor_working_directory:'C:\\ProgramData\\PTYSDNativeBridge\\CodexSpool',
      allowed_codex_models:{'gpt-6.1-sol':['medium']}};
    const receiptComments=[]; const logs=[]; const requests=[]; const posted=[];
    let triggers=0, specReads=0;
    const adapters={
      goalCommentsRead:()=>goalComments,
      commentsRead:()=>receiptComments,
      apiRead(uri){
        if(uri==='user')return {login:'worker'};
        if(uri===`repos/${REPO}/issues/407`)return {title:ISSUE_TITLE,state:'open'};
        if(uri===`repos/${REPO}/git/ref/heads/main`)return {object:{sha:commit}};
        if(uri===`repos/${REPO}/issues/comments/${directive.id}`)return directive;
        if(uri===`repos/${REPO}/contents/native-bridge/tasks/human-goal-source-only.md?ref=${commit}`){
          specReads++; return {encoding:'base64',content:Buffer.from(spec).toString('base64')};
        }
        throw new Error(`UNEXPECTED_HUMAN_GOAL_API_${uri}`);
      },
      assertCodexExecutorTaskReady:()=>({ready:true}),
      codexDispatchOptions:{
        createBundle:async(path,sourceSha)=>{assert.equal(sourceSha,commit);writeFileSync(path,'synthetic bundle bytes');},
        publishRequest:async(_spool,request)=>{requests.push(request);return 'synthetic-request-path';},
        publishStarted:async data=>{posted.push(data);return true;},
        trigger:async()=>{triggers++;},
      },
      log:message=>logs.push(message),
    };
    const reportOnly=await executeWorker(config,{...adapters,goalCommentsRead:()=>[statusReport]});
    assert.equal(requests.length,0,'a trusted author status report alone must not create a model request');
    assert.equal(triggers,0,'a status report must not start an executor');
    assert.equal(specReads,0,'a status report must not fetch an executable task spec');
    assert.equal(posted.length,0,'a status report must not publish a STARTED receipt');
    assert.notEqual(reportOnly.state,'CODEX_EXECUTOR_REQUESTED');
    const noPolicy=await executeWorker({...config,human_goal_codex_policy:undefined},adapters);
    assert.equal(noPolicy.state,'WAITING_ELIGIBILITY');
    assert.equal(noPolicy.reason,'HUMAN_GOAL_CODEX_POLICY_NOT_CONFIGURED');
    assert.equal(requests.length,0,'missing explicit intake policy must not reach any executor');
    assert.equal(specReads,0,'missing policy must not fetch or prepare a model task');
    assert.ok(logs.some(message=>message===`HUMAN_GOAL_CODEX_POLICY_NOT_CONFIGURED_${directive.id}_NO_MODEL`));

    const result=await executeWorker(config,adapters);
    assert.equal(result.state,'CODEX_EXECUTOR_REQUESTED',JSON.stringify({result,logs}));
    assert.equal(requests.length,1);
    assert.equal(posted.length,1);
    assert.equal(triggers,1,'only the existing Codex Executor trigger is used');
    assert.equal(specReads,1);
    const request=requests[0]; const sent={job:request.job,
      spec:Buffer.from(request.spec_base64,'base64').toString('utf8'),
      humanGoalContext:JSON.parse(Buffer.from(request.human_goal_context_base64,'base64').toString('utf8'))};
    assert.equal(sent.job.request_id,
      `PTYSD_HUMAN_GOAL_${directive.id}_${h(directive.body).slice(0,42).toUpperCase()}`,
    'the durable job identity must change when a trusted comment body is edited in place');
    assert.equal(sent.job.source_sha,commit);
    assert.equal(sent.job.goal_comment_id,directive.id);
    assert.equal(sent.job.goal_author,directive.user.login);
    assert.equal(sent.job.goal_body_sha256,h(directive.body));
    assert.equal(sent.job.goal_marker,marker);
    assert.equal(sent.spec,spec);
    assert.equal(typeof sent.humanGoalContext.fetched_at,'string',
      'the durable executor request must record when the exact Human comment was read back');
    assert.equal(new Date(sent.humanGoalContext.fetched_at).toISOString(),
      sent.humanGoalContext.fetched_at,'fetched_at must be an exact UTC ISO timestamp');
    assert.deepEqual(sent.humanGoalContext,{repo:REPO,issue:310,comment_id:directive.id,
      author:directive.user.login,body_sha256:h(directive.body),body:directive.body,
      fetched_at:sent.humanGoalContext.fetched_at,
      scoped_action:'Perform this bounded source-only unit within the pinned write paths.'});
    assert.ok(logs.some(message=>message===`HUMAN_GOAL_READBACK_${directive.id}_${h(directive.body)}_${sent.humanGoalContext.fetched_at}`),
      'the local discovery log must bind comment id, exact body digest, and readback time');
    assert.equal(sent.job.goal_comment_id,6219236273,'a later status-report marker by the trusted author is not an executable directive');

    const terminal=receipt(sent.job.request_id,'00000000-0000-0000-0000-000000000777',
      'BLOCKED',sent.job,{exit_code:45,outcome:'CODEX_EXECUTOR_PREFLIGHT_BLOCKED'});
    receiptComments.push(com(99,RECEIPT_MARKER+JSON.stringify(terminal),'worker'));
    const replay=await executeWorker(config,adapters);
    assert.equal(replay.state,'NO_DELTA');
    assert.equal(requests.length,1,'a receipt for this comment ID suppresses replay');
    assert.equal(triggers,1);
    assert.equal(specReads,1,'completed or blocked source IDs do not refetch and restart the model task');
    assert.ok(logs.some(message=>message===`HUMAN_GOAL_ALREADY_HAS_RECEIPT_${directive.id}_NO_REPLAY`));

    const changedBodyDirective={...directive,body:`${directive.body}\nA newly authorized source-only correction.`};
    const editedComments=goalComments.map(comment=>comment===directive?changedBodyDirective:comment);
    const editedAdapters={...adapters,goalCommentsRead:()=>editedComments,
      apiRead(uri){
        if(uri===`repos/${REPO}/issues/comments/${directive.id}`)return changedBodyDirective;
        return adapters.apiRead(uri);
      }};
    const edited=await executeWorker(config,editedAdapters);
    assert.equal(edited.state,'CODEX_EXECUTOR_REQUESTED',
      'an edited trusted directive with the same comment ID is a new exact body-bound job');
    assert.equal(requests.length,2);
    assert.equal(requests[1].job.request_id,
      `PTYSD_HUMAN_GOAL_${directive.id}_${h(changedBodyDirective.body).slice(0,42).toUpperCase()}`);
    assert.equal(requests[1].job.goal_body_sha256,h(changedBodyDirective.body));
    assert.equal(triggers,2);

    const legacyState=join(root,'legacy-receipt-state'); mkdirSync(legacyState);
    const legacyRequestId=`PTYSD_HUMAN_GOAL_${directive.id}`;
    const legacyJob={...sent.job,request_id:legacyRequestId};
    const legacyTerminal=receipt(legacyRequestId,'00000000-0000-0000-0000-000000000778',
      'BLOCKED',legacyJob,{exit_code:45,outcome:'CODEX_EXECUTOR_PREFLIGHT_BLOCKED'});
    const legacyAdapterSet={...editedAdapters,goalCommentsRead:()=>[humanGoalComment(),changedBodyDirective],
      commentsRead:()=>[com(100,RECEIPT_MARKER+JSON.stringify(legacyTerminal),'worker')]};
    const legacy=await executeWorker({...config,state_dir:legacyState},legacyAdapterSet);
    assert.equal(legacy.state,'CODEX_EXECUTOR_REQUESTED',
      'a terminal legacy receipt bound to the old body must not suppress an edited directive');
    assert.equal(requests.length,3,'the edited body receives its own content-bound request');
    assert.equal(requests[2].job.goal_body_sha256,h(changedBodyDirective.body));
    assert.equal(triggers,3);

    const sameBodyState=join(root,'legacy-same-body-state'); mkdirSync(sameBodyState);
    const sameBodyLegacyJob={...legacyJob,goal_body_sha256:h(changedBodyDirective.body)};
    const sameBodyLegacyTerminal=receipt(legacyRequestId,'00000000-0000-0000-0000-000000000780',
      'FINISHED',sameBodyLegacyJob,{exit_code:0,outcome:'CODEX_CLI_EXIT_0_UNVERIFIED'});
    const sameBodyAdapterSet={...legacyAdapterSet,
      commentsRead:()=>[com(100,RECEIPT_MARKER+JSON.stringify(sameBodyLegacyTerminal),'worker')]};
    const sameBody=await executeWorker({...config,state_dir:sameBodyState},sameBodyAdapterSet);
    assert.equal(sameBody.state,'NO_DELTA',
      'a legacy receipt with the same exact body digest suppresses duplicate execution');
    assert.equal(requests.length,3);
    assert.equal(triggers,3);

    const unknownState=join(root,'legacy-unknown-state'); mkdirSync(unknownState);
    const unknownLegacyTerminal={...legacyTerminal};
    delete unknownLegacyTerminal.goal_comment_id;
    delete unknownLegacyTerminal.goal_body_sha256;
    delete unknownLegacyTerminal.goal_author;
    delete unknownLegacyTerminal.goal_marker;
    const unknownAdapterSet={...legacyAdapterSet,
      commentsRead:()=>[com(101,RECEIPT_MARKER+JSON.stringify(unknownLegacyTerminal),'worker')]};
    const unknown=await executeWorker({...config,state_dir:unknownState},unknownAdapterSet);
    assert.equal(unknown.state,'WAITING_ELIGIBILITY',
      'a legacy receipt with no exact body identity must prevent possible replay');
    assert.equal(unknown.reason,'HUMAN_GOAL_LEGACY_RECEIPT_BODY_UNKNOWN');
    assert.equal(requests.length,3);
    assert.equal(triggers,3);
    assert.ok(logs.some(message=>message===
      `HUMAN_GOAL_LEGACY_RECEIPT_BODY_UNKNOWN_${directive.id}_NO_REPLAY`));

    const malformedState=join(root,'legacy-malformed-state'); mkdirSync(malformedState);
    const malformedLegacyReceipt={schema:1,project_id:PROJECT,host,request_id:legacyRequestId,
      state:'STARTED',kind:'codex_plan',goal_comment_id:directive.id,
      goal_body_sha256:h(directive.body)};
    const malformedAdapterSet={...legacyAdapterSet,
      commentsRead:()=>[com(103,RECEIPT_MARKER+JSON.stringify(malformedLegacyReceipt),'worker')]};
    const malformed=await executeWorker({...config,state_dir:malformedState},malformedAdapterSet);
    assert.equal(malformed.state,'WAITING_ELIGIBILITY',
      'a malformed but identifiable legacy receipt cannot be treated as no prior effect');
    assert.equal(malformed.reason,'HUMAN_GOAL_LEGACY_RECEIPT_BODY_UNKNOWN');
    assert.equal(requests.length,3);
    assert.equal(triggers,3);

    const inflightState=join(root,'legacy-inflight-state'); mkdirSync(inflightState);
    const inflight=receipt(legacyRequestId,'00000000-0000-0000-0000-000000000779',
      'STARTED',legacyJob);
    const inflightAdapterSet={...legacyAdapterSet,
      commentsRead:()=>[com(102,RECEIPT_MARKER+JSON.stringify(inflight),'worker')]};
    const pending=await executeWorker({...config,state_dir:inflightState},inflightAdapterSet);
    assert.equal(pending.state,'WAITING_ELIGIBILITY',
      'a different known body still cannot proceed while its legacy attempt is STARTED');
    assert.equal(requests.length,3);
    assert.equal(triggers,3);

    const hashInflightState=join(root,'hash-inflight-state'); mkdirSync(hashInflightState);
    const hashInflight=receipt(sent.job.request_id,'00000000-0000-0000-0000-000000000781',
      'STARTED',sent.job);
    const hashInflightAdapters={...editedAdapters,
      commentsRead:()=>[com(104,RECEIPT_MARKER+JSON.stringify(hashInflight),'worker')]};
    const hashPending=await executeWorker({...config,state_dir:hashInflightState},hashInflightAdapters);
    assert.equal(requests.length,3,'an edited comment cannot bypass an unresolved prior body-bound attempt');
    assert.equal(triggers,3);
    assert.equal(hashPending.state,'WAITING_ELIGIBILITY',
      'a hash-bound STARTED receipt for the same comment must block redispatch after that comment is edited');
    assert.equal(hashPending.reason,'HUMAN_GOAL_LEGACY_RECEIPT_BODY_UNKNOWN');

    const staleState=join(root,'stale-state'); mkdirSync(staleState);
    const staleDirective={...directive,id:6219236274,
      body:`# P0\n${marker}\nOriginal directive body before final readback.\n` +
        '**Codex 下一動作**：Perform this bounded source-only unit within the pinned write paths.\n'};
    const editedDirective={...staleDirective,body:`${staleDirective.body}\nEdited after intake.`};
    let directReads=0;
    const staleAdapters={...adapters,
      goalCommentsRead:()=>[humanGoalComment(),prior,staleDirective],
      apiRead(uri){
        if(uri===`repos/${REPO}/issues/comments/${staleDirective.id}`)
          return ++directReads===1 ? staleDirective : editedDirective;
        return adapters.apiRead(uri);
      }};
    const beforeStaleRequests=requests.length;
    const beforeStaleTriggers=triggers;
    const stale=await executeWorker({...config,state_dir:staleState},staleAdapters);
    assert.equal(stale.state,'STALE_HUMAN_GOAL');
    assert.equal(requests.length,beforeStaleRequests,'edited source bytes never reach an additional request publication');
    assert.equal(triggers,beforeStaleTriggers,'changed source bytes never trigger an additional executor run');
    assert.equal(directReads,2,'the selected body and the pre-dispatch body are both read back');
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('OpenCode V2 edit intake captures exact scoped diff without treating exit zero as coding acceptance', async () => {
  const home=mkdtempSync(join(homedir(),'.ptysd-v2-edit-test-'));
  try {
    const workspace=join(home,'workspace'),stateDir=join(home,'state');
    mkdirSync(join(workspace,'src'),{recursive:true}); mkdirSync(stateDir);
    const git=(...args)=>{
      const result=spawnSync('git',['-C',workspace,...args],{encoding:'utf8',windowsHide:true});
      assert.equal(result.status,0,result.stderr); return result.stdout.trim();
    };
    git('init','--quiet'); git('config','user.name','PTYSD test'); git('config','user.email','test@example.invalid');
    writeFileSync(join(workspace,'src','worker.mjs'),'export const state = "base";\n');
    writeFileSync(join(workspace,'README.md'),'baseline\n');
    git('add','src/worker.mjs','README.md'); git('commit','--quiet','-m','test source');
    const sourceSha=git('rev-parse','HEAD');
    const config={workspace,state_dir:stateDir,enable_v2_model_runs:true,
      allowed_models:{'opencode/spark':['high']}};
    const makeJob=request_id=>({schema:4,project_id:PROJECT,host:hostname().toUpperCase(),
      request_id,kind:'opencode_edit',source_sha:sourceSha,
      spec_path:'native-bridge/tasks/review.md',spec_sha256:hash,
      model:'opencode/spark',variant:'high',edit_paths:['src/worker.mjs']});
    let processTreeState='DEAD',modelLaunches=0;
    const execute=async (request_id,target,content,resultOverrides={})=>executeOpenCodeTask('Make the assigned source edit.',
      config,makeJob(request_id),randomUUID(),{
        qualifyOpenCodeV2:()=>({ready:true,bin:'fake-opencode-v2.exe',version:'2.0.27'}),
        readV2ProviderAuth:()=>({status:'AUTH_PROVIDER_RECORD_PRESENT'}),
        gitPlatform:'win32',
        readGitProcessTree:pid=>({state:processTreeState,root_pid:pid,
          process_ids:processTreeState==='DEAD'?[]:[pid],census_complete:processTreeState==='DEAD',
          observed_at:new Date().toISOString(),error:processTreeState==='UNKNOWN'?'TEST_CENSUS_UNKNOWN':null}),
        async runCapturedProcess(_bin,args,options){
          modelLaunches++;
          assert.equal(args[args.indexOf('--agent')+1],'ptysd-scoped-write');
          assert.equal(args[args.indexOf('--model')+1],'opencode/spark#high');
          assert.equal(args.includes('--shell'),false);
          if(content!==null) writeFileSync(join(workspace,target),content);
          const sessionID=`ses_${request_id.toLowerCase()}`;
          const events=[
            {type:'step_start',sessionID},
            {type:'text',sessionID,part:{type:'text',text:'synthetic private model output'}},
            {type:'tool_use',sessionID,part:{type:'tool',tool:'edit',callID:`edit-${request_id}`,
              state:{status:'completed'}}},
            {type:'step_finish',sessionID,part:{type:'step-finish',tokens:{input:8,output:2,
              reasoning:1,cache:{read:3}}}},
          ];
          const out=Buffer.from(resultOverrides.invalidOutput ? '{bad json\n' :
            `${events.map(event=>JSON.stringify(event)).join('\n')}\n`); const err=Buffer.alloc(0);
          writeFileSync(options.stdoutPath,out,{flag:'wx'}); writeFileSync(options.stderrPath,err,{flag:'wx'});
          const combined=createHash('sha256').update(out).update(Buffer.from('\n--- STDERR ---\n')).update(err).digest('hex');
          return {outcome:'SYNTHETIC_PROCESS_EXITED',exit_code:0,evidence_sha256:combined,
            evidence_bytes:out.length+Buffer.byteLength('\n--- STDERR ---\n'),
            local_evidence:{stdout_file:basename(options.stdoutPath),stdout_sha256:createHash('sha256').update(out).digest('hex'),
              stdout_bytes:out.length,stderr_file:basename(options.stderrPath),
              stderr_sha256:createHash('sha256').update(err).digest('hex'),stderr_bytes:0,
              termination_state:resultOverrides.termination_state ?? 'NOT_REQUESTED',
              ...(resultOverrides.capture_error ? {capture_error:resultOverrides.capture_error} : {}),
              ...(resultOverrides.storage_error ? {storage_error:resultOverrides.storage_error} : {})}};
        },
      });

    const allowed=await execute('PTYSD_OPEN_EDIT_ALLOWED_20261016','src/worker.mjs',
      'export const state = "changed";\n');
    assert.equal(allowed.outcome,'V2_EDIT_DIFF_CAPTURED_UNVERIFIED');
    assert.equal(allowed.coding_state,'DIFF_CAPTURED_UNVERIFIED');
    assert.deepEqual(allowed.changed_files,['src/worker.mjs']);
    assert.equal(allowed.scope_valid,true);
    assert.equal(allowed.session_id,'ses_ptysd_open_edit_allowed_20261016');
    assert.equal(allowed.session_started,true);
    assert.equal(allowed.model_invoked,true);
    assert.equal(allowed.provider_usage_evidence,'CONFIRMED');
    assert.equal(allowed.model_activity_evidence,'CONFIRMED');
    assert.equal(allowed.tool_execution_count,1);
    assert.equal(allowed.file_change_tool_evidence,'COMPLETED');
    assert.equal(JSON.stringify(allowed).includes('synthetic private model output'),false);
    assert.match(readFileSync(join(stateDir,allowed.file),'utf8'),/state = "changed"/);
    const allowedReceipt=receipt('PTYSD_OPEN_EDIT_ALLOWED_20261016',randomUUID(),'FINISHED',
      makeJob('PTYSD_OPEN_EDIT_ALLOWED_20261016'),allowed);
    assert.equal(allowedReceipt.coding_state,'DIFF_CAPTURED_UNVERIFIED');
    assert.equal(allowedReceipt.session_id,allowed.session_id);
    assert.equal(allowedReceipt.session_started,true);
    assert.equal(allowedReceipt.model_invoked,true);
    assert.equal(allowedReceipt.provider_usage_evidence,'CONFIRMED');
    assert.equal(parseReceipt(RECEIPT_MARKER+JSON.stringify(allowedReceipt)).session_id,allowed.session_id);
    assert.equal(await verifyCapturedEvidence(stateDir,{terminal:allowedReceipt,
      local_evidence:allowed.local_evidence}),true);
    const startReceipt=receipt('PTYSD_OPEN_EDIT_START_20261016',randomUUID(),'STARTED',
      makeJob('PTYSD_OPEN_EDIT_START_20261016'));
    assert.equal(startReceipt.session_id,null);
    assert.equal(startReceipt.session_started,null);
    assert.equal(startReceipt.model_invoked,null,
      'a dispatch acknowledgement cannot claim a session or model invocation');
    assert.equal(existsSync(join(workspace,'opencode.json')),false,
      'temporary V2 policy is removed after its exact readback');

    git('restore','--worktree','--','src/worker.mjs');
    const outside=await execute('PTYSD_OPEN_EDIT_SCOPE_20261016','README.md','changed out of scope\n');
    assert.equal(outside.outcome,'V2_EDIT_SCOPE_VIOLATION');
    assert.equal(outside.scope_valid,false);
    assert.deepEqual(outside.changed_files,['README.md']);
    const outsideReceipt=receipt('PTYSD_OPEN_EDIT_SCOPE_20261016',randomUUID(),'BLOCKED',
      makeJob('PTYSD_OPEN_EDIT_SCOPE_20261016'),outside);
    assert.equal(await verifyCapturedEvidence(stateDir,{terminal:outsideReceipt,
      local_evidence:outside.local_evidence}),true,
      'scope violations retain verifiable diff evidence but remain blocked');

    git('restore','--worktree','--','README.md');
    const launchesBeforeUnknownTree=modelLaunches;
    processTreeState='UNKNOWN';
    const unknownTree=await execute('PTYSD_OPEN_EDIT_GIT_TREE_UNKNOWN_20261016','src/worker.mjs',
      'export const state = "must not be written";\n');
    assert.match(unknownTree.outcome,/V2_EDIT_SCOPE_OR_SOURCE_EDIT_GIT_.*TERMINATION_UNCONFIRMED/);
    assert.equal(unknownTree.eligibility_state,'BLOCKED');
    assert.equal(unknownTree.model_invoked,false);
    assert.equal(modelLaunches,launchesBeforeUnknownTree,'unknown Git process census blocks before model launch');
    assert.equal(readFileSync(join(workspace,'src','worker.mjs'),'utf8').replaceAll('\r\n','\n'),
      'export const state = "base";\n');
    processTreeState='DEAD';

    const noDiff=await execute('PTYSD_OPEN_EDIT_NO_DIFF_20261016','src/worker.mjs',null);
    assert.equal(noDiff.cli_exit_code,0);
    assert.equal(noDiff.outcome,'V2_EDIT_NO_DIFF');
    assert.equal(noDiff.coding_state,'NO_DIFF');
    assert.equal(terminalStateForResult(noDiff),'BLOCKED');

    git('restore','--worktree','--','src/worker.mjs');
    const incompleteCapture=await execute('PTYSD_OPEN_EDIT_CAPTURE_ERROR_20261016','src/worker.mjs',
      'export const state = "capture error diff";\n',
      {capture_error:'OUTPUT_CAPTURE_FAILED',termination_state:'TERMINATION_CONFIRMED'});
    assert.equal(incompleteCapture.outcome,'V2_EDIT_EVIDENCE_CAPTURE_FAILED_DIFF_PRESERVED');
    assert.equal(terminalStateForResult(incompleteCapture),'BLOCKED');
    const incompleteReceipt=receipt('PTYSD_OPEN_EDIT_CAPTURE_ERROR_20261016',randomUUID(),'BLOCKED',
      makeJob('PTYSD_OPEN_EDIT_CAPTURE_ERROR_20261016'),incompleteCapture);
    const tamperedEvidence={...incompleteCapture.local_evidence,
      edit_diff:{...incompleteCapture.local_evidence.edit_diff,sha256:'0'.repeat(64)}};
    await assert.rejects(verifyCapturedEvidence(stateDir,{terminal:incompleteReceipt,
      local_evidence:tamperedEvidence}),/EDIT_DIFF_EVIDENCE_METADATA_INVALID/,
    'an output-capture error must not bypass verification of the separately preserved diff');
    assert.equal(await verifyCapturedEvidence(stateDir,{terminal:incompleteReceipt,
      local_evidence:incompleteCapture.local_evidence}),true);

    git('restore','--worktree','--','src/worker.mjs');
    const unreadableOutput=await execute('PTYSD_OPEN_EDIT_BAD_OUTPUT_20261016','src/worker.mjs',
      'export const state = "diff with unreadable output";\n',{invalidOutput:true});
    assert.equal(unreadableOutput.outcome,'V2_EDIT_DIFF_CAPTURED_UNVERIFIED');
    assert.deepEqual(unreadableOutput.changed_files,['src/worker.mjs']);
    assert.equal(unreadableOutput.session_id,null);
    assert.equal(unreadableOutput.session_started,null);
    assert.equal(unreadableOutput.model_invoked,null);
    assert.equal(unreadableOutput.provider_usage_evidence,'UNKNOWN');
    assert.equal(unreadableOutput.local_evidence.opencode_run.reason,'OPEN_CODE_JSONL_INVALID');
    const unreadableReceipt=receipt('PTYSD_OPEN_EDIT_BAD_OUTPUT_20261016',randomUUID(),
      'FINISHED',makeJob('PTYSD_OPEN_EDIT_BAD_OUTPUT_20261016'),unreadableOutput);
    assert.equal(unreadableReceipt.session_id,null);
    assert.equal(unreadableReceipt.model_invoked,null);
    assert.equal(await verifyCapturedEvidence(stateDir,{terminal:unreadableReceipt,
      local_evidence:unreadableOutput.local_evidence}),true,
    'the independent source diff remains verifiable while malformed session evidence stays unknown');

    git('restore','--worktree','--','src/worker.mjs');
    const uncertain=await execute('PTYSD_OPEN_EDIT_TERMINATION_UNKNOWN_20261016','src/worker.mjs',
      'export const state = "possibly still writing";\n',
      {termination_state:'TERMINATION_UNCONFIRMED'});
    assert.equal(uncertain.outcome,'V2_EDIT_PROCESS_TERMINATION_UNCONFIRMED');
    assert.equal(existsSync(join(workspace,'opencode.json')),true,
      'keep the scoped write policy in place while a child may still be writing');
  } finally { rmSync(home,{recursive:true,force:true}); }
});

test('Antigravity edit uses the pinned CLI/model only after a fresh no-overage authorization and preserves an unverified scoped diff', async () => {
  const home=mkdtempSync(join(homedir(),'.ptysd-antigravity-edit-test-'));
  try {
    const registeredProjectRoot=join(home,'registered-project');
    const workspace=join(home,'attempt-workspaces',randomUUID());
    const stateDir=join(home,'state'),localAppData=join(home,'localappdata');
    mkdirSync(join(registeredProjectRoot,'src'),{recursive:true}); mkdirSync(stateDir);
    mkdirSync(dirname(workspace),{recursive:true});
    const cliPath=join(localAppData,'agy','bin','agy.exe');
    mkdirSync(dirname(cliPath),{recursive:true});
    const cliBytes=Buffer.from('synthetic signed Antigravity CLI 1.4.2');
    writeFileSync(cliPath,cliBytes);
    const cliSha256=createHash('sha256').update(cliBytes).digest('hex');
    const git=(root,...args)=>{
      const result=spawnSync('git',['-C',root,...args],{encoding:'utf8',windowsHide:true});
      assert.equal(result.status,0,result.stderr); return result.stdout.trim();
    };
    git(registeredProjectRoot,'init','--quiet');
    git(registeredProjectRoot,'config','user.name','PTYSD test');
    git(registeredProjectRoot,'config','user.email','test@example.invalid');
    writeFileSync(join(registeredProjectRoot,'src','worker.mjs'),'export const state = "base";\n');
    git(registeredProjectRoot,'add','src/worker.mjs');
    git(registeredProjectRoot,'commit','--quiet','-m','test source');
    const sourceSha=git(registeredProjectRoot,'rev-parse','HEAD');
    git(registeredProjectRoot,'worktree','add','--quiet','--detach',workspace,sourceSha);
    writeFileSync(join(registeredProjectRoot,'registered-root-only.txt'),'outer project revision\n');
    git(registeredProjectRoot,'add','registered-root-only.txt');
    git(registeredProjectRoot,'commit','--quiet','-m','advance registered project independently');
    const registeredProjectSha=git(registeredProjectRoot,'rev-parse','HEAD');
    assert.notEqual(registeredProjectSha,sourceSha,
      'the registered outer project may be pinned to another task while the attempt checkout matches its source SHA');
    const now=Date.now();
    const attestation={model:ANTIGRAVITY_V2_MODEL,entitlement:'VERIFIED',
      cost:'NO_ADDITIONAL_CHARGE',observed_at:new Date(now).toISOString()};
    const config={workspace,antigravity_project_root:registeredProjectRoot,state_dir:stateDir,
      enable_antigravity_model_runs:true,
      allowed_models:{[ANTIGRAVITY_V2_MODEL]:['high']},antigravity_execution_attestation:attestation,
      antigravity_cli_project_id:'b8fbf647-6c41-4932-9d0a-8a7af257a27a'};
    const job=withHumanGoal({schema:6,project_id:PROJECT,host:hostname().toUpperCase(),
      request_id:'PTYSD_ANTIGRAVITY_EDIT_SYNTHETIC_20261018',kind:'antigravity_edit',source_sha:sourceSha,
      spec_path:'native-bridge/tasks/review.md',spec_sha256:hash,model:ANTIGRAVITY_V2_MODEL,
      variant:'high',edit_paths:['src/worker.mjs'],source_pr:448});

    let readinessCalls=0,modelLaunches=0;
    const blocked=await executeOpenCodeTask('Synthetic; no inference.',{...config,
      antigravity_execution_attestation:undefined},job,randomUUID(),{
      runAntigravityV2Readiness(){readinessCalls++;throw new Error('READINESS_MUST_NOT_RUN');},
      runCapturedProcess(){modelLaunches++;throw new Error('MODEL_MUST_NOT_RUN');},
    });
    assert.equal(blocked.outcome,'ANTIGRAVITY_EXECUTION_ATTESTATION_UNKNOWN');
    assert.equal(blocked.eligibility_state,'WAITING');
    assert.equal(blocked.model_invoked,false);
    assert.equal(readinessCalls,0); assert.equal(modelLaunches,0);

    for (const invalidAttestation of [
      {...attestation,entitlement:'UNKNOWN'},
      {...attestation,cost:'UNKNOWN'},
    ]) {
      const rejected=await executeOpenCodeTask('Synthetic; no inference.',{...config,
        antigravity_execution_attestation:invalidAttestation},job,randomUUID(),{
        runAntigravityV2Readiness(){readinessCalls++;throw new Error('READINESS_MUST_NOT_RUN');},
        runCapturedProcess(){modelLaunches++;throw new Error('MODEL_MUST_NOT_RUN');},
      });
      assert.equal(rejected.outcome,'ANTIGRAVITY_EXECUTION_ATTESTATION_UNKNOWN');
      assert.equal(rejected.eligibility_state,'WAITING');
      assert.equal(rejected.model_invoked,false);
    }
    assert.equal(readinessCalls,0); assert.equal(modelLaunches,0);

    const disabled=await executeOpenCodeTask('Synthetic; no inference.',{...config,
      enable_antigravity_model_runs:false},job,randomUUID(),{
      runAntigravityV2Readiness(){readinessCalls++;throw new Error('READINESS_MUST_NOT_RUN');},
      runCapturedProcess(){modelLaunches++;throw new Error('MODEL_MUST_NOT_RUN');},
    });
    assert.equal(disabled.outcome,'ANTIGRAVITY_MODEL_RUNS_NOT_ENABLED');
    assert.equal(modelLaunches,0);

    const unboundProject=await executeOpenCodeTask('Synthetic; no inference.',{...config,
      antigravity_cli_project_id:undefined},job,randomUUID(),{
      runAntigravityV2Readiness(){readinessCalls++;throw new Error('READINESS_MUST_NOT_RUN');},
      runCapturedProcess(){modelLaunches++;throw new Error('MODEL_MUST_NOT_RUN');},
    });
    assert.equal(unboundProject.outcome,'ANTIGRAVITY_PROJECT_SCOPE_UNVERIFIED');
    assert.equal(unboundProject.eligibility_state,'WAITING');
    assert.equal(unboundProject.model_invoked,false);
    assert.equal(readinessCalls,0); assert.equal(modelLaunches,0);

    const noQuotaReadiness={status:'CLI_AND_PINNED_MODEL_CATALOGED_NOT_EXECUTION_AUTH',
      signature_verified:true,model:ANTIGRAVITY_V2_MODEL,version:'1.4.2',authentication_checked:true,
      authentication_evidence:'AUTHENTICATED_QUOTA_READ',tool_policy_evidence:'W2_NONFILE_ACTIONS_DENIED',issues:[],
      project_scope_evidence:'PROJECT_WORKSPACE_MATCHED',
      effective_config_evidence:'EFFECTIVE_CONFIG_VERIFIED_NO_MODEL',
      credit_fallback_setting:'CREDIT_FALLBACK_DISABLED',
      gemini_aggregate_quota:{status:'GEMINI_AGGREGATE_QUOTA_READ',source:'GEMINI_MODELS_AGGREGATE',
        weekly_remaining_percent:95,five_hour_remaining_percent:0}};
    const emptyQuota=await executeOpenCodeTask('Synthetic; no inference.',config,job,randomUUID(),
      {now:()=>now,localAppData,runAntigravityV2Readiness:()=>noQuotaReadiness,
        runCapturedProcess(){modelLaunches++;}});
    assert.equal(emptyQuota.outcome,'ANTIGRAVITY_QUOTA_EMPTY');
    assert.equal(modelLaunches,0);

    const readiness={status:'CLI_AND_PINNED_MODEL_CATALOGED_NOT_EXECUTION_AUTH',signature_verified:true,
      model:ANTIGRAVITY_V2_MODEL,version:'1.4.2',authentication_checked:true,authentication_evidence:'AUTHENTICATED_QUOTA_READ',
      project_scope_evidence:'PROJECT_WORKSPACE_MATCHED',
      effective_config_evidence:'EFFECTIVE_CONFIG_VERIFIED_NO_MODEL',
      tool_policy_evidence:'W2_NONFILE_ACTIONS_DENIED',
      gemini_aggregate_quota:{status:'GEMINI_AGGREGATE_QUOTA_READ',
        source:'GEMINI_MODELS_AGGREGATE',weekly_remaining_percent:95,five_hour_remaining_percent:99},
      credit_fallback_setting:'CREDIT_FALLBACK_DISABLED',issues:[]};
    const overage=await executeOpenCodeTask('Synthetic; no inference.',{...config,
      antigravity_execution_attestation:{...attestation,use_g1_credits:true}},job,randomUUID(),{
      now:()=>now,localAppData,
      runAntigravityV2Readiness:()=>({...readiness,credit_fallback_setting:'CREDIT_FALLBACK_ENABLED'}),
      runCapturedProcess(){modelLaunches++;},
    });
    assert.equal(overage.outcome,'ANTIGRAVITY_CREDIT_OVERAGE_NOT_DISABLED');
    assert.equal(modelLaunches,0);

    for (const [rootName,invalidRoot,expected] of [
      ['missing',undefined,'ANTIGRAVITY_EDIT_PROJECT_ROOT_NOT_CONFIGURED'],
      ['same physical directory',workspace,'ANTIGRAVITY_EDIT_PROJECT_ROOT_SAME_AS_CANDIDATE'],
    ]) {
      let rootReadinessCalls=0,rootModelCalls=0;
      const rootBinding=await executeOpenCodeTask('Synthetic root-binding negative case; no inference.',
        {...config,antigravity_project_root:invalidRoot},job,randomUUID(),{
          now:()=>now,localAppData,
          runAntigravityV2Readiness(){rootReadinessCalls++;return readiness;},
          runCapturedProcess(){rootModelCalls++;throw new Error('MODEL_MUST_NOT_RUN');},
        });
      assert.equal(rootBinding.outcome,expected,`root binding ${rootName} must fail closed`);
      assert.equal(rootBinding.eligibility_state,'BLOCKED');
      assert.equal(rootBinding.model_invoked,false);
      assert.equal(rootBinding.scope_valid,false);
      assert.equal(rootBinding.external_effects,'NONE');
      assert.equal(rootReadinessCalls,0);
      assert.equal(rootModelCalls,0);
    }

    const toolPolicyBlocked=await executeOpenCodeTask('Synthetic; no inference.',config,job,randomUUID(),{
      now:()=>now,localAppData,
      runAntigravityV2Readiness:()=>({...readiness,tool_policy_evidence:'W2_NONFILE_ACTION_DENY_INCOMPLETE'}),
      runCapturedProcess(){modelLaunches++;throw new Error('MODEL_MUST_NOT_RUN');},
    });
    assert.equal(toolPolicyBlocked.outcome,'ANTIGRAVITY_NONFILE_TOOL_POLICY_UNVERIFIED');
    assert.equal(toolPolicyBlocked.eligibility_state,'WAITING');
    assert.equal(toolPolicyBlocked.model_invoked,false);
    assert.equal(modelLaunches,0);

    const projectScopeBlocked=await executeOpenCodeTask('Synthetic; no inference.',config,job,randomUUID(),{
      now:()=>now,localAppData,
      runAntigravityV2Readiness:()=>({...readiness,project_scope_evidence:'PROJECT_WORKSPACE_MISMATCH'}),
      runCapturedProcess(){modelLaunches++;throw new Error('MODEL_MUST_NOT_RUN');},
    });
    assert.equal(projectScopeBlocked.outcome,'ANTIGRAVITY_PROJECT_SCOPE_UNVERIFIED');
    assert.equal(projectScopeBlocked.eligibility_state,'WAITING');
    assert.equal(projectScopeBlocked.model_invoked,false);
    assert.equal(modelLaunches,0);

    const stale=await executeOpenCodeTask('Synthetic; no inference.',{...config,
      antigravity_execution_attestation:{...attestation,observed_at:new Date(now-6*60_000).toISOString()}},
    job,randomUUID(),{now:()=>now,localAppData,
      runAntigravityV2Readiness:()=>({...readiness,authentication_checked:false,
        authentication_evidence:'AUTHENTICATED_QUOTA_READ'}),
      runCapturedProcess(){modelLaunches++;}});
    assert.equal(stale.outcome,'ANTIGRAVITY_CLI_AUTH_NOT_VERIFIED');
    assert.equal(stale.eligibility_state,'WAITING');
    assert.equal(stale.model_invoked,false);
    assert.equal(modelLaunches,0);

    const conversation='conv_antigravity_20261018';
    const env={PATH:process.env.PATH,USERPROFILE:home,LOCALAPPDATA:localAppData,
      GEMINI_API_KEY:'synthetic-key-must-not-reach-child',GITHUB_TOKEN:'synthetic-publisher-token'};
    const unconfirmed=await executeOpenCodeTask('Synthetic; process termination is unknown.',config,job,
      randomUUID(),{
        now:()=>now,baseEnv:env,localAppData,
        runAntigravityV2Readiness:()=>readiness,
        readAntigravityV2RunEvidence:()=>({valid:true,reason:null,session_id:'conv_unconfirmed_20261018',
          session_started:true,cli_status:'SUCCESS',model_invoked:true,provider_usage_evidence:'OBSERVED',
          model_activity_evidence:'OBSERVED',token_usage:{input_tokens:1,output_tokens:1,
            thinking_tokens:0,cache_read_tokens:0,total_tokens:2},tool_execution_evidence:'UNKNOWN',
          tool_execution_count:0,file_change_tool_evidence:'UNKNOWN',
          file_change_tool_completed_count:0,file_change_tool_failed_count:0,
          file_change_tool_incomplete_count:0,event_count:2,stdout_bytes:10}),
        runCapturedProcess(_bin,_args,options){
          return {outcome:'CAPTURE_TERMINATION_UNCONFIRMED',exit_code:-1,evidence_sha256:null,
            evidence_bytes:0,local_evidence:{stdout_file:basename(options.stdoutPath),
              stdout_sha256:'0'.repeat(64),stdout_bytes:0,stderr_file:basename(options.stderrPath),
              stderr_sha256:'0'.repeat(64),stderr_bytes:0,
              termination_state:'TERMINATION_UNCONFIRMED'}};
        },
      });
    assert.equal(unconfirmed.outcome,'ANTIGRAVITY_EDIT_PROCESS_TERMINATION_UNCONFIRMED');
    assert.equal(unconfirmed.coding_state,'UNKNOWN_PROCESS_MAY_STILL_WRITE');
    assert.equal(unconfirmed.exit_code,-1);
    assert.equal(terminalStateForResult(unconfirmed),'BLOCKED');
    assert.equal(readdirSync(stateDir).some(name=>name.startsWith('edit-diff-')),false,
      'do not capture or publish a final diff while the model process tree may still be writing');

    const autoBoundConfig={...config,antigravity_cli_project_id:undefined};
    const result=await executeOpenCodeTask('Change the state value.',autoBoundConfig,job,randomUUID(),{
      now:()=>now,baseEnv:env,localAppData,
      resolveAntigravityProjectId(workspacePath,sourceEnv){
        assert.equal(workspacePath,workspace);
        assert.equal(sourceEnv.USERPROFILE,home);
        return {projectId:config.antigravity_cli_project_id,
          projectScopeEvidence:'PROJECT_WORKSPACE_MATCHED'};
      },
      runAntigravityV2Readiness(bin,cwd,_runner,_env,_signatureVerifier,projectId){
        readinessCalls++;
        assert.equal(bin,join(localAppData,'agy','bin','agy.exe'));
        assert.equal(cwd,workspace);
        assert.equal(projectId,config.antigravity_cli_project_id);
        return readiness;
      },
      async runCapturedProcess(bin,args,options){
        modelLaunches++;
        assert.equal(bin,join(localAppData,'agy','bin','agy.exe'));
        assert.deepEqual(args.slice(0,4),['--input-format','stream-json','--output-format','stream-json']);
        assert.equal(args[4],`--project=${config.antigravity_cli_project_id}`,
          'execution must target the exact candidate-scoped Antigravity project');
        const addDirIndex=args.indexOf('--add-dir');
        assert.notEqual(addDirIndex,-1,'execution must explicitly add the attempt checkout to the selected project');
        assert.equal(args[addDirIndex+1],workspace);
        assert.ok(JSON.parse(options.stdinText).message.content.includes(resolve(workspace,'src/worker.mjs')),
          'the file tool must receive the exact absolute path inside the attempt checkout');
        assert.equal(args.includes('--print'),false,
          'stream-json mode reads the prompt from stdin and must not pass the print alias');
        assert.equal(args.includes('--prompt'),false);
        assert.equal(args.includes('--print-timeout'),false);
        assert.equal(args[args.indexOf('--model')+1],ANTIGRAVITY_V2_MODEL);
        assert.equal(args.includes('--effort'),false,
          'Gemini 3.8 Flash High is selected by its exact model ID; do not send the incompatible effort override');
        assert.equal(args.includes('--mode=accept-edits'),true,
          'headless coding must not wait for interactive diff approval');
        assert.equal(args.includes('--sandbox'),true);
        assert.equal(args.includes('--dangerously-skip-permissions'),false,
          'accept-edits must keep the exact sandbox and permission allowlist');
        assert.equal(options.env.GEMINI_API_KEY,undefined);
        assert.equal(options.env.GITHUB_TOKEN,undefined);
        assert.equal(options.env.USERPROFILE,home);
        assert.equal(options.env.LOCALAPPDATA,localAppData);
        assert.equal(options.env.AGY_CLI_DISABLE_AUTO_UPDATE,'true');
        assert.equal(options.env.OPENCODE_DISABLE_AUTOUPDATE,undefined);
        assert.equal(JSON.parse(options.stdinText).event,'user');
        writeFileSync(join(workspace,'src','worker.mjs'),'export const state = "changed";\n');
        const events=[
          {event:'init',conversation_id:conversation,init:{model:ANTIGRAVITY_V2_MODEL,cwd:workspace,
            permission_mode:'request-review'}},
          {event:'step_update',step_update:{conversation_id:conversation,step_index:0,state:'DONE',
            step_type:'tool',tool_name:'write_to_file',tool_info:{}}},
          {event:'step_update',step_update:{conversation_id:conversation,step_index:1,state:'ACTIVE',
            step_type:'tool',tool_name:'run_command'}},
          {event:'step_update',step_update:{conversation_id:conversation,step_index:1,state:'ERROR',
            step_type:'tool',tool_name:'run_command',tool_info:{error:{code:'COMMAND_DENIED',
              message:'PRIVATE_COMMAND_ERROR'}}}},
          {event:'result',result:{conversation_id:conversation,status:'SUCCESS',response:'private response text',
            usage:{input_tokens:90,output_tokens:20,thinking_tokens:4,cache_read_tokens:0,total_tokens:114}}},
        ];
        const out=Buffer.from(events.map(event=>JSON.stringify(event)).join('\n')+'\n');
        const err=Buffer.alloc(0); writeFileSync(options.stdoutPath,out,{flag:'wx'});
        writeFileSync(options.stderrPath,err,{flag:'wx'});
        const combined=createHash('sha256').update(out).update(Buffer.from('\n--- STDERR ---\n')).update(err).digest('hex');
        return {outcome:'SYNTHETIC_PROCESS_EXITED',exit_code:0,evidence_sha256:combined,
          evidence_bytes:out.length+Buffer.byteLength('\n--- STDERR ---\n'),local_evidence:{
            stdout_file:basename(options.stdoutPath),stdout_sha256:createHash('sha256').update(out).digest('hex'),
            stdout_bytes:out.length,stderr_file:basename(options.stderrPath),
            stderr_sha256:createHash('sha256').update(err).digest('hex'),stderr_bytes:0,
            termination_state:'NOT_REQUESTED'}};
      },
    });
    assert.equal(readinessCalls,1); assert.equal(modelLaunches,1);
    assert.equal(result.outcome,'ANTIGRAVITY_EDIT_TOOL_EXECUTION_FAILED_DIFF_PRESERVED');
    assert.equal(result.coding_state,'DIFF_CAPTURED_UNVERIFIED');
    assert.equal(result.exit_code,-1);
    assert.equal(result.cli_exit_code,0);
    assert.equal(result.tool_execution_failed_count,1);
    assert.equal(result.tool_execution_incomplete_count,0);
    assert.equal(terminalStateForResult(result),'BLOCKED');
    assert.equal(result.model_invoked,true);
    assert.equal(result.session_id,conversation);
    assert.equal(result.cli_status,'SUCCESS');
    assert.equal(result.run_disposition,'CLI_SUCCESS_REQUIRES_SEMANTIC_REVIEW');
    assert.equal(result.cli_version,'1.4.2');
    assert.equal(result.cli_binary_sha256,cliSha256);
    assert.equal(result.cli_binary_integrity_evidence,'MATCHED');
    assert.equal(result.project_scope_evidence,'PROJECT_WORKSPACE_MATCHED');
    assert.equal(result.effective_config_evidence,'EFFECTIVE_CONFIG_VERIFIED_NO_MODEL');
    assert.equal(result.tool_policy_evidence,'W2_NONFILE_ACTIONS_DENIED');
    assert.equal(result.external_effects,'UNKNOWN');
    assert.equal(result.source_diff_evidence,'CAPTURED');
    assert.equal(result.task_acceptance,'UNKNOWN');
    assert.equal(result.permission_mode_evidence,'REQUEST_REVIEW_CONFIRMED');
    assert.equal(result.local_evidence.antigravity_run.permission_mode_evidence,'REQUEST_REVIEW_CONFIRMED');
    assert.equal(result.local_evidence.antigravity_run.source_diff_evidence,'CAPTURED');
    assert.equal(result.local_evidence.antigravity_run.cli_binary_sha256,cliSha256);
    assert.deepEqual(result.local_evidence.antigravity_project_root_check,{
      status:'CLEAN_STABLE',head_before_sha:registeredProjectSha,head_after_sha:registeredProjectSha,
      status_sha256:createHash('sha256').update(Buffer.alloc(0)).digest('hex'),status_bytes:0,
    },'the outer registered project is checked for isolation without requiring its HEAD to equal the candidate source SHA');
    assert.deepEqual(result.changed_files,['src/worker.mjs']);
    assert.equal(result.file_change_tool_completed_count,1);
    assert.equal(JSON.stringify(result).includes('private response text'),false);
    const finalReceipt=receipt(job.request_id,randomUUID(),'FINISHED',job,result);
    assert.equal(finalReceipt.model,ANTIGRAVITY_V2_MODEL);
    assert.equal(finalReceipt.variant,'high');
    assert.equal(finalReceipt.permission_mode_evidence,'REQUEST_REVIEW_CONFIRMED');
    assert.equal(finalReceipt.cli_status,'SUCCESS');
    assert.equal(finalReceipt.tool_execution_failed_count,1);
    assert.equal(finalReceipt.tool_execution_incomplete_count,0);
    assert.equal(finalReceipt.run_disposition,'CLI_SUCCESS_REQUIRES_SEMANTIC_REVIEW');
    assert.equal(finalReceipt.cli_version,'1.4.2');
    assert.equal(finalReceipt.cli_binary_sha256,cliSha256);
    assert.equal(finalReceipt.cli_binary_integrity_evidence,'MATCHED');
    assert.equal(finalReceipt.tool_policy_evidence,'W2_NONFILE_ACTIONS_DENIED');
    assert.equal(finalReceipt.external_effects,'UNKNOWN');
    assert.equal(finalReceipt.source_diff_evidence,'CAPTURED');
    assert.equal(finalReceipt.task_acceptance,'UNKNOWN');
    assert.equal(finalReceipt.coding_state,'DIFF_CAPTURED_UNVERIFIED');
    assert.equal(parseReceipt(RECEIPT_MARKER+JSON.stringify(finalReceipt)).session_id,conversation);
    assert.equal(parseReceipt(RECEIPT_MARKER+JSON.stringify(finalReceipt)).permission_mode_evidence,
      'REQUEST_REVIEW_CONFIRMED');
    assert.equal(parseReceipt(RECEIPT_MARKER+JSON.stringify({ ...finalReceipt,
      run_disposition: 'TASK_ACCEPTED' })), null,
    'receipts cannot promote a CLI status into task acceptance');
    assert.equal(parseReceipt(RECEIPT_MARKER+JSON.stringify({ ...finalReceipt,
      cli_binary_sha256: 'not-a-sha' })), null,
    'receipts must preserve a valid exact CLI binary digest');
    assert.equal(parseReceipt(RECEIPT_MARKER+JSON.stringify({ ...finalReceipt,
      permission_mode_evidence: 'UNSUPPORTED' })), null,
    'a receipt cannot claim an unsupported Antigravity permission mode');
    assert.equal(await verifyCapturedEvidence(stateDir,{terminal:finalReceipt,local_evidence:result.local_evidence}),true);

    git(workspace,'checkout','--','src/worker.mjs');
    const zeroUsageSession='conv_antigravity_zero_usage_20261018';
    const zeroUsage=await executeOpenCodeTask('Change the state value.',config,job,randomUUID(),{
      now:()=>now,baseEnv:env,localAppData,
      runAntigravityV2Readiness:()=>readiness,
      async runCapturedProcess(_bin,_args,options){
        writeFileSync(join(workspace,'src','worker.mjs'),'export const state = "changed-without-usage";\n');
        const events=[
          {event:'init',conversation_id:zeroUsageSession,init:{model:ANTIGRAVITY_V2_MODEL,cwd:workspace,
            permission_mode:'accept-edits'}},
          {event:'step_update',step_update:{conversation_id:zeroUsageSession,step_index:0,state:'DONE',
            step_type:'tool',tool_name:'write_to_file',tool_info:{}}},
          {event:'result',result:{conversation_id:zeroUsageSession,status:'SUCCESS',response:'',
            usage:{input_tokens:0,output_tokens:0,thinking_tokens:0,cache_read_tokens:0,total_tokens:0}}},
        ];
        const out=Buffer.from(events.map(event=>JSON.stringify(event)).join('\n')+'\n');
        const err=Buffer.alloc(0);
        writeFileSync(options.stdoutPath,out,{flag:'wx'});
        writeFileSync(options.stderrPath,err,{flag:'wx'});
        const combined=createHash('sha256').update(out).update(Buffer.from('\n--- STDERR ---\n')).update(err).digest('hex');
        return {outcome:'SYNTHETIC_ZERO_USAGE',exit_code:0,evidence_sha256:combined,
          evidence_bytes:out.length+Buffer.byteLength('\n--- STDERR ---\n'),local_evidence:{
            stdout_file:basename(options.stdoutPath),stdout_sha256:createHash('sha256').update(out).digest('hex'),
            stdout_bytes:out.length,stderr_file:basename(options.stderrPath),
            stderr_sha256:createHash('sha256').update(err).digest('hex'),stderr_bytes:0,
            termination_state:'NOT_REQUESTED'}};
      },
    });
    assert.equal(zeroUsage.outcome,'ANTIGRAVITY_NO_POSITIVE_MODEL_USAGE_DIFF_PRESERVED');
    assert.equal(zeroUsage.exit_code,-1);
    assert.equal(zeroUsage.coding_state,'DIFF_CAPTURED_UNVERIFIED');
    assert.equal(zeroUsage.model_invoked,false);
    assert.deepEqual(zeroUsage.changed_files,['src/worker.mjs']);
    assert.match(zeroUsage.diff_sha256,/^[a-f0-9]{64}$/);
    assert.equal(terminalStateForResult(zeroUsage),'BLOCKED');

    git(workspace,'checkout','--','src/worker.mjs');
    const changedBinary=await executeOpenCodeTask('Synthetic; binary changes during run.',config,job,randomUUID(),{
      now:()=>now,baseEnv:env,localAppData,runAntigravityV2Readiness:()=>readiness,
      async runCapturedProcess(_bin,_args,options){
        writeFileSync(join(workspace,'src','worker.mjs'),'export const state = "changed-with-cli-replacement";\n');
        const events=[
          {event:'init',conversation_id:'conv_agy_binary_changed',init:{model:ANTIGRAVITY_V2_MODEL,
            cwd:workspace,permission_mode:'accept-edits'}},
          {event:'step_update',step_update:{conversation_id:'conv_agy_binary_changed',step_index:0,
            state:'DONE',step_type:'tool',tool_name:'write_to_file',tool_info:{}}},
          {event:'result',result:{conversation_id:'conv_agy_binary_changed',status:'SUCCESS',response:'',
            usage:{input_tokens:1,output_tokens:1,thinking_tokens:0,cache_read_tokens:0,total_tokens:2}}},
        ];
        const out=Buffer.from(events.map(event=>JSON.stringify(event)).join('\n')+'\n');
        writeFileSync(options.stdoutPath,out,{flag:'wx'}); writeFileSync(options.stderrPath,Buffer.alloc(0),{flag:'wx'});
        writeFileSync(cliPath,Buffer.from('replaced after qualification'));
        return {outcome:'SYNTHETIC_PROCESS_EXITED',exit_code:0,evidence_sha256:'0'.repeat(64),
          evidence_bytes:out.length,local_evidence:{stdout_file:basename(options.stdoutPath),
            stdout_sha256:createHash('sha256').update(out).digest('hex'),stdout_bytes:out.length,
            stderr_file:basename(options.stderrPath),stderr_sha256:createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
            stderr_bytes:0,termination_state:'NOT_REQUESTED'}};
      },
    });
    assert.equal(changedBinary.outcome,'ANTIGRAVITY_CLI_BINARY_CHANGED_OR_UNKNOWN_DURING_RUN');
    assert.equal(changedBinary.cli_binary_integrity_evidence,'CHANGED_OR_UNKNOWN');
    assert.equal(changedBinary.external_effects,'UNKNOWN');
    assert.equal(terminalStateForResult(changedBinary),'BLOCKED');
    writeFileSync(cliPath,cliBytes);
    git(workspace,'checkout','--','src/worker.mjs');
    const incompleteStream=await executeOpenCodeTask(
      'Synthetic; retain edits when stream terminates without a result.',config,job,randomUUID(),{
        now:()=>now,baseEnv:env,localAppData,runAntigravityV2Readiness:()=>readiness,
        readGitProcessTree:pid=>({state:'DEAD',root_pid:pid,process_ids:[],
          census_complete:true,observed_at:new Date().toISOString(),error:null}),
        async runCapturedProcess(_bin,_args,options){
          writeFileSync(join(workspace,'src','worker.mjs'),
            'export const state = "changed-before-truncated-stream";\n');
          const events=[
            {event:'init',conversation_id:'conv_agy_incomplete_20261018',init:{
              model:ANTIGRAVITY_V2_MODEL,cwd:workspace,permission_mode:'accept-edits'}},
            {event:'step_update',step_update:{conversation_id:'conv_agy_incomplete_20261018',
              step_index:0,state:'DONE',step_type:'tool',tool_name:'write_to_file',tool_info:{}}},
          ];
          const out=Buffer.from(events.map(event=>JSON.stringify(event)).join('\n')+'\n');
          const err=Buffer.alloc(0);
          writeFileSync(options.stdoutPath,out,{flag:'wx'});
          writeFileSync(options.stderrPath,err,{flag:'wx'});
          const combined=createHash('sha256').update(out).update(Buffer.from('\n--- STDERR ---\n')).update(err).digest('hex');
          return {outcome:'SYNTHETIC_PROCESS_EXITED',exit_code:0,evidence_sha256:combined,
            evidence_bytes:out.length+Buffer.byteLength('\n--- STDERR ---\n'),local_evidence:{stdout_file:basename(options.stdoutPath),
              stdout_sha256:createHash('sha256').update(out).digest('hex'),stdout_bytes:out.length,
              stderr_file:basename(options.stderrPath),
              stderr_sha256:createHash('sha256').update(err).digest('hex'),stderr_bytes:0,
              termination_state:'NOT_REQUESTED'}};
        },
      });
    assert.equal(incompleteStream.outcome,
      'ANTIGRAVITY_STREAM_EVIDENCE_ANTIGRAVITY_JSONL_INCOMPLETE_DIFF_CAPTURED_UNVERIFIED');
    assert.equal(incompleteStream.external_effects,'UNKNOWN');
    assert.equal(incompleteStream.task_acceptance,'UNKNOWN');
    assert.equal(incompleteStream.model_invoked,null);
    assert.equal(incompleteStream.coding_state,'DIFF_CAPTURED_UNVERIFIED');
    assert.equal(incompleteStream.source_diff_evidence,'CAPTURED');
    assert.deepEqual(incompleteStream.changed_files,['src/worker.mjs']);
    assert.match(incompleteStream.diff_sha256,/^[a-f0-9]{64}$/);
    assert.equal(terminalStateForResult(incompleteStream),'BLOCKED');
    const incompleteAttemptId=randomUUID();
    const incompleteReceipt=receipt(job.request_id,incompleteAttemptId,'BLOCKED',job,incompleteStream);
    assert.equal(await verifyCapturedEvidence(stateDir,{terminal:incompleteReceipt,
      local_evidence:incompleteStream.local_evidence}),true,
    'the exact raw streams and captured diff remain independently verifiable');
    const incompleteComments=[com(9801,encoded(job)),
      com(9802,RECEIPT_MARKER+JSON.stringify(incompleteReceipt),'worker')];
    assert.equal(selectNext(incompleteComments,['t14210184'],'worker',job.host,job.source_sha),null,
      'an incomplete W2 session with captured edits is terminally unverified and cannot replay');

    git(workspace,'checkout','--','src/worker.mjs');
    const incompleteCommandSession='conv_agy_incomplete_command_20261020';
    const incompleteCommand=await executeOpenCodeTask(
      'Synthetic; keep command state unknown when it never reaches a terminal event.',config,job,randomUUID(),{
        now:()=>now,baseEnv:env,localAppData,runAntigravityV2Readiness:()=>readiness,
        readGitProcessTree:pid=>({state:'DEAD',root_pid:pid,process_ids:[],
          census_complete:true,observed_at:new Date().toISOString(),error:null}),
        async runCapturedProcess(_bin,_args,options){
          writeFileSync(join(workspace,'src','worker.mjs'),
            'export const state = "changed-with-unconfirmed-command";\n');
          const events=[
            {event:'init',conversation_id:incompleteCommandSession,init:{
              model:ANTIGRAVITY_V2_MODEL,cwd:workspace,permission_mode:'accept-edits'}},
            {event:'step_update',step_update:{conversation_id:incompleteCommandSession,step_index:0,
              state:'DONE',step_type:'tool',tool_name:'write_to_file',tool_info:{}}},
            {event:'step_update',step_update:{conversation_id:incompleteCommandSession,step_index:1,
              state:'ACTIVE',step_type:'tool',tool_name:'run_command'}},
            {event:'result',result:{conversation_id:incompleteCommandSession,status:'SUCCESS',response:'',
              usage:{input_tokens:5,output_tokens:2,thinking_tokens:0,cache_read_tokens:0,total_tokens:7}}},
          ];
          const out=Buffer.from(events.map(event=>JSON.stringify(event)).join('\n')+'\n');
          const err=Buffer.alloc(0);
          writeFileSync(options.stdoutPath,out,{flag:'wx'}); writeFileSync(options.stderrPath,err,{flag:'wx'});
          const combined=createHash('sha256').update(out).update(Buffer.from('\n--- STDERR ---\n')).update(err).digest('hex');
          return {outcome:'SYNTHETIC_PROCESS_EXITED',exit_code:0,evidence_sha256:combined,
            evidence_bytes:out.length+Buffer.byteLength('\n--- STDERR ---\n'),local_evidence:{
              stdout_file:basename(options.stdoutPath),stdout_sha256:createHash('sha256').update(out).digest('hex'),
              stdout_bytes:out.length,stderr_file:basename(options.stderrPath),
              stderr_sha256:createHash('sha256').update(err).digest('hex'),stderr_bytes:0,
              termination_state:'NOT_REQUESTED'}};
        },
      });
    assert.equal(incompleteCommand.outcome,
      'ANTIGRAVITY_EDIT_TOOL_EXECUTION_INCOMPLETE_DIFF_PRESERVED');
    assert.equal(incompleteCommand.exit_code,-1);
    assert.equal(incompleteCommand.cli_exit_code,0);
    assert.equal(incompleteCommand.tool_execution_failed_count,0);
    assert.equal(incompleteCommand.tool_execution_incomplete_count,1);
    assert.equal(incompleteCommand.task_acceptance,'UNKNOWN');
    assert.equal(terminalStateForResult(incompleteCommand),'BLOCKED');
    const incompleteCommandReceipt=receipt(job.request_id,randomUUID(),
      terminalStateForResult(incompleteCommand),job,incompleteCommand);
    assert.equal(incompleteCommandReceipt.tool_execution_failed_count,0);
    assert.equal(incompleteCommandReceipt.tool_execution_incomplete_count,1);
    assert.equal(parseReceipt(RECEIPT_MARKER+JSON.stringify(incompleteCommandReceipt)).outcome,
      'ANTIGRAVITY_EDIT_TOOL_EXECUTION_INCOMPLETE_DIFF_PRESERVED');

    git(workspace,'checkout','--','src/worker.mjs');
    const forbiddenSession='conv_agy_forbidden_tool_20261018';
    const forbiddenTool=await executeOpenCodeTask(
      'Synthetic; detect a prohibited browser tool event after process exit.',config,job,randomUUID(),{
        now:()=>now,baseEnv:env,localAppData,runAntigravityV2Readiness:()=>readiness,
        async runCapturedProcess(_bin,_args,options){
          writeFileSync(join(workspace,'src','worker.mjs'),
            'export const state = "changed-after-forbidden-tool";\n');
          const events=[
            {event:'init',conversation_id:forbiddenSession,init:{model:ANTIGRAVITY_V2_MODEL,
              cwd:workspace,permission_mode:'request-review'}},
            {event:'step_update',step_update:{conversation_id:forbiddenSession,step_index:0,
              state:'DONE',step_type:'tool',tool_name:'browser_click_element',
              tool_info:{url:'https://private.invalid/',text:'DO_NOT_LEAK_TOOL_PAYLOAD'}}},
            {event:'result',result:{conversation_id:forbiddenSession,status:'SUCCESS',response:'',
              usage:{input_tokens:10,output_tokens:2,thinking_tokens:0,cache_read_tokens:0,total_tokens:12}}},
          ];
          const out=Buffer.from(events.map(event=>JSON.stringify(event)).join('\n')+'\n');
          const err=Buffer.alloc(0);
          writeFileSync(options.stdoutPath,out,{flag:'wx'});
          writeFileSync(options.stderrPath,err,{flag:'wx'});
          return {outcome:'SYNTHETIC_PROCESS_EXITED',exit_code:0,evidence_sha256:'0'.repeat(64),
            evidence_bytes:out.length,local_evidence:{stdout_file:basename(options.stdoutPath),
              stdout_sha256:createHash('sha256').update(out).digest('hex'),stdout_bytes:out.length,
              stderr_file:basename(options.stderrPath),
              stderr_sha256:createHash('sha256').update(err).digest('hex'),stderr_bytes:0,
              termination_state:'NOT_REQUESTED'}};
        },
      });
    assert.equal(forbiddenTool.forbidden_tool_execution_evidence,'OBSERVED');
    assert.equal(forbiddenTool.outcome,'ANTIGRAVITY_FORBIDDEN_CUA_TOOL_EVENT_DIFF_CAPTURED_UNVERIFIED');
    assert.equal(forbiddenTool.exit_code,-1);
    assert.equal(forbiddenTool.external_effects,'UNKNOWN');
    assert.equal(forbiddenTool.task_acceptance,'UNKNOWN');
    assert.equal(forbiddenTool.source_diff_evidence,'CAPTURED');
    assert.deepEqual(forbiddenTool.changed_files,['src/worker.mjs']);
    assert.equal(JSON.stringify(forbiddenTool).includes('browser_click_element'),false);
    assert.equal(JSON.stringify(forbiddenTool).includes('DO_NOT_LEAK_TOOL_PAYLOAD'),false);
    assert.equal(JSON.stringify(forbiddenTool).includes('private.invalid'),false);
    assert.equal(terminalStateForResult(forbiddenTool),'BLOCKED');
    const forbiddenAttemptId=randomUUID();
    const forbiddenReceipt=receipt(job.request_id,forbiddenAttemptId,'BLOCKED',job,forbiddenTool);
    assert.equal(forbiddenReceipt.forbidden_tool_execution_evidence,'OBSERVED');
    assert.ok(parseReceipt(RECEIPT_MARKER+JSON.stringify(forbiddenReceipt)));
    const forbiddenComments=[com(9811,encoded(job)),
      com(9812,RECEIPT_MARKER+JSON.stringify(forbiddenReceipt),'worker')];
    assert.equal(selectNext(forbiddenComments,['t14210184'],'worker',job.host,job.source_sha),null,
      'a forbidden tool event with possible edits is preserved as terminal and never replayed');

    const escapedWorkspace=join(home,'attempt-workspaces',randomUUID());
    git(registeredProjectRoot,'worktree','add','--quiet','--detach',escapedWorkspace,sourceSha);
    const escapedAttempt=await executeOpenCodeTask('Synthetic project-root escape; no inference.',
      {...config,workspace:escapedWorkspace},job,randomUUID(),{
        now:()=>now,baseEnv:env,localAppData,runAntigravityV2Readiness:()=>readiness,
        async runCapturedProcess(_bin,_args,options){
          const escapedFiles=[
            ['package.json','{"name":"synthetic-root-escape"}\n'],
            ['native-bridge/antigravity-quota.mjs','export const recovered = true;\n'],
            ['tests/antigravity-quota.test.mjs','import test from \'node:test\';\n'],
          ];
          for (const [path,contents] of escapedFiles) {
            const absolute=join(registeredProjectRoot,path);
            mkdirSync(dirname(absolute),{recursive:true});
            writeFileSync(absolute,contents);
          }
          const empty=Buffer.alloc(0);
          writeFileSync(options.stdoutPath,empty,{flag:'wx'});
          writeFileSync(options.stderrPath,empty,{flag:'wx'});
          return {outcome:'SYNTHETIC_PROCESS_EXITED',exit_code:0,evidence_sha256:'0'.repeat(64),
            evidence_bytes:0,local_evidence:{stdout_file:basename(options.stdoutPath),
              stdout_sha256:createHash('sha256').update(empty).digest('hex'),stdout_bytes:0,
              stderr_file:basename(options.stderrPath),
              stderr_sha256:createHash('sha256').update(empty).digest('hex'),stderr_bytes:0,
              termination_state:'NOT_REQUESTED'}};
        },
      });
    assert.equal(escapedAttempt.outcome,'ANTIGRAVITY_EDIT_PROJECT_ROOT_WRITE_ESCAPED_ATTEMPT');
    assert.equal(escapedAttempt.scope_valid,false);
    assert.equal(escapedAttempt.external_effects,'UNKNOWN');
    assert.equal(escapedAttempt.coding_state,'PROJECT_ROOT_WRITE_PRESERVED_UNVERIFIED');
    assert.equal(escapedAttempt.project_root_changed_files_count,3);
    assert.equal(Object.hasOwn(escapedAttempt,'diff_bytes'),false,
      'a root mismatch must not be misreported as a zero-byte candidate diff');
    assert.equal(escapedAttempt.local_evidence.antigravity_project_root_check.status,'CHANGES_PRESERVED');
    assert.equal(existsSync(join(registeredProjectRoot,'package.json')),true);
    assert.equal(existsSync(join(registeredProjectRoot,'native-bridge','antigravity-quota.mjs')),true);
    assert.equal(existsSync(join(registeredProjectRoot,'tests','antigravity-quota.test.mjs')),true,
      'escaped model output is preserved for reconciliation and never silently discarded');
  } finally { rmSync(home,{recursive:true,force:true}); }
});

test('captureScopedEditDiff captures the exact candidate root including tracked and untracked authorized files', async () => {
  const home=mkdtempSync(join(homedir(),'.ptysd-scoped-edit-diff-test-'));
  try {
    const workspace=join(home,'candidate'),stateDir=join(home,'state');
    mkdirSync(workspace); mkdirSync(stateDir);
    const git=(...args)=>{
      const result=spawnSync('git',['-C',workspace,...args],{encoding:'utf8',windowsHide:true});
      assert.equal(result.status,0,result.stderr); return result.stdout.trim();
    };
    git('init','--quiet');
    git('config','user.name','PTYSD test');
    git('config','user.email','test@example.invalid');
    writeFileSync(join(workspace,'package.json'),'{"name":"synthetic-candidate"}\n');
    git('add','package.json'); git('commit','--quiet','-m','candidate base');
    const sourceSha=git('rev-parse','HEAD');
    writeFileSync(join(workspace,'package.json'),'{"name":"synthetic-candidate","private":true}\n');
    mkdirSync(join(workspace,'native-bridge'),{recursive:true});
    mkdirSync(join(workspace,'tests'),{recursive:true});
    writeFileSync(join(workspace,'native-bridge','antigravity-quota.mjs'),
      'export const recovered = true;\n');
    writeFileSync(join(workspace,'tests','antigravity-quota.test.mjs'),
      "import test from 'node:test';\n");
    const editPaths=['package.json','native-bridge/antigravity-quota.mjs',
      'tests/antigravity-quota.test.mjs'];
    const captured=await captureScopedEditDiff({workspace,state_dir:stateDir,
      job:{kind:'antigravity_edit',request_id:'PTYSD_SYNTHETIC_ROOT_DIFF_20261023',
        source_sha:sourceSha,edit_paths:editPaths},attempt_id:randomUUID()});
    assert.equal(captured.scope_valid,true);
    assert.deepEqual(captured.changed_files,[...editPaths].sort());
    assert.ok(captured.bytes>0);
    const patch=readFileSync(join(stateDir,captured.file),'utf8');
    for (const path of editPaths) assert.ok(patch.includes(path),`patch must include ${path}`);
  } finally { rmSync(home,{recursive:true,force:true}); }
});

test('OpenCode missing provider auth is recoverable WAITING and never launches the model', async () => {
  const root=mkdtempSync(join(homedir(),'.ptysd-v2-auth-wait-'));
  try {
    const workspace=join(root,'workspace'),stateDir=join(root,'state');
    mkdirSync(workspace); mkdirSync(stateDir);
    const requestId='PTYSD_OPEN_EDIT_AUTH_WAIT_20261017';
    const job={schema:4,project_id:PROJECT,host:hostname().toUpperCase(),request_id:requestId,
      kind:'opencode_edit',source_sha:commit,spec_path:'native-bridge/tasks/auth-wait.md',
      spec_sha256:hash,model:'opencode/spark',variant:'high',edit_paths:['README.md']};
    let modelLaunches=0;
    const result=await executeOpenCodeTask('Synthetic auth gate; no model use.',
      {workspace,state_dir:stateDir,enable_v2_model_runs:true,
        allowed_models:{'opencode/spark':['high']}},job,'00000000-0000-4000-8000-000000000021',{
        qualifyOpenCodeV2:()=>({ready:true,bin:'fake-opencode-v2.exe',version:'2.0.27'}),
        readV2ProviderAuth:()=>({status:'AUTH_PROVIDER_RECORD_ABSENT'}),
        runCapturedProcess:async()=>{modelLaunches++;throw new Error('MODEL_LAUNCH_FORBIDDEN_IN_TEST');},
      });
    assert.equal(modelLaunches,0);
    assert.equal(result.outcome,'OPENCODE_V2_AUTH_NOT_READY');
    assert.equal(result.eligibility_state,'WAITING');
    assert.equal(result.model_invoked,false);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('free model catalog entry alone never bypasses missing OpenCode provider authentication', async () => {
  const root=mkdtempSync(join(homedir(),'.ptysd-v2-free-model-auth-gate-'));
  const workspace=join(root,'workspace'),stateDir=join(root,'state');
  const model='opencode/deepseek-v4.1-flash-free';
  mkdirSync(workspace); mkdirSync(stateDir);
  const base={workspace,state_dir:stateDir,enable_v2_model_runs:true,
    allowed_models:{[model]:[null]}};
  let launches=0;
  try {
    const result=await executeOpenCodeTask('No model call in this test.',base,{
      schema:2,kind:'opencode_plan',request_id:'PTYSD_FREE_MODEL_NOAUTH_DENY_20261018',model,variant:null,
      host:hostname().toUpperCase()},'00000000-0000-4000-8000-000000000041',{
      qualifyOpenCodeV2:()=>({ready:true,bin:'qualified-opencode-v2'}),
      readV2ProviderAuth:()=>({status:'AUTH_PROVIDER_RECORD_ABSENT'}),
      runCapturedProcess(){launches++;throw new Error('MODEL_CALL_FORBIDDEN_WITHOUT_PROVIDER_AUTH');},
    });
    assert.equal(launches,0);
    assert.equal(result.outcome,'OPENCODE_V2_AUTH_NOT_READY');
    assert.equal(result.eligibility_state,'WAITING');
    assert.equal(result.model_invoked,false);
  } finally {rmSync(root,{recursive:true,force:true});}
});
test('runPlan rejects a no-auth allowlist entry for a different free model', async () => {
  const root=mkdtempSync(join(homedir(),'.ptysd-v2-free-model-approved-'));
  const workspace=join(root,'workspace'),stateDir=join(root,'state');
  const model='opencode/deepseek-v4.1-flash-free';
  mkdirSync(workspace); mkdirSync(stateDir);
  const job={schema:2,kind:'opencode_plan',request_id:'PTYSD_FREE_MODEL_WRONG_ALLOWLIST_TEST_20261022',
    model,variant:null,host:hostname().toUpperCase()};
  const config={workspace,state_dir:stateDir,enable_v2_model_runs:true,
    allowed_models:{[model]:[null]},unauthenticated_free_models:['opencode/another-free-model']};
  let launches=0;
  try {
    const result=await executeOpenCodeTask('Synthetic bounded free-model route check.',config,job,
      '00000000-0000-4000-8000-000000000042',{
        qualifyOpenCodeV2:()=>({ready:true,bin:'qualified-opencode-v2'}),
        readV2ProviderAuth:()=>({status:'AUTH_PROVIDER_RECORD_ABSENT'}),
        runCapturedProcess:async()=>{
          launches++;
          throw new Error('MODEL_MUST_NOT_LAUNCH_WITH_WRONG_FREE_MODEL_ALLOWLIST');
        },
      });
    assert.equal(launches,0,'legacy no-auth configuration must not authorize a model call');
    assert.equal(result.outcome,'OPENCODE_V2_AUTH_NOT_READY');
    assert.equal(result.eligibility_state,'WAITING');
    assert.equal(result.model_invoked,false);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('worker config accepts only no-auth free models already pinned in the OpenCode allowlist', () => {
  const root=mkdtempSync(join(homedir(),'.ptysd-v2-free-model-config-'));
  const workspace=join(root,'workspace'),stateDir=join(root,'state');
  const model='opencode/deepseek-v4.1-flash-free';
  mkdirSync(workspace); mkdirSync(stateDir);
  const config={repo:REPO,project_id:PROJECT,host:hostname().toUpperCase(),issue:407,
    dispatchers:['t14210184'],workspace,state_dir:stateDir,enable_v2_model_runs:true,
    allowed_models:{[model]:[null]},unauthenticated_free_models:[model]};
  try {
    assert.deepEqual(guardConfig({...config}).unauthenticated_free_models,[model]);
    assert.throws(() => guardConfig({...config,unauthenticated_free_models:['opencode/paid-model']}),
      /UNAUTHENTICATED_FREE_MODEL_ALLOWLIST_INVALID/);
    assert.throws(() => guardConfig({...config,unauthenticated_free_models:[model,model]}),
      /UNAUTHENTICATED_FREE_MODEL_ALLOWLIST_INVALID/);
    assert.throws(() => guardConfig({...config,unauthenticated_free_models:['openai/model']}),
      /UNAUTHENTICATED_FREE_MODEL_ALLOWLIST_INVALID/);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('legacy no-auth free-model allowlist cannot bypass unknown OpenCode auth metadata', async () => {
  const root=mkdtempSync(join(homedir(),'.ptysd-v2-free-model-auth-unknown-'));
  const workspace=join(root,'workspace'),stateDir=join(root,'state');
  const model='opencode/deepseek-v4.1-flash-free';
  mkdirSync(workspace); mkdirSync(stateDir);
  const job={schema:2,kind:'opencode_plan',request_id:'PTYSD_FREE_MODEL_AUTH_UNKNOWN_20261019',
    model,variant:null,host:hostname().toUpperCase()};
  const config={workspace,state_dir:stateDir,enable_v2_model_runs:true,
    allowed_models:{[model]:[null]},unauthenticated_free_models:[model]};
  let launches=0;
  try {
    const result=await executeOpenCodeTask('Unknown auth metadata must remain WAITING.',config,job,
      '00000000-0000-4000-8000-000000000043',{
        qualifyOpenCodeV2:()=>({ready:true,bin:'qualified-opencode-v2'}),
        readV2ProviderAuth:()=>({status:'AUTH_PROVIDER_METADATA_UNKNOWN'}),
        runCapturedProcess(){launches++;throw new Error('MODEL_LAUNCH_FORBIDDEN_WHEN_AUTH_IS_UNKNOWN');},
      });
    assert.equal(launches,0,'an allowlist cannot convert unknown auth evidence into a launch');
    assert.equal(result.outcome,'OPENCODE_V2_AUTH_METADATA_UNKNOWN');
    assert.equal(result.eligibility_state,'WAITING');
    assert.equal(result.model_invoked,false);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('OpenCode child keeps profile authentication but strips ambient credentials and runtime overrides', () => {
  const base={PATH:'C:\\Windows\\System32',USERPROFILE:'C:\\worker',
    APPDATA:'C:\\worker\\AppData\\Roaming',LOCALAPPDATA:'C:\\worker\\AppData\\Local',
    HOME:'C:\\untrusted-home',
    OPENCODE_API_KEY:'synthetic-provider-key',OPENAI_API_KEY:'synthetic-openai-key',
    ANTHROPIC_API_KEY:'synthetic-anthropic-key',GEMINI_API_KEY:'synthetic-gemini-key',
    GOOGLE_APPLICATION_CREDENTIALS:'synthetic-credential-path',AWS_ACCESS_KEY_ID:'synthetic-aws-key',
    GOOGLE_API_KEY:'synthetic-google-key',AWS_SECRET_ACCESS_KEY:'synthetic-aws-secret',
    AWS_SESSION_TOKEN:'synthetic-aws-session',AZURE_CLIENT_SECRET:'synthetic-azure-secret',
    CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE:'synthetic-gcp-credential-path',
    GITHUB_TOKEN:'synthetic-github-token',GH_TOKEN:'synthetic-gh-token',
    GH_ENTERPRISE_TOKEN:'synthetic-enterprise-token',OPENCODE_CONFIG_DIR:'unsafe-config-dir',
    OPENCODE_CONFIG_CONTENT:'unsafe override',OPENCODE_PERMISSION:'unsafe permissions',
    NODE_OPTIONS:'--require synthetic-hook',NODE_PATH:'C:\\untrusted-node-modules',
    CUSTOM_PRIVATE_ENV:'must-not-pass'};
  const child=buildOpenCodeChildEnv(base,'win32');
  assert.equal(child.PATH,base.PATH);
  assert.equal(child.USERPROFILE,base.USERPROFILE);
  assert.equal(child.APPDATA,base.APPDATA);
  assert.equal(child.LOCALAPPDATA,base.LOCALAPPDATA);
  assert.equal(child.HOME,base.USERPROFILE);
  for (const key of ['OPENCODE_API_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY','GEMINI_API_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS','GOOGLE_API_KEY','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN','AZURE_CLIENT_SECRET','CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',
    'GITHUB_TOKEN','GH_TOKEN','GH_ENTERPRISE_TOKEN','OPENCODE_CONFIG_DIR',
    'OPENCODE_CONFIG_CONTENT','OPENCODE_PERMISSION','NODE_OPTIONS','NODE_PATH','CUSTOM_PRIVATE_ENV'])
    assert.equal(child[key],undefined,`${key} cannot reach the model process`);
  assert.equal(child.OPENCODE_DISABLE_AUTOUPDATE,'true');
  assert.deepEqual(Object.keys(child).sort(),
    ['APPDATA','HOME','LOCALAPPDATA','OPENCODE_DISABLE_AUTOUPDATE','PATH','USERPROFILE'].sort());
});
test('Antigravity child keeps the signed-in profile, strips ambient secrets and disables auto-update', () => {
  const base={PATH:'C:\\Windows\\System32',USERPROFILE:'C:\\worker',
    APPDATA:'C:\\worker\\AppData\\Roaming',LOCALAPPDATA:'C:\\worker\\AppData\\Local',
    HOME:'C:\\untrusted-home',AGY_CLI_DISABLE_AUTO_UPDATE:'false',
    GEMINI_API_KEY:'synthetic-model-secret',OPENCODE_API_KEY:'synthetic-opencode-secret',
    GOOGLE_APPLICATION_CREDENTIALS:'synthetic-credential-path',GITHUB_TOKEN:'synthetic-publisher-token',
    AWS_ACCESS_KEY_ID:'synthetic-cloud-key',CUSTOM_PRIVATE_ENV:'must-not-pass'};
  const child=buildAntigravityChildEnvironment(base,'win32');
  for (const key of ['USERPROFILE','APPDATA','LOCALAPPDATA'])
    assert.equal(child[key],base[key],`${key} keeps the native CLI profile binding`);
  assert.equal(child.HOME,base.USERPROFILE,'HOME cannot redirect CLI config/keyring away from the task profile');
  for (const key of ['GEMINI_API_KEY','OPENCODE_API_KEY','GOOGLE_APPLICATION_CREDENTIALS','GITHUB_TOKEN',
    'AWS_ACCESS_KEY_ID','CUSTOM_PRIVATE_ENV'])
    assert.equal(child[key],undefined,`${key} must not reach the W2 process`);
  assert.equal(child.AGY_CLI_DISABLE_AUTO_UPDATE,'true');
  assert.equal(child.OPENCODE_DISABLE_AUTOUPDATE,undefined);
  assert.deepEqual(Object.keys(child).sort(),
    ['AGY_CLI_DISABLE_AUTO_UPDATE','APPDATA','HOME','LOCALAPPDATA','PATH','USERPROFILE'].sort());
});
test('native child environment preserves absolute POSIX HOME and pins Windows HOME to USERPROFILE', () => {
  const posix=buildNativeChildEnvironment({
    HOME:'/home/worker',PATH:'/usr/bin',OPENAI_API_KEY:'must-not-pass',
  },'linux');
  assert.equal(posix.HOME,'/home/worker');
  assert.equal(posix.PATH,'/usr/bin');
  assert.equal(posix.OPENAI_API_KEY,undefined);

  const windows=buildNativeChildEnvironment({
    HOME:'C:\\untrusted-home',USERPROFILE:'C:\\Users\\worker',PATH:'C:\\Windows\\System32',
  },'win32');
  assert.equal(windows.HOME,'C:\\Users\\worker');

  const windowsWithoutProfile=buildNativeChildEnvironment({
    HOME:'C:\\untrusted-home',PATH:'C:\\Windows\\System32',
  },'win32');
  assert.equal(windowsWithoutProfile.HOME,undefined,
    'an untrusted HOME cannot redirect profile auth when USERPROFILE is absent on Windows');
});
test('legacy free-model configuration cannot bypass unknown OpenCode provider authentication', async () => {
  const root=mkdtempSync(join(homedir(),'.ptysd-v2-free-model-deny-'));
  const workspace=join(root,'workspace'),stateDir=join(root,'state');
  mkdirSync(workspace); mkdirSync(stateDir);
  const model='opencode/deepseek-v4.1-flash-free';
  const job={schema:2,kind:'opencode_plan',request_id:'PTYSD_FREE_MODEL_DENY_20261018',
    model,variant:null,host:hostname().toUpperCase()};
  const base={workspace,state_dir:stateDir,enable_v2_model_runs:true,
    allowed_models:{[model]:[null]}};
  let launches=0;
  try {
    for (const [config,authStatus,expected] of [
      [base,'AUTH_PROVIDER_RECORD_ABSENT','OPENCODE_V2_AUTH_NOT_READY'],
      [{...base,unauthenticated_free_models:[model]},'AUTH_PROVIDER_METADATA_UNKNOWN',
        'OPENCODE_V2_AUTH_METADATA_UNKNOWN'],
    ]) {
      const result=await executeOpenCodeTask('No model call in this test.',config,job,
        randomUUID(),{
          qualifyOpenCodeV2:()=>({ready:true,bin:'qualified-opencode-v2'}),
          readV2ProviderAuth:()=>({status:authStatus}),
          runCapturedProcess:async()=>{launches++;throw new Error('MODEL_CALL_FORBIDDEN_IN_TEST');},
        });
      assert.equal(result.outcome,expected);
      assert.equal(result.eligibility_state,'WAITING');
      assert.equal(result.model_invoked,false);
    }
    assert.equal(launches,0);
  } finally {rmSync(root,{recursive:true,force:true});}
});
test('only allowlisted sender and host are eligible, completed/started jobs never rerun', () => {
  const a = encoded(mkjob());
  const state = [com(1,a,'outsider'), com(2,a)];
  assert.equal(selectNext(state, ['t14210184'], 'worker', 'DESKTOP-1B6PD2P').id, 2);
  assert.equal(selectNext(state, ['t14210184'], 'worker', 'OTHER-HOST'), null);
  const start = receipt(mkjob().request_id,'00000000-0000-0000-0000-000000000000','STARTED',mkjob());
  assert.ok(parseReceipt(RECEIPT_MARKER + JSON.stringify(start)));
  state.push(com(3,RECEIPT_MARKER+JSON.stringify(start),'worker'));
  assert.equal(selectNext(state,['t14210184'],'worker','DESKTOP-1B6PD2P'),null);
});
test('a recoverable WAITING receipt makes the same OpenCode task eligible for reevaluation', () => {
  const job = { ...mkjob({ request_id: 'PTYSD_OPENCODE_WAITING_REEVALUATE_20261018',
    kind: 'opencode_edit' }), schema: 4, spec_path: 'native-bridge/tasks/waiting.md',
    spec_sha256: hash, model: 'opencode/spark', variant: 'high', edit_paths: ['src/worker.mjs'] };
  const attemptId = '11111111-1111-4111-8111-111111111111';
  const started = receipt(job.request_id, attemptId, 'STARTED', job);
  const waiting = receipt(job.request_id, attemptId, 'WAITING', job, {
    outcome: 'OPENCODE_V2_AUTH_NOT_READY', exit_code: 48,
    evidence_sha256: null, evidence_bytes: 0,
  });
  const comments = [com(1, encoded(job)), com(2, RECEIPT_MARKER + JSON.stringify(started), 'worker'),
    com(3, RECEIPT_MARKER + JSON.stringify(waiting), 'worker')];

  assert.equal(parseReceipt(comments[2].body)?.state, 'WAITING');
  assert.equal(parseReceipt(RECEIPT_MARKER + JSON.stringify({ ...waiting,
    outcome: 'UNCLASSIFIED_WAITING_REASON' })), null,
  'only an explicit no-model recoverable preflight result may be recorded as WAITING');
  assert.equal(parseReceipt(RECEIPT_MARKER + JSON.stringify(receipt(job.request_id, attemptId,
    'WAITING', mkjob({ request_id: job.request_id, host: job.host })))), null,
  'WAITING is only valid for recoverable OpenCode execution attempts');
  assert.equal(selectNext(comments, ['t14210184'], 'worker', job.host, job.source_sha)?.id, 1,
    'WAITING closes the no-effect attempt without making the task terminal');
  assert.equal(selectNext(comments.slice(0, 2), ['t14210184'], 'worker', job.host, job.source_sha), null,
    'STARTED with no verified follow-up remains protected from replay');
  comments.push(com(4, RECEIPT_MARKER + JSON.stringify({ ...waiting, state: 'BLOCKED',
    outcome: 'MODEL_RUN_FAILED' }), 'worker'));
  assert.equal(selectNext(comments, ['t14210184'], 'worker', job.host, job.source_sha), null,
    'a true terminal attempt remains non-replayable');
});
test('publisher records executor WAITING, continues a ping, then re-dispatches the same task after readiness', async () => {
  const root = mkdtempSync(join(homedir(), '.ptysd-opencode-waiting-reconcile-'));
  try {
    const workspace = join(root, 'workspace'), stateDir = join(root, 'state');
    const manifestDir = join(root, 'manifests'), resultsDir = join(root, 'results');
    for (const path of [workspace, stateDir, manifestDir, resultsDir]) mkdirSync(path);
    mkdirSync(join(workspace, 'src'));
    writeFileSync(join(workspace, 'src', 'worker.mjs'), 'export const value = 1;\n');
    const host = hostname().toUpperCase();
    const requestId = 'PTYSD_OPENCODE_WAITING_RESULT_20261018';
    const attemptId = '22222222-2222-4222-8222-222222222222';
    const spec = '# Synthetic preflight only; model execution is forbidden.\n';
    const editJob = { schema: 4, project_id: PROJECT, host, request_id: requestId,
      kind: 'opencode_edit', source_sha: commit, spec_path: 'native-bridge/tasks/waiting.md',
      spec_sha256: h(spec), model: 'opencode/spark', variant: 'high', edit_paths: ['src/worker.mjs'] };
    const sourceComment = com(9701, encoded(editJob));
    const started = receipt(requestId, attemptId, 'STARTED', editJob);
    const pingJob = mkjob({ host, request_id: 'PTYSD_PING_AFTER_WAITING_RESULT_20261018' });
    const comments = [sourceComment, com(9702, RECEIPT_MARKER + JSON.stringify(started), 'worker'),
      com(9703, encoded(pingJob))];
    const executor = { task_name: '\\PTYSD\\OpenCodeExecutor',
      user_sid: 'S-1-5-21-100-200-300-1001', publisher_sid: 'S-1-5-21-100-200-300-1002',
      wscript_path: 'C:\\Windows\\System32\\wscript.exe',
      launcher_path: 'C:\\PTYSD\\HiddenCodexExecutor.vbs', node_bin: 'C:\\Node\\node.exe',
      script_path: 'C:\\PTYSD\\executor.mjs', config_path: 'C:\\PTYSD\\executor.json',
      manifest_dir: manifestDir, results_dir: resultsDir, working_directory: workspace,
      source_bundle_per_attempt: true };
    const config = { repo: REPO, project_id: PROJECT, host, issue: 101, workspace, state_dir: stateDir,
      dispatchers: ['t14210184'], enable_v2_model_runs: true,
      allowed_models: { 'opencode/spark': ['high'] }, executor };
    const writes = [], logs = [];
    let nextId = 9704, dispatches = 0, inlineModelCalls = 0, failWaitingPublication = true;
    const resultPath = join(resultsDir, `result-${requestId}-${attemptId}.json`);
    const waiting = receipt(requestId, attemptId, 'WAITING', editJob, {
      outcome: 'OPENCODE_V2_AUTH_NOT_READY', exit_code: 48,
      evidence_sha256: null, evidence_bytes: 0, model_invoked: false,
    });
    writeFileSync(resultPath, JSON.stringify({ request_id: requestId, attempt_id: attemptId,
      terminal: waiting, local_evidence: null }), { flag: 'wx' });
    const adapters = {
      apiRead(uri) {
        if (uri === 'user') return { login: 'worker' };
        if (uri === `repos/${REPO}/issues/101`) return { title: ISSUE_TITLE, state: 'open' };
        if (uri === `repos/${REPO}/git/ref/heads/main`) return { object: { sha: commit } };
        if (uri.startsWith(`repos/${REPO}/contents/${editJob.spec_path}?ref=`))
          return { encoding: 'base64', content: Buffer.from(spec).toString('base64') };
        const match = uri.match(/\/issues\/comments\/(\d+)$/);
        if (match) return comments.find(item => item.id === Number(match[1]));
        throw new Error(`UNEXPECTED_WAITING_API_READ:${uri}`);
      },
      commentsRead: () => comments,
      executorResultsDir: () => resultsDir,
      executorResultPath: (_dir, request, attempt) => join(resultsDir, `result-${request}-${attempt}.json`),
      assertExecutorTaskReady: () => ({ ready: true, source_bundle_per_attempt: true }),
      createExecutorSourceBundle: ({ job, attemptId: nextAttemptId }) => ({
        attempt_id: nextAttemptId, source_sha: job.source_sha, sha256: 'd'.repeat(64),
      }),
      writeReceipt(_config, data, login) {
        if (data.request_id === requestId && data.state === 'WAITING' && failWaitingPublication) {
          failWaitingPublication = false;
          throw new Error('MOCK_WAITING_RECEIPT_READBACK_UNKNOWN');
        }
        writes.push(data);
        comments.push(com(nextId++, RECEIPT_MARKER + JSON.stringify(data), login));
      },
      dispatchToExecutor() { dispatches++; return { outcome: 'EXECUTOR_REQUESTED_NOT_ACCEPTANCE' }; },
      runPlan() { inlineModelCalls++; throw new Error('MODEL_EXECUTION_FORBIDDEN_IN_TEST'); },
      observationDependencies: { collectWindowsObservation: () => ({ status: 'UNKNOWN' }) },
      log: value => logs.push(value),
    };

    const recovered = await executeWorker(config, adapters);
    assert.equal(recovered.request_id, pingJob.request_id,
      'WAITING reconciliation cannot starve independent zero-token work');
    assert.equal(writes.some(item => item.request_id === requestId && item.state === 'WAITING'), false);
    assert.equal(dispatches, 0);
    assert.equal(inlineModelCalls, 0);
    assert.ok(logs.some(value => value.startsWith(`LOCAL_RESULT_RECEIPT_PUBLISH_UNKNOWN_${requestId}_`)));
    assert.ok(existsSync(resultPath), 'unknown GitHub receipt outcome preserves exact local evidence');

    const published = await executeWorker(config, adapters);
    assert.equal(published.state, 'NO_DELTA',
      'the no-effect attempt is acknowledged before it can be reevaluated');
    assert.equal(writes.filter(item => item.request_id === requestId && item.state === 'WAITING').length, 1);
    assert.ok(logs.includes(`RECOVERED_EXECUTOR_RESULT_WAITING_${requestId}`));

    const retried = await executeWorker(config, adapters);
    assert.equal(retried.state, 'DISPATCHED');
    assert.equal(retried.request_id, requestId,
      'the same immutable task is re-evaluated after its previous attempt is durably WAITING');
    assert.notEqual(retried.attempt_id, attemptId);
    assert.equal(dispatches, 1);
    assert.equal(inlineModelCalls, 0);
    assert.deepEqual(writes.filter(item => item.request_id === requestId).map(item => item.state),
      ['WAITING', 'STARTED']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('stale unsigned job does not starve newer exact-main job', () => {
  const first=mkjob({request_id:'PTYSD_NATIVE_OLD_20261012',source_sha:'a'.repeat(40)});
  const second=mkjob({request_id:'PTYSD_NATIVE_NEW_20261012',source_sha:'c'.repeat(40)});
  const s=[com(1,encoded(first)),com(2,encoded(second))];
  assert.equal(selectNext(s,['t14210184'],'worker','DESKTOP-1B6PD2P','c'.repeat(40)).id,2);
});
test('corrupt per-attempt result is isolated and does not starve an independent ping', async () => {
  const home=mkdtempSync(join(homedir(),'.ptysd-native-reconcile-'));
  try {
    const workspace=join(home,'workspace'),stateDir=join(home,'state');
    mkdirSync(workspace); mkdirSync(stateDir);
    const attemptId='11111111-1111-4111-8111-111111111111';
    const requestId='PTYSD_NATIVE_CORRUPT_PLAN_20261015';
    const plan={...mkjob({host:hostname().toUpperCase(),request_id:requestId,kind:'opencode_plan',
      spec_path:'native-bridge/tasks/legacy-plan-recovery-test.md',spec_sha256:hash}),
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
        publisher_sid:'S-1-5-21-100-200-300-1002',
        wscript_path:'C:\\Windows\\System32\\wscript.exe',
        launcher_path:'C:\\PTYSD\\HiddenCodexExecutor.vbs',node_bin:'C:\\Node\\node.exe',
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
test('duplicate changed dispatch same request ID is blocked', () => {
  const a = encoded(mkjob()), b = encoded(mkjob({ source_sha: 'c'.repeat(40) }));
  assert.equal(selectNext([com(1,a),com(2,b)],['t14210184'],'worker','DESKTOP-1B6PD2P'),null);
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
    writeFileSync(fakeGh, `#!/usr/bin/env node\nconst fs=require('fs');const a=process.argv.slice(2);const p=process.env.MOCK_GH_STATE;const x=JSON.parse(fs.readFileSync(p,'utf8'));if(a[0]==='api'){if(a[1]==='user')console.log(JSON.stringify({login:x.user}));else if(a[1].includes('/git/ref/heads/main'))console.log(JSON.stringify({object:{sha:x.main}}));else if(a[1].includes('/issues/310/comments'))console.log(JSON.stringify([]));else if(a[1].includes('/issues/comments/')){console.log(JSON.stringify(x.comments.find(c=>c.id===Number(a[1].split('/').pop()))));}else if(a[1].includes('/issues/101/comments'))console.log(JSON.stringify([x.comments]));else if(a[1].endsWith('/issues/101'))console.log(JSON.stringify({title:'[PTYSD-NATIVE] OpenCode dispatch and receipts',state:'open'}));else if(a[1].includes('/contents/'))console.log(JSON.stringify({encoding:'base64',content:Buffer.from(x.spec).toString('base64')}));else process.exit(20);}else if(a[0]==='issue'&&a[1]==='comment'){const fn=a[a.indexOf('--body-file')+1];x.comments.push({id:x.next++,body:fs.readFileSync(fn,'utf8'),user:{login:x.user}});fs.writeFileSync(p,JSON.stringify(x));console.log('posted');}else process.exit(21);\n`);
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
    // A legacy read-only plan stays parseable for history but cannot start a new CLI attempt.
    const plan='review README only';
    m.spec=plan;
    const planJob={...mkjob({ host:hostname().toUpperCase(),request_id:'PTYSD_NATIVE_PLAN_20261012',
      kind:'opencode_plan',spec_path:'native-bridge/tasks/legacy-readonly-plan-test.md',spec_sha256:h(plan)}),schema:2,model:'opencode/spark',variant:'high'};
    m.comments.push(com(m.next++,encoded(planJob))); writeFileSync(mock,JSON.stringify(m));
    const planRun=spawnSync(process.execPath,[path,'--config',config],{cwd:resolve('.'),env,encoding:'utf8',timeout:15000});
    assert.equal(planRun.status,0,planRun.stderr);
    assert.match(planRun.stdout,/NO_DELTA_NO_LLM/);
    const m2=JSON.parse(readFileSync(mock,'utf8'));
    assert.equal(m2.comments.length,m.comments.length,'a legacy plan receives no new receipt');
    assert.equal(readdirSync(work).includes('opencode.json'),false,'the retired plan path never starts OpenCode');
    // A prior STARTED plan remains historical evidence; independent native probes continue.
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
const fs=require('fs');const a=process.argv.slice(2);const p=process.env.MOCK_GH_STATE;const x=JSON.parse(fs.readFileSync(p,'utf8'));if(a[0]==='api'){if(a[1]==='user')console.log(JSON.stringify({login:x.user}));else if(a[1].includes('/git/ref/heads/main'))console.log(JSON.stringify({object:{sha:x.main}}));else if(a[1].includes('/issues/310/comments'))console.log(JSON.stringify([]));else if(a[1].includes('/issues/comments/'))console.log(JSON.stringify(x.comments.find(c=>c.id===Number(a[1].split('/').pop()))));else if(a[1].includes('/issues/101/comments'))console.log(JSON.stringify([x.comments]));else if(a[1].endsWith('/issues/101'))console.log(JSON.stringify({title:'[PTYSD-NATIVE] OpenCode dispatch and receipts',state:'open'}));else process.exit(20);}else if(a[0]==='issue'&&a[1]==='comment'){x.comments.push({id:x.next++,body:fs.readFileSync(a[a.indexOf('--body-file')+1],'utf8'),user:{login:x.user}});fs.writeFileSync(p,JSON.stringify(x));}else process.exit(21);
`);
    chmodSync(fakeGh,0o755);
    const config=join(home,'config.json');
    writeFileSync(config,JSON.stringify({repo:REPO,project_id:PROJECT,host:hostname().toUpperCase(),issue:101,workspace:work,state_dir:state,dispatchers:['t14210184']}));
    const runner=resolve('native-bridge/worker.mjs');
    const env={...process.env,PATH:`${bin}:${process.env.PATH}`,MOCK_GH_STATE:mock,
      LOCALAPPDATA:join(home,'LOCALAPPDATA')};
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
      'else if(a[1].includes("/git/ref/heads/main"))console.log(JSON.stringify({object:{sha:x.main}}));else if(a[1].includes("/issues/310/comments"))console.log(JSON.stringify([]));',
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
      codex_sandbox_boundary: 'VERIFIED_EXACT_PATH_PERMISSION_PROFILE',
      publisher_identity_sid: 'S-1-5-21-1000', executor_identity_sid: 'S-1-5-21-2000',
      codex_executor_task: 'PTYSD-Codex-Executor',
      codex_executor_task_user: 'DESKTOP-1B6PD2P\\PTYSDCODEXEXEC',
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
    assert.equal(guarded.state, 'WAITING_ELIGIBILITY');
    assert.equal(guarded.reason, 'CODEX_EXECUTOR_SPOOL_OR_OWNER_NOT_READY');
    assert.ok(lockLogs.includes(
      'CODEX_LANE_WAITING_ELIGIBILITY_CODEX_EXECUTOR_SPOOL_OR_OWNER_NOT_READY'), lockLogs.join('\n'));
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
      codex_sandbox_boundary: 'VERIFIED_EXACT_PATH_PERMISSION_PROFILE',
      publisher_identity_sid: 'S-1-5-21-1000', executor_identity_sid: 'S-1-5-21-2000',
      codex_executor_task: 'PTYSD-Codex-Executor',
      codex_executor_task_user: 'DESKTOP-1B6PD2P\\PTYSDCODEXEXEC',
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
    assert.ok(logs.some(value => value.includes(
      'CODEX_LANE_WAITING_ELIGIBILITY_CODEX_EXECUTOR_TASK_READBACK_CODEX_EXECUTOR_TASK_DISABLED')));
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
    for (const name of ['requests', 'bundles', 'claims', 'locks', 'results'])
      mkdirSync(join(spoolDir, name), { recursive: true });
    const host = hostname().toUpperCase();
    const attemptId = '11111111-1111-4111-8111-111111111112';
    const spec = '# Codex exact scope review\n';
    const bundlePath = join(spoolDir, 'bundles', 'source.bundle');
    const bundleBytes = Buffer.from('immutable review source');
    writeFileSync(bundlePath, bundleBytes);
    const codexJob = { schema: 3, project_id: PROJECT, host,
      request_id: 'PTYSD_CODEX_RECOVERED_20261015', kind: 'codex_plan',
      source_sha: commit, spec_path: 'native-bridge/tasks/codex-review.md',
      spec_sha256: h(spec), model: 'gpt-6.1-sol', reasoning_effort: 'medium',
      write_paths: ['native-bridge/sample.mjs'] };
    const request = makeCodexExecutorRequest(codexJob, attemptId, spec, bundlePath, h(bundleBytes));
    writeFileSync(join(spoolDir, 'requests', `${codexJob.request_id}-${attemptId}.json`),
      JSON.stringify(request));
    const started = { ...receipt(codexJob.request_id, attemptId, 'STARTED', codexJob),
      task_fingerprint: request.fingerprint };
    const pingJob = mkjob({ host, request_id: 'PTYSD_PING_AFTER_CODEX_RECOVERY_20261015' });
    const comments = [com(9201, encoded(codexJob)),
      com(9202, RECEIPT_MARKER + JSON.stringify(started), 'worker'),
      com(9203, encoded(pingJob))];
    const config = { repo: REPO, project_id: PROJECT, host, issue: 407,
      workspace, state_dir: stateDir, codex_spool: spoolDir,
      dispatchers: ['t14210184'] };
    const resultBytes = JSON.stringify({ schema: 1, kind: 'codex_plan',
      request_id: codexJob.request_id, attempt_id: attemptId, source_sha: commit,
      fingerprint: request.fingerprint, exit_code: 0, outcome: 'CODEX_CLI_EXIT_0_UNVERIFIED',
      session_id: 'session_12345678', diff_sha256: null,
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

test('recovered OpenCode terminal continues to an independent ping in the same dispatcher tick', async () => {
  const root = mkdtempSync(join(homedir(), '.ptysd-opencode-recovered-independent-'));
  try {
    const workspace = join(root, 'workspace');
    const stateDir = join(root, 'state');
    mkdirSync(workspace); mkdirSync(stateDir);
    const host = hostname().toUpperCase();
    const requestId = 'PTYSD_OPENCODE_RECOVERED_20261016';
    const attemptId = '22222222-2222-4222-8222-222222222222';
    const opencodeJob = { ...mkjob({ host, request_id: requestId,
      kind: 'opencode_plan', spec_path: 'native-bridge/tasks/recovery-test.md',
      spec_sha256: hash }), schema: 2, model: 'opencode/spark', variant: 'high' };
    const started = receipt(requestId, attemptId, 'STARTED', opencodeJob);
    const pingJob = mkjob({ host, request_id: 'PTYSD_PING_AFTER_OPENCODE_RECOVERY_20261016' });
    const comments = [com(9301, encoded(opencodeJob)),
      com(9302, RECEIPT_MARKER + JSON.stringify(started), 'worker'),
      com(9303, encoded(pingJob))];
    const terminal = receipt(requestId, attemptId, 'FINISHED', opencodeJob,
      { outcome: 'OPENCODE_V2_EXIT_0_UNTRUSTED', exit_code: 0,
        evidence_sha256: null, evidence_bytes: 0 });
    writeFileSync(join(stateDir, `result-${requestId}-${attemptId}.json`), JSON.stringify({
      request_id: requestId, attempt_id: attemptId, terminal, local_evidence: null,
    }));
    const writes = [];
    let nextId = 9304;
    const result = await executeWorker({ repo: REPO, project_id: PROJECT, host, issue: 407,
      workspace, state_dir: stateDir, dispatchers: ['t14210184'] }, {
      apiRead(uri) {
        if (uri === 'user') return { login: 'worker' };
        if (uri === `repos/${REPO}/issues/407`) return { title: ISSUE_TITLE, state: 'open' };
        if (uri === `repos/${REPO}/git/ref/heads/main`) return { object: { sha: commit } };
        const match = uri.match(/\/issues\/comments\/(\d+)$/);
        if (match) return comments.find(item => item.id === Number(match[1]));
        throw new Error(`UNEXPECTED_MOCK_API_ROUTE:${uri}`);
      },
      commentsRead: () => comments,
      writeReceipt(_config, data, login) {
        writes.push(data);
        comments.push(com(nextId++, RECEIPT_MARKER + JSON.stringify(data), login));
      },
      runPlan: () => { throw new Error('INDEPENDENT_PING_MUST_NOT_INVOKE_A_MODEL'); },
    });
    assert.equal(result.request_id, pingJob.request_id);
    assert.deepEqual(writes.map(item => [item.kind, item.state]), [
      ['opencode_plan', 'FINISHED'], ['ping', 'STARTED'], ['ping', 'FINISHED'],
    ]);
    assert.equal(comments.filter(item => parseReceipt(item.body)?.request_id === requestId).length, 2,
      'recovery adds one terminal receipt and does not replay the OpenCode attempt');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('STARTED OpenCode edit retries only its exact pending attempt and continues an independent ping', async () => {
  const scenarios = [
    { label: 'EXACT', sourceChanged: false },
    { label: 'CHANGED', sourceChanged: true },
    { label: 'ERROR_MESSAGE', sourceChanged: false,
      triggerError: 'provider failure bearer ghp_SYNTHETIC_NOT_A_REAL_CREDENTIAL_DO_NOT_LOG',
      triggerCode: 'GH_TOKEN_SYNTHETIC_NOT_A_REAL_CREDENTIAL_DO_NOT_LOG' },
  ];
  for (const scenario of scenarios) {
    const { sourceChanged } = scenario;
    const root = mkdtempSync(join(homedir(), '.ptysd-opencode-pending-retry-'));
    try {
      const workspace = join(root, 'workspace');
      const stateDir = join(root, 'state');
      const manifestDir = join(root, 'manifests');
      const resultsDir = join(root, 'results');
      for (const path of [workspace, stateDir, manifestDir, resultsDir]) mkdirSync(path);
      const host = hostname().toUpperCase();
      const requestId = `PTYSD_OPENCODE_PENDING_RETRY_${scenario.label}_20261017`;
      const attemptId = sourceChanged
        ? '33333333-3333-4333-8333-333333333333'
        : '44444444-4444-4444-8444-444444444444';
      const editJob = { schema: 4, project_id: PROJECT, host, request_id: requestId,
        kind: 'opencode_edit', source_sha: commit,
        spec_path: 'native-bridge/tasks/pending-retry.md', spec_sha256: hash,
        model: 'opencode/spark', variant: 'high', edit_paths: ['src/worker.mjs'] };
      const sourceComment = com(9911, encoded(editJob));
      const started = receipt(requestId, attemptId, 'STARTED', editJob);
      const pingJob = mkjob({ host,
        request_id: `PTYSD_PING_AFTER_PENDING_RETRY_${sourceChanged ? 'CHANGED' : 'EXACT'}_20261017` });
      const comments = [sourceComment,
        com(9912, RECEIPT_MARKER + JSON.stringify(started), 'worker'),
        com(9913, encoded(pingJob))];
      const executor = { task_name: '\\PTYSD\\OpenCodeExecutor',
        user_sid: 'S-1-5-21-100-200-300-1001', publisher_sid: 'S-1-5-21-100-200-300-1002',
        wscript_path: 'C:\\Windows\\System32\\wscript.exe',
        launcher_path: 'C:\\PTYSD\\HiddenCodexExecutor.vbs',
        node_bin: 'C:\\Node\\node.exe', script_path: 'C:\\PTYSD\\executor.mjs',
        config_path: 'C:\\PTYSD\\executor.json', manifest_dir: manifestDir,
        results_dir: resultsDir, working_directory: workspace, source_bundle_per_attempt: true };
      const config = { repo: REPO, project_id: PROJECT, host, issue: 407,
        workspace, state_dir: stateDir, dispatchers: ['t14210184'], executor };
      const writes = [], logs = [];
      let triggerCalls = 0, nextId = 9920, modelCalls = 0;
      const result = await executeWorker(config, {
        apiRead(uri) {
          if (uri === 'user') return { login: 'worker' };
          if (uri === `repos/${REPO}/issues/407`) return { title: ISSUE_TITLE, state: 'open' };
          if (uri === `repos/${REPO}/git/ref/heads/main`) return { object: { sha: commit } };
          const match = uri.match(/\/issues\/comments\/(\d+)$/);
          if (match) {
            const comment = comments.find(item => item.id === Number(match[1]));
            if (Number(match[1]) === sourceComment.id && sourceChanged)
              return { ...comment, body: `${comment.body}\\nchanged after discovery` };
            return comment;
          }
          throw new Error(`UNEXPECTED_MOCK_API_ROUTE:${uri}`);
        },
        commentsRead: () => comments,
        triggerPendingExecutorAttempt(descriptor, actualAttemptId, { expectedJob }) {
          triggerCalls++;
          assert.equal(descriptor, executor);
          assert.equal(actualAttemptId, attemptId);
          assert.deepEqual(expectedJob, editJob);
          if (scenario.triggerError) {
            const error = new Error(scenario.triggerError);
            error.code = scenario.triggerCode;
            throw error;
          }
          return { outcome: 'EXECUTOR_PENDING_ATTEMPT_TRIGGERED_NOT_ACCEPTANCE',
            exit_code: 0, attempt_id: actualAttemptId };
        },
        writeReceipt(_config, data, login) {
          writes.push(data);
          comments.push(com(nextId++, RECEIPT_MARKER + JSON.stringify(data), login));
        },
        runPlan: () => { modelCalls++; throw new Error('PING_OR_RECOVERY_MUST_NOT_INVOKE_MODEL'); },
        observationDependencies: { collectWindowsObservation: () => ({ status: 'UNKNOWN' }) },
        log: value => logs.push(value),
      });

      assert.equal(result.request_id, pingJob.request_id,
        'recovery of an OpenCode attempt cannot starve an independent ping');
      assert.equal(modelCalls, 0);
      assert.equal(triggerCalls, sourceChanged ? 0 : 1,
        'only a same-source, unmodified task comment can retrigger the pending attempt');
      assert.equal(comments.map(item => parseReceipt(item.body))
        .filter(item => item?.request_id === requestId).length, 1,
      'recovery never writes a duplicate STARTED or terminal receipt');
      assert.deepEqual(writes.map(item => [item.kind, item.state]), [
        ['ping', 'STARTED'], ['ping', 'FINISHED'],
      ]);
      if (scenario.triggerError)
        assert.ok(!/ghp_SYNTHETIC_NOT_A_REAL|GH_TOKEN_SYNTHETIC/.test(logs.join('\n')),
          'provider error messages and untrusted error codes must never enter durable worker logs');
      assert.ok(logs.includes(sourceChanged
        ? `PENDING_EXECUTOR_SOURCE_CHANGED_${requestId}_NO_REPLAY`
        : scenario.triggerError
          ? `PENDING_EXECUTOR_RETRIGGER_NOT_CONFIRMED_${requestId}_UNKNOWN_NO_REPLAY`
          : `PENDING_EXECUTOR_RETRIGGERED_${requestId}_${attemptId}_NO_NEW_RECEIPT`));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('legacy read-only OpenCode plans stay historical-only while pings continue', async () => {
  const root = mkdtempSync(join(homedir(), '.ptysd-opencode-eligibility-wait-'));
  try {
    const workspace = join(root, 'workspace');
    const stateDir = join(root, 'state');
    mkdirSync(workspace); mkdirSync(stateDir);
    const host = hostname().toUpperCase();
    const requestId = 'PTYSD_OPENCODE_WAITING_ELIGIBILITY_20261016';
    const spec = '# Synthetic eligibility test; model execution is forbidden.\n';
    const opencodeJob = { ...mkjob({ host, request_id: requestId,
      kind: 'opencode_plan', spec_path: 'native-bridge/tasks/eligibility-test.md',
      spec_sha256: h(spec) }), schema: 2, model: 'opencode/spark', variant: 'high' };
    const pingJob = mkjob({ host, request_id: 'PTYSD_PING_DURING_OPENCODE_WAIT_20261016' });
    const comments = [com(9401, encoded(opencodeJob)), com(9402, encoded(pingJob))];
    const writes = [];
    const logs = [];
    const executor = { task_name: '\\PTYSD\\OpenCodeExecutor',
      user_sid: 'S-1-5-21-100-200-300-1001', publisher_sid: 'S-1-5-21-100-200-300-1002',
      wscript_path: 'C:\\Windows\\System32\\wscript.exe',
      launcher_path: 'C:\\PTYSD\\HiddenCodexExecutor.vbs',
      node_bin: 'C:\\Node\\node.exe', script_path: 'C:\\PTYSD\\executor.mjs',
      config_path: 'C:\\PTYSD\\executor.json', manifest_dir: 'C:\\PTYSD\\manifests',
      results_dir: 'C:\\PTYSD\\results', working_directory: 'C:\\PTYSD' };
    const config = { repo: REPO, project_id: PROJECT, host, issue: 407,
      workspace, state_dir: stateDir, dispatchers: ['t14210184'] };
    let modelCalls = 0;
    let executorDispatches = 0;
    const adapters = {
      apiRead(uri) {
        if (uri === 'user') return { login: 'worker' };
        if (uri === `repos/${REPO}/issues/407`) return { title: ISSUE_TITLE, state: 'open' };
        if (uri === `repos/${REPO}/git/ref/heads/main`) return { object: { sha: commit } };
        if (uri.startsWith(`repos/${REPO}/contents/${opencodeJob.spec_path}?ref=`))
          return { encoding: 'base64', content: Buffer.from(spec).toString('base64') };
        const match = uri.match(/\/issues\/comments\/(\d+)$/);
        if (match) return comments.find(item => item.id === Number(match[1]));
        throw new Error(`UNEXPECTED_MOCK_API_ROUTE:${uri}`);
      },
      commentsRead: () => comments,
      writeReceipt(_config, data, login) {
        writes.push(data);
        comments.push(com(9403 + writes.length, RECEIPT_MARKER + JSON.stringify(data), login));
      },
      assertExecutorTaskReady: () => ({ ready: true }),
      dispatchToExecutor: () => { executorDispatches++; return { outcome: 'EXECUTOR_REQUESTED' }; },
      runPlan: async () => {
        modelCalls++;
        return { outcome: 'V2_MODEL_EXECUTION_NOT_YET_APPROVED', exit_code: 44,
          evidence_sha256: null, evidence_bytes: 0 };
      },
      log: value => logs.push(value),
    };

    const first = await executeWorker(config, adapters);
    assert.equal(first.request_id, pingJob.request_id,
      'an ineligible OpenCode task must not starve independent ping work');
    assert.equal(parseReceipt(comments.find(item => parseReceipt(item.body)?.request_id === requestId)?.body), null,
      'missing model authorization must not publish STARTED or terminal BLOCKED');
    assert.equal(logs.some(value => value.includes('OPENCODE_LANE_WAITING_ELIGIBILITY')), false,
      'historical read-only plans are not waiting executable work');
    assert.deepEqual(writes.map(item => item.kind), ['ping', 'ping']);

    Object.assign(config, { enable_v2_model_runs: true,
      allowed_models: { 'opencode/spark': ['high'] }, executor });
    const secondPingJob = mkjob({ host, request_id: 'PTYSD_PING_AFTER_LEGACY_PLAN_ENABLE_20261016' });
    comments.push(com(9501, encoded(secondPingJob)));
    const second = await executeWorker(config, adapters);
    assert.equal(second.state, 'FINISHED');
    assert.equal(second.request_id, secondPingJob.request_id,
      'an old read-only plan must not become executable when model eligibility changes');
    assert.equal(executorDispatches, 0);
    assert.equal(modelCalls, 0, 'the dispatcher test never invokes a model');
    assert.equal(writes.some(item => item.request_id === requestId), false,
      'legacy plan requests remain available only for historical receipt recovery');
    const historic = receipt(requestId, '00000000-0000-4000-8000-000000000001', 'FINISHED', opencodeJob,
      { outcome: 'OPENCODE_V2_EXIT_0_UNTRUSTED', exit_code: 0, evidence_sha256: null, evidence_bytes: 0 });
    assert.equal(parseReceipt(RECEIPT_MARKER + JSON.stringify(historic)).kind, 'opencode_plan');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('OpenCode edit eligibility waits without receipts, keeps ping moving, then dispatches the same task once ready', async () => {
  const root = mkdtempSync(join(homedir(), '.ptysd-opencode-edit-eligibility-'));
  try {
    const workspace = join(root, 'workspace');
    const stateDir = join(root, 'state');
    mkdirSync(join(workspace, 'src'), { recursive: true }); mkdirSync(stateDir);
    writeFileSync(join(workspace, 'src', 'worker.mjs'), 'export const value = 1;\n');
    const host = hostname().toUpperCase();
    const requestId = 'PTYSD_OPENCODE_EDIT_WAIT_RECOVERY_20261017';
    const spec = '# Synthetic test only. Do not invoke a model.\n';
    const editJob = withHumanGoal({ schema: 5, project_id: PROJECT, host, request_id: requestId,
      kind: 'opencode_edit', source_sha: commit, spec_path: 'native-bridge/tasks/edit-worker.md',
      spec_sha256: h(spec), model: 'opencode/spark', variant: 'high',
      edit_paths: ['src/worker.mjs'], source_pr: 437 });
    const pingJob = mkjob({ host, request_id: 'PTYSD_PING_DURING_EDIT_ELIGIBILITY_20261017' });
    const comments = [com(9601, encoded(editJob)), com(9602, encoded(pingJob))];
    const executor = { task_name: '\\PTYSD\\OpenCodeExecutor',
      user_sid: 'S-1-5-21-100-200-300-1001', publisher_sid: 'S-1-5-21-100-200-300-1002',
      wscript_path: 'C:\\Windows\\System32\\wscript.exe',
      launcher_path: 'C:\\PTYSD\\HiddenCodexExecutor.vbs',
      node_bin: 'C:\\Node\\node.exe', script_path: 'C:\\PTYSD\\executor.mjs',
      config_path: 'C:\\PTYSD\\executor.json', manifest_dir: join(root, 'manifests'),
      results_dir: join(root, 'results'), working_directory: root, source_bundle_per_attempt: true };
    const config = { repo: REPO, project_id: PROJECT, host, issue: 407, workspace,
      state_dir: stateDir, dispatchers: ['t14210184'], executor };
    let nextId = 9700, bundleCalls = 0, dispatchCalls = 0, modelCalls = 0;
    const writes = [], logs = [];
    const pull = { number: 437, state: 'open',
      base: { ref: 'main', repo: { id: 1352411536, full_name: REPO } },
      head: { sha: commit, repo: { id: 1352411536, full_name: REPO } } };
    const adapters = {
      goalCommentsRead: () => [humanGoalComment()],
      apiRead(uri) {
        if (uri === 'user') return { login: 'worker' };
        if (uri === `repos/${REPO}/issues/407`) return { title: ISSUE_TITLE, state: 'open' };
        if (uri === `repos/${REPO}/git/ref/heads/main`) return { object: { sha: commit } };
        if (uri === `repos/${REPO}/issues/comments/6188322050`) return humanGoalComment();
        if (uri === `repos/${REPO}/pulls/437`) return pull;
        if (uri.startsWith('repos/') && uri.includes('/issues/comments/'))
          return comments.find(item => item.id === Number(uri.split('/').at(-1)));
        if (uri.startsWith(`repos/${REPO}/contents/`))
          return { encoding: 'base64', content: Buffer.from(spec).toString('base64') };
        throw new Error(`UNEXPECTED_TEST_API:${uri}`);
      },
      commentsRead: () => comments,
      writeReceipt(_config, data, login) {
        writes.push(data);
        comments.push(com(nextId++, RECEIPT_MARKER + JSON.stringify(data), login));
      },
      assertExecutorTaskReady: () => ({ ready: true }),
      createExecutorSourceBundle: ({ job, attemptId }) => {
        bundleCalls++;
        return { attempt_id: attemptId, source_sha: job.source_sha, sha256: 'c'.repeat(64) };
      },
      dispatchToExecutor: (_descriptor, manifest) => {
        dispatchCalls++;
        assert.equal(manifest.job.request_id, requestId);
        assert.equal(manifest.source_bundle_sha256, 'c'.repeat(64));
        return { outcome: 'SYNTHETIC_EXECUTOR_REQUESTED_NOT_MODEL_EXECUTION' };
      },
      runPlan: () => { modelCalls++; throw new Error('MODEL_INVOCATION_FORBIDDEN_IN_TEST'); },
      observationDependencies: { collectWindowsObservation: () => ({ status: 'UNKNOWN' }) },
      log: value => logs.push(value),
    };

    const first = await executeWorker(config, adapters);
    assert.equal(first.request_id, pingJob.request_id,
      'an edit task waiting for authorization cannot starve an independent ping');
    assert.equal(writes.filter(item => item.request_id === requestId).length, 0,
      'missing authorization publishes no STARTED or terminal BLOCKED receipt');
    assert.equal(first.state, 'FINISHED');

    const second = await executeWorker(config, adapters);
    assert.equal(second.state, 'WAITING_ELIGIBILITY',
      'the same unstarted task remains retryable while model authorization is absent');
    assert.equal(second.reason, 'OPENCODE_MODEL_RUNS_NOT_ENABLED');
    assert.equal(writes.filter(item => item.request_id === requestId).length, 0);

    Object.assign(config, { enable_v2_model_runs: true,
      allowed_models: { 'opencode/spark': ['high'] } });
    const third = await executeWorker(config, adapters);
    assert.equal(third.state, 'DISPATCHED');
    assert.equal(third.request_id, requestId,
      'eligibility recovery dispatches the original immutable task exactly once');
    assert.equal(bundleCalls, 1); assert.equal(dispatchCalls, 1); assert.equal(modelCalls, 0);
    assert.deepEqual(writes.filter(item => item.request_id === requestId).map(item => item.state), ['STARTED']);
    assert.ok(logs.filter(value => value.includes('OPENCODE_LANE_WAITING_ELIGIBILITY_MODEL_RUNS_NOT_ENABLED')).length >= 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an ineligible OpenCode edit does not starve a later independent edit request', async () => {
  const root = mkdtempSync(join(homedir(), '.ptysd-opencode-independent-edit-'));
  try {
    const workspace = join(root, 'workspace');
    const stateDir = join(root, 'state');
    mkdirSync(join(workspace, 'src'), { recursive: true }); mkdirSync(stateDir);
    writeFileSync(join(workspace, 'src', 'worker.mjs'), 'export const value = 1;\n');
    const host = hostname().toUpperCase();
    const spec = '# Synthetic test only. Do not invoke a model.\n';
    const badJob = { schema: 4, project_id: PROJECT, host,
      request_id: 'PTYSD_OPENCODE_BAD_SCOPE_20261017', kind: 'opencode_edit',
      source_sha: commit, spec_path: 'native-bridge/tasks/edit-worker.md', spec_sha256: h(spec),
      model: 'opencode/spark', variant: 'high', edit_paths: ['missing/worker.mjs'] };
    const readyJob = { ...badJob, request_id: 'PTYSD_OPENCODE_READY_SCOPE_20261017',
      edit_paths: ['src/worker.mjs'] };
    const comments = [com(9801, encoded(badJob)), com(9802, encoded(readyJob))];
    const executor = { task_name: '\\PTYSD\\OpenCodeExecutor',
      user_sid: 'S-1-5-21-100-200-300-1001', publisher_sid: 'S-1-5-21-100-200-300-1002',
      wscript_path: 'C:\\Windows\\System32\\wscript.exe',
      launcher_path: 'C:\\PTYSD\\HiddenCodexExecutor.vbs',
      node_bin: 'C:\\Node\\node.exe', script_path: 'C:\\PTYSD\\executor.mjs',
      config_path: 'C:\\PTYSD\\executor.json', manifest_dir: join(root, 'manifests'),
      results_dir: join(root, 'results'), working_directory: root,
      source_bundle_per_attempt: true };
    const config = { repo: REPO, project_id: PROJECT, host, issue: 407, workspace,
      state_dir: stateDir, dispatchers: ['t14210184'], enable_v2_model_runs: true,
      allowed_models: { 'opencode/spark': ['high'] }, executor };
    const writes = [], logs = [];
    let dispatches = 0, nextId = 9900;
    const result = await executeWorker(config, {
      apiRead(uri) {
        if (uri === 'user') return { login: 'worker' };
        if (uri === `repos/${REPO}/issues/407`) return { title: ISSUE_TITLE, state: 'open' };
        if (uri === `repos/${REPO}/git/ref/heads/main`) return { object: { sha: commit } };
        if (uri.startsWith(`repos/${REPO}/contents/`))
          return { encoding: 'base64', content: Buffer.from(spec).toString('base64') };
        const match = uri.match(/\/issues\/comments\/(\d+)$/);
        if (match) return comments.find(item => item.id === Number(match[1]));
        throw new Error(`UNEXPECTED_TEST_API:${uri}`);
      },
      commentsRead: () => comments,
      assertExecutorTaskReady: () => ({ ready: true, source_bundle_per_attempt: true }),
      createExecutorSourceBundle: ({ job, attemptId }) => ({
        attempt_id: attemptId, source_sha: job.source_sha, sha256: 'e'.repeat(64),
      }),
      writeReceipt(_config, data, login) {
        writes.push(data);
        comments.push(com(nextId++, RECEIPT_MARKER + JSON.stringify(data), login));
      },
      dispatchToExecutor: (_descriptor, manifest) => {
        dispatches++;
        assert.equal(manifest.request_id, readyJob.request_id);
        return { outcome: 'SYNTHETIC_EXECUTOR_REQUESTED_NOT_MODEL_EXECUTION' };
      },
      runPlan: () => { throw new Error('TEST_MUST_NOT_INVOKE_A_MODEL'); },
      log: value => logs.push(value),
    });
    assert.equal(result.state, 'DISPATCHED');
    assert.equal(result.request_id, readyJob.request_id,
      'a request-specific scope failure must not block another valid OpenCode edit');
    assert.equal(dispatches, 1);
    assert.deepEqual(writes.map(item => [item.request_id, item.state]), [[readyJob.request_id, 'STARTED']]);
    assert.ok(logs.includes('OPENCODE_LANE_WAITING_ELIGIBILITY_EDIT_SCOPE_SCOPED_EDIT_PARENT_PATH_MISSING'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Codex terminal receipt keeps exit-zero execution explicitly unverified', () => {
  const started = { schema: 1, project_id: PROJECT, host: 'DESKTOP-1B6PD2P',
    request_id: 'PTYSD_CODEX_TERMINAL_TEST_20261015', kind: 'codex_plan',
    source_sha: commit, attempt_id: '11111111-1111-4111-8111-111111111111',
    state: 'STARTED', model: 'gpt-6.1-sol', reasoning_effort: 'medium',
    task_fingerprint: hash };
  const result = { schema: 1, kind: 'codex_plan', request_id: started.request_id,
    attempt_id: started.attempt_id, source_sha: commit, exit_code: 0,
    fingerprint: hash, session_id: 'session_12345678', diff_sha256: null,
    stdout_sha256: hash, stderr_sha256: hash, outcome: 'CODEX_CLI_EXIT_0_UNVERIFIED',
    model_invoked: true, changed_paths: [], out_of_scope_paths: [], pr_url: null, tests: 'NOT_RUN' };
  const terminal = codexTerminalReceipt(started, result);
  assert.equal(terminal.state, 'FINISHED');
  assert.equal(terminal.outcome, 'CODEX_CLI_EXIT_0_UNVERIFIED');
  assert.equal(Object.hasOwn(terminal, 'accepted'), false);
  const incomplete = codexTerminalReceipt(started, { ...result, outcome: 'EVIDENCE_STORAGE_FAILED' });
  assert.equal(incomplete.state, 'BLOCKED');
});

test('native preflight records Antigravity readiness without claiming model entitlement or activity', () => {
  const root=mkdtempSync(join(homedir(),'.ptysd-antigravity-preflight-'));
  try {
    const workspace=join(root,'workspace'),state=join(root,'state');
    mkdirSync(workspace);mkdirSync(state);
    let observed=null;
    const result=nativePreflight({host:hostname().toUpperCase(),workspace,state_dir:state,
      allowed_models:{},enable_v2_model_runs:false},
    mkjob({kind:'native_preflight',host:hostname().toUpperCase(),
      request_id:'PTYSD_ANTIGRAVITY_PREFLIGHT_20261018'}),{
      qualifyOpenCodeV2:()=>({ready:true,candidates_checked:1,version:'2.0.32'}),
      localAppData:join(root,'LOCALAPPDATA'),
      baseEnv:{PATH:'clean'},
      resolveAntigravityProjectId:(directory,env)=>{
        assert.equal(directory,workspace); assert.equal(env.PATH,'clean');
        return {projectId:'b8fbf647-6c41-4932-9d0a-8a7af257a27a',
          projectScopeEvidence:'PROJECT_WORKSPACE_MATCHED'};
      },
      runAntigravityV2Readiness:(bin,directory,_runner,env,_signatureVerifier,projectId)=>{
        observed={bin,directory,hasPublisherCredential:Object.keys(env).some(key=>/GITHUB_TOKEN|API_KEY/i.test(key))};
        assert.equal(projectId,'b8fbf647-6c41-4932-9d0a-8a7af257a27a');
        return {status:'CLI_AND_PINNED_MODEL_CATALOGED_NOT_EXECUTION_AUTH',
          model:'gemini-3.8-flash-high',signature_verified:true,authentication_checked:false,
          credit_fallback_setting:'SETTING_ABSENT',entitlement:'UNKNOWN',cost:'UNKNOWN',
          write_scope:'UNKNOWN',inference_executed:false};
      },
    });
    assert.equal(result.outcome,'OPENCODE_V2_VERSION_CONFIRMED_NO_MODEL_AUTH');
    assert.equal(observed.directory,workspace);
    assert.match(observed.bin,/LOCALAPPDATA[\\/]agy[\\/]bin[\\/]agy\.exe$/i);
    assert.equal(observed.hasPublisherCredential,false);
    const file=readdirSync(state).find(name=>name.startsWith('native-evidence-'));
    const facts=JSON.parse(readFileSync(join(state,file),'utf8'));
    assert.equal(facts.antigravity_v2.model,'gemini-3.8-flash-high');
    assert.equal(facts.antigravity_v2.credit_fallback_setting,'SETTING_ABSENT');
    assert.equal(facts.antigravity_v2.entitlement,'UNKNOWN');
    assert.equal(facts.antigravity_v2.cost,'UNKNOWN');
    assert.equal(facts.antigravity_v2.inference_executed,false);
    assert.equal(JSON.stringify(facts).includes(root),false);
  } finally {rmSync(root,{recursive:true,force:true});}
});
