import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, chmodSync, readdirSync, existsSync,
  symlinkSync, unlinkSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseJob, selectNext, parseReceipt, parseCodexSourceAcceptance, receipt, PROJECT, REPO, JOB_MARKER,
  RECEIPT_MARKER, checkModelAuthorization, terminalStateForResult,
  runWorker as runWorkerImplementation, main as runWorker, writeReceipt, ISSUE_TITLE, guardConfig,
  runPlan as executeOpenCodeTask, verifyCapturedEvidence, antigravityExecutionAuthorization,
  captureScopedEditDiff,
  codexTerminalReceipt, selectNextWithCodexClaim, readPinnedCandidateSources, executorForJobKind,
  writePathsOverlap,
  publishOperatorObservation, buildOpenCodeChildEnv, nativePreflight, derivePollDisposition,
  isRecoverableModelPreflightWait }
  from '../native-bridge/worker.mjs';
import { OPERATOR_MARKER, OPERATOR_COMMENT_ID, encodeOperatorObservation, parseOperatorObservation }
  from '../native-bridge/operator-observation.mjs';
import { makeCodexExecutorRequest, codexScopedActionStatus, codexTaskFingerprint,
  validCodexWritePaths }
  from '../native-bridge/codex-continuation.mjs';
import { candidateWorkspacePath, executorResultPath } from '../native-bridge/windows-executor.mjs';
import { ANTIGRAVITY_V2_MODEL, buildAntigravityChildEnvironment, buildNativeChildEnvironment,
  readAntigravityV2RunEvidence }
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
const codexPlan = write_paths => ({ schema: 4, project_id: PROJECT, host: 'DESKTOP-1B6PD2P',
  request_id: `PTYSD_HUMAN_GOAL_6188322050_${h(humanGoalBody).slice(0, 42).toUpperCase()}`,
  kind: 'codex_plan', source_sha: commit,
  spec_path: 'native-bridge/tasks/human-goal-source-only.md', spec_sha256: hash,
  model: 'gpt-6.1-sol', reasoning_effort: 'medium', write_paths,
  goal_comment_id: 6188322050, goal_body_sha256: h(humanGoalBody), goal_author: 't14210184',
  goal_marker: 'PTYSD_V53R4_DELETE_FIRST_AUTONOMY_GOAL_20261015' });

test('Antigravity stream evidence binds the exact candidate cwd and reports mismatch or missing cwd without leaking paths', async () => {
  const root=mkdtempSync(join(homedir(),'.ptysd-agy-cwd-evidence-'));
  try {
    const expectedCwd=join(root,'candidate'),otherCwd=join(root,'other-candidate');
    mkdirSync(expectedCwd); mkdirSync(otherCwd);
    const stdoutPath=join(root,'stream.jsonl');
    const read=async init=>{
      const session='conv_agy_cwd_evidence_20261026';
      const events=[
        {event:'init',conversation_id:session,init:{model:ANTIGRAVITY_V2_MODEL,
          permission_mode:'request-review',...init}},
        {event:'result',result:{conversation_id:session,status:'SUCCESS',response:'synthetic',
          usage:{input_tokens:0,output_tokens:0,thinking_tokens:0,cache_read_tokens:0,total_tokens:0}}},
      ];
      const bytes=Buffer.from(events.map(event=>JSON.stringify(event)).join('\n')+'\n');
      writeFileSync(stdoutPath,bytes);
      return readAntigravityV2RunEvidence(stdoutPath,h(bytes),expectedCwd);
    };

    const matched=await read({cwd:expectedCwd});
    assert.equal(matched.valid,true);
    assert.equal(matched.workspace_cwd_evidence.status,'MATCHED');
    assert.equal(matched.workspace_cwd_evidence.expected_path_sha256,
      matched.workspace_cwd_evidence.observed_path_sha256);

    const mismatch=await read({cwd:otherCwd});
    assert.equal(mismatch.valid,false);
    assert.equal(mismatch.reason,'ANTIGRAVITY_WORKSPACE_CWD_MISMATCH');
    assert.equal(mismatch.workspace_cwd_evidence.status,'MISMATCH');
    assert.notEqual(mismatch.workspace_cwd_evidence.expected_path_sha256,
      mismatch.workspace_cwd_evidence.observed_path_sha256);
    assert.equal(JSON.stringify(mismatch).includes(otherCwd),false,
      'the public evidence carries path digests, not local absolute paths');

    const missing=await read({});
    assert.equal(missing.valid,false);
    assert.equal(missing.reason,'ANTIGRAVITY_WORKSPACE_CWD_MISSING_OR_INVALID');
    assert.equal(missing.workspace_cwd_evidence.status,'MISSING_OR_INVALID');
    assert.equal(missing.workspace_cwd_evidence.observed_path_sha256,null);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
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
  seededObservation = true, includeDefaultJob = true,
  collectWindowsFailure = null, windowsObservation = null, goalComments = [], taskComments = [], candidatePulls = {},
  issueCommentsCount = null, configOverrides = {}, contentFiles = {}, workerOverrides = {} } = {}) {
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
      ...(includeDefaultJob ? [com(702, encoded(job), 't14210184')] : []),
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
    const contentsPrefix = `repos/${REPO}/contents/`;
    if (uri.startsWith(contentsPrefix)) {
      const [path, ref] = uri.slice(contentsPrefix.length).split('?ref=');
      if (ref !== commit) throw new Error('MOCK_CONTENT_REF_MISMATCH');
      if (typeof contentFiles[path] !== 'string') throw new Error('MOCK_CONTENT_MISSING');
      return { encoding: 'base64', content: Buffer.from(contentFiles[path], 'utf8').toString('base64') };
    }
    if (uri === `repos/${REPO}/issues/407`)
      return { title: ISSUE_TITLE, state: 'open', comments: issueCommentsCount ?? store.comments.length };
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
  const writeReceipt = (_config, data, login) => {
    store.comments.push(com(store.next++, RECEIPT_MARKER + JSON.stringify(data), login));
    store.posts++;
    receiptWrites.push(data);
  };
  const log = value => logs.push(value);
  const run = () => Object.keys(workerOverrides).length
    ? runWorkerImplementation(config, { apiRead: api, commentsRead: () => store.comments,
      goalCommentsRead: () => goalComments, observationDependencies, writeReceipt, log,
      ...workerOverrides })
    : runWorker({
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
      writeReceipt, log,
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
  const legacyRuntimeComponents = parsedLegacy.runtime_deployment.component_sha256;
  assert.ok(Object.hasOwn(legacyRuntimeComponents, 'executor.mjs'));
  assert.ok(Object.values(legacyRuntimeComponents).every(value => value === null),
    'a legacy four-file manifest cannot claim any component of the current runtime');
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
    assert.equal(value.native_worker.poll_disposition, 'READY_JOB_SELECTED_NOT_DISPATCHED',
      'the observation is published after selection and before dispatch');
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
    assert.equal(value.native_worker.poll_disposition, 'NO_READY_JOB_NO_MODEL_DISPATCH',
      'ten completed idle ticks have no READY job and no model dispatch');
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

test('poll disposition and safe wait code separate an empty queue, a waiting gate, and a selected job', async () => {
  const readObservation = store => parseOperatorObservation(
    store.comments.find(comment => comment.body.startsWith(OPERATOR_MARKER)).body);

  const empty = makeObservationWorkerFixture({ includeDefaultJob: false });
  try {
    const result = await empty.run();
    assert.equal(result.state, 'NO_DELTA');
    const observation = readObservation(empty.store);
    assert.equal(observation.native_worker.poll_disposition, 'NO_READY_JOB_NO_MODEL_DISPATCH');
    assert.equal(observation.native_worker.poll_wait_code, 'NOT_APPLICABLE');
    assert.equal(observation.native_worker.current_task, null);
    assert.equal(observation.native_worker.latest_task, null);
    assert.equal(observation.native_worker.files_modified, 'UNPROVEN');
    assert.equal(empty.modelCalls.count, 0);
    assert.equal(empty.codexDispatchCalls.count, 0);
  } finally { empty.cleanup(); }

  const host = hostname().toUpperCase();
  const waitingJob = { schema: 4, project_id: PROJECT, host,
    request_id: 'PTYSD_POLL_DISPOSITION_WAITING_20261101', kind: 'opencode_edit',
    source_sha: commit, spec_path: 'native-bridge/tasks/poll-disposition.md',
    spec_sha256: hash, model: 'opencode/deepseek-v4.1-flash-free', variant: null,
    edit_paths: ['native-bridge/worker.mjs'] };
  const waiting = makeObservationWorkerFixture({ includeDefaultJob: false,
    taskComments: [com(704, encoded(waitingJob), 't14210184')] });
  try {
    const result = await waiting.run();
    assert.equal(result.state, 'WAITING_ELIGIBILITY');
    assert.equal(result.reason, 'OPENCODE_MODEL_RUNS_NOT_ENABLED');
    const observation = readObservation(waiting.store);
    assert.equal(observation.native_worker.poll_disposition, 'WAITING_GATE_NO_MODEL_DISPATCH');
    assert.equal(observation.native_worker.poll_wait_code, 'MODEL_RUNS_NOT_ENABLED');
    assert.equal(observation.native_worker.files_modified, 'UNPROVEN');
    assert.equal(observation.native_worker.pull_request, null);
    assert.equal(observation.native_worker.ci, 'UNKNOWN');
    assert.equal(waiting.modelCalls.count, 0,
      'a preflight gate must not invoke the model adapter');
    assert.equal(waiting.codexDispatchCalls.count, 0);
  } finally { waiting.cleanup(); }

  const selected = makeObservationWorkerFixture();
  try {
    await selected.run();
    const observation = readObservation(selected.store);
    assert.equal(observation.native_worker.poll_disposition, 'READY_JOB_SELECTED_NOT_DISPATCHED');
    assert.equal(observation.native_worker.poll_wait_code, 'NOT_APPLICABLE');
    assert.equal(observation.native_worker.latest_task.state, 'QUEUED_NOT_STARTED',
      'publication happens before the selected job is dispatched');
    assert.equal(selected.modelCalls.count, 0);
  } finally { selected.cleanup(); }
});

test('poll disposition derivation fails closed to UNKNOWN for non-derivable inputs', () => {
  assert.equal(derivePollDisposition({ next: null, waitingEligibility: null,
    humanGoalWaitingReason: null, preflightBlockers: new Map() }),
  'NO_READY_JOB_NO_MODEL_DISPATCH');
  assert.equal(derivePollDisposition({ next: null,
    preflightBlockers: new Map([['PTYSD_REQUEST', 'MODEL_RUNS_NOT_ENABLED']]) }),
  'WAITING_GATE_NO_MODEL_DISPATCH');
  assert.equal(derivePollDisposition({ next: null, waitingEligibility: 'MODEL_NOT_ENABLED',
    preflightBlockers: new Map() }), 'WAITING_GATE_NO_MODEL_DISPATCH');
  assert.equal(derivePollDisposition({ next: null, humanGoalWaitingReason: 'HUMAN_GOAL_READ_UNKNOWN',
    preflightBlockers: new Map() }), 'WAITING_GATE_NO_MODEL_DISPATCH');
  assert.equal(derivePollDisposition({ next: { job: { request_id: 'PTYSD_REQUEST' } },
    preflightBlockers: new Map() }), 'READY_JOB_SELECTED_NOT_DISPATCHED');
  assert.equal(derivePollDisposition(null), 'UNKNOWN');
  assert.equal(derivePollDisposition({ next: null, preflightBlockers: {} }), 'UNKNOWN');
  assert.equal(derivePollDisposition({ next: 'selected' }), 'UNKNOWN');
  assert.equal(derivePollDisposition({ next: null, waitingEligibility: '' }), 'UNKNOWN');
  assert.equal(derivePollDisposition({ next: null, waitingEligibility: 7 }), 'UNKNOWN');
  assert.equal(derivePollDisposition({ next: null, waitingEligibility: 'MODEL_NOT_ENABLED',
    humanGoalWaitingReason: false }), 'UNKNOWN');
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
    const observation = parseOperatorObservation(
      fixture.store.comments.find(comment => comment.body.startsWith(OPERATOR_MARKER)).body);
    assert.equal(observation.github.issue_comments_count, 2,
      'Issue #407 count must exclude the schema-6 candidate read separately from Issue #310');
    assert.equal(result.state, 'FINISHED', 'the independent zero-model ping remains runnable');
    assert.ok(fixture.logs.includes(`STALE_CANDIDATE_SOURCE_${w2Job.request_id}_PR_461_` +
      `EXPECTED_SHA_${expectedSha}_OBSERVED_SHA_${observedSha}_NO_DISPATCH`));
    assert.deepEqual(fixture.receiptWrites.map(value => value.kind), ['ping', 'ping']);
    assert.equal(fixture.modelCalls.count, 0);
    assert.equal(fixture.codexDispatchCalls.count, 0);
  } finally { fixture.cleanup(); }
});

test('Worker reconciles recoverable quota-window-expired preflight wait, preserves W1 progress, and redispatches W2 with a new attempt', async () => {
  const host = hostname().toUpperCase();
  const priorAttemptId = '00000000-0000-4000-8000-000000000021';
  const spec = 'Recover W2 after a quota-window expiration without replaying its prior attempt.';

  const w2Job = withHumanGoal({
    schema: 6,
    project_id: PROJECT,
    host,
    request_id: 'PTYSD_W2_QUOTA_WINDOW_RECOVERABLE_20261101',
    kind: 'antigravity_edit',
    source_sha: commit,
    spec_path: 'native-bridge/tasks/w2-quota-canary.md',
    spec_sha256: h(spec),
    model: ANTIGRAVITY_V2_MODEL,
    variant: 'high',
    edit_paths: ['src/w2-quota-canary.mjs'],
    source_pr: 461,
  });
  const w2Comment = {
    ...com(6188322051, encoded(w2Job)),
    issue_url: `https://api.github.com/repos/${REPO}/issues/310`,
  };
  const sameRepo = { id: 1352411536, full_name: REPO };
  const pull = {
    number: 461,
    state: 'open',
    base: { ref: 'main', repo: sameRepo },
    head: { sha: commit, repo: sameRepo },
  };

  const priorStartedReceipt = receipt(w2Job.request_id, priorAttemptId, 'STARTED', w2Job);
  const priorStartedComment = com(701, RECEIPT_MARKER + JSON.stringify(priorStartedReceipt), 'trusted-publisher');

  const waitingResult = {
    outcome: 'ANTIGRAVITY_QUOTA_WINDOW_EXPIRED_OR_INVALID',
    exit_code: 48,
    eligibility_state: 'WAITING',
    model_invoked: false,
    evidence_sha256: null,
    evidence_bytes: 0,
  };
  assert.equal(isRecoverableModelPreflightWait(waitingResult, w2Job), true,
    'ANTIGRAVITY_QUOTA_WINDOW_EXPIRED_OR_INVALID must be recognized as recoverable preflight wait');

  const waitingTerminal = receipt(w2Job.request_id, priorAttemptId, 'WAITING', w2Job, waitingResult);
  assert.equal(parseReceipt(RECEIPT_MARKER + JSON.stringify(waitingTerminal))?.state, 'WAITING',
    'the persisted WAITING receipt must parse successfully');

  const root = mkdtempSync(join(homedir(), '.ptysd-w2-quota-window-reconcile-'));
  try {
    const opencodeResultsDir = join(root, 'opencode-results');
    const opencodeManifestDir = join(root, 'opencode-manifests');
    const antigravityResultsDir = join(root, 'antigravity-results');
    const antigravityManifestDir = join(root, 'antigravity-manifests');
    mkdirSync(opencodeResultsDir, { recursive: true });
    mkdirSync(opencodeManifestDir, { recursive: true });
    mkdirSync(antigravityResultsDir, { recursive: true });
    mkdirSync(antigravityManifestDir, { recursive: true });

    const dispatchedW2Attempts = [];

    const baseOpencode = executorDescriptorForLane('OpenCode', 1001);
    const baseAntigravity = executorDescriptorForLane('Antigravity', 1003);
    const configuredOpencode = {
      ...baseOpencode,
      manifest_dir: opencodeManifestDir,
      results_dir: opencodeResultsDir,
      config_path: join(root, 'opencode-config.json'),
      working_directory: join(root, 'opencode-work'),
    };
    const configuredAntigravity = {
      ...baseAntigravity,
      manifest_dir: antigravityManifestDir,
      results_dir: antigravityResultsDir,
      config_path: join(root, 'antigravity-config.json'),
      working_directory: join(root, 'antigravity-work'),
    };

    const waitingResultPath = executorResultPath(antigravityResultsDir, w2Job.request_id, priorAttemptId);
    writeFileSync(waitingResultPath, JSON.stringify({ request_id: w2Job.request_id,
      attempt_id: priorAttemptId, terminal: waitingTerminal }));
    const candidateWorkspace = candidateWorkspacePath(antigravityResultsDir, priorAttemptId);
    mkdirSync(candidateWorkspace, { recursive: true });

    const fixture = makeObservationWorkerFixture({
      goalComments: [humanGoalComment(), w2Comment],
      candidatePulls: { 461: pull },
      taskComments: [priorStartedComment],
      contentFiles: { [w2Job.spec_path]: spec },
      configOverrides: {
        enable_antigravity_model_runs: true,
        allowed_models: { [ANTIGRAVITY_V2_MODEL]: ['high'] },
        antigravity_execution_attestation: {
          model: ANTIGRAVITY_V2_MODEL,
          entitlement: 'VERIFIED',
          cost: 'NO_ADDITIONAL_CHARGE',
          observed_at: new Date().toISOString(),
        },
        executors: {
          opencode: configuredOpencode,
          antigravity: configuredAntigravity,
        },
      },
      workerOverrides: {
        assertExecutorTaskReady: () => ({ ready: true }),
        createExecutorSourceBundle: ({ job, attemptId }) => ({
          attempt_id: attemptId, source_sha: job.source_sha, sha256: 'd'.repeat(64),
        }),
        dispatchToExecutor: (_executor, request) => {
          dispatchedW2Attempts.push(request);
          return { outcome: 'EXECUTOR_PENDING_NOT_ACCEPTANCE' };
        },
      },
    });

    try {
      const pollResult = await fixture.run();
      assert.equal(pollResult.state, 'FINISHED',
        'the poll must complete after dispatching the independent READY W1 ping job');

      assert.equal(existsSync(waitingResultPath), true,
        'the verified terminal result remains as durable reconciliation evidence');
      assert.equal(existsSync(candidateWorkspace), false,
        'the candidate workspace must be cleaned up after receipt reconciliation');

      assert.equal(fixture.modelCalls.count, 0, 'assert zero inline model calls');
      assert.equal(fixture.codexDispatchCalls.count, 0, 'assert zero codex executor calls');

      assert.equal(fixture.receiptWrites.length, 3,
        'exactly three receipts must be written: 1 reconciled WAITING receipt + 2 W1 ping receipts');

      const reconciledReceipt = fixture.receiptWrites[0];
      assert.equal(reconciledReceipt.state, 'WAITING');
      assert.equal(reconciledReceipt.outcome, 'ANTIGRAVITY_QUOTA_WINDOW_EXPIRED_OR_INVALID');
      assert.equal(reconciledReceipt.eligibility_state, 'WAITING');
      assert.equal(reconciledReceipt.model_invoked, false);
      assert.equal(reconciledReceipt.request_id, w2Job.request_id);
      assert.equal(reconciledReceipt.attempt_id, priorAttemptId);
      assert.equal(reconciledReceipt.source_sha, w2Job.source_sha);
      assert.equal(reconciledReceipt.model, w2Job.model);
      assert.equal(reconciledReceipt.variant, w2Job.variant);
      assert.equal(reconciledReceipt.source_pr, w2Job.source_pr);
      assert.equal(reconciledReceipt.goal_comment_id, w2Job.goal_comment_id);
      assert.equal(reconciledReceipt.goal_body_sha256, w2Job.goal_body_sha256);

      const w1Started = fixture.receiptWrites[1];
      const w1Finished = fixture.receiptWrites[2];
      assert.equal(w1Started.kind, 'ping');
      assert.equal(w1Started.state, 'STARTED');
      assert.equal(w1Finished.kind, 'ping');
      assert.equal(w1Finished.state, 'FINISHED');

      const w2Receipts = fixture.store.comments
        .map(c => parseReceipt(c.body))
        .filter(r => r && r.request_id === w2Job.request_id);
      assert.equal(w2Receipts.length, 2, 'Issue #407 must contain both STARTED and WAITING for the prior attempt');
      assert.deepEqual(w2Receipts.map(r => r.state), ['STARTED', 'WAITING']);
      assert.ok(w2Receipts.every(r => r.attempt_id === priorAttemptId));

      fixture.store.now += 60_000;
      const poll2Result = await fixture.run();
      assert.equal(poll2Result.state, 'DISPATCHED',
        `the same W2 request must be eligible after its exact WAITING attempt is reconciled; logs=${JSON.stringify(fixture.logs)}`);
      assert.equal(dispatchedW2Attempts.length, 1, 'exactly one later W2 executor dispatch occurs');
      assert.equal(dispatchedW2Attempts[0].request_id, w2Job.request_id);
      assert.notEqual(dispatchedW2Attempts[0].attempt_id, priorAttemptId,
        'the recovered W2 request receives a fresh attempt ID');
      assert.equal(dispatchedW2Attempts[0].source_sha, w2Job.source_sha);
      assert.ok(fixture.receiptWrites.every((r, index) => index === 0 || r.attempt_id !== priorAttemptId),
        'no later receipt replays the prior W2 attempt ID');
      assert.equal(fixture.modelCalls.count, 0, 'the test intercepts Executor dispatch before any model call');
    } finally {
      fixture.cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('operator observation uses the authoritative GitHub issue comment count, not the fetched page length', async () => {
  const fixture = makeObservationWorkerFixture({ issueCommentsCount: 58 });
  try {
    const result = await fixture.run();
    const observation = parseOperatorObservation(
      fixture.store.comments.find(comment => comment.body.startsWith(OPERATOR_MARKER)).body);
    assert.equal(result.state, 'FINISHED');
    assert.equal(observation.github.issue_comments_count, 58);
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

test('candidate edit jobs remain source-pinned after an exact official PR merge', async () => {
  const host = hostname().toUpperCase();
  const sourceSha = 'c'.repeat(40), mergeSha = 'e'.repeat(40);
  const candidate = withHumanGoal({ schema: 6, project_id: PROJECT, host,
    request_id: 'PTYSD_MERGED_EDIT_PR_SOURCE_20261021', kind: 'antigravity_edit',
    source_sha: sourceSha, spec_path: 'native-bridge/tasks/w2-quota-canary.md',
    spec_sha256: hash, model: ANTIGRAVITY_V2_MODEL, variant: 'high',
    edit_paths: ['src/w2-quota-canary.mjs'], source_pr: 461 });
  const comment = { ...com(10, encoded(candidate), 't14210184'),
    issue_url: `https://api.github.com/repos/${REPO}/issues/310` };
  const repo = { id: 1352411536, full_name: REPO };
  const mergedPull = { number: 461, state: 'closed', merged: true,
    merged_at: '2026-10-21T12:00:00Z', merge_commit_sha: mergeSha,
    base: { ref: 'main', repo }, head: { sha: sourceSha, repo } };
  const goal = humanGoalComment();
  const logs = [];
  const comments = [comment];
  const mergedSources = await readPinnedCandidateSources(comments, ['t14210184'], 'worker', host,
    path => path.endsWith('/6188322050') ? goal : mergedPull,
    message => logs.push(message), [], () => [goal]);
  assert.equal(mergedSources.get(461), sourceSha,
    'a verified merge keeps the exact PR head available as the pinned task source');
  assert.equal(selectNext(comments, ['t14210184'], 'worker', host,
    'f'.repeat(40), [], mergedSources)?.job.request_id, candidate.request_id);

  const unmergedLogs = [];
  const closedUnmerged = await readPinnedCandidateSources(comments, ['t14210184'], 'worker', host,
    path => path.endsWith('/6188322050') ? goal : { ...mergedPull, merged: false,
      merged_at: null, merge_commit_sha: null },
    message => unmergedLogs.push(message), [], () => [goal]);
  assert.equal(closedUnmerged.size, 0,
    'a closed PR without GitHub merge evidence remains non-dispatchable');
  assert.ok(unmergedLogs.includes(`CANDIDATE_SOURCE_NOT_DISPATCHABLE_${candidate.request_id}_PR_461_` +
    `REASON_PR_NOT_OPEN_EXPECTED_SHA_${sourceSha}_OBSERVED_SHA_${sourceSha}_NO_DISPATCH`));

  const missingMergeEvidence = await readPinnedCandidateSources(comments, ['t14210184'], 'worker', host,
    path => path.endsWith('/6188322050') ? goal : { ...mergedPull, merged_at: null },
    undefined, [], () => [goal]);
  assert.equal(missingMergeEvidence.size, 0,
    'the merged flag alone is insufficient without timestamp and merge SHA readback');

  const changedHead = await readPinnedCandidateSources(comments, ['t14210184'], 'worker', host,
    path => path.endsWith('/6188322050') ? goal : { ...mergedPull,
      head: { ...mergedPull.head, sha: 'd'.repeat(40) } },
    undefined, [], () => [goal]);
  assert.equal(selectNext(comments, ['t14210184'], 'worker', host,
    'f'.repeat(40), [], changedHead), null,
  'merge acceptance does not weaken exact PR-head SHA binding');
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

test('active edit scopes exclude a second writer on overlapping paths but leave independent paths ready', () => {
  const host = 'DESKTOP-1B6PD2P';
  const sourceSha = 'c'.repeat(40);
  const makeEdit = (requestId, kind, editPaths) => withHumanGoal({ schema: 6,
    project_id: PROJECT, host, request_id: requestId, kind, source_sha: sourceSha,
    spec_path: 'native-bridge/tasks/conflict-test.md', spec_sha256: hash,
    ...(kind === 'antigravity_edit'
      ? { model: ANTIGRAVITY_V2_MODEL, variant: 'high' }
      : { model: 'opencode/deepseek-v4.1-flash-free', variant: 'free' }),
    edit_paths: editPaths, source_pr: 461 });
  const active = makeEdit('PTYSD_ACTIVE_W2_SHARED_PATH', 'antigravity_edit', ['src/shared.mjs']);
  const overlapping = makeEdit('PTYSD_READY_W1_SHARED_PATH', 'opencode_edit', ['src/shared.mjs']);
  const independent = makeEdit('PTYSD_READY_W1_INDEPENDENT_PATH', 'opencode_edit', ['docs/independent.md']);
  assert.ok(parseJob(encoded(active)));
  assert.ok(parseJob(encoded(overlapping)));
  assert.ok(parseJob(encoded(independent)));
  const attemptId = '44444444-4444-4444-8444-444444444444';
  const comments = [
    { ...com(801, encoded(active)), issue_url: `https://api.github.com/repos/${REPO}/issues/310` },
    { ...com(802, encoded(overlapping)), issue_url: `https://api.github.com/repos/${REPO}/issues/310` },
    { ...com(803, encoded(independent)), issue_url: `https://api.github.com/repos/${REPO}/issues/310` },
    com(804, RECEIPT_MARKER + JSON.stringify(receipt(active.request_id, attemptId,
      'STARTED', active)), 'worker'),
  ];
  const next = selectNext(comments, ['t14210184'], 'worker', host, commit, [],
    new Map([[461, sourceSha]]));
  assert.equal(next?.id, 803,
    'the shared file remains owned by the active W2 attempt while another path can proceed');
});

test('unresolved Codex write_paths reserve overlapping W1 and W2 edit scopes, but not independent paths', () => {
  const host = 'DESKTOP-1B6PD2P';
  const sourceSha = commit;
  const codex = codexPlan(['src']);
  const makeEdit = (requestId, kind, editPaths) => withHumanGoal(mkjob({
    request_id: requestId, kind, source_sha: sourceSha,
    spec_path: 'native-bridge/tasks/conflict-test.md', spec_sha256: hash,
    model: kind === 'antigravity_edit' ? ANTIGRAVITY_V2_MODEL :
      'opencode/deepseek-v4.1-flash-free',
    variant: kind === 'antigravity_edit' ? 'high' : 'free',
    edit_paths: editPaths, source_pr: 461,
  }));
  const w1 = makeEdit('PTYSD_READY_W1_CODEX_OVERLAP', 'opencode_edit', ['src/worker.mjs']);
  const w2 = makeEdit('PTYSD_READY_W2_CODEX_OVERLAP', 'antigravity_edit', ['src/readiness.mjs']);
  const independent = makeEdit('PTYSD_READY_W1_CODEX_INDEPENDENT', 'opencode_edit',
    ['docs/independent.md']);
  assert.ok(parseJob(encoded(codex)), 'the test uses a valid schema-4 Codex job');
  const attemptId = '66666666-6666-4666-8666-666666666666';
  const started = receipt(codex.request_id, attemptId, 'STARTED', codex, {
    model_invoked: true, external_effects: 'UNKNOWN',
  });
  const jobComment = (id, job) => ({ ...com(id, encoded(job)),
    issue_url: `https://api.github.com/repos/${REPO}/issues/310` });
  const comments = [jobComment(801, codex), jobComment(802, w1), jobComment(803, w2),
    jobComment(804, independent), com(805, RECEIPT_MARKER + JSON.stringify(started), 'worker')];
  const heads = new Map([[461, sourceSha]]);
  const next = selectNext(comments, ['t14210184'], 'worker', host, sourceSha, [], heads);
  assert.equal(next?.id, 804,
    'a Codex STARTED attempt protects its authorized write scope without starving independent work');
  assert.equal(selectNext(comments.filter(comment => comment.id !== 804),
    ['t14210184'], 'worker', host, sourceSha, [], heads), null,
  'both W1 and W2 candidates overlapping the Codex write scope must wait');

  const sameRequestW1 = makeEdit(codex.request_id, 'opencode_edit', ['src/worker.mjs']);
  const sameRequestCrossKindComments = [jobComment(817, sameRequestW1),
    com(818, RECEIPT_MARKER + JSON.stringify(started), 'worker')];
  assert.equal(selectNext(sameRequestCrossKindComments, ['t14210184'], 'worker', host,
    sourceSha, [], heads), null,
  'a same-ID receipt from another job kind still owns its overlapping write scope');

  const receiptOnlyComments = comments.filter(comment => comment.id !== 801);
  assert.equal(selectNext(receiptOnlyComments, ['t14210184'], 'worker', host, sourceSha, [], heads)?.id,
    804, 'a Codex STARTED receipt retains its write scope after the synthetic job source disappears');
  assert.equal(selectNext(receiptOnlyComments.filter(comment => comment.id !== 804),
    ['t14210184'], 'worker', host, sourceSha, [], heads), null,
  'receipt-only Codex scope still blocks both overlapping Worker lanes');

  const wrongSourceReceipt = receipt(codex.request_id, attemptId, 'STARTED',
    { ...codex, source_sha: 'b'.repeat(40) }, { model_invoked: true });
  const wrongSourceComments = [...comments.slice(0, 4),
    com(809, RECEIPT_MARKER + JSON.stringify(wrongSourceReceipt), 'worker')];
  assert.equal(selectNext(wrongSourceComments.filter(comment => comment.id !== 804),
    ['t14210184'], 'worker', host, sourceSha, [], heads), null,
  'a request-bound Codex receipt with mismatched source identity cannot release or bypass the write lease');

  const uncertainTerminal = receipt(codex.request_id, attemptId, 'FINISHED', codex, {
    model_invoked: true, external_effects: 'UNKNOWN', session_id: 'session_codex_overlap',
  });
  const terminalComments = [...comments.slice(0, 4),
    com(806, RECEIPT_MARKER + JSON.stringify(uncertainTerminal), 'worker')];
  assert.equal(selectNext(terminalComments.filter(comment => comment.id !== 804),
    ['t14210184'], 'worker', host, sourceSha, [], heads), null,
  'a terminal Codex receipt with unknown effects retains only its overlapping path reservation');

  const completedDiff = receipt(codex.request_id, attemptId, 'FINISHED', codex, {
    model_invoked: true, session_started: true, session_id: 'session_codex_overlap',
    fingerprint: codexTaskFingerprint(codex), diff_sha256: hash,
    outcome: 'CODEX_CLI_EXIT_0_UNVERIFIED', exit_code: 0,
    tool_execution_evidence: 'OBSERVED', tool_execution_count: 2,
    file_change_tool_evidence: 'COMPLETED', file_change_tool_completed_count: 1,
  });
  const completedComments = [...comments.slice(0, 4),
    com(808, RECEIPT_MARKER + JSON.stringify(completedDiff), 'worker')];
  assert.equal(selectNext(completedComments.filter(comment => comment.id !== 804),
    ['t14210184'], 'worker', host, sourceSha, [], heads)?.id, 802,
  'a complete request-bound Codex diff releases the path lease without claiming task acceptance');

  const dispatcherTerminalComments = [...comments.slice(0, 4),
    com(815, RECEIPT_MARKER + JSON.stringify(completedDiff), 't14210184')];
  assert.equal(selectNext(dispatcherTerminalComments.filter(comment => comment.id !== 804),
    ['t14210184'], 'worker', host, sourceSha, [], heads), null,
  'a dispatcher-authored terminal receipt is only a replay blocker and cannot release the Worker path lease');

  const wrongFingerprint = receipt(codex.request_id, attemptId, 'FINISHED', codex, {
    model_invoked: true, session_started: true, session_id: 'session_codex_overlap',
    fingerprint: hash, diff_sha256: hash, outcome: 'CODEX_CLI_EXIT_0_UNVERIFIED', exit_code: 0,
  });
  const wrongFingerprintComments = [...comments.slice(0, 4),
    com(810, RECEIPT_MARKER + JSON.stringify(wrongFingerprint), 'worker')];
  assert.equal(selectNext(wrongFingerprintComments.filter(comment => comment.id !== 804),
    ['t14210184'], 'worker', host, sourceSha, [], heads), null,
  'a diff whose task fingerprint does not bind the exact write_paths cannot release the lease');

  const unobservedNoEffect = receipt(codex.request_id, attemptId, 'BLOCKED', codex, {
    model_invoked: false,
  });
  const unobservedComments = [...comments.slice(0, 4),
    com(816, RECEIPT_MARKER + JSON.stringify(unobservedNoEffect), 'worker')];
  assert.equal(selectNext(unobservedComments.filter(comment => comment.id !== 804),
    ['t14210184'], 'worker', host, sourceSha, [], heads), null,
  'missing tool evidence cannot be converted into a no-effect terminal');

  const noEffectTerminal = receipt(codex.request_id, attemptId, 'BLOCKED', codex, {
    model_invoked: false, session_started: false,
    tool_execution_evidence: 'OBSERVED',
    tool_execution_count: 0, file_change_tool_evidence: 'UNKNOWN',
  });
  const noEffectComments = [...comments.slice(0, 4),
    com(807, RECEIPT_MARKER + JSON.stringify(noEffectTerminal), 'worker')];
  assert.equal(selectNext(noEffectComments, ['t14210184'], 'worker', host, sourceSha, [], heads)?.id,
    802, 'a verified no-effect Codex terminal releases the path reservation');

  for (const malformedEvidence of [
    { session_started: null },
    { provider_usage_evidence: 'UNVERIFIED' },
    { model_activity_evidence: 'OBSERVED' },
  ]) {
    const malformedTerminal = { ...noEffectTerminal, ...malformedEvidence };
    const malformedComments = [...comments.slice(0, 4),
      com(817, RECEIPT_MARKER + JSON.stringify(malformedTerminal), 'worker')];
    assert.equal(selectNext(malformedComments.filter(comment => comment.id !== 804),
      ['t14210184'], 'worker', host, sourceSha, [], heads), null,
    'malformed no-effect evidence cannot release an overlapping writer lease');
  }

  for (const omittedField of ['session_id', 'diff_sha256', 'token_usage']) {
    const missingExplicitNull = { ...noEffectTerminal };
    delete missingExplicitNull[omittedField];
    const missingFieldComments = [...comments.slice(0, 4),
      com(818, RECEIPT_MARKER + JSON.stringify(missingExplicitNull), 'worker')];
    assert.equal(selectNext(missingFieldComments, ['t14210184'], 'worker', host,
      sourceSha, [], heads)?.id, 804,
    `omitted ${omittedField} cannot be treated as an explicit null or release the overlapping lease`);
  }

  const startedWithoutModel = receipt(codex.request_id, attemptId, 'BLOCKED', codex, {
    model_invoked: false, session_started: true,
  });
  const startedWithoutModelComments = [...comments.slice(0, 4),
    com(814, RECEIPT_MARKER + JSON.stringify(startedWithoutModel), 'worker')];
  assert.equal(selectNext(startedWithoutModelComments.filter(comment => comment.id !== 804),
    ['t14210184'], 'worker', host, sourceSha, [], heads), null,
  'a session-started terminal without a captured diff remains fenced even when model invocation is false');
});

test('legacy Codex unknown scope remains a global fence when a same-ID source job is present', () => {
  const host = 'DESKTOP-1B6PD2P';
  const sourceSha = commit;
  const replacement = { ...codexPlan(['docs/new-review.md']), source_sha: sourceSha };
  const requestId = replacement.request_id;
  const legacy = { schema: 3, project_id: PROJECT, host, request_id: requestId,
    kind: 'codex_plan', source_sha: sourceSha,
    spec_path: 'native-bridge/tasks/codex-review.md', spec_sha256: hash,
    model: 'gpt-6.1-sol', reasoning_effort: 'medium' };
  const overlapping = withHumanGoal(mkjob({
    request_id: 'PTYSD_READY_W1_POSSIBLE_LEGACY_SCOPE_OVERLAP', kind: 'opencode_edit',
    source_sha: sourceSha, spec_path: 'native-bridge/tasks/conflict-test.md', spec_sha256: hash,
    model: 'opencode/deepseek-v4.1-flash-free', variant: 'free',
    edit_paths: ['src/worker.mjs'], source_pr: 461,
  }));
  const legacyStarted = receipt(requestId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'STARTED', legacy, { model_invoked: true, session_started: true,
      session_id: 'legacy_unknown_scope_session' });
  const issueUrl = `https://api.github.com/repos/${REPO}/issues/310`;
  const comments = [
    { ...com(841, encoded(replacement)), issue_url: issueUrl },
    { ...com(842, encoded(overlapping)), issue_url: issueUrl },
    com(843, RECEIPT_MARKER + JSON.stringify(legacyStarted), 'worker'),
  ];
  assert.ok(parseJob(encoded(replacement)), 'the replacement is a valid current Codex source job');
  assert.equal(Object.hasOwn(legacyStarted, 'write_paths'), false,
    'the old Codex attempt has no recoverable write scope');
  const heads = new Map([[461, sourceSha]]);
  assert.equal(selectNext(comments, ['t14210184'], 'worker', host, sourceSha, [], heads), null,
    'a same-ID replacement source cannot release an unknown legacy Codex scope for another writer');
  const noEffectTerminal = receipt(requestId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'BLOCKED', legacy, { model_invoked: false, session_started: false,
      tool_execution_evidence: 'OBSERVED', tool_execution_count: 0,
      file_change_tool_evidence: 'UNKNOWN' });
  const reconciledComments = [comments[0], comments[1],
    com(844, RECEIPT_MARKER + JSON.stringify(noEffectTerminal), 'worker')];
  assert.equal(selectNext(reconciledComments, ['t14210184'], 'worker', host,
    sourceSha, [], heads)?.id, 842,
  'a same-ID source remains dispatchable after a worker-authored, observed zero-effect terminal');
});

test('schema-4 Codex terminal-only receipt releases its verified exact write scope', () => {
  const host = 'DESKTOP-1B6PD2P';
  const sourceSha = commit;
  const codex = codexPlan(['src']);
  const attemptId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const fingerprint = codexTaskFingerprint(codex);
  const started = receipt(codex.request_id, attemptId, 'STARTED', codex, {
    fingerprint, model_invoked: true, session_started: true, session_id: 'session_schema4',
  });
  const terminal = codexTerminalReceipt(started, {
    schema: 1, kind: 'codex_plan', request_id: codex.request_id, attempt_id: attemptId,
    source_sha: sourceSha, exit_code: 0, fingerprint, session_id: 'session_schema4',
    diff_sha256: hash, stdout_sha256: hash, stderr_sha256: hash,
    outcome: 'CODEX_CLI_EXIT_0_UNVERIFIED', model_invoked: true,
    changed_paths: ['src/worker.mjs'], out_of_scope_paths: [], pr_url: null, tests: 'NOT_RUN',
  });
  const candidate = withHumanGoal(mkjob({
    request_id: 'PTYSD_READY_W1_AFTER_TERMINAL_ONLY_CODEX', kind: 'opencode_edit',
    source_sha: sourceSha, spec_path: 'native-bridge/tasks/conflict-test.md', spec_sha256: hash,
    model: 'opencode/deepseek-v4.1-flash-free', variant: 'free',
    edit_paths: ['src/worker.mjs'], source_pr: 461,
  }));
  const issueUrl = `https://api.github.com/repos/${REPO}/issues/310`;
  const comments = [
    { ...com(851, encoded(candidate)), issue_url: issueUrl },
    com(852, RECEIPT_MARKER + JSON.stringify(started), 'worker'),
    com(853, RECEIPT_MARKER + JSON.stringify(terminal), 'worker'),
  ];
  assert.equal(terminal.job_schema, 4,
    'the terminal keeps the authenticated schema-4 scope and Goal fingerprint');
  assert.equal(selectNext(comments, ['t14210184'], 'worker', host, sourceSha, [],
    new Map([[461, sourceSha]]))?.id, 851,
  'a complete exact-source terminal releases only its authenticated path lease when source is gone');
  const badFingerprintTerminal = { ...terminal, task_fingerprint: 'c'.repeat(64) };
  const invalidComments = [comments[0], comments[1],
    com(854, RECEIPT_MARKER + JSON.stringify(badFingerprintTerminal), 'worker')];
  assert.equal(selectNext(invalidComments, ['t14210184'], 'worker', host, sourceSha, [],
    new Map([[461, sourceSha]])), null,
  'a terminal with a mismatched fingerprint cannot release the preceding STARTED lease');
});

test('an unresolved W1 edit scope also excludes an overlapping Codex plan', () => {
  const host = 'DESKTOP-1B6PD2P';
  const sourceSha = commit;
  const w1 = withHumanGoal(mkjob({
    request_id: 'PTYSD_ACTIVE_W1_CODEX_OVERLAP', kind: 'opencode_edit', source_sha: sourceSha,
    spec_path: 'native-bridge/tasks/conflict-test.md', spec_sha256: hash,
    model: 'opencode/deepseek-v4.1-flash-free', variant: 'free',
    edit_paths: ['src/worker.mjs'], source_pr: 461,
  }));
  const codex = codexPlan(['src']);
  const attemptId = '77777777-7777-4777-8777-777777777777';
  const started = receipt(w1.request_id, attemptId, 'STARTED', w1, {
    model_invoked: true, external_effects: 'UNKNOWN',
  });
  const comments = [
    { ...com(811, encoded(w1)), issue_url: `https://api.github.com/repos/${REPO}/issues/310` },
    com(812, encoded(codex)),
    com(813, RECEIPT_MARKER + JSON.stringify(started), 'worker'),
  ];
  assert.equal(selectNext(comments, ['t14210184'], 'worker', host, sourceSha, [],
    new Map([[461, sourceSha]])), null,
  'path reservation is symmetric when Codex is the candidate and W1 owns the active scope');

  const mismatchedSource = receipt(w1.request_id, attemptId, 'STARTED',
    { ...w1, source_sha: 'b'.repeat(40) }, { model_invoked: true });
  const mismatchedComments = [comments[0], comments[1],
    com(814, RECEIPT_MARKER + JSON.stringify(mismatchedSource), 'worker')];
  assert.equal(selectNext(mismatchedComments, ['t14210184'], 'worker', host, sourceSha,
    ['opencode_edit'],
    new Map([[461, sourceSha]])), null,
  'a same-request W1 receipt from a different source SHA remains fenced');
});

test('a schema-6 receipt with a reused request id and different source SHA blocks that candidate', () => {
  const host = 'DESKTOP-1B6PD2P';
  const sourceSha = commit;
  const requestId = 'PTYSD_REUSED_W1_SOURCE_IDENTITY';
  const candidate = withHumanGoal(mkjob({
    schema: 6, request_id: requestId, kind: 'opencode_edit', source_sha: sourceSha,
    spec_path: 'native-bridge/tasks/conflict-test.md', spec_sha256: hash,
    model: 'opencode/deepseek-v4.1-flash-free', variant: 'free',
    edit_paths: ['src/worker.mjs'], source_pr: 461,
  }));
  const oldAttempt = receipt(requestId, '99999999-9999-4999-8999-999999999999',
    'STARTED', { ...candidate, source_sha: 'b'.repeat(40) }, { model_invoked: true });
  const comments = [
    { ...com(831, encoded(candidate)), issue_url: `https://api.github.com/repos/${REPO}/issues/310` },
    com(832, RECEIPT_MARKER + JSON.stringify(oldAttempt), 'worker'),
  ];
  assert.equal(selectNext(comments, ['t14210184'], 'worker', host, sourceSha, [],
    new Map([[461, sourceSha]])), null,
  'same request identity cannot discard a mismatched-source STARTED receipt and replay the candidate');
});

test('legacy Codex receipts without a recoverable source scope fence writers until no effects are proven', () => {
  const host = 'DESKTOP-1B6PD2P';
  const sourceSha = commit;
  const legacy = { schema: 3, project_id: PROJECT, host,
    request_id: 'PTYSD_CODEX_LEGACY_SCOPE_20261030', kind: 'codex_plan',
    source_sha: sourceSha, spec_path: 'native-bridge/tasks/codex-review.md',
    spec_sha256: hash, model: 'gpt-6.1-sol', reasoning_effort: 'medium' };
  const candidate = withHumanGoal(mkjob({
    request_id: 'PTYSD_READY_W1_LEGACY_SCOPE_GUARD', kind: 'opencode_edit',
    source_sha: sourceSha, spec_path: 'native-bridge/tasks/conflict-test.md', spec_sha256: hash,
    model: 'opencode/deepseek-v4.1-flash-free', variant: 'free',
    edit_paths: ['docs/unrelated.md'], source_pr: 461,
  }));
  const attemptId = '88888888-8888-4888-8888-888888888888';
  const legacyStarted = receipt(legacy.request_id, attemptId, 'STARTED', legacy, {
    model_invoked: true, session_started: true, session_id: 'legacy_session_1234',
  });
  assert.equal(Object.hasOwn(legacyStarted, 'write_paths'), false,
    'the fixture represents a valid pre-scope Codex receipt');
  const jobComment = { ...com(821, encoded(candidate)),
    issue_url: `https://api.github.com/repos/${REPO}/issues/310` };
  const startedComments = [jobComment,
    com(822, RECEIPT_MARKER + JSON.stringify(legacyStarted), 'worker')];
  const heads = new Map([[461, sourceSha]]);
  assert.equal(selectNext(startedComments, ['t14210184'], 'worker', host, sourceSha, [], heads), null,
    'an unresolved old Codex attempt with unknown paths fences possible writers');

  const noEffectTerminal = receipt(legacy.request_id, attemptId, 'BLOCKED', legacy, {
    model_invoked: false, session_started: false, tool_execution_evidence: 'OBSERVED',
    tool_execution_count: 0, file_change_tool_evidence: 'UNKNOWN',
  });
  const terminalComments = [jobComment,
    com(822, RECEIPT_MARKER + JSON.stringify(noEffectTerminal), 'worker')];
  assert.equal(selectNext(terminalComments, ['t14210184'], 'worker', host, sourceSha, [], heads)?.id,
    821, 'the old global fence releases only after worker-authored zero-effect evidence');
});

test('Windows write-path overlap normalizes trailing dot and space aliases', () => {
  assert.equal(writePathsOverlap(['src/file.'], ['src/file'], 'win32'), true);
  assert.equal(writePathsOverlap(['src/folder.'], ['src/folder/file.mjs'], 'win32'), true);
  assert.equal(writePathsOverlap(['src/.. /file.mjs'], ['src/file.mjs'], 'win32'), true);
  assert.equal(writePathsOverlap(['src/file.'], ['src/file'], 'linux'), false);
  assert.equal(validCodexWritePaths(['src/.. /file.mjs']), false);
  assert.equal(validCodexWritePaths(['src/.../file.mjs']), false);
  assert.equal(writePathsOverlap(['src/file ./child.mjs'], ['src/file/child.mjs'], 'win32'), true);
  assert.equal(writePathsOverlap(['src/file. /child.mjs'], ['src/file/child.mjs'], 'win32'), true);
});

test('a terminal W2 candidate-root-only diff releases only the W2 same-path writer lease', () => {
  const host = 'DESKTOP-1B6PD2P';
  const sourceSha = commit;
  const makeEdit = (requestId, kind = 'antigravity_edit') => withHumanGoal({
    schema: 6, project_id: PROJECT, host, request_id: requestId, kind,
    source_sha: sourceSha, spec_path: 'native-bridge/tasks/w2-panel.md', spec_sha256: hash,
    model: kind === 'antigravity_edit' ? ANTIGRAVITY_V2_MODEL :
      'opencode/deepseek-v4.1-flash-free',
    variant: kind === 'antigravity_edit' ? 'high' : 'free',
    edit_paths: ['operator-panel/index.html'], source_pr: 461,
  });
  const prior = makeEdit('PTYSD_W2_PRIOR_ISOLATED_DIFF');
  const nextW2 = makeEdit('PTYSD_W2_NEXT_ISOLATED_DIFF');
  const isolatedReceipt = receipt(prior.request_id,
    '55555555-5555-4555-8555-555555555555', 'BLOCKED', prior, {
      model_invoked: true,
      session_id: '66666666-6666-4666-8666-666666666666',
      external_effects: 'UNKNOWN',
      source_diff_evidence: 'CAPTURED',
      task_acceptance: 'UNKNOWN',
      coding_state: 'DIFF_CAPTURED_UNVERIFIED',
      scope_valid: true,
      diff_sha256: 'c'.repeat(64),
      diff_bytes: 18413,
      changed_files: ['operator-panel/index.html'],
      tool_execution_evidence: 'OBSERVED',
      tool_execution_count: 64,
      file_change_tool_evidence: 'OBSERVED',
      file_change_tool_completed_count: 19,
      file_change_tool_failed_count: 4,
      file_change_tool_incomplete_count: 0,
      file_change_target_evidence: {
        status: 'CANDIDATE_ROOT_ONLY', tool_count: 23, target_count: 23,
        candidate_root_count: 23, registered_root_count: 0,
        outside_or_unknown_root_count: 0, relative_or_unknown_root_count: 0,
        unidentified_tool_count: 0,
      },
      permission_mode_evidence: 'REQUEST_REVIEW_CONFIRMED',
      tool_policy_evidence: 'W2_NONFILE_ACTIONS_DENIED',
      cli_binary_integrity_evidence: 'MATCHED',
      forbidden_tool_execution_evidence: 'NOT_OBSERVED',
    });
  const comments = [
    { ...com(801, encoded(prior)), issue_url: `https://api.github.com/repos/${REPO}/issues/310` },
    { ...com(802, encoded(nextW2)), issue_url: `https://api.github.com/repos/${REPO}/issues/310` },
    com(803, RECEIPT_MARKER + JSON.stringify(isolatedReceipt), 'worker'),
  ];
  assert.ok(parseReceipt(RECEIPT_MARKER + JSON.stringify(isolatedReceipt)));
  assert.equal(isolatedReceipt.external_effects, 'UNKNOWN');
  assert.equal(isolatedReceipt.task_acceptance, 'UNKNOWN');
  const next = selectNext(comments, ['t14210184'], 'worker', host, sourceSha, [],
    new Map([[461, sourceSha]]));
  assert.equal(next?.id, 802,
    'a complete, isolated W2 diff frees the path lease without accepting the prior task');
});

test('a terminal W2 multi-target candidate-root-only diff releases the same-path writer lease', () => {
  const host = 'DESKTOP-1B6PD2P';
  const sourceSha = commit;
  const makeEdit = requestId => withHumanGoal({
    schema: 6, project_id: PROJECT, host, request_id: requestId, kind: 'antigravity_edit',
    source_sha: sourceSha, spec_path: 'native-bridge/tasks/w2-panel.md', spec_sha256: hash,
    model: ANTIGRAVITY_V2_MODEL, variant: 'high',
    edit_paths: ['operator-panel/index.html'], source_pr: 461,
  });
  const prior = makeEdit('PTYSD_W2_PRIOR_MULTI_TARGET_ISOLATED_DIFF');
  const nextW2 = makeEdit('PTYSD_W2_NEXT_MULTI_TARGET_ISOLATED_DIFF');
  const isolatedReceipt = receipt(prior.request_id,
    '55555555-5555-4555-8555-555555555556', 'BLOCKED', prior, {
      model_invoked: true,
      session_id: '66666666-6666-4666-8666-666666666667',
      external_effects: 'UNKNOWN',
      source_diff_evidence: 'CAPTURED',
      task_acceptance: 'UNKNOWN',
      coding_state: 'DIFF_CAPTURED_UNVERIFIED',
      scope_valid: true,
      diff_sha256: 'c'.repeat(64),
      diff_bytes: 18413,
      changed_files: ['operator-panel/index.html'],
      tool_execution_evidence: 'OBSERVED',
      tool_execution_count: 64,
      file_change_tool_evidence: 'OBSERVED',
      file_change_tool_completed_count: 19,
      file_change_tool_failed_count: 4,
      file_change_tool_incomplete_count: 0,
      file_change_target_evidence: {
        status: 'CANDIDATE_ROOT_ONLY', tool_count: 23, target_count: 27,
        candidate_root_count: 27, registered_root_count: 0,
        outside_or_unknown_root_count: 0, relative_or_unknown_root_count: 0,
        unidentified_tool_count: 0,
      },
      permission_mode_evidence: 'REQUEST_REVIEW_CONFIRMED',
      tool_policy_evidence: 'W2_NONFILE_ACTIONS_DENIED',
      cli_binary_integrity_evidence: 'MATCHED',
      forbidden_tool_execution_evidence: 'NOT_OBSERVED',
    });
  const comments = [
    { ...com(801, encoded(prior)), issue_url: `https://api.github.com/repos/${REPO}/issues/310` },
    { ...com(802, encoded(nextW2)), issue_url: `https://api.github.com/repos/${REPO}/issues/310` },
    com(803, RECEIPT_MARKER + JSON.stringify(isolatedReceipt), 'worker'),
  ];
  assert.ok(parseReceipt(RECEIPT_MARKER + JSON.stringify(isolatedReceipt)));
  assert.equal(isolatedReceipt.external_effects, 'UNKNOWN');
  assert.equal(isolatedReceipt.task_acceptance, 'UNKNOWN');
  const next = selectNext(comments, ['t14210184'], 'worker', host, sourceSha, [],
    new Map([[461, sourceSha]]));
  assert.equal(next?.id, 802,
    'verified multi-target candidate-root evidence frees the same-path W2 lease');
});

test('candidate-root lease release fails closed for mixed targets and other Worker lanes', () => {
  const host = 'DESKTOP-1B6PD2P';
  const sourceSha = commit;
  const makeEdit = (requestId, kind = 'antigravity_edit') => withHumanGoal({
    schema: 6, project_id: PROJECT, host, request_id: requestId, kind,
    source_sha: sourceSha, spec_path: 'native-bridge/tasks/w2-panel.md', spec_sha256: hash,
    model: kind === 'antigravity_edit' ? ANTIGRAVITY_V2_MODEL :
      'opencode/deepseek-v4.1-flash-free',
    variant: kind === 'antigravity_edit' ? 'high' : 'free',
    edit_paths: ['operator-panel/index.html'], source_pr: 461,
  });
  const prior = makeEdit('PTYSD_W2_PRIOR_MIXED_TARGETS');
  const nextW2 = makeEdit('PTYSD_W2_NEXT_MIXED_TARGETS');
  const receiptFor = (targetEvidence, attemptId) => receipt(prior.request_id, attemptId,
    'BLOCKED', prior, {
      model_invoked: true, session_id: '66666666-6666-4666-8666-666666666666',
      external_effects: 'UNKNOWN', source_diff_evidence: 'CAPTURED',
      task_acceptance: 'UNKNOWN', coding_state: 'DIFF_CAPTURED_UNVERIFIED', scope_valid: true,
      diff_sha256: 'c'.repeat(64), diff_bytes: 100,
      changed_files: ['operator-panel/index.html'], tool_execution_evidence: 'OBSERVED',
      tool_execution_count: 3, file_change_tool_evidence: 'OBSERVED',
      file_change_tool_completed_count: 2, file_change_tool_failed_count: 1,
      file_change_tool_incomplete_count: 0, file_change_target_evidence: targetEvidence,
      permission_mode_evidence: 'REQUEST_REVIEW_CONFIRMED',
      tool_policy_evidence: 'W2_NONFILE_ACTIONS_DENIED',
      cli_binary_integrity_evidence: 'MATCHED',
      forbidden_tool_execution_evidence: 'NOT_OBSERVED',
    });
  const mixedReceipt = receiptFor({
    status: 'MIXED_ROOTS', tool_count: 3, target_count: 3,
    candidate_root_count: 2, registered_root_count: 1,
    outside_or_unknown_root_count: 0, relative_or_unknown_root_count: 0,
    unidentified_tool_count: 0,
  }, '77777777-7777-4777-8777-777777777777');
  const mixedComments = [
    { ...com(811, encoded(prior)), issue_url: `https://api.github.com/repos/${REPO}/issues/310` },
    { ...com(812, encoded(nextW2)), issue_url: `https://api.github.com/repos/${REPO}/issues/310` },
    com(813, RECEIPT_MARKER + JSON.stringify(mixedReceipt), 'worker'),
    { ...com(814, encoded(makeEdit('PTYSD_W1_OVERLAPPING_MIXED_W2', 'opencode_edit'))),
      issue_url: `https://api.github.com/repos/${REPO}/issues/310` },
    com(815, encoded(mkjob({ host, request_id: 'PTYSD_W2_MIXED_TARGET_INDEPENDENT_PING' }))),
  ];
  assert.ok(parseReceipt(RECEIPT_MARKER + JSON.stringify(mixedReceipt)));
  assert.equal(selectNext(mixedComments, ['t14210184'], 'worker', host, sourceSha, [],
    new Map([[461, sourceSha]]))?.id, 815,
  'mixed-root writes continue to hold the same-path lease across W1 and W2');

  const isolatedReceipt = receiptFor({
    status: 'CANDIDATE_ROOT_ONLY', tool_count: 3, target_count: 3,
    candidate_root_count: 3, registered_root_count: 0,
    outside_or_unknown_root_count: 0, relative_or_unknown_root_count: 0,
    unidentified_tool_count: 0,
  }, '88888888-8888-4888-8888-888888888888');
  const overlappingW1 = makeEdit('PTYSD_W1_OVERLAPPING_ISOLATED_W2', 'opencode_edit');
  const crossLaneComments = [
    { ...com(821, encoded(prior)), issue_url: `https://api.github.com/repos/${REPO}/issues/310` },
    { ...com(822, encoded(overlappingW1)), issue_url: `https://api.github.com/repos/${REPO}/issues/310` },
    com(823, RECEIPT_MARKER + JSON.stringify(isolatedReceipt), 'worker'),
    com(824, encoded(mkjob({ host, request_id: 'PTYSD_CROSS_LANE_INDEPENDENT_PING' }))),
  ];
  assert.equal(selectNext(crossLaneComments, ['t14210184'], 'worker', host, sourceSha, [],
    new Map([[461, sourceSha]]))?.id, 822,
  'a verified W2 candidate-root-only terminal releases the overlapping W1 path lease');
});

test('a terminal W1 edit releases its path lease so the next distinct W1 request is selected once', () => {
  const host = 'DESKTOP-1B6PD2P';
  const sourceSha = 'c'.repeat(40);
  const sourcePr = 437;
  const makeRequest = requestId => withHumanGoal({ schema: 6, project_id: PROJECT, host,
    request_id: requestId, kind: 'opencode_edit', source_sha: sourceSha,
    spec_path: 'native-bridge/tasks/w1-next-request-after-terminal.md', spec_sha256: hash,
    model: 'opencode/deepseek-v4.1-flash-free', variant: 'free',
    edit_paths: ['native-bridge/worker.mjs'], source_pr: sourcePr });
  const older = makeRequest('PTYSD_W1_TERMINAL_THEN_NEXT');
  const newer = makeRequest('PTYSD_W1_DISTINCT_NEXT_READY');
  assert.notEqual(older.request_id, newer.request_id);
  assert.equal(older.source_pr, newer.source_pr, 'both requests bind the same exact PR');
  assert.equal(older.source_sha, newer.source_sha, 'both requests bind the same exact PR head');
  assert.deepEqual(older.edit_paths, newer.edit_paths,
    'the sequential requests contend for the same path lease');
  assert.ok(parseJob(encoded(older)));
  assert.ok(parseJob(encoded(newer)));

  const attemptId = '99999999-9999-4999-8999-999999999999';
  const finished = receipt(older.request_id, attemptId, 'FINISHED', older, {
    outcome: 'V2_EDIT_DIFF_CAPTURED_UNVERIFIED', exit_code: 0,
    model_invoked: true, session_id: '77777777-7777-4777-8777-777777777777',
    // A terminal attempt still carries UNKNOWN acceptance and effects. Only the
    // complete, request-bound scoped diff releases the same-path writer lease.
    external_effects: 'UNKNOWN', source_diff_evidence: 'CAPTURED',
    task_acceptance: 'UNKNOWN', coding_state: 'DIFF_CAPTURED_UNVERIFIED',
    scope_valid: true, diff_sha256: 'd'.repeat(64), diff_bytes: 96,
    changed_files: ['native-bridge/worker.mjs'],
  });
  assert.equal(parseReceipt(RECEIPT_MARKER + JSON.stringify(finished))?.state, 'FINISHED');
  assert.equal(finished.external_effects, 'UNKNOWN');
  assert.equal(finished.task_acceptance, 'UNKNOWN');
  assert.equal(finished.source_pr, sourcePr);
  assert.equal(finished.source_diff_evidence, 'CAPTURED');
  assert.equal(finished.coding_state, 'DIFF_CAPTURED_UNVERIFIED');
  assert.equal(finished.scope_valid, true);
  assert.equal(finished.edit_paths_sha256, h(JSON.stringify(older.edit_paths)));
  assert.equal(finished.changed_files_sha256, h(JSON.stringify(['native-bridge/worker.mjs'])));

  const olderComment = { ...com(901, encoded(older)),
    issue_url: `https://api.github.com/repos/${REPO}/issues/310` };
  const newerComment = { ...com(902, encoded(newer)),
    issue_url: `https://api.github.com/repos/${REPO}/issues/310` };
  const attemptComment = com(903, RECEIPT_MARKER + JSON.stringify(finished), 't14210184');
  const comments = [olderComment, attemptComment, newerComment];
  const before = structuredClone(comments);
  const sources = new Map([[sourcePr, sourceSha]]);

  const selected = selectNext(comments, ['t14210184'], 'worker', host, sourceSha, [], sources);
  assert.equal(selected?.id, newerComment.id);
  assert.equal(selected?.job.request_id, newer.request_id);
  assert.equal(selected?.originalBody, newerComment.body);
  assert.notEqual(selected?.job.request_id, older.request_id,
    'the terminal prior W1 request is not replayed');

  assert.deepEqual(comments, before,
    'selection neither rewrites nor replays the terminal prior request or attempt');
  assert.equal(comments.filter(comment =>
    parseJob(comment.body)?.request_id === newer.request_id).length, 1,
  'the newer READY request is present exactly once');
  assert.equal(comments.filter(comment =>
    parseReceipt(comment.body)?.request_id === older.request_id).length, 1,
  'the prior attempt retains exactly its one terminal receipt');
  assert.equal(comments.some(comment =>
    parseReceipt(comment.body)?.request_id === newer.request_id), false,
  'selecting the newer request does not invent an attempt receipt');
});

test('a foreign dispatcher terminal edit keeps its lease only when the exact scoped diff is complete', () => {
  const host = 'DESKTOP-1B6PD2P';
  const sourceSha = 'c'.repeat(40);
  const sourcePr = 437;
  const makeRequest = (requestId, editPaths) => withHumanGoal({
    schema: 6, project_id: PROJECT, host, request_id: requestId, kind: 'opencode_edit',
    source_sha: sourceSha,
    spec_path: `native-bridge/tasks/${requestId.toLowerCase().replaceAll('_', '-')}.md`,
    spec_sha256: hash, model: 'opencode/deepseek-v4.1-flash-free', variant: 'free',
    edit_paths: editPaths, source_pr: sourcePr,
  });
  const older = makeRequest('PTYSD_W1_FOREIGN_TERMINAL_OWNER', ['native-bridge/worker.mjs']);
  const newer = makeRequest('PTYSD_W1_AFTER_FOREIGN_TERMINAL', ['native-bridge/worker.mjs']);
  const independent = makeRequest('PTYSD_W1_FOREIGN_TERMINAL_INDEPENDENT', ['tests/other.test.mjs']);
  const finished = receipt(older.request_id,
    '99999999-9999-4999-8999-999999999999', 'FINISHED', older, {
      outcome: 'V2_EDIT_DIFF_CAPTURED_UNVERIFIED', exit_code: 0,
      model_invoked: true, session_id: '77777777-7777-4777-8777-777777777777',
      external_effects: 'UNKNOWN', source_diff_evidence: 'CAPTURED',
      task_acceptance: 'UNKNOWN', coding_state: 'DIFF_CAPTURED_UNVERIFIED',
      scope_valid: true, diff_sha256: 'd'.repeat(64), diff_bytes: 96,
      changed_files: ['native-bridge/worker.mjs'],
    });
  const baseComments = [
    { ...com(931, encoded(older)), issue_url: `https://api.github.com/repos/${REPO}/issues/310` },
    com(932, RECEIPT_MARKER + JSON.stringify(finished), 't14210184'),
    { ...com(933, encoded(newer)), issue_url: `https://api.github.com/repos/${REPO}/issues/310` },
    { ...com(934, encoded(independent)), issue_url: `https://api.github.com/repos/${REPO}/issues/310` },
  ];
  assert.equal(finished.external_effects, 'UNKNOWN');
  assert.equal(finished.task_acceptance, 'UNKNOWN');
  assert.equal(selectNext(baseComments, ['t14210184'], 'wfvupu1212', host, sourceSha, [],
    new Map([[sourcePr, sourceSha]]))?.id, 933,
  'an allowlisted dispatcher terminal with a complete bound diff releases the finished W1 lease');

  const incomplete = { ...finished, scope_valid: false };
  assert.ok(parseReceipt(RECEIPT_MARKER + JSON.stringify(incomplete)));
  const incompleteComments = baseComments.map(comment => comment.id === 932
    ? { ...comment, body: RECEIPT_MARKER + JSON.stringify(incomplete) } : comment);
  assert.equal(selectNext(incompleteComments, ['t14210184'], 'wfvupu1212', host,
    sourceSha, [], new Map([[sourcePr, sourceSha]]))?.id, 934,
  'a foreign terminal lacking a complete bound diff keeps overlapping work blocked');
});

const sourceAcceptanceComment = (job, completedReceipt) =>
  `PTYSD_V53R4_R2_EVIDENCE_RECONCILIATION_V1\n` +
  `record_type=ADDITIVE_CODEX_SOURCE_AND_DIFF_RECONCILIATION_NOT_NATIVE_WORKER_RECEIPT\n` +
  `repo=${REPO}\nproject_id=${PROJECT}\nhuman_goal_comment_id=${job.goal_comment_id}\n` +
  `goal_body_sha256=${job.goal_body_sha256}\n` +
  `request_id=${job.request_id}\nattempt_id=${completedReceipt.attempt_id}\n` +
  `source_pr=${job.source_pr}\nsource_head=${job.source_sha}\n` +
  `spec_path=${job.spec_path}\nspec_sha256=${job.spec_sha256}\nmodel=${job.model}\n` +
  `worker_diff_sha256=${completedReceipt.diff_sha256}\ndiff_sha256=${completedReceipt.diff_sha256}\n` +
  `codex_review=PASS_EXACT_DIFF_AND_SCOPE\nintegration=PR_665_MERGED\n` +
  `integration_commit=080e592b2cd691494f1297c47dd307a275bd52f1\n` +
  `pr_665_head=450d483e7258c62772a8fd5a620aacf9b8dde3aa\n` +
  `pr_665_checks=check-native-only=SUCCESS;csg-trusted-verifier-hosted=SUCCESS;v2-native-windows=SUCCESS\n` +
  `source_acceptance=ACCEPTED_FOR_EXACT_WORKER_DIFF_AND_MERGED_PR_665`;

test('a completed scoped edit suppresses only an exact duplicate request and leaves other READY work selectable', () => {
  const host = 'DESKTOP-1B6PD2P';
  const sourceSha = '497f60d5377a8a08c6a303e246d5f5378f4db45f';
  const sourcePr = 664;
  const goalHash = '2f1829da0e1f5105a384be03904b2289c57c05e8a44215c4824fb6b8631d8f7b';
  const makeRequest = (requestId, overrides = {}) => withHumanGoal({
    schema: 6, project_id: PROJECT, host, request_id: requestId,
    kind: 'opencode_edit', source_sha: sourceSha,
    spec_path: 'native-bridge/tasks/w1-native-task-info-partial-readback.md',
    spec_sha256: '228ad870822a567e6e8fb52ac74543288092e9797fb6fa0f96e2efbe2e9d8de7',
    model: 'opencode/deepseek-v4.1-flash-free', variant: null,
    edit_paths: ['native-bridge/operator-observation.mjs', 'tests/operator-observation.test.mjs'],
    source_pr: sourcePr, ...overrides,
  });
  const completed = { ...makeRequest('W1_TASKINFO_PARTIAL_20261101_A84C91E2'), goal_body_sha256: goalHash };
  const duplicate = { ...makeRequest(
    'W1_TASKINFO_PARTIAL_DUP_20261101'),
  goal_body_sha256: goalHash };
  const independent = makeRequest('PTYSD_W1_INDEPENDENT_READY', {
    spec_path: 'native-bridge/tasks/w1-independent-ready.md',
    edit_paths: ['tests/native-bridge.test.mjs'],
  });
  const finished = receipt(completed.request_id,
    '84e8dfee-a704-43ef-9cc5-3bb6da0279c7', 'FINISHED', completed, {
      outcome: 'V2_EDIT_DIFF_CAPTURED_UNVERIFIED', exit_code: 0,
      model_invoked: true, session_id: 'ses_e6d482e8cffenfCUm8UHz4hlBV',
      external_effects: 'UNKNOWN', source_diff_evidence: 'CAPTURED',
      task_acceptance: 'UNKNOWN', coding_state: 'DIFF_CAPTURED_UNVERIFIED',
      scope_valid: true,
      diff_sha256: '25d5c925579246b66c238211df289cee3ef19e457832d509f45938a4e139214e',
      diff_bytes: 5480,
      changed_files: ['native-bridge/operator-observation.mjs', 'tests/operator-observation.test.mjs'],
    });
  const comments = [
    { ...com(901, encoded(duplicate)), issue_url: `https://api.github.com/repos/${REPO}/issues/310` },
    { ...com(902, encoded(completed)), issue_url: `https://api.github.com/repos/${REPO}/issues/310` },
    com(903, RECEIPT_MARKER + JSON.stringify(finished), 'worker'),
    { ...com(904, encoded(independent)), issue_url: `https://api.github.com/repos/${REPO}/issues/310` },
    { ...com(905, sourceAcceptanceComment(completed, finished), 't14210184'),
      issue_url: `https://api.github.com/repos/${REPO}/issues/407` },
  ];
  assert.ok(parseCodexSourceAcceptance(comments.at(-1), ['t14210184']));
  assert.equal(finished.task_acceptance, 'UNKNOWN');
  assert.equal(finished.external_effects, 'UNKNOWN');
  const selected = selectNext(comments, ['t14210184'], 'worker', host, sourceSha, [],
    new Map([[sourcePr, sourceSha]]));
  assert.equal(selected?.id, 904,
    'the identical unstarted duplicate is suppressed without starving another READY edit');
  assert.equal(comments.some(comment => parseReceipt(comment.body)?.request_id === duplicate.request_id), false,
    'duplicate suppression does not invent or rewrite a receipt');
  for (const [caseIndex, rejected] of [
    sourceAcceptanceComment(completed, finished).replace(
      'ACCEPTED_FOR_EXACT_WORKER_DIFF_AND_MERGED_PR_665', 'REJECTED'),
    sourceAcceptanceComment(completed, finished).replace(`source_head=${sourceSha}`,
      `source_head=${'a'.repeat(40)}`),
    sourceAcceptanceComment(completed, finished).replace('v2-native-windows=SUCCESS',
      'v2-native-windows=FAILURE'),
    sourceAcceptanceComment(completed, finished) + ';check-native-only=SUCCESS',
  ].entries()) {
    const withoutValidAcceptance = comments.filter(comment => comment.id !== 905)
      .concat({ ...com(905, rejected, 't14210184'),
        issue_url: `https://api.github.com/repos/${REPO}/issues/407` });
    assert.equal(selectNext(withoutValidAcceptance, ['t14210184'], 'worker', host,
      sourceSha, [], new Map([[sourcePr, sourceSha]]))?.id, 901,
    `invalid source acceptance case ${caseIndex} cannot suppress a queued request`);
  }
  assert.equal(parseCodexSourceAcceptance({
    ...comments.at(-1), issue_url: `https://api.github.com/repos/${REPO}/issues/310`,
  }, ['t14210184']), null, 'acceptance outside the formal receipt issue cannot suppress work');
  const noGoalBinding = sourceAcceptanceComment(completed, finished)
    .replace(`human_goal_comment_id=${completed.goal_comment_id}\n`, '');
  assert.equal(parseCodexSourceAcceptance({ ...comments.at(-1), body: noGoalBinding },
    ['t14210184']), null, 'acceptance without the exact Human GOAL binding fails closed');
});

test('the formal W2 V1 Codex acceptance format is parsed only from the canonical receipt issue', () => {
  const acceptance = [
    'PTYSD_V53R4_CODEX_SOURCE_ACCEPTANCE_V1',
    'record_type=ADDITIVE_CODEX_SOURCE_ACCEPTANCE_NOT_NATIVE_WORKER_RECEIPT',
    `repo=${REPO}`,
    `project_id=${PROJECT}`,
    'goal_comment_id=6188322050',
    'goal_body_sha256=2f1829da0e1f5105a384be03904b2289c57c05e8a44215c4824fb6b8631d8f7b',
    'request_id=W2_SAME_POLL_WAITING_RECOVERY_20261101_CE5F40A1',
    'attempt_id=9855fb47-d48b-4c53-8a8b-81c4d3f90155',
    'source_pr=666',
    'source_head=cd236aa968e4cb5b7875700b94f6b3f856442885',
    'spec_path=native-bridge/tasks/w2-executor-readiness-failure-keeps-w1-moving.md',
    'spec_sha256=32ce0c12b911400317e0d5f07c12b5d961146731d56d6a57c57a27d259e8034d',
    'model=gemini-3.8-flash-high',
    'worker_diff_sha256=ec5cd249a76a47ba8407b937992ef390576b0cd8e010a9dba0c146bed3caa22a',
    'codex_patch_scope_review=PASS_EXACT_SINGLE_PATH_DIFF_MATCHES_TASK_SPEC',
    'result_pr=667',
    'result_head=a7f377c4bf7cdd5c4b9af165870bd435b60406d6',
    'result_pr_merge_commit=6cfe6986ff2a38c5f04bbc0db18b383863d9945c',
    'trusted_exact_head_checks=check-native-only:SUCCESS;csg-trusted-verifier-hosted:SUCCESS;v2-native-windows:SUCCESS',
    'source_acceptance=ACCEPTED_FOR_EXACT_WORKER_DIFF_AND_MERGED_RESULT_PR_667',
  ].join('\n');
  const comment = { ...com(920, acceptance),
    issue_url: `https://api.github.com/repos/${REPO}/issues/407` };
  const parsed = parseCodexSourceAcceptance(comment, ['t14210184']);
  assert.equal(parsed?.request_id, 'W2_SAME_POLL_WAITING_RECOVERY_20261101_CE5F40A1');
  assert.equal(parsed?.source_sha, 'cd236aa968e4cb5b7875700b94f6b3f856442885');
  assert.equal(parsed?.goal_comment_id, 6188322050);
  assert.equal(parseCodexSourceAcceptance({ ...comment, issue_url:
    `https://api.github.com/repos/${REPO}/issues/310` }, ['t14210184']), null);
  assert.equal(parseCodexSourceAcceptance(comment, ['other-dispatcher']), null);
});

test('a different spec identity is not suppressed by a completed edit with an overlapping path', () => {
  const host = 'DESKTOP-1B6PD2P';
  const sourceSha = 'c'.repeat(40);
  const sourcePr = 437;
  const makeRequest = (requestId, specSha) => withHumanGoal({
    schema: 6, project_id: PROJECT, host, request_id: requestId,
    kind: 'opencode_edit', source_sha: sourceSha,
    spec_path: 'native-bridge/tasks/w1-next-request-after-terminal.md', spec_sha256: specSha,
    model: 'opencode/deepseek-v4.1-flash-free', variant: 'free',
    edit_paths: ['native-bridge/worker.mjs'], source_pr: sourcePr,
  });
  const completed = makeRequest('PTYSD_W1_PRIOR_SPEC_COMPLETED', hash);
  const differentSpec = makeRequest('PTYSD_W1_DIFFERENT_SPEC_READY', 'e'.repeat(64));
  const finished = receipt(completed.request_id,
    '99999999-9999-4999-8999-999999999999', 'FINISHED', completed, {
      outcome: 'V2_EDIT_DIFF_CAPTURED_UNVERIFIED', exit_code: 0,
      model_invoked: true, session_id: '77777777-7777-4777-8777-777777777777',
      external_effects: 'UNKNOWN', source_diff_evidence: 'CAPTURED',
      task_acceptance: 'UNKNOWN', coding_state: 'DIFF_CAPTURED_UNVERIFIED',
      scope_valid: true, diff_sha256: 'd'.repeat(64), diff_bytes: 96,
      changed_files: ['native-bridge/worker.mjs'],
    });
  const comments = [
    { ...com(911, encoded(completed)), issue_url: `https://api.github.com/repos/${REPO}/issues/310` },
    com(912, RECEIPT_MARKER + JSON.stringify(finished), 'worker'),
    { ...com(913, encoded(differentSpec)), issue_url: `https://api.github.com/repos/${REPO}/issues/310` },
    { ...com(914, sourceAcceptanceComment(completed, finished), 't14210184'),
      issue_url: `https://api.github.com/repos/${REPO}/issues/407` },
  ];
  const selected = selectNext(comments, ['t14210184'], 'worker', host, sourceSha, [],
    new Map([[sourcePr, sourceSha]]));
  assert.equal(selected?.job.request_id, differentSpec.request_id,
    'the guard requires exact spec identity and leaves a distinct task eligible');
});

test('a later W1 poll starts and dispatches the next distinct edit after the prior terminal receipt', async () => {
  const root = mkdtempSync(join(homedir(), '.ptysd-w1-next-after-terminal-poll-'));
  try {
    const workspace = join(root, 'workspace');
    const stateDir = join(root, 'state');
    mkdirSync(workspace);
    mkdirSync(join(workspace, 'native-bridge'), { recursive: true });
    writeFileSync(join(workspace, 'native-bridge', 'worker.mjs'), 'export const fixture = true;\n');
    mkdirSync(stateDir);
    const host = hostname().toUpperCase();
    const spec = 'Synthetic W1 continuation task; dispatch only, never invoke a model.';
    const request = requestId => withHumanGoal({
      project_id: PROJECT,
      host,
      request_id: requestId,
      kind: 'opencode_edit',
      source_sha: commit,
      spec_path: 'native-bridge/tasks/w1-next-request-after-terminal.md',
      spec_sha256: h(spec),
      model: 'opencode/deepseek-v4.1-flash-free',
      variant: 'free',
      edit_paths: ['native-bridge/worker.mjs'],
      source_pr: 437,
    });
    const priorJob = request('PTYSD_W1_TERMINAL_BEFORE_NEXT_POLL_20261030');
    const nextJob = request('PTYSD_W1_NEXT_POLL_DISPATCH_ONCE_20261030');
    const sourceComment = (id, job) => ({
      ...com(id, encoded(job)),
      issue_url: `https://api.github.com/repos/${REPO}/issues/310`,
    });
    const goalJobs = [sourceComment(901, priorJob), sourceComment(902, nextJob)];
    const priorAttemptId = '99999999-9999-4999-8999-999999999998';
    const priorTerminal = receipt(priorJob.request_id, priorAttemptId, 'FINISHED', priorJob, {
      outcome: 'V2_EDIT_DIFF_CAPTURED_UNVERIFIED',
      exit_code: 0,
      model_invoked: true,
      session_id: '77777777-7777-4777-8777-777777777778',
      external_effects: 'UNKNOWN',
      source_diff_evidence: 'CAPTURED',
      task_acceptance: 'UNKNOWN',
      coding_state: 'DIFF_CAPTURED_UNVERIFIED',
      scope_valid: true,
      diff_sha256: 'd'.repeat(64),
      diff_bytes: 96,
      changed_files: ['native-bridge/worker.mjs'],
    });
    assert.equal(priorTerminal.external_effects, 'UNKNOWN');
    assert.equal(priorTerminal.task_acceptance, 'UNKNOWN');
    const receiptComments = [com(903, RECEIPT_MARKER + JSON.stringify(priorTerminal), 'worker')];
    const executor = executorDescriptorForLane('OpenCode', 1001);
    const config = {
      repo: REPO,
      project_id: PROJECT,
      host,
      issue: 407,
      workspace,
      state_dir: stateDir,
      dispatchers: ['t14210184'],
      executors: { opencode: executor },
      enable_v2_model_runs: true,
      allowed_models: { 'opencode/deepseek-v4.1-flash-free': ['free'] },
    };
    const posted = [];
    const logs = [];
    let nextCommentId = 904;
    let bundles = 0;
    let dispatches = 0;
    const adapters = {
      goalCommentsRead: () => [humanGoalComment(), ...goalJobs],
      readExecutorWorkspace: descriptor => {
        assert.equal(descriptor, executor);
        return workspace;
      },
      apiRead(uri) {
        if (uri === 'user') return { login: 'worker' };
        if (uri === `repos/${REPO}/issues/407`) return { title: ISSUE_TITLE, state: 'open' };
        if (uri === `repos/${REPO}/git/ref/heads/main`) return { object: { sha: commit } };
        if (uri === `repos/${REPO}/issues/comments/6188322050`) return humanGoalComment();
        if (uri === `repos/${REPO}/pulls/437`) return {
          number: 437,
          state: 'open',
          base: { ref: 'main', repo: { id: 1352411536, full_name: REPO } },
          head: { sha: commit, repo: { id: 1352411536, full_name: REPO } },
        };
        const commentMatch = uri.match(new RegExp(
          `^repos/${REPO.replaceAll('/', '\\/')}\/issues\/comments\\/(\\d+)$`));
        if (commentMatch) return goalJobs.find(item => item.id === Number(commentMatch[1]));
        if (uri.startsWith(`repos/${REPO}/contents/`))
          return { encoding: 'base64', content: Buffer.from(spec).toString('base64') };
        throw new Error(`UNEXPECTED_W1_NEXT_AFTER_TERMINAL_API_${uri}`);
      },
      commentsRead: () => receiptComments,
      assertExecutorTaskReady: descriptor => {
        assert.equal(descriptor, executor);
        return { ready: true };
      },
      createExecutorSourceBundle: ({ descriptor, job, attemptId }) => {
        assert.equal(descriptor, executor);
        assert.equal(job.request_id, nextJob.request_id);
        assert.equal(job.source_sha, commit);
        assert.equal(job.source_pr, 437);
        assert.deepEqual(job.edit_paths, ['native-bridge/worker.mjs']);
        bundles++;
        return { attempt_id: attemptId, source_sha: job.source_sha, sha256: 'c'.repeat(64) };
      },
      dispatchToExecutor: (descriptor, manifest) => {
        assert.equal(descriptor, executor);
        assert.equal(manifest.job.request_id, nextJob.request_id);
        assert.equal(manifest.source_bundle_sha256, 'c'.repeat(64));
        dispatches++;
        return { outcome: 'SYNTHETIC_DISPATCH_ACK_NOT_EXECUTION' };
      },
      writeReceipt(receiptConfig, data, login) {
        assert.equal(receiptConfig.issue, 407);
        posted.push(data);
        receiptComments.push(com(nextCommentId++, RECEIPT_MARKER + JSON.stringify(data), login));
      },
      runPlan: () => { throw new Error('DISPATCH_MUST_NOT_INVOKE_A_MODEL_INLINE'); },
      observationDependencies: { collectWindowsObservation: () => ({ status: 'UNKNOWN' }) },
      log: value => logs.push(value),
    };

    const result = await runWorkerImplementation(config, adapters);
    assert.equal(result.state, 'DISPATCHED', JSON.stringify({ result, logs }));
    assert.equal(result.request_id, nextJob.request_id);
    assert.equal(bundles, 1);
    assert.equal(dispatches, 1);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].request_id, nextJob.request_id);
    assert.equal(posted[0].attempt_id, result.attempt_id);
    assert.equal(posted[0].state, 'STARTED');
    assert.equal(posted[0].model_invoked, null,
      'executor dispatch is not evidence that the model has started');
    assert.equal(posted[0].task_acceptance, 'UNKNOWN');
    assert.equal(posted[0].external_effects, 'UNKNOWN');
    assert.equal(posted[0].source_diff_evidence, 'NOT_INSPECTED');
    assert.equal(posted[0].source_sha, commit);
    assert.equal(posted[0].source_pr, 437);
    assert.equal(posted.some(item => item.request_id === priorJob.request_id), false,
      'the prior terminal attempt is not replayed on the next poll');
    assert.equal(receiptComments.filter(item => parseReceipt(item.body)?.request_id === nextJob.request_id).length, 1,
      'the next W1 request has exactly one durable STARTED receipt');
    assert.ok(!logs.some(value => value.startsWith('OPENCODE_LANE_WAITING_ELIGIBILITY_')),
      logs.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

// This joins the two previously separate cases: the focused writeReceipt
// POST-success/readback-failure test and the Worker tests that begin from an
// already-persisted STARTED receipt. A fresh Worker invocation must recover the
// ambiguous STARTED write on the exact original request and attempt, never
// creating a second STARTED receipt or a new attempt ID. This is a synthetic
// adapter-level regression only; it does not claim a live reboot, model
// recovery, or any task acceptance. external_effects and task_acceptance stay
// UNKNOWN throughout.
test('a fresh Worker invocation recovers an ambiguous STARTED write on the exact original attempt', async () => {
  const root = mkdtempSync(join(homedir(), '.ptysd-ambiguous-started-recovery-'));
  try {
    const workspace = join(root, 'workspace');
    const stateDir = join(root, 'state');
    const resultsDir = join(root, 'results');
    mkdirSync(workspace);
    mkdirSync(join(workspace, 'native-bridge'), { recursive: true });
    writeFileSync(join(workspace, 'native-bridge', 'worker.mjs'), 'export const fixture = true;\n');
    mkdirSync(stateDir);
    mkdirSync(resultsDir);
    const host = hostname().toUpperCase();
    const spec = 'Synthetic W1 recovery task; dispatch only, never invoke a model.';
    const job = withHumanGoal({
      schema: 6, project_id: PROJECT, host,
      request_id: 'PTYSD_W1_AMBIGUOUS_STARTED_RECOVERY_20261101',
      kind: 'opencode_edit', source_sha: commit,
      spec_path: 'native-bridge/tasks/w1-ambiguous-started-recovery.md',
      spec_sha256: h(spec),
      model: 'opencode/deepseek-v4.1-flash-free', variant: 'free',
      edit_paths: ['native-bridge/worker.mjs'], source_pr: 437,
    });
    const goalComment = humanGoalComment();
    const jobComment = { ...com(704, encoded(job), 't14210184'),
      issue_url: `https://api.github.com/repos/${REPO}/issues/310` };
    const pull = { number: 437, state: 'open',
      base: { ref: 'main', repo: { id: 1352411536, full_name: REPO } },
      head: { sha: commit, repo: { id: 1352411536, full_name: REPO } } };
    // One durable mock GitHub comment store shared by both Worker invocations.
    const remote = { comments: [], next: 710, posts: 0 };
    const executor = executorDescriptorForLane('OpenCode', 1001);
    const config = { repo: REPO, project_id: PROJECT, host, issue: 407,
      workspace, state_dir: stateDir, dispatchers: ['t14210184'],
      executors: { opencode: executor }, enable_v2_model_runs: true,
      allowed_models: { 'opencode/deepseek-v4.1-flash-free': ['free'] } };
    const makeApiRead = () => uri => {
      if (uri === 'user') return { login: 'worker' };
      if (uri === `repos/${REPO}/issues/407`) return { title: ISSUE_TITLE, state: 'open' };
      if (uri === `repos/${REPO}/git/ref/heads/main`) return { object: { sha: commit } };
      if (uri === `repos/${REPO}/issues/comments/6188322050`) return structuredClone(goalComment);
      if (uri === `repos/${REPO}/pulls/437`) return structuredClone(pull);
      if (uri === `repos/${REPO}/issues/comments/704`) return structuredClone(jobComment);
      if (uri.startsWith(`repos/${REPO}/contents/`))
        return { encoding: 'base64', content: Buffer.from(spec).toString('base64') };
      throw new Error(`UNEXPECTED_AMBIGUOUS_STARTED_API_${uri}`);
    };

    const firstLogs = [];
    let firstAttemptId = null;
    let firstBundleCalls = 0;
    let firstDispatchCalls = 0;
    let firstModelCalls = 0;
    let firstTriggerCalls = 0;
    let readbackFailures = 1;
    let posted = false;
    const firstReceiptDependencies = {
      readComments: () => {
        if (posted && readbackFailures > 0) {
          readbackFailures--;
          throw new Error('MOCK_RECEIPT_READBACK_UNAVAILABLE_AFTER_POST');
        }
        return structuredClone(remote.comments);
      },
      postComment: body => {
        remote.comments.push(com(remote.next++, body, 'worker'));
        remote.posts++;
        posted = true;
      },
    };
    const first = await executeWorker(config, {
      goalCommentsRead: () => [goalComment, jobComment],
      readExecutorWorkspace: descriptor => {
        assert.equal(descriptor, executor);
        return workspace;
      },
      apiRead: makeApiRead(),
      commentsRead: () => structuredClone(remote.comments),
      executorResultsDir: () => resultsDir,
      assertExecutorTaskReady: descriptor => {
        assert.equal(descriptor, executor);
        return { ready: true };
      },
      createExecutorSourceBundle: ({ descriptor, job: sourceJob, attemptId }) => {
        assert.equal(descriptor, executor);
        assert.equal(sourceJob.request_id, job.request_id);
        firstBundleCalls++;
        firstAttemptId = attemptId;
        return { attempt_id: attemptId, source_sha: sourceJob.source_sha, sha256: 'c'.repeat(64) };
      },
      dispatchToExecutor: () => {
        firstDispatchCalls++;
        throw new Error('AMBIGUOUS_STARTED_MUST_NOT_DISPATCH');
      },
      triggerPendingExecutorAttempt: () => {
        firstTriggerCalls++;
        throw new Error('AMBIGUOUS_STARTED_MUST_NOT_TRIGGER');
      },
      writeReceipt: (receiptConfig, data, login) =>
        writeReceipt(receiptConfig, data, login, firstReceiptDependencies),
      runPlan: () => {
        firstModelCalls++;
        throw new Error('AMBIGUOUS_STARTED_MUST_NOT_INVOKE_A_MODEL');
      },
      observationDependencies: { collectWindowsObservation: () => ({ status: 'UNKNOWN' }) },
      log: value => firstLogs.push(value),
    }).catch(error => error);
    assert.match(first.message, /RECEIPT_WRITE_AMBIGUOUS_NO_EXECUTION/,
      'the first invocation stops on the ambiguous STARTED write');
    assert.equal(firstDispatchCalls, 0, 'no executor dispatch follows an ambiguous STARTED write');
    assert.equal(firstTriggerCalls, 0, 'no pending handoff retry happens in the same invocation');
    assert.equal(firstModelCalls, 0, 'the Worker never invokes a model directly');
    assert.equal(firstBundleCalls, 1, 'the source bundle is prepared before the STARTED receipt');
    assert.ok(firstAttemptId, 'the prepared attempt ID is bound to the persisted STARTED receipt');
    assert.equal(remote.posts, 1, 'the STARTED POST persisted exactly once to the mock remote store');
    assert.equal(readbackFailures, 0, 'the immediate post-write readback failed exactly once');
    assert.ok(!firstLogs.some(value => value.startsWith('DISPATCHED_')),
      'the ambiguous write never logs a dispatch');

    const persisted = remote.comments
      .map(comment => parseReceipt(comment.body))
      .filter(receiptValue => receiptValue?.request_id === job.request_id);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].state, 'STARTED');
    assert.equal(persisted[0].attempt_id, firstAttemptId);
    assert.equal(persisted[0].source_sha, commit);
    assert.equal(persisted[0].source_pr, 437);
    assert.equal(persisted[0].goal_comment_id, job.goal_comment_id);
    assert.equal(persisted[0].goal_body_sha256, job.goal_body_sha256);
    assert.equal(persisted[0].edit_paths_sha256, h(JSON.stringify(job.edit_paths)));
    assert.equal(persisted[0].model_invoked, null,
      'a dispatch acknowledgement is not evidence that the model started');
    assert.equal(persisted[0].outcome, 'DISPATCH_ACK_NOT_ACCEPTANCE');
    assert.equal(persisted[0].task_acceptance, 'UNKNOWN');
    assert.equal(persisted[0].external_effects, 'UNKNOWN');
    assert.equal(persisted[0].source_diff_evidence, 'NOT_INSPECTED');

    // A fresh Worker/config/dependency context reads the same persisted mock
    // comments and the same local state directory.
    const secondLogs = [];
    let secondBundleCalls = 0;
    let secondDispatchCalls = 0;
    let secondModelCalls = 0;
    let secondTriggerCalls = 0;
    let secondTriggerDescriptor = null;
    let secondTriggerAttemptId = null;
    let secondTriggerJob = null;
    const secondReceiptDependencies = {
      readComments: () => structuredClone(remote.comments),
      postComment: body => {
        remote.comments.push(com(remote.next++, body, 'worker'));
        remote.posts++;
      },
    };
    const second = await executeWorker({ ...config }, {
      goalCommentsRead: () => [goalComment, jobComment],
      readExecutorWorkspace: descriptor => {
        assert.equal(descriptor, executor);
        return workspace;
      },
      apiRead: makeApiRead(),
      commentsRead: () => structuredClone(remote.comments),
      executorResultsDir: () => resultsDir,
      assertExecutorTaskReady: descriptor => {
        assert.equal(descriptor, executor);
        return { ready: true };
      },
      createExecutorSourceBundle: () => {
        secondBundleCalls++;
        throw new Error('RECOVERY_MUST_NOT_CREATE_A_NEW_ATTEMPT_BUNDLE');
      },
      dispatchToExecutor: () => {
        secondDispatchCalls++;
        throw new Error('RECOVERY_MUST_NOT_DISPATCH_A_NEW_ATTEMPT');
      },
      triggerPendingExecutorAttempt: (descriptor, attemptId, { expectedJob }) => {
        secondTriggerCalls++;
        secondTriggerDescriptor = descriptor;
        secondTriggerAttemptId = attemptId;
        secondTriggerJob = expectedJob;
        return { outcome: 'EXECUTOR_PENDING_ATTEMPT_TRIGGERED_NOT_ACCEPTANCE',
          exit_code: 0, attempt_id: attemptId };
      },
      writeReceipt: (receiptConfig, data, login) =>
        writeReceipt(receiptConfig, data, login, secondReceiptDependencies),
      runPlan: () => {
        secondModelCalls++;
        throw new Error('RECOVERY_MUST_NOT_INVOKE_A_MODEL');
      },
      observationDependencies: { collectWindowsObservation: () => ({ status: 'UNKNOWN' }) },
      log: value => secondLogs.push(value),
    });

    assert.notEqual(second.state, 'DISPATCHED',
      'the recovery tick does not claim a new dispatch');
    assert.equal(secondTriggerCalls, 1, 'the pending executor handoff is retried exactly once');
    assert.equal(secondTriggerDescriptor, executor);
    assert.equal(secondTriggerAttemptId, firstAttemptId,
      'recovery is bound to the exact original attempt ID');
    assert.deepEqual(secondTriggerJob, job, 'recovery is bound to the exact original request');
    assert.equal(secondBundleCalls, 0, 'recovery never prepares a second attempt');
    assert.equal(secondDispatchCalls, 0, 'recovery never dispatches a new executor attempt');
    assert.equal(secondModelCalls, 0, 'recovery never invokes a model directly');
    assert.equal(remote.posts, 1, 'recovery does not post a second STARTED receipt');
    const recovered = remote.comments
      .map(comment => parseReceipt(comment.body))
      .filter(receiptValue => receiptValue?.request_id === job.request_id);
    assert.equal(recovered.length, 1, 'exactly the original STARTED receipt remains');
    assert.equal(recovered[0].attempt_id, firstAttemptId, 'no new attempt ID is created');
    assert.equal(recovered[0].task_acceptance, 'UNKNOWN');
    assert.equal(recovered[0].external_effects, 'UNKNOWN');
    assert.ok(secondLogs.includes(
      `PENDING_EXECUTOR_RETRIGGERED_${job.request_id}_${firstAttemptId}_NO_NEW_RECEIPT`),
    secondLogs.join('\n'));
    assert.ok(!secondLogs.some(value => value.startsWith('DISPATCHED_')),
      'recovery never logs a new dispatch');
  } finally { rmSync(root, { recursive: true, force: true }); }
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
  assert.equal(parseJob(encoded({ ...editJob, edit_paths:['governance./policy.json'] })), null,
    'a Win32 trailing-dot alias cannot bypass the protected governance directory');
  assert.equal(parseJob(encoded({ ...editJob, edit_paths:['runs ./worker.json'] })), null,
    'a Win32 trailing-space alias cannot bypass the protected runs directory');
  assert.equal(validCodexWritePaths(['governance./policy.json']), false,
    'Codex scope rejects a trailing-dot alias of the protected governance directory');
  assert.equal(validCodexWritePaths(['runs ./worker.json']), false,
    'Codex scope rejects a trailing-space alias of the protected runs directory');
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

test('schema-6 OpenCode candidate edit is not gated by the schema-4 Codex scoped-action requirement', async () => {
  // The schema-4-only Codex continuation path still demands one unique
  // **Codex 下一動作** section in the bound Human GOAL body.
  assert.deepEqual(codexScopedActionStatus(humanGoalBody),
    { ready: false, code: 'HUMAN_GOAL_SCOPED_ACTION_MISSING' });
  const goalSha = h(humanGoalBody);
  const codexSpec = '# schema-4 scoped-action guard probe\n';
  const schema4Job = { schema: 4, project_id: PROJECT, host: 'DESKTOP-1B6PD2P',
    request_id: `PTYSD_HUMAN_GOAL_6188322050_${goalSha.slice(0, 42).toUpperCase()}`,
    kind: 'codex_plan', source_sha: commit,
    spec_path: 'native-bridge/tasks/human-goal-source-only.md', spec_sha256: h(codexSpec),
    model: 'gpt-6.1-sol', reasoning_effort: 'medium',
    write_paths: ['native-bridge/worker.mjs'], goal_comment_id: 6188322050,
    goal_body_sha256: goalSha, goal_author: 't14210184',
    goal_marker: 'PTYSD_V53R4_DELETE_FIRST_AUTONOMY_GOAL_20261015' };
  assert.throws(() => makeCodexExecutorRequest(schema4Job,
    '00000000-0000-4000-8000-000000000001', codexSpec,
    join(homedir(), 'synthetic-codex-source.bundle'), 'c'.repeat(64),
    { repo: REPO, issue: 310, comment_id: 6188322050, author: 't14210184',
      body_sha256: goalSha, body: humanGoalBody,
      fetched_at: '2026-10-29T00:00:00.000Z' }), /HUMAN_GOAL_SCOPED_ACTION_MISSING/);

  // The same byte-pinned GOAL still authorizes a schema-6 OpenCode candidate
  // edit because that path never consults the schema-4 Codex scoped action.
  const host = 'DESKTOP-1B6PD2P';
  const job = withHumanGoal({ project_id: PROJECT, host,
    request_id: 'PTYSD_OPENCODE_EDIT_NO_CODEX_ACTION_20261029', kind: 'opencode_edit',
    source_sha: commit, spec_path: 'native-bridge/tasks/edit-worker.md',
    spec_sha256: hash, model: 'opencode/spark', variant: 'high',
    edit_paths: ['native-bridge/worker.mjs'], source_pr: 437 });
  const comments = [com(10, encoded(job), 't14210184')];
  const goal = humanGoalComment();
  const pull = { number: 437, state: 'open',
    base: { ref: 'main', repo: { id: 1352411536, full_name: REPO } },
    head: { sha: commit, repo: { id: 1352411536, full_name: REPO } } };
  const reads = [];
  const sources = await readPinnedCandidateSources(comments, ['t14210184'], 'worker', host,
    path => { reads.push(path); return path.endsWith('/6188322050') ? goal : pull; },
    undefined, [], () => [goal]);
  assert.deepEqual(reads,
    [`repos/${REPO}/issues/comments/6188322050`, `repos/${REPO}/pulls/437`]);
  assert.equal(sources.get(437), commit);
  assert.equal(selectNext(comments, ['t14210184'], 'worker', host, 'c'.repeat(40), [], sources)
    ?.job.request_id, job.request_id);
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

test('operator observation reports a queued W1 preflight refusal without inventing an attempt or acceptance', async () => {
  const host=hostname().toUpperCase(),publisher='publisher',now=new Date();
  const job=withHumanGoal({schema:6,project_id:PROJECT,host,
    request_id:'PTYSD_W1_SOURCE_BUNDLE_PREFLIGHT_20261029',kind:'opencode_edit',
    source_sha:commit,spec_path:'native-bridge/tasks/w1-panel-additive-acceptance-negative-cases.md',
    spec_sha256:hash,model:'opencode/deepseek-v4.1-flash-free',variant:'free',
    edit_paths:['tests/operator-panel-api.test.mjs'],source_pr:619});
  const taskComment={...com(702,encoded(job),'t14210184'),
    issue_url:`https://api.github.com/repos/${REPO}/issues/310`};
  const priorTime=now.getTime()-60_000;
  const prior=seededOperatorObservation(OPERATOR_COMMENT_ID,17,'c'.repeat(40),priorTime);
  const observationComment={id:OPERATOR_COMMENT_ID,user:{login:publisher},
    body:encodeOperatorObservation(prior),updated_at:new Date(priorTime).toISOString()};
  const comments=[observationComment,taskComment];
  const workspace=mkdtempSync(join(homedir(),'.ptysd-w1-preflight-observation-'));
  try {
    const config={repo:REPO,project_id:PROJECT,host,issue:407,workspace,state_dir:workspace,
      dispatchers:['t14210184'],enable_v2_model_runs:true,enable_antigravity_model_runs:false};
    const dependencies={now:()=>now,
      collectWindowsObservation:()=>({status:'FRESH',observed_at:now.toISOString(),
        tasks_total:1,legacy_monitor_registered:false,listener_2667:false,opencode_process_count:0,
        runner_service_count:0,runner_service_running:false,native_task:{registered:true,enabled:true,
          state:'READY',last_run:null,last_result:'0x00000000',action_kind:'WINDOWLESS_LAUNCHER',
          identity_class:'INTERACTIVE_LIMITED',multiple_instances:'IGNORENEW',trigger_interval_minutes:5}}),
      readRunnerRegistration:()=>({total_count:0}),
      readComment:id=>structuredClone(comments.find(comment=>comment.id===id)),
      patchComment:(id,body)=>{
        const comment=comments.find(value=>value.id===id);
        comment.body=body;
        comment.updated_at=new Date(now.getTime()+1000).toISOString();
      },
      readComments:()=>structuredClone(comments)};
    const blockers=new Map([[job.request_id,'EXECUTOR_SOURCE_COMMIT_UNAVAILABLE']]);
    const result=await publishOperatorObservation(config,publisher,comments,commit,dependencies,
      new Map([[619,commit]]),comments.length,blockers);
    assert.equal(result.status,'UPDATED',JSON.stringify(result));
    const w1=result.observation.workers.find(record=>record.worker_id==='W1');
    assert.equal(w1.status,'PENDING');
    assert.equal(w1.task_state,'QUEUED_NOT_STARTED');
    assert.equal(w1.request_id,undefined);
    assert.equal(w1.task_id,job.request_id);
    assert.equal(w1.attempt_id,undefined);
    assert.equal(w1.model_eligibility,'WAITING');
    assert.equal(w1.blocker_code,'EXECUTOR_SOURCE_COMMIT_UNAVAILABLE');
    assert.equal(w1.delivery_status,undefined);
    assert.equal(result.observation.native_worker.next_owner,'CODEX_REPAIR_NATIVE_PREFLIGHT');
  } finally {rmSync(workspace,{recursive:true,force:true});}
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

test('schema-6 OpenCode edit honors phase-specific OS identity and leaves independent work moving', async () => {
  const root=mkdtempSync(join(homedir(),'.ptysd-opencode-isolation-gate-'));
  try {
    const workspace=join(root,'workspace'),stateDir=join(root,'state');
    const blockedStateDir=join(root,'blocked-state');
    mkdirSync(join(workspace,'src'),{recursive:true}); mkdirSync(stateDir); mkdirSync(blockedStateDir);
    writeFileSync(join(workspace,'src','worker.mjs'),'export const state = "base";\n');
    const host=hostname().toUpperCase(),spec='Edit only src/worker.mjs for this synthetic task.';
    const job=withHumanGoal({project_id:PROJECT,host,
      request_id:'PTYSD_OPENCODE_ISOLATION_REQUIRED_20261027',kind:'opencode_edit',source_sha:commit,
      spec_path:'native-bridge/tasks/edit-worker.md',spec_sha256:h(spec),model:'opencode/spark',
      variant:'high',edit_paths:['src/worker.mjs'],source_pr:437});
    const jobComment={...com(10,encoded(job)),issue_url:`https://api.github.com/repos/${REPO}/issues/310`};
    const pingJob=mkjob({host,request_id:'PTYSD_PING_DURING_OPENCODE_ISOLATION_WAIT_20261027'});
    const pingComment={...com(11,encoded(pingJob)),issue_url:`https://api.github.com/repos/${REPO}/issues/310`};
    const taskComments=[jobComment],receiptComments=[pingComment];
    const publisherSid='S-1-5-21-100-200-300-1002';
    const executor={...executorDescriptorForLane('OpenCode',1002),publisher_sid:publisherSid,
      execution_phase:'WIN11_TRANSITION'};
    const config={repo:REPO,project_id:PROJECT,host,issue:407,workspace,state_dir:stateDir,
      dispatchers:['t14210184'],executors:{opencode:executor},enable_v2_model_runs:true,
      allowed_models:{'opencode/spark':['high']}};
    const writes=[],logs=[]; let bundles=0,dispatches=0,modelCalls=0,readinessCalls=0,nextId=20;
    const adapters={
      goalCommentsRead:()=>[humanGoalComment(),...taskComments],
      readExecutorWorkspace:()=>workspace,
      apiRead(uri){
        if(uri==='user')return {login:'worker'};
        if(uri===`repos/${REPO}/issues/407`)return {title:ISSUE_TITLE,state:'open'};
        if(uri===`repos/${REPO}/git/ref/heads/main`)return {object:{sha:commit}};
        if(uri===`repos/${REPO}/issues/comments/6188322050`)return humanGoalComment();
        if(uri===`repos/${REPO}/pulls/437`)return {number:437,state:'open',
          base:{ref:'main',repo:{id:1352411536,full_name:REPO}},
          head:{sha:commit,repo:{id:1352411536,full_name:REPO}}};
        if(uri===`repos/${REPO}/issues/comments/10`)return jobComment;
        if(uri===`repos/${REPO}/issues/comments/11`)return pingComment;
        if(uri.startsWith(`repos/${REPO}/contents/`))
          return {encoding:'base64',content:Buffer.from(spec).toString('base64')};
        throw new Error(`UNEXPECTED_OPENCODE_ISOLATION_TEST_API:${uri}`);
      },
      commentsRead:()=>receiptComments,
      assertExecutorTaskReady:()=>{readinessCalls++;return {ready:true};},
      createExecutorSourceBundle:({job:sourceJob,attemptId})=>{
        bundles++; return {attempt_id:attemptId,source_sha:sourceJob.source_sha,sha256:'c'.repeat(64)};
      },
      dispatchToExecutor:()=>{dispatches++;return {outcome:'SYNTHETIC_DISPATCH_ACK_NOT_EXECUTION'};},
      writeReceipt(_receiptConfig,data,login){
        writes.push(data);
        receiptComments.push(com(nextId++,RECEIPT_MARKER+JSON.stringify(data),login));
      },
      runPlan:()=>{modelCalls++;throw new Error('TEST_MUST_NOT_INVOKE_MODEL_INLINE');},
      observationDependencies:{collectWindowsObservation:()=>({status:'UNKNOWN'})},
      log:value=>logs.push(value),
    };

    const ping=await executeWorker({...config,state_dir:blockedStateDir},adapters);
    assert.equal(ping.state,'FINISHED');
    assert.equal(ping.request_id,pingJob.request_id,
      'an independent ping remains runnable while the W1 candidate is present');
    async function runJob(requestId,phase,userSid){
      jobComment.body=encoded({...job,request_id:requestId});
      executor.execution_phase=phase; executor.user_sid=userSid;
      return executeWorker({...config,state_dir:blockedStateDir},adapters);
    }
    const transitionReady=await runJob(job.request_id,'WIN11_TRANSITION',publisherSid);
    assert.equal(transitionReady.state,'DISPATCHED',
      'the Human-authorized Win11 transition allows only the same Publisher and Executor SID');
    assert.equal(transitionReady.request_id,job.request_id);
    assert.equal(readinessCalls,1); assert.equal(bundles,1); assert.equal(dispatches,1);
    assert.equal(modelCalls,0,'the synthetic dispatcher test never launches OpenCode');
    assert.deepEqual(writes.filter(item=>item.request_id===job.request_id).map(item=>item.state),['STARTED']);

    await assert.rejects(runJob('PTYSD_OPENCODE_TRANSITION_MISMATCH_20261027',
      'WIN11_TRANSITION','S-1-5-21-100-200-300-1001'), /EXECUTOR_TRANSITION_IDENTITY_MISMATCH/);
    assert.equal(readinessCalls,1,'a phase/identity mismatch must fail before Task Scheduler preflight');
    assert.equal(dispatches,1);

    const vmDescriptor={...executorDescriptorForLane('OpenCode',1001),execution_phase:'VM_ISOLATED'};
    assert.doesNotThrow(()=>guardConfig({...config,executors:{opencode:vmDescriptor}}),
      'the separate-SID VM phase remains eligible');
    assert.throws(()=>guardConfig({...config,executors:{opencode:{...vmDescriptor,
      user_sid:publisherSid}}}),/EXECUTOR_IDENTITY_NOT_SEPARATE/);
    assert.equal(readinessCalls,1); assert.equal(bundles,1); assert.equal(dispatches,1);
    assert.equal(modelCalls,0);
    assert.deepEqual(writes.filter(item=>item.request_id==='PTYSD_OPENCODE_TRANSITION_MISMATCH_20261027'),[]);
  } finally {rmSync(root,{recursive:true,force:true});}
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
      readExecutorWorkspace:()=>workspace,
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
      readExecutorWorkspace:()=>workspace,
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

test('a disabled W2 lane does not starve a new W1 edit after a prior terminal W1 receipt', async () => {
  const root=mkdtempSync(join(homedir(),'.ptysd-w1-after-disabled-w2-test-'));
  try {
    const workspace=join(root,'workspace'),opencodeWorkspace=join(root,'opencode-workspace'),stateDir=join(root,'state');
    mkdirSync(join(workspace,'src'),{recursive:true}); mkdirSync(stateDir);
    mkdirSync(join(opencodeWorkspace,'src'),{recursive:true});
    const host=hostname().toUpperCase();
    const w2Spec='Synthetic W2 request that must remain queued without model execution.';
    const priorW1Spec='A prior W1 request has a terminal receipt and must not be replayed.';
    const w1Spec='Edit only src/w1-after-disabled-w2.mjs for this synthetic task.';
    const w2Job=withHumanGoal({schema:6,project_id:PROJECT,host,
      request_id:'PTYSD_W2_DISABLED_BEFORE_W1_20261029',kind:'antigravity_edit',
      source_sha:commit,spec_path:'native-bridge/tasks/w2-before-w1.md',spec_sha256:h(w2Spec),
      model:ANTIGRAVITY_V2_MODEL,variant:'high',
      edit_paths:['src/w2-before-w1.mjs'],source_pr:448});
    const priorW1Job=withHumanGoal({schema:6,project_id:PROJECT,host,
      request_id:'PTYSD_W1_PREVIOUS_TERMINAL_BEFORE_NEXT_20261030',kind:'opencode_edit',
      source_sha:commit,spec_path:'native-bridge/tasks/w1-prior-terminal.md',spec_sha256:h(priorW1Spec),
      model:'opencode/deepseek-v4.1-flash-free',variant:'free',
      edit_paths:['src/w1-prior-terminal.mjs'],source_pr:437});
    const w1Job=withHumanGoal({schema:6,project_id:PROJECT,host,
      request_id:'PTYSD_W1_AFTER_DISABLED_W2_20261029',kind:'opencode_edit',
      source_sha:commit,spec_path:'native-bridge/tasks/w1-after-w2.md',spec_sha256:h(w1Spec),
      model:'opencode/deepseek-v4.1-flash-free',variant:'free',
      edit_paths:['src/w1-after-disabled-w2.mjs'],source_pr:437});
    const w2Comment={...com(410,encoded(w2Job),'t14210184'),
      issue_url:`https://api.github.com/repos/${REPO}/issues/310`};
    const priorW1Comment={...com(411,encoded(priorW1Job),'t14210184'),
      issue_url:`https://api.github.com/repos/${REPO}/issues/310`};
    const priorW1Terminal=receipt(priorW1Job.request_id,
      '88888888-8888-4888-8888-888888888888','FINISHED',priorW1Job,{
        outcome:'V2_EDIT_DIFF_CAPTURED_UNVERIFIED',exit_code:0,model_invoked:true,
        session_id:'77777777-7777-4777-8777-777777777777',external_effects:'UNKNOWN',
        source_diff_evidence:'CAPTURED',task_acceptance:'UNKNOWN',
        coding_state:'DIFF_CAPTURED_UNVERIFIED',scope_valid:true,
        diff_sha256:'d'.repeat(64),diff_bytes:96,changed_files:['src/w1-prior-terminal.mjs']});
    const priorW1ReceiptComment=com(412,RECEIPT_MARKER+JSON.stringify(priorW1Terminal),'worker');
    const w1Comment={...com(413,encoded(w1Job),'t14210184'),
      issue_url:`https://api.github.com/repos/${REPO}/issues/310`};
    const comments=[w2Comment,priorW1Comment,priorW1ReceiptComment,w1Comment];
    const w1Executor=executorDescriptorForLane('OpenCode',1001);
    const w2Executor=executorDescriptorForLane('Antigravity',1003);
    const config={repo:REPO,project_id:PROJECT,host,issue:407,workspace,state_dir:stateDir,
      dispatchers:['t14210184'],executors:{opencode:w1Executor,antigravity:w2Executor},
      enable_v2_model_runs:true,enable_antigravity_model_runs:false,
      allowed_models:{'opencode/deepseek-v4.1-flash-free':['free'],[ANTIGRAVITY_V2_MODEL]:['high']}};
    const posted=[],logs=[];
    let bundles=0,dispatches=0,inlineModels=0,antigravityReadiness=0,w2Readiness=0,
      pendingTriggers=0,nextReceiptId=420;
    const pullFor=pr=>({number:pr,state:'open',
      base:{ref:'main',repo:{id:1352411536,full_name:REPO}},
      head:{sha:commit,repo:{id:1352411536,full_name:REPO}}});
    const adapters={
      goalCommentsRead:()=>[humanGoalComment(),...comments],
      readExecutorWorkspace:(descriptor)=>{
        assert.equal(descriptor,w1Executor,'the W1 lane resolves its own registered workspace');
        return opencodeWorkspace;
      },
      apiRead(uri){
        if(uri==='user')return {login:'worker'};
        if(uri===`repos/${REPO}/issues/407`)return {title:ISSUE_TITLE,state:'open'};
        if(uri===`repos/${REPO}/git/ref/heads/main`)return {object:{sha:commit}};
        if(uri===`repos/${REPO}/issues/comments/6188322050`)return humanGoalComment();
        if(uri===`repos/${REPO}/pulls/448`)return pullFor(448);
        if(uri===`repos/${REPO}/pulls/437`)return pullFor(437);
        const commentMatch=uri.match(new RegExp(`^repos/${REPO.replaceAll('/','\\/')}/issues/comments/(\\d+)$`));
        if(commentMatch)return comments.find(item=>item.id===Number(commentMatch[1]));
        if(uri.startsWith(`repos/${REPO}/contents/`)) {
          const spec=uri.includes('w2-before-w1.md')?w2Spec
            :uri.includes('w1-prior-terminal.md')?priorW1Spec:w1Spec;
          return {encoding:'base64',content:Buffer.from(spec).toString('base64')};
        }
        throw new Error(`UNEXPECTED_W1_AFTER_DISABLED_W2_API_${uri}`);
      },
      commentsRead:()=>comments,
      assertExecutorTaskReady(descriptor){
        if(descriptor===w2Executor)w2Readiness++;
        assert.equal(descriptor,w1Executor,
          'only the independently eligible W1 descriptor reaches Task Scheduler readiness');
        return {ready:true};
      },
      createExecutorSourceBundle({workspace:sourceWorkspace,descriptor,job,attemptId}){
        assert.equal(sourceWorkspace,opencodeWorkspace,
          'source bundle creation must not touch the global W2 workspace');
        assert.equal(descriptor,w1Executor,'W1 source bundles must use the OpenCode descriptor');
        assert.equal(job.request_id,w1Job.request_id);
        assert.equal(job.source_sha,commit);
        assert.equal(job.source_pr,437);
        assert.deepEqual(job.edit_paths,['src/w1-after-disabled-w2.mjs']);
        bundles++;
        return {attempt_id:attemptId,source_sha:job.source_sha,sha256:'c'.repeat(64)};
      },
      dispatchToExecutor(descriptor,manifest){
        assert.equal(descriptor,w1Executor,'W1 dispatch must not use the disabled W2 identity');
        assert.equal(manifest.job.request_id,w1Job.request_id);
        assert.equal(manifest.job.source_sha,commit);
        assert.equal(manifest.job.source_pr,437);
        assert.deepEqual(manifest.job.edit_paths,['src/w1-after-disabled-w2.mjs']);
        assert.equal(manifest.source_bundle_sha256,'c'.repeat(64));
        dispatches++;
        return {outcome:'SYNTHETIC_DISPATCH_ACK_NOT_EXECUTION'};
      },
      writeReceipt(receiptConfig,data){
        assert.equal(receiptConfig.issue,407,'receipts stay on the existing #407 stream');
        posted.push(data);
        comments.push(com(nextReceiptId++,RECEIPT_MARKER+JSON.stringify(data),'worker'));
      },
      runPlan(){inlineModels++;throw new Error('W1_MODEL_MUST_RUN_ONLY_IN_EXECUTOR');},
      runAntigravityV2Readiness(){
        antigravityReadiness++;
        throw new Error('ANTIGRAVITY_READINESS_MUST_NOT_RUN_WHILE_W2_DISABLED');
      },
      triggerPendingExecutorAttempt(){
        pendingTriggers++;
        return {outcome:'SYNTHETIC_PENDING_TRIGGER_NOT_CONFIRMED'};
      },
      observationDependencies:{collectWindowsObservation:()=>({status:'UNKNOWN'})},
      log:value=>logs.push(value),
    };

    const result=await executeWorker(config,adapters);
    assert.equal(result.state,'DISPATCHED',JSON.stringify({result,logs}));
    assert.equal(result.request_id,w1Job.request_id);
    assert.equal(bundles,1);
    assert.equal(dispatches,1,'the W1 request is dispatched exactly once through the OpenCode Executor');
    assert.equal(inlineModels,0,'the Worker never invokes an inline model');
    assert.equal(antigravityReadiness,0,'a disabled W2 lane cannot trigger Antigravity readiness');
    assert.equal(w2Readiness,0,'the W2 Task Scheduler identity is never probed');
    assert.equal(pendingTriggers,0);
    assert.ok(logs.includes('ANTIGRAVITY_LANE_WAITING_ELIGIBILITY_ANTIGRAVITY_MODEL_RUNS_NOT_ENABLED'),
      'the W2 gate was evaluated before continuing to W1');
    assert.ok(!logs.some(value=>value.startsWith('OPENCODE_LANE_WAITING_ELIGIBILITY_')),
      'the eligible W1 lane was not denied');
    assert.equal(posted.filter(item=>item.request_id===priorW1Job.request_id).length,0,
      'the prior terminal W1 request is not replayed by this fresh Worker poll');
    assert.equal(comments.filter(item=>parseReceipt(item.body)?.request_id===priorW1Job.request_id).length,1,
      'the prior W1 receipt, including UNKNOWN effects, remains preserved');
    assert.equal(priorW1Terminal.external_effects,'UNKNOWN');
    assert.equal(priorW1Terminal.task_acceptance,'UNKNOWN');
    assert.equal(posted.filter(item=>item.request_id===w2Job.request_id).length,0,
      'W2 remains unclaimed with no STARTED receipt');
    assert.equal(posted.filter(item=>item.kind==='antigravity_edit').length,0);
    assert.equal(comments.filter(item=>parseReceipt(item.body)?.request_id===w2Job.request_id).length,0,
      'no W2 STARTED or terminal receipt exists after the W1 dispatch tick');
    const w1Receipts=posted.filter(item=>item.request_id===w1Job.request_id);
    assert.equal(w1Receipts.length,1);
    assert.equal(w1Receipts[0].state,'STARTED');
    assert.equal(w1Receipts[0].kind,'opencode_edit');
    assert.equal(w1Receipts[0].source_sha,commit);
    assert.equal(w1Receipts[0].source_pr,437);
    assert.equal(w1Receipts[0].goal_comment_id,w1Job.goal_comment_id);
    assert.equal(w1Receipts[0].goal_body_sha256,w1Job.goal_body_sha256);
    assert.equal(w1Receipts[0].edit_paths_sha256,h(JSON.stringify(w1Job.edit_paths)));

    const next=selectNext(comments,['t14210184'],'worker',host,commit,[],
      new Map([[448,commit],[437,commit]]));
    assert.equal(next?.job.request_id,w2Job.request_id,
      'the disabled W2 request remains queued and eligible for later reevaluation');
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
      readExecutorWorkspace:()=>workspace,
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
      readExecutorWorkspace:()=>workspace,
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
      readExecutorWorkspace:()=>workspace,
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
      'BLOCKED',sent.job,{exit_code:45,outcome:'CODEX_EXECUTOR_PREFLIGHT_BLOCKED',
        model_invoked:false,session_started:false,
        tool_execution_evidence:'OBSERVED',tool_execution_count:0,
        file_change_tool_evidence:'UNKNOWN'});
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
      'BLOCKED',legacyJob,{exit_code:45,outcome:'CODEX_EXECUTOR_PREFLIGHT_BLOCKED',
        model_invoked:false,session_started:false,tool_execution_evidence:'OBSERVED',
        tool_execution_count:0,file_change_tool_evidence:'UNKNOWN'});
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
    assert.equal(allowed.source_diff_evidence,'CAPTURED');
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
    assert.equal(allowedReceipt.source_diff_evidence,'CAPTURED');
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

test('OpenCode V2 edit preserves UNKNOWN when a junction appears during execution and never reports a zero diff', async () => {
  const home=mkdtempSync(join(homedir(),'.ptysd-opencode-junction-race-test-'));
  try {
    const workspace=join(home,'workspace'),stateDir=join(home,'state'),outside=join(home,'outside');
    const junction=join(workspace,'escape');
    mkdirSync(join(workspace,'src'),{recursive:true}); mkdirSync(join(workspace,'escape'));
    mkdirSync(stateDir); mkdirSync(outside);
    const git=(...args)=>{
      const result=spawnSync('git',['-C',workspace,...args],{encoding:'utf8',windowsHide:true});
      assert.equal(result.status,0,result.stderr); return result.stdout.trim();
    };
    git('init','--quiet'); git('config','user.name','PTYSD test'); git('config','user.email','test@example.invalid');
    writeFileSync(join(workspace,'src','worker.mjs'),'export const state = "base";\n');
    git('add','src/worker.mjs'); git('commit','--quiet','-m','synthetic OpenCode source');
    const sourceSha=git('rev-parse','HEAD');
    const config={workspace,state_dir:stateDir,enable_v2_model_runs:true,
      allowed_models:{'opencode/spark':['high']}};
    const job={schema:4,project_id:PROJECT,host:hostname().toUpperCase(),
      request_id:'PTYSD_OPENCODE_JUNCTION_RACE_20261023',kind:'opencode_edit',source_sha:sourceSha,
      spec_path:'native-bridge/tasks/review.md',spec_sha256:hash,
      model:'opencode/spark',variant:'high',edit_paths:['escape/worker.mjs']};
    const launchedModels=[];
    const outsideFile=join(outside,'worker.mjs');
    const result=await executeOpenCodeTask('Synthetic junction race; no real model invocation.',
      config,job,randomUUID(),{
        qualifyOpenCodeV2:()=>({ready:true,bin:'synthetic-opencode-v2.exe',version:'2.0.test'}),
        readV2ProviderAuth:()=>({status:'AUTH_PROVIDER_RECORD_PRESENT'}),
        gitPlatform:'win32',
        readGitProcessTree:pid=>({state:'DEAD',root_pid:pid,process_ids:[],census_complete:true,
          observed_at:new Date().toISOString(),error:null}),
        runCapturedProcess(_bin,args,options){
          launchedModels.push(args[args.indexOf('--model')+1]);
          rmSync(junction,{recursive:true});
          symlinkSync(outside,junction,'junction');
          writeFileSync(outsideFile,'export const state = "written outside workspace";\n');
          const sessionID='synthetic-opencode-junction-session';
          const events=[
            {type:'step_start',sessionID},
            {type:'tool_use',sessionID,part:{type:'tool',tool:'edit',callID:'junction-race-edit',
              state:{status:'completed'}}},
            {type:'step_finish',sessionID,part:{type:'step-finish',tokens:{input:1,output:1,
              reasoning:0,cache:{read:0}}}},
          ];
          const stdout=Buffer.from(`${events.map(event=>JSON.stringify(event)).join('\n')}\n`);
          const stderr=Buffer.alloc(0);
          writeFileSync(options.stdoutPath,stdout,{flag:'wx'});
          writeFileSync(options.stderrPath,stderr,{flag:'wx'});
          return {outcome:'SYNTHETIC_PROCESS_EXITED',exit_code:0,
            local_evidence:{stdout_file:basename(options.stdoutPath),
              stdout_sha256:createHash('sha256').update(stdout).digest('hex'),stdout_bytes:stdout.length,
              stderr_file:basename(options.stderrPath),stderr_sha256:createHash('sha256').update(stderr).digest('hex'),
              stderr_bytes:0,termination_state:'NOT_REQUESTED'}};
        },
      });

    assert.equal(result.model_invoked,true,JSON.stringify(result));
    assert.deepEqual(launchedModels,['opencode/spark#high'],
      'the pinned OpenCode model is launched once; no fallback model is attempted');
    assert.equal(result.outcome,'V2_EDIT_PHYSICAL_PATH_SCOPE_UNKNOWN');
    assert.equal(result.coding_state,'UNKNOWN');
    assert.equal(result.scope_valid,false);
    assert.equal(result.external_effects,'UNKNOWN');
    assert.equal(result.source_diff_evidence,'UNKNOWN');
    assert.equal(result.diff_bytes,null,'physical scope uncertainty cannot be reported as zero bytes');
    assert.equal(result.diff_sha256,null);
    assert.equal(result.physical_scope_failure,'EDIT_PATH_PHYSICAL_ROOT_ESCAPE');
    assert.equal(readFileSync(outsideFile,'utf8'),'export const state = "written outside workspace";\n',
      'the externally written file remains preserved for reconciliation');
    assert.equal(readFileSync(join(workspace,'src','worker.mjs'),'utf8'),'export const state = "base";\n');
    assert.equal(existsSync(join(workspace,'opencode.json')),false,
      'the temporary scoped policy is removed after normal process termination and exact readback');
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
      inference_executed:false,credential_values_collected:false,
      model_catalog:{status:'PINNED_MODEL_CATALOGED_NOT_ENTITLEMENT',pinned_model_cataloged:true,
        catalog_count:1,catalog_sha256:h(ANTIGRAVITY_V2_MODEL)},
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
      inference_executed:false,credential_values_collected:false,
      model_catalog:{status:'PINNED_MODEL_CATALOGED_NOT_ENTITLEMENT',pinned_model_cataloged:true,
        catalog_count:1,catalog_sha256:h(ANTIGRAVITY_V2_MODEL)},
      gemini_aggregate_quota:{status:'GEMINI_AGGREGATE_QUOTA_READ',
        source:'GEMINI_MODELS_AGGREGATE',weekly_remaining_percent:95,
        weekly_reset_at:new Date(now+7*24*60*60*1000).toISOString(),
        five_hour_remaining_percent:99,
        five_hour_reset_at:new Date(now+5*60*60*1000).toISOString()},
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

    const escapedRoot=join(home,'outside-edit-target');
    const escapedFile=join(escapedRoot,'worker.mjs');
    const escapedJunction=join(workspace,'escape');
    mkdirSync(escapedRoot,{recursive:true});
    writeFileSync(escapedFile,'export const value = "before";\n');
    symlinkSync(escapedRoot,escapedJunction,'junction');
    let junctionModelCalls=0;
    try {
      const escapedJob={...job,edit_paths:['escape/worker.mjs']};
      const preflight=await executeOpenCodeTask('Synthetic junction escape; no inference.',config,
        escapedJob,randomUUID(),{now:()=>now,localAppData,
          runAntigravityV2Readiness:()=>readiness,
          runCapturedProcess(){junctionModelCalls++;throw new Error('MODEL_MUST_NOT_RUN');}});
      assert.equal(preflight.outcome,'ANTIGRAVITY_EDIT_SOURCE_EDIT_PATH_PHYSICAL_ROOT_ESCAPE');
      assert.equal(preflight.model_invoked,false);
      assert.equal(preflight.scope_valid,false);
      assert.equal(preflight.external_effects,'NONE');
      assert.equal(junctionModelCalls,0,'a pre-existing junction escape must be rejected before model launch');
      assert.equal(readFileSync(escapedFile,'utf8'),'export const value = "before";\n');
    } finally { unlinkSync(escapedJunction); }

    const racedJunction=join(workspace,'race');
    const racedFile=join(escapedRoot,'raced-worker.mjs');
    let racedModelCalls=0;
    const racedResult=await executeOpenCodeTask('Synthetic junction inserted during model execution.',config,
      {...job,edit_paths:['race/raced-worker.mjs']},randomUUID(),{
        now:()=>now,localAppData,runAntigravityV2Readiness:()=>readiness,
        readGitProcessTree:pid=>({state:'DEAD',root_pid:pid,process_ids:[],
          census_complete:true,observed_at:new Date(now).toISOString(),error:null}),
        readAntigravityV2RunEvidence:()=>({valid:true,reason:null,session_id:'synthetic-session',
          session_started:true,cli_status:'SUCCESS',run_disposition:'MODEL_ACTIVITY_OBSERVED',
          external_effects:'OBSERVED',source_diff_evidence:'CAPTURED',task_acceptance:'UNVERIFIED',
          permission_mode_evidence:'REQUEST_REVIEW',model_invoked:true,
          provider_usage_evidence:'OBSERVED',model_activity_evidence:'OBSERVED',
          token_usage:{input_tokens:1,output_tokens:1,thinking_tokens:0,cache_read_tokens:0,total_tokens:2},
          tool_execution_evidence:'OBSERVED',tool_execution_count:1,tool_execution_failed_count:0,
          tool_execution_incomplete_count:0,file_change_tool_evidence:'OBSERVED',
          file_change_tool_completed_count:1,file_change_tool_failed_count:0,
          file_change_tool_incomplete_count:0,forbidden_tool_execution_evidence:'NONE',
          event_count:2,stdout_bytes:10}),
        runCapturedProcess(_bin,_args,options){
          racedModelCalls++;
          symlinkSync(escapedRoot,racedJunction,'junction');
          writeFileSync(racedFile,'export const value = "escaped";\n');
          writeFileSync(options.stdoutPath,'synthetic stream evidence\n');
          return {outcome:'SYNTHETIC_PROCESS_EXITED',exit_code:0,
            local_evidence:{stdout_file:basename(options.stdoutPath),
              stdout_sha256:h('synthetic stream evidence\n'),stdout_bytes:26,
              stderr_file:basename(options.stderrPath),stderr_sha256:h(''),stderr_bytes:0,
              termination_state:'NOT_REQUESTED'}};
        },
      });
    try {
      assert.equal(racedModelCalls,1,'the synthetic executor alone created this post-preflight race');
      assert.equal(racedResult.outcome,'ANTIGRAVITY_EDIT_PHYSICAL_PATH_SCOPE_UNKNOWN');
      assert.equal(racedResult.coding_state,'UNKNOWN');
      assert.equal(racedResult.scope_valid,false);
      assert.equal(racedResult.external_effects,'UNKNOWN');
      assert.equal(racedResult.source_diff_evidence,'UNKNOWN');
      assert.equal(racedResult.diff_bytes,null,'an escaped write is never reported as a zero-byte diff');
      assert.equal(racedResult.physical_scope_failure,'EDIT_PATH_PHYSICAL_ROOT_ESCAPE');
      assert.equal(readFileSync(racedFile,'utf8'),'export const value = "escaped";\n',
        'the test preserves and reads back the external effect instead of deleting or replaying it');
    } finally { if (existsSync(racedJunction)) unlinkSync(racedJunction); }

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
      runAntigravityV2Readiness(bin,cwd,_runner,_env,_signatureVerifier,projectId,projectBindingRoot){
        readinessCalls++;
        assert.equal(bin,join(localAppData,'agy','bin','agy.exe'));
        assert.equal(cwd,workspace);
        assert.equal(projectId,config.antigravity_cli_project_id);
        assert.equal(projectBindingRoot,registeredProjectRoot,
          'readiness binds the CLI project ID to the registered root while preserving the isolated candidate cwd');
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
        const promptContent = JSON.parse(options.stdinText).message.content;
        assert.ok(promptContent.includes(resolve(workspace,'src/worker.mjs')),
          'the file tool must receive the exact absolute path inside the attempt checkout');
        assert.ok(promptContent.includes('Use only the exact absolute paths supplied for the current attempt workspace. Never resolve or edit a path from the registered parent project.'),
          'prompt must enforce attempt-workspace absolute paths and forbid parent project resolution');
        assert.ok(promptContent.includes('Read files from byte offset zero in bounded chunks no larger than 16 KiB'),
          'prompt must require bounded reads no larger than 16 KiB starting from offset zero');
        assert.ok(promptContent.includes('never use a line number or an offset beyond the returned content/file length'),
          'prompt must forbid line numbers and invalid offsets');
        assert.ok(promptContent.includes('Immediately before each `edit_file`, reread the exact current target text from the same path and attempt workspace'),
          'prompt must require fresh target text readback immediately before each edit_file');
        assert.ok(promptContent.includes('Build the replacement from that fresh text, not from an earlier read or remembered source'),
          'prompt must require replacement to be built from fresh text');
        assert.ok(promptContent.includes('If an exact target no longer matches, reread the affected section once and adjust to the current exact text'),
          'prompt must require one reread on target mismatch');
        assert.ok(promptContent.includes('stop without broad replacement and report the blocker'),
          'prompt must require stopping without broad replacement if target is ambiguous or absent');
        assert.ok(promptContent.includes('After each edit, reread the changed span and verify the intended result before proceeding'),
          'prompt must require post-edit readback verification');
        assert.ok(promptContent.includes('Do not run shell commands, access the network, inspect credentials, or edit any other path'),
          'prompt must retain existing non-file-tool restrictions');
        assert.ok(promptContent.includes('Do not request broader permissions'),
          'prompt must forbid requesting broader permissions');
        assert.ok(promptContent.includes('If a required permission or file is unavailable, report the blocker without requesting broader access'),
          'prompt must report blockers without broader access');
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
            step_type:'tool',tool_name:'write_to_file',tool_info:{name:'write_to_file',parameters:{
              TargetFile:join(workspace,'src','worker.mjs')}}}},
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
      baseline_changed_files_count:0,changed_files_count:0,
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
    const fileFailureSession='conv_antigravity_file_failure_20261027';
    let fileFailureModelLaunches=0;
    const fileFailure=await executeOpenCodeTask('Synthetic; retain a scoped diff after a failed file edit.',
      config,job,randomUUID(),{now:()=>now,baseEnv:env,localAppData,
        runAntigravityV2Readiness:()=>readiness,
        async runCapturedProcess(_bin,_args,options){
          fileFailureModelLaunches++;
          writeFileSync(join(workspace,'src','worker.mjs'),
            'export const state = "captured after a failed edit attempt";\n');
          const fileTarget=join(workspace,'src','worker.mjs');
          const events=[
            {event:'init',conversation_id:fileFailureSession,init:{model:ANTIGRAVITY_V2_MODEL,
              cwd:workspace,permission_mode:'request-review'}},
            {event:'step_update',step_update:{conversation_id:fileFailureSession,step_index:0,
              state:'ACTIVE',step_type:'tool',tool_name:'write_to_file',tool_info:{parameters:{TargetFile:fileTarget}}}},
            {event:'step_update',step_update:{conversation_id:fileFailureSession,step_index:0,
              state:'ERROR',step_type:'tool',tool_name:'write_to_file',tool_info:{parameters:{TargetFile:fileTarget},
                error:{code:'WRITE_REJECTED'}}}},
            {event:'step_update',step_update:{conversation_id:fileFailureSession,step_index:1,
              state:'ACTIVE',step_type:'tool',tool_name:'edit_file',tool_info:{parameters:{TargetFile:fileTarget}}}},
            {event:'step_update',step_update:{conversation_id:fileFailureSession,step_index:1,
              state:'DONE',step_type:'tool',tool_name:'edit_file',tool_info:{parameters:{TargetFile:fileTarget}}}},
            {event:'result',result:{conversation_id:fileFailureSession,status:'SUCCESS',response:'',
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
        }});
    assert.equal(fileFailureModelLaunches,1);
    assert.equal(fileFailure.outcome,'ANTIGRAVITY_EDIT_DIFF_CAPTURED_UNVERIFIED_FILE_TOOL_FAILURES_RETAINED',
      JSON.stringify({edit_diff_error:fileFailure.local_evidence?.edit_diff_error,
        cli_status:fileFailure.cli_status,run_reason:fileFailure.local_evidence?.antigravity_run?.reason}));
    assert.equal(fileFailure.exit_code,0,'a completed CLI session with a captured scoped diff is terminal');
    assert.equal(fileFailure.cli_exit_code,0);
    assert.equal(fileFailure.tool_execution_failed_count,1);
    assert.equal(fileFailure.file_change_tool_failed_count,1);
    assert.equal(fileFailure.file_change_tool_completed_count,1);
    assert.equal(fileFailure.file_change_tool_incomplete_count,0);
    assert.deepEqual(fileFailure.changed_files,['src/worker.mjs']);
    assert.equal(fileFailure.task_acceptance,'UNKNOWN');
    assert.equal(fileFailure.external_effects,'UNKNOWN');
    assert.equal(terminalStateForResult(fileFailure),'FINISHED',
      'FINISHED records terminal lifecycle only; the captured diff remains unaccepted');
    const fileFailureReceipt=receipt(job.request_id,randomUUID(),'FINISHED',job,fileFailure);
    assert.equal(fileFailureReceipt.file_change_tool_failed_count,1);
    assert.equal(fileFailureReceipt.task_acceptance,'UNKNOWN');
    assert.equal(parseReceipt(RECEIPT_MARKER+JSON.stringify(fileFailureReceipt)).file_change_tool_failed_count,1);

    git(workspace,'checkout','--','src/worker.mjs');
    const unrelatedWipPath=join(registeredProjectRoot,'registered-root-only.txt');
    const unrelatedWip='pre-existing unrelated registered-root WIP\n';
    writeFileSync(unrelatedWipPath,unrelatedWip);
    const isolatedSession='conv_antigravity_unrelated_registered_root_wip_20261027';
    let isolatedModelLaunches=0;
    try {
      const isolated=await executeOpenCodeTask('Synthetic; preserve unrelated registered-root WIP.',
        config,job,randomUUID(),{now:()=>now,baseEnv:env,localAppData,
          runAntigravityV2Readiness:()=>readiness,
          readGitProcessTree:pid=>({state:'DEAD',root_pid:pid,process_ids:[],
            census_complete:true,observed_at:new Date(now).toISOString(),error:null}),
          async runCapturedProcess(_bin,_args,options){
            isolatedModelLaunches++;
            writeFileSync(join(workspace,'src','worker.mjs'),
              'export const state = "candidate-change-with-unrelated-root-wip";\n');
            const events=[
              {event:'init',conversation_id:isolatedSession,init:{model:ANTIGRAVITY_V2_MODEL,
                cwd:workspace,permission_mode:'accept-edits'}},
              {event:'step_update',step_update:{conversation_id:isolatedSession,step_index:0,state:'DONE',
                step_type:'tool',tool_name:'write_to_file',tool_info:{name:'write_to_file',parameters:{
                  TargetFile:join(workspace,'src','worker.mjs')}}}},
              {event:'result',result:{conversation_id:isolatedSession,status:'SUCCESS',response:'',
                usage:{input_tokens:8,output_tokens:3,thinking_tokens:0,cache_read_tokens:0,total_tokens:11}}},
            ];
            const out=Buffer.from(events.map(event=>JSON.stringify(event)).join('\n')+'\n');
            const err=Buffer.alloc(0);writeFileSync(options.stdoutPath,out,{flag:'wx'});
            writeFileSync(options.stderrPath,err,{flag:'wx'});
            const combined=createHash('sha256').update(out).update(Buffer.from('\n--- STDERR ---\n'))
              .update(err).digest('hex');
            return {outcome:'SYNTHETIC_PROCESS_EXITED',exit_code:0,evidence_sha256:combined,
              evidence_bytes:out.length+Buffer.byteLength('\n--- STDERR ---\n'),local_evidence:{
                stdout_file:basename(options.stdoutPath),stdout_sha256:createHash('sha256').update(out).digest('hex'),
                stdout_bytes:out.length,stderr_file:basename(options.stderrPath),
                stderr_sha256:createHash('sha256').update(err).digest('hex'),stderr_bytes:0,
                termination_state:'NOT_REQUESTED'}};
          }});
      assert.equal(isolatedModelLaunches,1,
        'an unrelated pre-existing registered-root change must not block the isolated candidate');
      assert.equal(isolated.outcome,'ANTIGRAVITY_EDIT_DIFF_CAPTURED_UNVERIFIED');
      assert.equal(isolated.model_invoked,true);
      assert.deepEqual(isolated.changed_files,['src/worker.mjs']);
      assert.equal(readFileSync(unrelatedWipPath,'utf8'),unrelatedWip,
        'the unrelated registered-root WIP must remain byte-identical');
      assert.deepEqual(isolated.local_evidence.antigravity_project_root_check,{
        status:'UNCHANGED_PREEXISTING_CHANGES',head_before_sha:registeredProjectSha,
        head_after_sha:registeredProjectSha,status_sha256:createHash('sha256')
          .update(Buffer.from(' M registered-root-only.txt\0')).digest('hex'),
        status_bytes:Buffer.byteLength(' M registered-root-only.txt\0'),
        baseline_changed_files_count:1,changed_files_count:0,
      });
    } finally {
      git(workspace,'checkout','--','src/worker.mjs');
      git(registeredProjectRoot,'checkout','--','registered-root-only.txt');
    }

    const wrongRootSession='conv_antigravity_registered_root_write_20261027';
    const wrongRoot=await executeOpenCodeTask('Synthetic; file tool writes outside candidate root.',config,job,
      randomUUID(),{now:()=>now,baseEnv:env,localAppData,
        runAntigravityV2Readiness:()=>readiness,
        readGitProcessTree:pid=>({state:'DEAD',root_pid:pid,process_ids:[],
          census_complete:true,observed_at:new Date(now).toISOString(),error:null}),
        async runCapturedProcess(_bin,_args,options){
          const events=[
            {event:'init',conversation_id:wrongRootSession,init:{model:ANTIGRAVITY_V2_MODEL,
              cwd:workspace,permission_mode:'accept-edits'}},
            {event:'step_update',step_update:{conversation_id:wrongRootSession,step_index:0,
              state:'ACTIVE',step_type:'tool',tool_name:'multi_replace_file_content',
              tool_info:{name:'multi_replace_file_content',parameters:{
                TargetFile:join(registeredProjectRoot,'src','worker.mjs')}}}},
            {event:'step_update',step_update:{conversation_id:wrongRootSession,step_index:0,
              state:'DONE',step_type:'tool',tool_name:'multi_replace_file_content',
              tool_info:{name:'multi_replace_file_content',parameters:{
                TargetFile:join(registeredProjectRoot,'src','worker.mjs')}}}},
            {event:'result',result:{conversation_id:wrongRootSession,status:'SUCCESS',response:'',
              usage:{input_tokens:10,output_tokens:2,thinking_tokens:0,cache_read_tokens:0,total_tokens:12}}},
          ];
          const out=Buffer.from(events.map(event=>JSON.stringify(event)).join('\n')+'\n');
          const err=Buffer.alloc(0); writeFileSync(options.stdoutPath,out,{flag:'wx'});
          writeFileSync(options.stderrPath,err,{flag:'wx'});
          const combined=createHash('sha256').update(out).update(Buffer.from('\n--- STDERR ---\n')).update(err).digest('hex');
          return {outcome:'SYNTHETIC_REGISTERED_ROOT_WRITE',exit_code:0,
            evidence_sha256:combined,evidence_bytes:out.length+Buffer.byteLength('\n--- STDERR ---\n'),
            local_evidence:{stdout_file:basename(options.stdoutPath),
              stdout_sha256:createHash('sha256').update(out).digest('hex'),stdout_bytes:out.length,
              stderr_file:basename(options.stderrPath),stderr_sha256:createHash('sha256').update(err).digest('hex'),
              stderr_bytes:0,termination_state:'NOT_REQUESTED'}};
        }});
    assert.equal(wrongRoot.outcome,'ANTIGRAVITY_EDIT_FILE_TARGET_MISMATCH_NO_CANDIDATE_DIFF');
    assert.equal(wrongRoot.coding_state,'UNKNOWN');
    assert.equal(wrongRoot.scope_valid,false);
    assert.equal(wrongRoot.external_effects,'UNKNOWN');
    assert.equal(wrongRoot.model_invoked,true);
    assert.equal(wrongRoot.diff_bytes,0);
    assert.deepEqual(wrongRoot.file_change_target_evidence,{
      status:'REGISTERED_ROOT_ONLY',tool_count:1,target_count:1,candidate_root_count:0,
      registered_root_count:1,outside_or_unknown_root_count:0,
      relative_or_unknown_root_count:0,unidentified_tool_count:0,
    });
    const wrongRootReceipt=receipt(job.request_id,randomUUID(),'BLOCKED',job,wrongRoot);
    assert.deepEqual(parseReceipt(RECEIPT_MARKER+JSON.stringify(wrongRootReceipt))?.file_change_target_evidence,
      wrongRoot.file_change_target_evidence);
    assert.equal(terminalStateForResult(wrongRoot),'BLOCKED');

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
            step_type:'tool',tool_name:'write_to_file',tool_info:{name:'write_to_file',parameters:{
              TargetFile:join(workspace,'src','worker.mjs')}}}},
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
      readGitProcessTree:pid=>({state:'DEAD',root_pid:pid,process_ids:[],
        census_complete:true,observed_at:new Date(now).toISOString(),error:null}),
      async runCapturedProcess(_bin,_args,options){
        writeFileSync(join(workspace,'src','worker.mjs'),'export const state = "changed-with-cli-replacement";\n');
        const events=[
          {event:'init',conversation_id:'conv_agy_binary_changed',init:{model:ANTIGRAVITY_V2_MODEL,
            cwd:workspace,permission_mode:'accept-edits'}},
          {event:'step_update',step_update:{conversation_id:'conv_agy_binary_changed',step_index:0,
            state:'DONE',step_type:'tool',tool_name:'write_to_file',tool_info:{name:'write_to_file',parameters:{
              TargetFile:join(workspace,'src','worker.mjs')}}}},
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
              step_index:0,state:'DONE',step_type:'tool',tool_name:'write_to_file',tool_info:{name:'write_to_file',
                parameters:{TargetFile:join(workspace,'src','worker.mjs')}}}},
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
              state:'DONE',step_type:'tool',tool_name:'write_to_file',tool_info:{name:'write_to_file',
                parameters:{TargetFile:join(workspace,'src','worker.mjs')}}}},
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

    git(workspace,'checkout','--','src/worker.mjs');
    const mismatchedWorkspace=join(home,'mismatched-workspace',randomUUID());
    mkdirSync(dirname(mismatchedWorkspace),{recursive:true});
    git(registeredProjectRoot,'worktree','add','--quiet','--detach',mismatchedWorkspace,sourceSha);
    const mismatchedFile=join(mismatchedWorkspace,'src','worker.mjs');
    const mismatchSession='conv_agy_cwd_mismatch_20261018';
    const candidateDiffsBefore=readdirSync(stateDir).filter(name=>name.startsWith('edit-diff-')).length;
    const cwdMismatch=await executeOpenCodeTask(
      'Synthetic unexpected Antigravity cwd; no model call.',config,job,randomUUID(),{
        now:()=>now,baseEnv:env,localAppData,runAntigravityV2Readiness:()=>readiness,
        readGitProcessTree:pid=>({state:'DEAD',root_pid:pid,process_ids:[],census_complete:true,
          observed_at:new Date(now).toISOString(),error:null}),
        async runCapturedProcess(_bin,_args,options){
          writeFileSync(mismatchedFile,'export const state = "changed in other workspace";\n');
          const events=[
            {event:'init',conversation_id:mismatchSession,init:{model:ANTIGRAVITY_V2_MODEL,
              cwd:mismatchedWorkspace,permission_mode:'request-review'}},
            {event:'step_update',step_update:{conversation_id:mismatchSession,step_index:0,
              state:'DONE',step_type:'tool',tool_name:'edit_file',tool_info:{name:'edit_file',parameters:{
                Path:join(mismatchedWorkspace,'src','worker.mjs')}}}},
            {event:'result',result:{conversation_id:mismatchSession,status:'SUCCESS',response:'synthetic',
              usage:{input_tokens:1,output_tokens:1,thinking_tokens:0,cache_read_tokens:0,total_tokens:2}}},
          ];
          const out=Buffer.from(events.map(event=>JSON.stringify(event)).join('\n')+'\n');
          const err=Buffer.alloc(0);
          writeFileSync(options.stdoutPath,out,{flag:'wx'});
          writeFileSync(options.stderrPath,err,{flag:'wx'});
          return {outcome:'SYNTHETIC_PROCESS_EXITED',exit_code:0,evidence_sha256:null,
            evidence_bytes:out.length,local_evidence:{stdout_file:basename(options.stdoutPath),
              stdout_sha256:createHash('sha256').update(out).digest('hex'),stdout_bytes:out.length,
              stderr_file:basename(options.stderrPath),stderr_sha256:createHash('sha256').update(err).digest('hex'),
              stderr_bytes:0,termination_state:'NOT_REQUESTED'}};
        },
      });
    assert.equal(cwdMismatch.outcome,
      'ANTIGRAVITY_EDIT_FILE_TARGET_ROOT_MISMATCH_WORKSPACE_IDENTITY_UNKNOWN');
    assert.equal(cwdMismatch.scope_valid,false);
    assert.equal(cwdMismatch.external_effects,'UNKNOWN');
    assert.equal(cwdMismatch.source_diff_evidence,'UNKNOWN');
    assert.equal(cwdMismatch.diff_bytes,null,'a different cwd must never become a zero-byte candidate diff');
    assert.equal(cwdMismatch.diff_sha256,null);
    assert.equal(cwdMismatch.local_evidence.workspace_cwd_evidence.status,'MISMATCH');
    assert.equal(cwdMismatch.local_evidence.edit_diff.status,'NOT_CAPTURED_WORKSPACE_IDENTITY_UNKNOWN');
    assert.ok(existsSync(join(stateDir,cwdMismatch.local_evidence.stdout_file)),
      'the original captured stream remains available for reconciliation');
    assert.equal(readdirSync(stateDir).filter(name=>name.startsWith('edit-diff-')).length,
      candidateDiffsBefore,'the executor must not capture an unrelated checkout as proof of no changes');
    assert.match(readFileSync(mismatchedFile,'utf8'),/changed in other workspace/,
      'the mismatched workspace effect remains intact for later recovery');
    assert.equal(readFileSync(join(workspace,'src','worker.mjs'),'utf8').replaceAll('\r\n','\n'),
      'export const state = "base";\n',
      'the configured candidate is not falsely treated as the model write destination');

    const escapedWorkspace=join(home,'attempt-workspaces',randomUUID());
    git(registeredProjectRoot,'worktree','add','--quiet','--detach',escapedWorkspace,sourceSha);
    const escapedJob={...job,edit_paths:['package.json','native-bridge/antigravity-quota.mjs',
      'tests/antigravity-quota.test.mjs']};
    const escapedAttempt=await executeOpenCodeTask('Synthetic project-root escape; no inference.',
      {...config,workspace:escapedWorkspace},escapedJob,randomUUID(),{
        now:()=>now,baseEnv:env,localAppData,runAntigravityV2Readiness:()=>readiness,
        readGitProcessTree:pid=>({state:'DEAD',root_pid:pid,process_ids:[],
          census_complete:true,observed_at:new Date(now).toISOString(),error:null}),
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
          writeFileSync(join(registeredProjectRoot,'unapproved-local-state.txt'),
            'must remain undisclosed by the recovery receipt\n');
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
    assert.equal(escapedAttempt.project_root_changed_files_count,4);
    assert.deepEqual(escapedAttempt.project_root_changed_paths,[
      'native-bridge/antigravity-quota.mjs','package.json','tests/antigravity-quota.test.mjs',
    ]);
    assert.equal(escapedAttempt.project_root_out_of_scope_changed_files_count,1);
    assert.deepEqual(escapedAttempt.local_evidence.antigravity_project_root_check.changed_allowed_paths,
      escapedAttempt.project_root_changed_paths);
    assert.equal(escapedAttempt.local_evidence.antigravity_project_root_check.out_of_scope_changed_files_count,1);
    assert.equal(JSON.stringify(escapedAttempt).includes('unapproved-local-state.txt'),false,
      'only exact authorized edit paths may be emitted in recovery evidence');
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
test('trusted dispatcher receipts block cross-identity replay without becoming worker acceptance', async () => {
  const job = withHumanGoal({ schema: 6, project_id: PROJECT, host: 'DESKTOP-1B6PD2P',
    request_id: 'PTYSD_CROSS_IDENTITY_RECEIPT_DEDUPE_20261029', kind: 'antigravity_edit',
    source_sha: commit, spec_path: 'native-bridge/tasks/w2-quota-canary.md',
    spec_sha256: hash, model: ANTIGRAVITY_V2_MODEL, variant: 'high',
    edit_paths: ['src/w2-quota-canary.mjs'], source_pr: 461 });
  const attemptId = '11111111-1111-4111-8111-111111111111';
  const started = receipt(job.request_id, attemptId, 'STARTED', job);
  const blocked = receipt(job.request_id, attemptId, 'BLOCKED', job);
  const comments = [com(10, encoded(job), 't14210184'),
    com(11, RECEIPT_MARKER + JSON.stringify(started), 't14210184'),
    com(12, RECEIPT_MARKER + JSON.stringify(blocked), 't14210184')];
  assert.equal(parseReceipt(comments[2].body)?.state, 'BLOCKED');

  const sourceReads = [];
  const sources = await readPinnedCandidateSources(comments, ['t14210184'], 'wfvupu1212',
    job.host, path => { sourceReads.push(path); return {}; }, undefined, [], () => []);
  assert.equal(sources.size, 0,
    'a trusted dispatcher receipt suppresses replay when the local Worker login changed');
  assert.deepEqual(sourceReads, [], 'a terminal cross-identity receipt prevents candidate reads');
  assert.equal(selectNext(comments, ['t14210184'], 'wfvupu1212', job.host,
    commit, [], new Map([[job.source_pr, job.source_sha]])), null,
  'the exact historical request cannot be selected again');

  const now = Date.now();
  const observationComments = [{ id: OPERATOR_COMMENT_ID,
    user: { login: 'wfvupu1212' },
    body: encodeOperatorObservation(seededOperatorObservation(OPERATOR_COMMENT_ID, 2,
      'c'.repeat(40), now - 60_000)),
    updated_at: new Date(now - 50_000).toISOString() }, ...comments];
  const config = { repo: REPO, project_id: PROJECT, host: job.host, issue: 407,
    dispatchers: ['t14210184'], state_dir: 'unused', enable_antigravity_model_runs: true };
  const observed = await publishOperatorObservation(config, 'wfvupu1212', observationComments,
    commit, {
      now: () => new Date(now),
      collectWindowsObservation: () => ({ status: 'FRESH',
        native_task: { registered: true, enabled: true, state: 'READY' } }),
      collectRuntimeDeployment: () => ({ status: 'UNKNOWN', observed_at: new Date(now).toISOString(),
        bundle_sha256: hash, component_sha256: Object.fromEntries([
          'worker.mjs', 'opencode-v2.mjs', 'v2-readiness.mjs', 'codex-continuation.mjs',
          'antigravity-quota.mjs', 'operator-observation.mjs', 'captured-process.mjs',
          'safe-error-code.mjs', 'executor.mjs', 'windows-executor.mjs',
        ].map(name => [name, null])), reason_code: 'RUNTIME_FILES_UNAVAILABLE' }),
      readRunnerRegistration: () => ({ total_count: 0 }),
      readComment: id => structuredClone(observationComments.find(item => item.id === id)),
      patchComment: (id, body) => {
        const target = observationComments.find(item => item.id === id);
        target.body = body;
        target.updated_at = new Date(now + 1_000).toISOString();
      },
      readComments: () => structuredClone(observationComments),
    }, new Map([[job.source_pr, job.source_sha]]));
  const workerRecord = observed.observation.workers.find(item => item.worker_id === 'W2');
  assert.equal(workerRecord.task_state, 'QUEUED_NOT_STARTED',
    'dispatcher-authored receipts do not become Worker activity');
  assert.equal(workerRecord.attempt_id, undefined);
  assert.equal(workerRecord.delivery_status, undefined,
    'dispatcher-authored receipts cannot produce Worker delivery acceptance');
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
test('an unresolved edit attempt blocks only overlapping paths across model lanes', () => {
  const host = 'DESKTOP-1B6PD2P';
  const sourceSha = 'c'.repeat(40);
  const makeEdit = (requestId, kind, editPaths) => withHumanGoal(mkjob({
    request_id: requestId, kind, source_sha: sourceSha,
    spec_path: 'native-bridge/tasks/overlap-test.md', spec_sha256: hash,
    model: kind === 'antigravity_edit' ? ANTIGRAVITY_V2_MODEL : 'opencode/deepseek-v4.1-flash-free',
    variant: kind === 'antigravity_edit' ? 'high' : 'free',
    edit_paths: editPaths, source_pr: 461,
  }));
  const active = makeEdit('PTYSD_ACTIVE_W2_SHARED_PATH', 'antigravity_edit', ['src/shared.mjs']);
  const overlapping = makeEdit('PTYSD_READY_W1_SHARED_PATH', 'opencode_edit', ['src/shared.mjs']);
  const independent = makeEdit('PTYSD_READY_W1_INDEPENDENT_PATH', 'opencode_edit', ['docs/independent.md']);
  const attemptId = '44444444-4444-4444-8444-444444444444';
  const jobComment = (id, job) => ({ ...com(id, encoded(job)),
    issue_url: `https://api.github.com/repos/${REPO}/issues/310` });
  const started = receipt(active.request_id, attemptId, 'STARTED', active, {
    model_invoked: true, external_effects: 'UNKNOWN',
  });
  const comments = [
    jobComment(801, active), jobComment(802, overlapping), jobComment(803, independent),
    com(804, RECEIPT_MARKER + JSON.stringify(started), 'worker'),
  ];
  const heads = new Map([[461, sourceSha]]);
  assert.equal(selectNext(comments, ['t14210184'], 'worker', host, sourceSha, [], heads)?.id, 803,
    'an unresolved W2 effect must not starve a non-overlapping W1 task');
  assert.equal(selectNext([comments[0], comments[1], comments[3]],
    ['t14210184'], 'worker', host, sourceSha, [], heads), null,
  'the same uncertain attempt must protect its overlapping path from another writer');
  const blocked = receipt(active.request_id, attemptId, 'BLOCKED', active, {
    outcome: 'EXECUTOR_EDIT_WORKSPACE_READBACK_UNKNOWN', exit_code: 46,
    model_invoked: true, external_effects: 'UNKNOWN', source_diff_evidence: 'NOT_INSPECTED',
  });
  const blockedComments = [comments[0], comments[1], comments[2],
    com(805, RECEIPT_MARKER + JSON.stringify(blocked), 'worker')];
  assert.equal(selectNext(blockedComments, ['t14210184'], 'worker', host,
    sourceSha, [], heads)?.id, 803,
  'a terminal W2 receipt with unknown effects must still permit independent paths');
  assert.equal(selectNext([blockedComments[0], blockedComments[1], blockedComments[3]],
    ['t14210184'], 'worker', host, sourceSha, [], heads), null,
  'a terminal W2 receipt with unknown effects must protect overlapping paths');
});
test('captured terminal edit evidence releases its path lease for a later exact source', () => {
  const host = 'DESKTOP-1B6PD2P';
  const oldSha = 'c'.repeat(40), nextSha = 'd'.repeat(40);
  const makeEdit = (requestId, sourceSha) => withHumanGoal(mkjob({
    request_id: requestId, kind: 'opencode_edit', source_sha: sourceSha,
    spec_path: 'native-bridge/tasks/overlap-test.md', spec_sha256: hash,
    model: 'opencode/deepseek-v4.1-flash-free', variant: 'free',
    edit_paths: ['native-bridge/v2-readiness.mjs'], source_pr: 461,
  }));
  const prior = makeEdit('PTYSD_FINISHED_CAPTURED_W1', oldSha);
  const next = makeEdit('PTYSD_NEXT_CAPTURED_W1', nextSha);
  const attemptId = '55555555-5555-4555-8555-555555555555';
  const completed = receipt(prior.request_id, attemptId, 'FINISHED', prior, {
    outcome: 'V2_EDIT_DIFF_CAPTURED_UNVERIFIED', exit_code: 0, model_invoked: true,
    external_effects: 'UNKNOWN', source_diff_evidence: 'CAPTURED',
    coding_state: 'DIFF_CAPTURED_UNVERIFIED', task_acceptance: 'UNVERIFIED', scope_valid: true,
    diff_sha256: 'e'.repeat(64), diff_bytes: 128,
    changed_files: ['native-bridge/v2-readiness.mjs'],
  });
  const jobComment = (id, job) => ({ ...com(id, encoded(job)),
    issue_url: `https://api.github.com/repos/${REPO}/issues/310` });
  const comments = [jobComment(901, prior), jobComment(902, next),
    com(903, RECEIPT_MARKER + JSON.stringify(completed), 'worker')];
  const heads = new Map([[461, nextSha]]);

  assert.ok(parseJob(comments[0].body), 'the previous request must be a valid schema-6 edit job');
  assert.ok(parseJob(comments[1].body), 'the new request must be a valid schema-6 edit job');
  assert.equal(parseReceipt(comments[2].body)?.source_diff_evidence, 'CAPTURED');
  assert.equal(selectNext(comments, ['t14210184'], 'worker', host, nextSha, [], heads)?.id, 902,
    'a FINISHED attempt with a complete, scope-valid diff releases its path lease even when the broader effect field remains UNKNOWN');

  for (const unsafe of [
    { ...completed, scope_valid: false },
    { ...completed, diff_sha256: null },
    { ...completed, edit_paths_sha256: '0'.repeat(64) },
    { ...completed, state: 'BLOCKED' },
  ]) {
    const unsafeComments = [jobComment(901, prior), jobComment(902, next),
      com(903, RECEIPT_MARKER + JSON.stringify(unsafe), 'worker')];
    assert.equal(selectNext(unsafeComments, ['t14210184'], 'worker', host, nextSha, [], heads), null,
      'incomplete, out-of-scope, or blocked terminal evidence must retain the path lease');
  }
});
test('complete legacy schema-6 diff receipt releases its path lease without the later source-diff field', () => {
  const host = 'DESKTOP-1B6PD2P';
  const oldSha = '221e0c0e4524e07bc06a2aae431fdd34d121b73d';
  const nextSha = '19a62538854b648e583a6a92df563b82c6d99e36';
  const paths = ['native-bridge/v2-readiness.mjs', 'tests/v2-readiness.test.mjs'];
  const makeEdit = (requestId, kind, sourceSha, sourcePr, editPaths = paths) =>
    withHumanGoal(mkjob({ request_id: requestId, kind, source_sha: sourceSha,
      spec_path: 'native-bridge/tasks/legacy-lease-compat.md', spec_sha256: hash,
      model: kind === 'antigravity_edit' ? ANTIGRAVITY_V2_MODEL
        : 'opencode/deepseek-v4.1-flash-free',
      variant: kind === 'antigravity_edit' ? 'high' : null,
      edit_paths: editPaths, source_pr: sourcePr }));
  const prior = makeEdit('W1_EDITFILE_TELEMETRY_20261023_9C8247675F914DCBBC708DD2AB90A6C2',
    'opencode_edit', oldSha, 505);
  const next = makeEdit('W2_R7_TARGET_MULTIPLICITY_TEST', 'antigravity_edit', nextSha, 572);
  const attemptId = '3f9246cd-f968-4290-9c76-0514bb7775b5';
  const legacyTerminal = receipt(prior.request_id, attemptId, 'FINISHED', prior, {
    outcome: 'V2_EDIT_DIFF_CAPTURED_UNVERIFIED', exit_code: 0, model_invoked: true,
    coding_state: 'DIFF_CAPTURED_UNVERIFIED', scope_valid: true,
    diff_sha256: '2d40660d98eb983dc343c7b1a6612a868a948a288545bb51a4abb7af14e9e968',
    diff_bytes: 12151, changed_files: paths,
  });
  delete legacyTerminal.external_effects;
  delete legacyTerminal.source_diff_evidence;
  delete legacyTerminal.task_acceptance;

  const jobComment = (id, job) => ({ ...com(id, encoded(job)),
    issue_url: `https://api.github.com/repos/${REPO}/issues/310` });
  const comments = [jobComment(6356591863, prior), jobComment(6420000000, next),
    com(6356778997, RECEIPT_MARKER + JSON.stringify(legacyTerminal), 'worker')];
  const heads = new Map([[572, nextSha]]);

  assert.equal(parseJob(comments[0].body)?.request_id, prior.request_id);
  assert.equal(parseReceipt(comments[2].body)?.source_diff_evidence, undefined,
    'the historical terminal predates the optional source_diff_evidence field');
  assert.equal(legacyTerminal.changed_files_sha256,
    '1400bf7c12ebb87ee6ac38f56acfa0c521702754cfa8ba57cfa81882e9645af9',
    'the fixture preserves the historical two-path change-set digest');
  assert.equal(selectNext(comments, ['t14210184'], 'worker', host, nextSha, [], heads)?.id,
    6420000000,
    'the request-bound legacy diff releases the same-path lease so the new W2 job can run');

  for (const unsafe of [
    { ...legacyTerminal, source_diff_evidence: 'UNKNOWN' },
    { ...legacyTerminal, changed_files_count: null },
    { ...legacyTerminal, source_pr: 501 },
    { ...legacyTerminal, goal_body_sha256: '0'.repeat(64) },
  ]) {
    const unsafeComments = [comments[0], comments[1],
      com(6356778997, RECEIPT_MARKER + JSON.stringify(unsafe), 'worker')];
    assert.equal(selectNext(unsafeComments, ['t14210184'], 'worker', host,
      nextSha, [], heads), null,
    'explicitly unknown or incomplete request/source evidence must keep the path lease');
  }
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
    const waitingResult = { request_id: requestId, attempt_id: attemptId,
      terminal: waiting, local_evidence: { executor_workspace_guard: {
        registered_root_identity_sha256: 'a'.repeat(64),
        registered_root_state_sha256: 'b'.repeat(64),
        candidate_root_identity_sha256: 'c'.repeat(64),
        candidate_root_state_sha256: 'd'.repeat(64),
        registered_root_after_sha256: 'b'.repeat(64),
        candidate_root_after_sha256: 'd'.repeat(64),
        readback: 'COMPLETE', registered_root_changed_paths: 0,
        candidate_root_changed_paths: 0,
      } } };
    assert.equal(await verifyCapturedEvidence(resultsDir, waitingResult), true,
      'workspace guard metadata does not require stdout capture for a no-model WAITING receipt');
    await assert.rejects(verifyCapturedEvidence(resultsDir, { ...waitingResult,
      terminal: { ...waiting, session_id: 'forged_session' } }), /CAPTURED_EVIDENCE_PATH_INVALID/,
    'a WAITING receipt claiming a Session cannot use the no-capture recovery path');
    writeFileSync(resultPath, JSON.stringify(waitingResult), { flag: 'wx' });
    const adapters = {
      readExecutorWorkspace:()=>workspace,
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
    const pendingJob = { ...codexJob, request_id: 'PTYSD_CODEX_ACTIVE_LOCK_GUARD_20261015',
      write_paths: ['native-bridge/another-sample.mjs'] };
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
      readExecutorWorkspace:()=>workspace,
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
      readExecutorWorkspace:()=>workspace,
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

for (const failureCase of [
  { label: 'unreadable', article: 'an', reason: 'SPEC_UNREADABLE',
    badResponse: { encoding: 'utf-8', content: 'not base64' } },
  { label: 'hash-mismatched', article: 'a', reason: 'SPEC_HASH_MISMATCH',
    badResponse: { encoding: 'base64',
      content: Buffer.from('# Different bytes than the pinned task spec.\n').toString('base64') } },
]) {
  test(failureCase.article + ' ' + failureCase.label + ' OpenCode spec does not starve a later independent request', async () => {
    const root = mkdtempSync(join(homedir(), '.ptysd-opencode-spec-failover-'));
    try {
      const workspace = join(root, 'workspace');
      const stateDir = join(root, 'state');
      mkdirSync(join(workspace, 'src'), { recursive: true });
      mkdirSync(stateDir);
      writeFileSync(join(workspace, 'src', 'bad.mjs'), 'export const bad = 1;\n');
      writeFileSync(join(workspace, 'src', 'ready.mjs'), 'export const ready = 1;\n');
      const host = hostname().toUpperCase();
      const intendedBadSpec = '# Pinned but unavailable spec bytes.\n';
      const readySpec = '# Synthetic valid spec; model execution is forbidden.\n';
      const badJob = { schema: 4, project_id: PROJECT, host,
        request_id: 'PTYSD_OPENCODE_BAD_SPEC_' + failureCase.label.toUpperCase() + '_20261030',
        kind: 'opencode_edit', source_sha: commit,
        spec_path: 'native-bridge/tasks/bad-' + failureCase.label + '.md',
        spec_sha256: h(intendedBadSpec), model: 'opencode/spark', variant: 'high',
        edit_paths: ['src/bad.mjs'] };
      const readyJob = { ...badJob, request_id: 'PTYSD_OPENCODE_READY_AFTER_BAD_SPEC_20261030',
        spec_path: 'native-bridge/tasks/ready-after-bad-spec.md',
        spec_sha256: h(readySpec), edit_paths: ['src/ready.mjs'] };
      const comments = [com(9911, encoded(badJob)), com(9912, encoded(readyJob))];
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
      const writes = [], logs = [], bundleRequests = [];
      let nextId = 9913, dispatches = 0;
      const result = await executeWorker(config, {
        readExecutorWorkspace: () => workspace,
        goalCommentsRead: () => [],
        apiRead(uri) {
          if (uri === 'user') return { login: 'worker' };
          if (uri === 'repos/' + REPO + '/issues/407') return { title: ISSUE_TITLE, state: 'open' };
          if (uri === 'repos/' + REPO + '/git/ref/heads/main') return { object: { sha: commit } };
          if (uri.startsWith('repos/' + REPO + '/contents/')) {
            if (uri.includes('/bad-' + failureCase.label + '.md?ref=')) return failureCase.badResponse;
            if (uri.includes('/ready-after-bad-spec.md?ref=')) return {
              encoding: 'base64', content: Buffer.from(readySpec).toString('base64') };
          }
          const match = uri.match(/\/issues\/comments\/(\d+)$/);
          if (match) return comments.find(item => item.id === Number(match[1]));
          throw new Error('UNEXPECTED_TEST_API:' + uri);
        },
        commentsRead: () => comments,
        assertExecutorTaskReady: () => ({ ready: true, source_bundle_per_attempt: true }),
        createExecutorSourceBundle: ({ job, attemptId }) => {
          bundleRequests.push(job.request_id);
          return { attempt_id: attemptId, source_sha: job.source_sha, sha256: 'f'.repeat(64) };
        },
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
        observationDependencies: { collectWindowsObservation: () => ({ status: 'UNKNOWN' }) },
        log: value => logs.push(value),
      });
      assert.equal(result.state, 'DISPATCHED');
      assert.equal(result.request_id, readyJob.request_id,
        'a pinned spec failure must not starve a later independent edit');
      assert.equal(dispatches, 1);
      assert.deepEqual(bundleRequests, [readyJob.request_id],
        'an invalid pinned spec is rejected before building its executor source bundle');
      assert.deepEqual(writes.map(item => [item.request_id, item.state]),
        [[readyJob.request_id, 'STARTED']],
        'the invalid spec publishes no STARTED or terminal receipt');
      assert.ok(logs.includes('OPENCODE_LANE_WAITING_ELIGIBILITY_PREFLIGHT_' + failureCase.reason));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
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
      readExecutorWorkspace:()=>workspace,
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
  assert.equal(Object.hasOwn(terminal, 'write_paths'), false,
    'an incomplete legacy Codex job must not fabricate receipt scope metadata');
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


test('parseReceipt rejects schema-6 Antigravity receipt with impossible file-target aggregate evidence', () => {
  const job = withHumanGoal({
    schema: 6,
    project_id: PROJECT,
    host: hostname().toUpperCase(),
    request_id: 'PTYSD_ANTIGRAVITY_AGGREGATE_REGRESSION_20261028',
    kind: 'antigravity_edit',
    source_sha: commit,
    spec_path: 'native-bridge/tasks/review.md',
    spec_sha256: hash,
    model: ANTIGRAVITY_V2_MODEL,
    variant: 'high',
    edit_paths: ['src/worker.mjs'],
    source_pr: 448,
  });
  const attemptId = '11111111-1111-4111-8111-111111111111';
  const baseResult = {
    outcome: 'ANTIGRAVITY_EDIT_DIFF_CAPTURED_UNVERIFIED',
    exit_code: 0,
    diff_sha256: hash,
    diff_bytes: 120,
    changed_files: ['src/worker.mjs'],
    coding_state: 'DIFF_CAPTURED_UNVERIFIED',
    scope_valid: true,
    model_invoked: true,
    external_effects: 'UNKNOWN',
    source_diff_evidence: 'CAPTURED',
    task_acceptance: 'UNKNOWN',
    permission_mode_evidence: 'REQUEST_REVIEW_CONFIRMED',
    cli_status: 'SUCCESS',
    run_disposition: 'CLI_SUCCESS_REQUIRES_SEMANTIC_REVIEW',
    cli_version: '1.4.2',
    cli_binary_sha256: hash,
    cli_binary_integrity_evidence: 'MATCHED',
    tool_policy_evidence: 'W2_NONFILE_ACTIONS_DENIED',
    forbidden_tool_execution_evidence: 'NOT_OBSERVED',
    tool_execution_failed_count: 0,
    tool_execution_incomplete_count: 0,
  };

  const validReceipt = receipt(job.request_id, attemptId, 'FINISHED', job, {
    ...baseResult,
    file_change_target_evidence: {
      status: 'CANDIDATE_ROOT_ONLY',
      tool_count: 3,
      target_count: 3,
      candidate_root_count: 3,
      registered_root_count: 0,
      outside_or_unknown_root_count: 0,
      relative_or_unknown_root_count: 0,
      unidentified_tool_count: 0,
    },
  });
  assert.ok(parseReceipt(RECEIPT_MARKER + JSON.stringify(validReceipt)),
    'otherwise valid schema-6 Antigravity receipt must pass parseReceipt');

  const impossibleReceipt = {
    ...validReceipt,
    file_change_target_evidence: {
      status: 'CANDIDATE_ROOT_ONLY',
      tool_count: 3,
      target_count: 1,
      candidate_root_count: 1,
      registered_root_count: 0,
      outside_or_unknown_root_count: 0,
      relative_or_unknown_root_count: 0,
      unidentified_tool_count: 0,
    },
  };
  assert.equal(parseReceipt(RECEIPT_MARKER + JSON.stringify(impossibleReceipt)), null,
    'parseReceipt must reject file_change_target_evidence with 3 tools, 1 target, 0 unidentified tools, and CANDIDATE_ROOT_ONLY');

  const multiTargetReceipt = {
    ...validReceipt,
    file_change_target_evidence: {
      status: 'CANDIDATE_ROOT_ONLY',
      tool_count: 2,
      target_count: 3,
      candidate_root_count: 3,
      registered_root_count: 0,
      outside_or_unknown_root_count: 0,
      relative_or_unknown_root_count: 0,
      unidentified_tool_count: 0,
    },
  };
  assert.ok(parseReceipt(RECEIPT_MARKER + JSON.stringify(multiTargetReceipt)),
    'multi-target tools must remain valid');

  const explicitlyUnidentifiedReceipt = {
    ...validReceipt,
    file_change_target_evidence: {
      status: 'MIXED_ROOTS',
      tool_count: 3,
      target_count: 1,
      candidate_root_count: 1,
      registered_root_count: 0,
      outside_or_unknown_root_count: 0,
      relative_or_unknown_root_count: 0,
      unidentified_tool_count: 2,
    },
  };
  assert.ok(parseReceipt(RECEIPT_MARKER + JSON.stringify(explicitlyUnidentifiedReceipt)),
    'summaries with explicitly unidentified tools must remain valid');
});

test('unreadable W2 executor result stays UNKNOWN without starving an independent W1 edit in the same poll', async () => {
  const root = mkdtempSync(join(homedir(), '.ptysd-w2-unreadable-w1-continue-'));
  try {
    const workspace = join(root, 'workspace');
    const opencodeWorkspace = join(root, 'opencode-workspace');
    const stateDir = join(root, 'state');
    const w1ManifestDir = join(root, 'opencode-manifests');
    const w1ResultsDir = join(root, 'opencode-results');
    const w2ManifestDir = join(root, 'antigravity-manifests');
    const w2ResultsDir = join(root, 'antigravity-results');
    for (const dir of [workspace, opencodeWorkspace, stateDir, w1ManifestDir, w1ResultsDir,
      w2ManifestDir, w2ResultsDir, join(workspace, 'src'), join(opencodeWorkspace, 'src')])
      mkdirSync(dir, { recursive: true });

    const host = hostname().toUpperCase();
    const w2Spec = '# Synthetic W2 task; its executor result is deliberately unreadable.\n';
    const w1Spec = '# Synthetic independent W1 task; no model call in this test.\n';
    const w2Job = withHumanGoal({ schema: 6, project_id: PROJECT, host,
      request_id: 'PTYSD_W2_UNREADABLE_RESULT_20261101', kind: 'antigravity_edit',
      source_sha: commit, spec_path: 'native-bridge/tasks/w2-unreadable-result.md',
      spec_sha256: h(w2Spec), model: ANTIGRAVITY_V2_MODEL, variant: 'high',
      edit_paths: ['src/w2-file.mjs'], source_pr: 461 });
    const w1Job = withHumanGoal({ schema: 6, project_id: PROJECT, host,
      request_id: 'PTYSD_W1_AFTER_W2_UNKNOWN_20261101', kind: 'opencode_edit',
      source_sha: commit, spec_path: 'native-bridge/tasks/w1-independent.md',
      spec_sha256: h(w1Spec), model: 'opencode/deepseek-v4.1-flash-free', variant: 'free',
      edit_paths: ['src/w1-file.mjs'], source_pr: 437 });
    const w2AttemptId = '33333333-3333-4333-8333-333333333333';
    const w2Started = receipt(w2Job.request_id, w2AttemptId, 'STARTED', w2Job, {
      model_invoked: true, external_effects: 'UNKNOWN',
    });
    const corruptBytes = '{ incomplete executor result';
    const w2ResultPath = join(w2ResultsDir,
      `result-${w2Job.request_id}-${w2AttemptId}.json`);
    writeFileSync(w2ResultPath, corruptBytes, 'utf8');

    const w2Comment = { ...com(9101, encoded(w2Job), 't14210184'),
      issue_url: `https://api.github.com/repos/${REPO}/issues/310` };
    const w1Comment = { ...com(9102, encoded(w1Job), 't14210184'),
      issue_url: `https://api.github.com/repos/${REPO}/issues/310` };
    const startedComment = com(9103, RECEIPT_MARKER + JSON.stringify(w2Started), 'worker');
    const receiptComments = [startedComment];
    const w1Executor = { ...executorDescriptorForLane('OpenCode', 1001),
      manifest_dir: w1ManifestDir, results_dir: w1ResultsDir, working_directory: opencodeWorkspace };
    const w2Executor = { ...executorDescriptorForLane('Antigravity', 1003),
      manifest_dir: w2ManifestDir, results_dir: w2ResultsDir, working_directory: workspace };
    const config = { repo: REPO, project_id: PROJECT, host, issue: 407, workspace, state_dir: stateDir,
      dispatchers: ['t14210184'], executors: { opencode: w1Executor, antigravity: w2Executor },
      enable_v2_model_runs: true, enable_antigravity_model_runs: true,
      allowed_models: { 'opencode/deepseek-v4.1-flash-free': ['free'],
        [ANTIGRAVITY_V2_MODEL]: ['high'] } };
    const posted = [], logs = [];
    let nextCommentId = 9200, w1BundleCalls = 0, w1DispatchCalls = 0;
    let w2BundleCalls = 0, w2DispatchCalls = 0, inlineModelCalls = 0;
    const pullFor = number => ({ number, state: 'open',
      base: { ref: 'main', repo: { id: 1352411536, full_name: REPO } },
      head: { sha: commit, repo: { id: 1352411536, full_name: REPO } } });
    const allIssueComments = [humanGoalComment(), w2Comment, w1Comment];
    const adapters = {
      goalCommentsRead: () => allIssueComments,
      readExecutorWorkspace: descriptor => {
        if (descriptor === w1Executor) return opencodeWorkspace;
        if (descriptor === w2Executor) return workspace;
        throw new Error('UNEXPECTED_DESCRIPTOR_WORKSPACE');
      },
      apiRead(uri) {
        if (uri === 'user') return { login: 'worker' };
        if (uri === `repos/${REPO}/issues/407`) return { title: ISSUE_TITLE, state: 'open' };
        if (uri === `repos/${REPO}/git/ref/heads/main`) return { object: { sha: commit } };
        if (uri === `repos/${REPO}/issues/comments/6188322050`) return humanGoalComment();
        const commentMatch = uri.match(new RegExp(
          `^repos/${REPO.replaceAll('/', '\\/')}\/issues\/comments\\/(\\d+)$`));
        if (commentMatch) return allIssueComments.find(item => item.id === Number(commentMatch[1])) ||
          receiptComments.find(item => item.id === Number(commentMatch[1]));
        const pullMatch = uri.match(new RegExp(`^repos/${REPO.replaceAll('/', '\\/')}\/pulls\\/(\\d+)$`));
        if (pullMatch) return pullFor(Number(pullMatch[1]));
        if (uri.startsWith(`repos/${REPO}/contents/`)) {
          const spec = uri.includes('w2-unreadable-result.md') ? w2Spec : w1Spec;
          return { encoding: 'base64', content: Buffer.from(spec).toString('base64') };
        }
        throw new Error(`UNEXPECTED_API_ROUTE:${uri}`);
      },
      commentsRead: () => receiptComments,
      assertExecutorTaskReady: descriptor => {
        assert.equal(descriptor, w1Executor,
          'the malformed W2 attempt is fenced before Task Scheduler readiness checks');
        return { ready: true };
      },
      createExecutorSourceBundle: ({ workspace: sourceWorkspace, descriptor, job, attemptId }) => {
        if (descriptor === w2Executor) {
          w2BundleCalls++;
          throw new Error('UNKNOWN_W2_MUST_NOT_CREATE_BUNDLE');
        }
        assert.equal(descriptor, w1Executor);
        assert.equal(sourceWorkspace, opencodeWorkspace);
        assert.equal(job.request_id, w1Job.request_id);
        assert.equal(job.source_sha, commit);
        assert.equal(job.source_pr, 437);
        assert.deepEqual(job.edit_paths, ['src/w1-file.mjs']);
        w1BundleCalls++;
        return { attempt_id: attemptId, source_sha: job.source_sha, sha256: 'c'.repeat(64) };
      },
      dispatchToExecutor: (descriptor, manifest) => {
        if (descriptor === w2Executor) {
          w2DispatchCalls++;
          throw new Error('UNKNOWN_W2_MUST_NOT_DISPATCH');
        }
        assert.equal(descriptor, w1Executor);
        assert.equal(manifest.job.request_id, w1Job.request_id);
        assert.equal(manifest.job.source_sha, commit);
        w1DispatchCalls++;
        return { outcome: 'SYNTHETIC_DISPATCH_ACK_NOT_EXECUTION' };
      },
      writeReceipt: (_receiptConfig, data, login) => {
        posted.push(data);
        receiptComments.push(com(nextCommentId++, RECEIPT_MARKER + JSON.stringify(data), login));
      },
      runPlan: () => { inlineModelCalls++; throw new Error('MODEL_MUST_NOT_RUN_INLINE'); },
      observationDependencies: { collectWindowsObservation: () => ({ status: 'UNKNOWN' }) },
      log: value => logs.push(value),
    };

    const result = await executeWorker(config, adapters);
    assert.equal(result.state, 'DISPATCHED', JSON.stringify({ result, logs }));
    assert.equal(result.request_id, w1Job.request_id);
    assert.equal(result.outcome, 'SYNTHETIC_DISPATCH_ACK_NOT_EXECUTION');
    assert.equal(w1BundleCalls, 1);
    assert.equal(w1DispatchCalls, 1);
    assert.equal(w2BundleCalls, 0);
    assert.equal(w2DispatchCalls, 0);
    assert.equal(inlineModelCalls, 0);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].request_id, w1Job.request_id);
    assert.equal(posted[0].state, 'STARTED');
    assert.equal(readFileSync(w2ResultPath, 'utf8'), corruptBytes,
      'the ambiguous W2 result remains preserved for later reconciliation');
    assert.equal(parseReceipt(receiptComments[0].body)?.external_effects, 'UNKNOWN');
    assert.ok(logs.some(value => value.startsWith(
      `LOCAL_RESULT_RECONCILIATION_UNKNOWN_${w2Job.request_id}_`) && value.endsWith('_NO_REPLAY')),
    'the exact W2 result stays unresolved and is never replayed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('W2 executor preflight WAITING result reconciles without redispatch while independent W1 edit is dispatched in the same poll', async () => {
  const root = mkdtempSync(join(homedir(), '.ptysd-w2-waiting-w1-continue-'));
  try {
    const workspace = join(root, 'workspace');
    const opencodeWorkspace = join(root, 'opencode-workspace');
    const stateDir = join(root, 'state');
    const w1ManifestDir = join(root, 'opencode-manifests');
    const w1ResultsDir = join(root, 'opencode-results');
    const w2ManifestDir = join(root, 'antigravity-manifests');
    const w2ResultsDir = join(root, 'antigravity-results');

    for (const dir of [
      workspace,
      opencodeWorkspace,
      stateDir,
      w1ManifestDir,
      w1ResultsDir,
      w2ManifestDir,
      w2ResultsDir,
      join(workspace, 'src'),
      join(opencodeWorkspace, 'src'),
    ]) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(join(opencodeWorkspace, 'src', 'w1-worker.mjs'), 'export const value = 1;\n');
    writeFileSync(join(workspace, 'src', 'w2-quota-canary.mjs'), 'export const value = 2;\n');

    const host = hostname().toUpperCase();
    const w2Spec = '# Synthetic W2 task spec; no model execution in this test.\n';
    const w1Spec = '# Synthetic W1 task spec; model runs in executor only.\n';

    const w2Job = withHumanGoal({
      schema: 6,
      project_id: PROJECT,
      host,
      request_id: 'PTYSD_W2_WAITING_RECONCILE_20261031',
      kind: 'antigravity_edit',
      source_sha: commit,
      spec_path: 'native-bridge/tasks/w2-quota-canary.md',
      spec_sha256: h(w2Spec),
      model: ANTIGRAVITY_V2_MODEL,
      variant: 'high',
      edit_paths: ['src/w2-quota-canary.mjs'],
      source_pr: 461,
    });

    const w1Job = withHumanGoal({
      schema: 6,
      project_id: PROJECT,
      host,
      request_id: 'PTYSD_W1_READY_WHILE_W2_WAITING_20261031',
      kind: 'opencode_edit',
      source_sha: commit,
      spec_path: 'native-bridge/tasks/w1-edit.md',
      spec_sha256: h(w1Spec),
      model: 'opencode/deepseek-v4.1-flash-free',
      variant: 'free',
      edit_paths: ['src/w1-worker.mjs'],
      source_pr: 437,
    });

    const w2AttemptId = '33333333-3333-4333-8333-333333333333';
    const w2Started = receipt(w2Job.request_id, w2AttemptId, 'STARTED', w2Job);
    const w2WaitingTerminal = receipt(w2Job.request_id, w2AttemptId, 'WAITING', w2Job, {
      outcome: 'ANTIGRAVITY_NONFILE_TOOL_POLICY_UNVERIFIED',
      exit_code: 48,
      evidence_sha256: null,
      evidence_bytes: 0,
      model_invoked: false,
      session_id: null,
      session_started: null,
      diff_sha256: null,
      diff_bytes: null,
    });

    const w2WaitingResult = {
      request_id: w2Job.request_id,
      attempt_id: w2AttemptId,
      terminal: w2WaitingTerminal,
      local_evidence: {
        executor_workspace_guard: {
          registered_root_identity_sha256: 'a'.repeat(64),
          registered_root_state_sha256: 'b'.repeat(64),
          candidate_root_identity_sha256: 'c'.repeat(64),
          candidate_root_state_sha256: 'd'.repeat(64),
          registered_root_after_sha256: 'b'.repeat(64),
          candidate_root_after_sha256: 'd'.repeat(64),
          readback: 'COMPLETE',
          registered_root_changed_paths: 0,
          candidate_root_changed_paths: 0,
        },
      },
    };

    const w2ResultPath = join(w2ResultsDir, `result-${w2Job.request_id}-${w2AttemptId}.json`);
    writeFileSync(w2ResultPath, JSON.stringify(w2WaitingResult), 'utf8');

    const w2Comment = {
      ...com(9101, encoded(w2Job), 't14210184'),
      issue_url: `https://api.github.com/repos/${REPO}/issues/310`,
    };
    const w2StartedReceiptComment = com(9102, RECEIPT_MARKER + JSON.stringify(w2Started), 'worker');
    const w1Comment = {
      ...com(9103, encoded(w1Job), 't14210184'),
      issue_url: `https://api.github.com/repos/${REPO}/issues/310`,
    };
    const receiptComments = [w2StartedReceiptComment];

    const w1Executor = {
      ...executorDescriptorForLane('OpenCode', 1001),
      manifest_dir: w1ManifestDir,
      results_dir: w1ResultsDir,
      working_directory: opencodeWorkspace,
    };
    const w2Executor = {
      ...executorDescriptorForLane('Antigravity', 1003),
      manifest_dir: w2ManifestDir,
      results_dir: w2ResultsDir,
      working_directory: workspace,
    };

    const config = {
      repo: REPO,
      project_id: PROJECT,
      host,
      issue: 407,
      workspace,
      state_dir: stateDir,
      dispatchers: ['t14210184'],
      executors: { opencode: w1Executor, antigravity: w2Executor },
      enable_v2_model_runs: true,
      enable_antigravity_model_runs: true,
      allowed_models: {
        'opencode/deepseek-v4.1-flash-free': ['free'],
        [ANTIGRAVITY_V2_MODEL]: ['high'],
      },
    };

    const posted = [];
    const logs = [];
    let nextCommentId = 9200;
    let w1BundleCalls = 0;
    let w1DispatchCalls = 0;
    let w2BundleCalls = 0;
    let w2DispatchCalls = 0;
    let inlineModelCalls = 0;

    const pullFor = pr => ({
      number: pr,
      state: 'open',
      base: { ref: 'main', repo: { id: 1352411536, full_name: REPO } },
      head: { sha: commit, repo: { id: 1352411536, full_name: REPO } },
    });

    const adapters = {
      goalCommentsRead: () => [humanGoalComment(), w2Comment, w1Comment],
      readExecutorWorkspace: descriptor => {
        if (descriptor === w1Executor) return opencodeWorkspace;
        if (descriptor === w2Executor) return workspace;
        throw new Error('UNEXPECTED_DESCRIPTOR_WORKSPACE');
      },
      apiRead(uri) {
        if (uri === 'user') return { login: 'worker' };
        if (uri === `repos/${REPO}/issues/407`) return { title: ISSUE_TITLE, state: 'open' };
        if (uri === `repos/${REPO}/git/ref/heads/main`) return { object: { sha: commit } };
        if (uri === `repos/${REPO}/issues/comments/6188322050`) return humanGoalComment();
        if (uri === `repos/${REPO}/pulls/461`) return pullFor(461);
        if (uri === `repos/${REPO}/pulls/437`) return pullFor(437);
        const commentMatch = uri.match(new RegExp(`^repos/${REPO.replaceAll('/', '\\/')}/issues/comments/(\\d+)$`));
        if (commentMatch) {
          const id = Number(commentMatch[1]);
          if (id === 6188322050) return humanGoalComment();
          if (id === w2Comment.id) return w2Comment;
          if (id === w1Comment.id) return w1Comment;
          return receiptComments.find(item => item.id === id);
        }
        if (uri.startsWith(`repos/${REPO}/contents/`)) {
          const spec = uri.includes('w2-quota-canary.md') ? w2Spec : w1Spec;
          return { encoding: 'base64', content: Buffer.from(spec).toString('base64') };
        }
        throw new Error(`UNEXPECTED_API_ROUTE:${uri}`);
      },
      commentsRead: () => receiptComments,
      assertExecutorTaskReady: descriptor => {
        assert.equal(descriptor, w1Executor, 'only the ready W1 descriptor reaches Task Scheduler readiness');
        return { ready: true };
      },
      createExecutorSourceBundle: ({ workspace: sourceWorkspace, descriptor, job, attemptId }) => {
        if (descriptor === w2Executor) {
          w2BundleCalls++;
          throw new Error('W2_MUST_NOT_CREATE_SOURCE_BUNDLE');
        }
        assert.equal(descriptor, w1Executor);
        assert.equal(sourceWorkspace, opencodeWorkspace);
        assert.equal(job.request_id, w1Job.request_id);
        assert.equal(job.source_sha, commit);
        assert.equal(job.source_pr, 437);
        assert.deepEqual(job.edit_paths, ['src/w1-worker.mjs']);
        w1BundleCalls++;
        return { attempt_id: attemptId, source_sha: job.source_sha, sha256: 'c'.repeat(64) };
      },
      dispatchToExecutor: (descriptor, manifest) => {
        if (descriptor === w2Executor) {
          w2DispatchCalls++;
          throw new Error('W2_MUST_NOT_BE_DISPATCHED');
        }
        assert.equal(descriptor, w1Executor);
        assert.equal(manifest.job.request_id, w1Job.request_id);
        assert.equal(manifest.job.source_sha, commit);
        assert.equal(manifest.job.source_pr, 437);
        assert.deepEqual(manifest.job.edit_paths, ['src/w1-worker.mjs']);
        assert.equal(manifest.source_bundle_sha256, 'c'.repeat(64));
        w1DispatchCalls++;
        return { outcome: 'SYNTHETIC_DISPATCH_ACK_NOT_EXECUTION' };
      },
      writeReceipt: (receiptConfig, data, login) => {
        assert.equal(receiptConfig.issue, 407);
        posted.push(data);
        receiptComments.push(com(nextCommentId++, RECEIPT_MARKER + JSON.stringify(data), login || 'worker'));
      },
      runPlan: () => {
        inlineModelCalls++;
        throw new Error('MODEL_MUST_NOT_BE_CALLED_INLINE');
      },
      observationDependencies: { collectWindowsObservation: () => ({ status: 'UNKNOWN' }) },
      log: value => logs.push(value),
    };

    const result = await executeWorker(config, adapters);

    // 1. Result of same-poll recovery dispatching W1
    assert.equal(result.state, 'DISPATCHED');
    assert.equal(result.request_id, w1Job.request_id);
    assert.notEqual(result.attempt_id, w2AttemptId);
    assert.equal(result.outcome, 'SYNTHETIC_DISPATCH_ACK_NOT_EXECUTION');

    // 2. Exactly one W1 bundle & dispatch; zero W2 bundle, dispatch, or inline model calls
    assert.equal(w1BundleCalls, 1);
    assert.equal(w1DispatchCalls, 1);
    assert.equal(w2BundleCalls, 0);
    assert.equal(w2DispatchCalls, 0);
    assert.equal(inlineModelCalls, 0);

    // 3. Exactly two receipts posted: W2 WAITING reconciled, then W1 STARTED dispatched
    assert.equal(posted.length, 2);

    const w2Receipt = posted[0];
    assert.equal(w2Receipt.request_id, w2Job.request_id);
    assert.equal(w2Receipt.attempt_id, w2AttemptId);
    assert.equal(w2Receipt.state, 'WAITING');
    assert.equal(w2Receipt.kind, 'antigravity_edit');
    assert.equal(w2Receipt.model, ANTIGRAVITY_V2_MODEL);
    assert.equal(w2Receipt.variant, 'high');
    assert.equal(w2Receipt.model_invoked, false);
    assert.equal(w2Receipt.session_id, null);
    assert.equal(w2Receipt.session_started, null);
    assert.equal(w2Receipt.diff_sha256, null);
    assert.equal(w2Receipt.diff_bytes, null);
    assert.equal(w2Receipt.evidence_sha256, null);
    assert.equal(w2Receipt.evidence_bytes, 0);
    assert.equal(w2Receipt.source_sha, commit);
    assert.equal(w2Receipt.source_pr, 461);
    assert.equal(w2Receipt.goal_comment_id, 6188322050);
    assert.equal(w2Receipt.goal_body_sha256, h(humanGoalBody));
    assert.equal(w2Receipt.eligibility_state, 'WAITING');
    assert.equal(w2Receipt.outcome, 'ANTIGRAVITY_NONFILE_TOOL_POLICY_UNVERIFIED');

    const w1Receipt = posted[1];
    assert.equal(w1Receipt.request_id, w1Job.request_id);
    assert.equal(w1Receipt.attempt_id, result.attempt_id);
    assert.notEqual(w1Receipt.attempt_id, w2AttemptId);
    assert.equal(w1Receipt.state, 'STARTED');
    assert.equal(w1Receipt.kind, 'opencode_edit');
    assert.equal(w1Receipt.model, 'opencode/deepseek-v4.1-flash-free');
    assert.equal(w1Receipt.variant, 'free');
    assert.equal(w1Receipt.source_sha, commit);
    assert.equal(w1Receipt.source_pr, 437);
    assert.equal(w1Receipt.goal_comment_id, 6188322050);
    assert.equal(w1Receipt.goal_body_sha256, h(humanGoalBody));
    assert.equal(w1Receipt.edit_paths_sha256, h(JSON.stringify(w1Job.edit_paths)));

    // 4. Log assertions verifying W2 recovery and W1 dispatch
    assert.ok(logs.includes(`RECOVERED_EXECUTOR_RESULT_WAITING_${w2Job.request_id}`));
    assert.ok(logs.includes(`DISPATCHED_${w1Job.request_id}_SYNTHETIC_DISPATCH_ACK_NOT_EXECUTION`));
    assert.equal(logs.some(value => value.includes('OPENCODE_LANE_WAITING_ELIGIBILITY_')), false);

    // 5. Subsequent selection leaves W2 eligible for later reevaluation while W1 is in flight
    const allComments = [w2Comment, w1Comment, ...receiptComments];
    const nextCandidate = selectNext(
      allComments,
      ['t14210184'],
      'worker',
      host,
      commit,
      [],
      new Map([[461, commit], [437, commit]])
    );
    assert.equal(nextCandidate?.job.request_id, w2Job.request_id,
      'the reconciled no-model W2 preflight WAITING receipt leaves the W2 task eligible for later reevaluation');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
