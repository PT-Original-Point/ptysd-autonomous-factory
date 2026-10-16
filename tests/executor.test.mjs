import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { JOB_MARKER, PROJECT, RECEIPT_MARKER, REPO, parseReceipt, receipt, runWorker,
  runPlan, verifyCapturedEvidence, verifyScopedEditEvidence, createCandidateSourceBundle,
  ISSUE_TITLE, REPO_ID } from '../native-bridge/worker.mjs';
import { executePendingManifest } from '../native-bridge/executor.mjs';
import { runCapturedProcess } from '../native-bridge/captured-process.mjs';
import {
  assertExecutorTaskReady, buildExecutorTaskXml, claimPendingManifest,
  dispatchToExecutor, executorResultPath, makeExecutorManifest, triggerPendingExecutorAttempt,
  validateExecutorTaskXml,
} from '../native-bridge/windows-executor.mjs';

const PUBLISHER_SID = 'S-1-5-21-101-202-303-1001';
const EXECUTOR_SID = 'S-1-5-21-101-202-303-1002';
const ATTEMPT = '00000000-0000-4000-8000-000000000001';
const TEST_GOAL_BODY = '# V5.3-R4\nPTYSD_V53R4_DELETE_FIRST_AUTONOMY_GOAL_20261015\nAuthorized synthetic test scope.';
const TEST_GOAL_REF = { issue: 310, comment_id: 6188322050,
  marker: 'PTYSD_V53R4_DELETE_FIRST_AUTONOMY_GOAL_20261015',
  body_sha256: createHash('sha256').update(TEST_GOAL_BODY).digest('hex') };
const TEST_GOAL_COMMENT = { id: TEST_GOAL_REF.comment_id, body: TEST_GOAL_BODY,
  issue_url: `https://api.github.com/repos/${REPO}/issues/310`, user: { login: 'dispatcher' } };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ptysd-executor-'));
  const manifestDir = join(root, 'inbox');
  const resultsDir = join(root, 'results');
  mkdirSync(manifestDir);
  mkdirSync(resultsDir);
  const descriptor = {
    task_name: '\\PTYSD\\OpenCodeExecutor', user_sid: EXECUTOR_SID,
    publisher_sid: PUBLISHER_SID, node_bin: 'C:\\Program Files\\nodejs\\node.exe',
    script_path: 'C:\\Users\\PTYSDExecutor\\AppData\\Local\\PTYSD\\executor.mjs',
    config_path: 'C:\\Users\\PTYSDExecutor\\AppData\\Local\\PTYSD\\executor.json',
    manifest_dir: root.replaceAll('/', '\\') + '\\inbox',
    results_dir: root.replaceAll('/', '\\') + '\\results',
    working_directory: 'C:\\Users\\PTYSDExecutor\\Documents\\Work',
  };
  return { root, manifestDir, resultsDir, descriptor,
    currentSid: () => PUBLISHER_SID,
    readTaskXml: () => buildExecutorTaskXml(descriptor),
    dispose: () => rmSync(root, { recursive: true, force: true }) };
}

function modelJob(spec) {
  const specHash = createHash('sha256').update(spec).digest('hex');
  return {
    schema: 2, project_id: PROJECT, host: hostname().toUpperCase(),
    request_id: 'PTYSD_NATIVE_V2_PLAN_20261015', kind: 'opencode_plan',
    source_sha: 'a'.repeat(40), spec_path: 'native-bridge/tasks/read-only-check.md',
    spec_sha256: specHash, model: 'opencode/spark', variant: 'high',
  };
}

function legacyStoredPlanManifest(job, spec, attemptId) {
  return { schema: 1, kind: 'PTYSD_NATIVE_EXECUTOR_MANIFEST_V1',
    request_id: job.request_id, attempt_id: attemptId, source_sha: job.source_sha,
    spec_sha256: job.spec_sha256, job, spec };
}

function editJob(spec, requestId = 'PTYSD_NATIVE_V2_EDIT_20261015') {
  return {
    schema: 6, project_id: PROJECT, host: hostname().toUpperCase(), request_id: requestId,
    kind: 'opencode_edit', source_sha: 'a'.repeat(40),
    spec_path: 'native-bridge/tasks/scoped-edit.md',
    spec_sha256: createHash('sha256').update(spec).digest('hex'),
    model: 'opencode/spark', variant: 'high', write_paths: ['README.md'],
    candidate_pr: 434, goal_ref: TEST_GOAL_REF,
  };
}

function createDispatchBundle(f, attemptId = ATTEMPT) {
  const dir = join(f.manifestDir, 'candidate-bundles');
  mkdirSync(dir, { recursive: true });
  const bytes = Buffer.from('pinned source bundle fixture\n');
  writeFileSync(join(dir, `${attemptId}.bundle`), bytes, { flag: 'wx' });
  return createHash('sha256').update(bytes).digest('hex');
}

test('retired read-only OpenCode jobs cannot start a new executor attempt', () => {
  const f = fixture();
  try {
    const spec = 'Read only; retain this as a legacy receipt fixture.';
    const job = modelJob(spec);
    let starts = 0;
    assert.throws(() => dispatchToExecutor(f.descriptor, {
      request_id: job.request_id, attempt_id: ATTEMPT, source_sha: job.source_sha, job, spec,
    }, { currentSid: f.currentSid, readTaskXml: f.readTaskXml,
      filesystemPath: localPathMap(f), runTask: () => { starts++; } }),
    /EXECUTOR_READONLY_PLAN_RETIRED/);
    assert.equal(starts, 0);
    assert.deepEqual(readdirSync(f.manifestDir), [], 'a retired request cannot leave a runnable manifest');
  } finally { f.dispose(); }
});

test('new executor manifest builder refuses retired read-only OpenCode jobs', () => {
  const spec = 'Read only; retain legacy receipts without creating another execution manifest.';
  assert.throws(() => makeExecutorManifest(modelJob(spec), spec, ATTEMPT),
    /EXECUTOR_READONLY_PLAN_RETIRED/);
});

test('executor manifest rejects a GOAL reference with unbound fields', () => {
  const spec='Public synthetic bounded edit.';
  const job={...editJob(spec),goal_ref:{...TEST_GOAL_REF,untrusted_source:'other'}};
  assert.throws(()=>makeExecutorManifest(job,spec,ATTEMPT,'a'.repeat(64)),
    error=>error.code==='EXECUTOR_EDIT_JOB_HUMAN_GOAL_BINDING_REQUIRED');
});

function localPathMap(f) {
  const paths = new Map([
    [f.descriptor.manifest_dir.toLowerCase(), f.manifestDir],
    [f.descriptor.results_dir.toLowerCase(), f.resultsDir],
  ]);
  return value => paths.get(value.toLowerCase()) ?? value;
}

function createSourceBundle(f, workspace, git, attemptId = ATTEMPT) {
  const bundleDir = join(f.manifestDir, 'candidate-bundles');
  mkdirSync(bundleDir, { recursive: true });
  const bundle = join(bundleDir, `${attemptId}.bundle`);
  const sourceSha = git(['rev-parse', 'HEAD']).trim();
  const ref = `refs/pty-native/candidate-bundles/${attemptId}`;
  git(['update-ref', ref, sourceSha, '0'.repeat(40)]);
  try { git(['bundle', 'create', bundle, ref]); }
  finally { git(['update-ref', '-d', ref, sourceSha]); }
  return createHash('sha256').update(readFileSync(bundle)).digest('hex');
}

test('executor task template pins a distinct standard identity, PT0S, IgnoreNew, and exact hidden action', () => {
  const f = fixture();
  try {
    const xml = buildExecutorTaskXml(f.descriptor);
    const result = validateExecutorTaskXml(xml, f.descriptor);
    assert.deepEqual(result, { ready: true, user_sid: EXECUTOR_SID, logon_type: 'Password',
      run_level: 'LeastPrivilege', execution_time_limit: 'PT0S', multiple_instances: 'IgnoreNew' });
    assert.throws(() => validateExecutorTaskXml(xml.replace('<ExecutionTimeLimit>PT0S',
      '<ExecutionTimeLimit>PT15M'), f.descriptor), /EXECUTOR_TASK_TIME_LIMIT_NOT_UNBOUNDED/);
    assert.throws(() => validateExecutorTaskXml(xml.replace('<RunLevel>LeastPrivilege',
      '<RunLevel>HighestAvailable'), f.descriptor), /EXECUTOR_TASK_RUNLEVEL_UNSAFE/);
    assert.throws(() => validateExecutorTaskXml(xml.replace('<LogonType>Password',
      '<LogonType>S4U'), f.descriptor), /EXECUTOR_TASK_LOGON_TYPE_UNSAFE/);
    assert.throws(() => validateExecutorTaskXml(xml.replace('<MultipleInstancesPolicy>IgnoreNew',
      '<MultipleInstancesPolicy>Parallel'), f.descriptor), /EXECUTOR_TASK_MULTIPLE_INSTANCE_POLICY_UNSAFE/);
    assert.throws(() => validateExecutorTaskXml(xml.replace(`<UserId>${EXECUTOR_SID}`, `<UserId>${PUBLISHER_SID}`),
      f.descriptor), /EXECUTOR_TASK_IDENTITY_MISMATCH/);
    assert.throws(() => validateExecutorTaskXml(xml.replace('<AllowHardTerminate>false',
      '<AllowHardTerminate>true'), f.descriptor), /EXECUTOR_TASK_HARD_TERMINATE_ENABLED/);
    assert.throws(() => validateExecutorTaskXml(xml.replace('</Settings>',
      '<Triggers><LogonTrigger/></Triggers></Settings>'), f.descriptor), /EXECUTOR_TASK_TRIGGERS_NOT_ALLOWED/);
    assert.throws(() => validateExecutorTaskXml(xml.replace('</Actions>',
      '<Exec><Command>extra.exe</Command></Exec></Actions>'), f.descriptor), /EXECUTOR_TASK_ACTION_COUNT_MISMATCH/);
  } finally { f.dispose(); }
});

test('dispatcher exclusive-creates one manifest and only starts the pre-read executor task', () => {
  const f = fixture();
  try {
    const filesystemPath = localPathMap(f);
    assert.deepEqual(assertExecutorTaskReady(f.descriptor, {
      currentSid: f.currentSid, readTaskXml: f.readTaskXml, filesystemPath,
    }).mailbox, 'EMPTY');
    const spec = 'Review the public README and report observations only.';
    const job = editJob(spec);
    const source_bundle_sha256 = createDispatchBundle(f);
    let starts = 0;
    const result = dispatchToExecutor(f.descriptor, {
      request_id: job.request_id, attempt_id: ATTEMPT, source_sha: job.source_sha, job, spec,
      source_bundle_sha256,
    }, { currentSid: f.currentSid, readTaskXml: f.readTaskXml, filesystemPath,
      runTask: taskName => { assert.equal(taskName, f.descriptor.task_name); starts++; } });
    assert.equal(result.outcome, 'EXECUTOR_TASK_DISPATCHED_NOT_ACCEPTANCE');
    assert.equal(result.exit_code, 0);
    assert.equal(starts, 1);
    assert.deepEqual(readdirSync(f.manifestDir).filter(name => name.endsWith('.json')),
      [`${ATTEMPT}.pending.json`]);
    const manifest = JSON.parse(readFileSync(join(f.manifestDir, `${ATTEMPT}.pending.json`), 'utf8'));
    assert.equal(manifest.kind, 'PTYSD_NATIVE_EXECUTOR_MANIFEST_V1');
    assert.equal(manifest.request_id, job.request_id);
    assert.equal(manifest.spec, spec);
    assert.equal(readdirSync(f.resultsDir).length, 0, 'a dispatcher acknowledgement is not an executor result');
    assert.throws(() => dispatchToExecutor(f.descriptor, {
      request_id: job.request_id, attempt_id: '00000000-0000-4000-8000-000000000002',
      source_sha: job.source_sha, job, spec,
    }, { currentSid: f.currentSid, readTaskXml: f.readTaskXml, filesystemPath,
      runTask: () => { starts++; } }), /EXECUTOR_ATTEMPT_UNRESOLVED/);
    assert.equal(starts, 1, 'a second job cannot overlap or replace an unresolved attempt');
  } finally { f.dispose(); }
});

test('unknown Task Scheduler start is retained as an unresolved attempt and is never retried', () => {
  const f = fixture();
  try {
    const filesystemPath = localPathMap(f);
    const spec = 'Read only.';
    const job = editJob(spec, 'PTYSD_NATIVE_V2_EDIT_UNCERTAIN_START');
    const source_bundle_sha256 = createDispatchBundle(f);
    let starts = 0;
    const manifest = { request_id: job.request_id, attempt_id: ATTEMPT,
      source_sha: job.source_sha, job, spec, source_bundle_sha256 };
    assert.throws(() => dispatchToExecutor(f.descriptor, manifest, {
      currentSid: f.currentSid, readTaskXml: f.readTaskXml, filesystemPath,
      runTask: () => { starts++; throw new Error('native result ambiguous'); },
    }), /EXECUTOR_TASK_START_UNKNOWN/);
    assert.equal(starts, 1);
    assert.ok(readdirSync(f.manifestDir).includes(`${ATTEMPT}.pending.json`));
    assert.throws(() => dispatchToExecutor(f.descriptor, {
      ...manifest, attempt_id: '00000000-0000-4000-8000-000000000002',
    }, { currentSid: f.currentSid, readTaskXml: f.readTaskXml, filesystemPath,
      runTask: () => { starts++; } }), /EXECUTOR_ATTEMPT_UNRESOLVED/);
    assert.equal(starts, 1);
  } finally { f.dispose(); }
});

test('executor reads an existing legacy plan manifest without treating exit zero as acceptance', async t => {
  if (process.platform !== 'win32') return t.skip('Task Scheduler identity execution is Windows-only');
  const f = fixture();
  try {
    const workspace = join(f.root, 'workspace');
    mkdirSync(workspace);
    const spec = 'Inspect one public text fixture.';
    const job = modelJob(spec);
    const manifest = legacyStoredPlanManifest(job, spec, ATTEMPT);
    writeFileSync(join(f.manifestDir, `${ATTEMPT}.pending.json`), JSON.stringify(manifest), { flag: 'wx' });
    let calls = 0;
    const outcome = await executePendingManifest({
      manifestDir: f.descriptor.manifest_dir,
      currentSid: () => EXECUTOR_SID,
      config: { project_id: PROJECT, repo: REPO, host: hostname().toUpperCase(),
        executor_runtime: { user_sid: EXECUTOR_SID, publisher_sid: PUBLISHER_SID,
        manifest_dir: f.descriptor.manifest_dir, results_dir: f.descriptor.results_dir },
        workspace, state_dir: f.descriptor.results_dir },
      execute: async (receivedSpec, _config, receivedJob, attemptId) => {
        calls++;
        assert.equal(receivedSpec, spec);
        assert.equal(receivedJob.request_id, job.request_id);
        assert.equal(attemptId, ATTEMPT);
        return { outcome: 'OPENCODE_V2_EXIT_0_UNTRUSTED', exit_code: 0,
          evidence_sha256: 'b'.repeat(64), evidence_bytes: 7 };
      },
    });
    assert.equal(calls, 1);
    assert.equal(outcome.terminal_state, 'FINISHED');
    assert.match(outcome.outcome, /NOT_SEMANTIC_ACCEPTANCE/);
    const saved = JSON.parse(readFileSync(executorResultPath(f.descriptor.results_dir,
      job.request_id, ATTEMPT), 'utf8'));
    assert.equal(saved.terminal.state, 'FINISHED');
    assert.equal(saved.terminal.outcome, 'OPENCODE_V2_EXIT_0_UNTRUSTED');
    assert.equal(saved.terminal.exit_code, 0);
    assert.ok(readdirSync(f.manifestDir).includes(`${ATTEMPT}.running.json`));
    assert.throws(() => claimPendingManifest(f.descriptor.manifest_dir), /EXECUTOR_ATTEMPT_ALREADY_RUNNING/);
  } finally { f.dispose(); }
});

test('separate executor accepts only the exact scoped OpenCode edit manifest and keeps completion unverified', async t => {
  if (process.platform !== 'win32') return t.skip('Task Scheduler identity execution is Windows-only');
  const f=fixture();
  try {
    const workspace=join(f.root,'edit-workspace');
    mkdirSync(workspace);
    const git=(args)=>execFileSync('git',['-C',workspace,...args],{
      encoding:'utf8',windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
    git(['init']);
    writeFileSync(join(workspace,'README.md'),'fixture\n');
    git(['add','README.md']);
    git(['-c','user.name=PTYSD test','-c','user.email=ptysd-test@example.invalid','commit','-m','fixture']);
    const spec='Edit only README.md; return a reviewable diff.';
    const specHash=createHash('sha256').update(spec).digest('hex');
    const job={...editJob(spec,'PTYSD_NATIVE_V2_EDIT_20261015'),source_sha:git(['rev-parse','HEAD']).trim()};
    const sourceBundleSha256=createSourceBundle(f,workspace,git);
    writeFileSync(join(f.manifestDir,`${ATTEMPT}.pending.json`),
      JSON.stringify(makeExecutorManifest(job,spec,ATTEMPT,sourceBundleSha256)),{flag:'wx'});
    let calls=0;
    const outcome=await executePendingManifest({manifestDir:f.descriptor.manifest_dir,
      currentSid:()=>EXECUTOR_SID,
      config:{project_id:PROJECT,repo:REPO,host:hostname().toUpperCase(),
        executor_runtime:{user_sid:EXECUTOR_SID,publisher_sid:PUBLISHER_SID,
          manifest_dir:f.descriptor.manifest_dir,results_dir:f.descriptor.results_dir},
        workspace,state_dir:f.descriptor.results_dir},
      execute:async(receivedSpec,receivedConfig,receivedJob,attemptId)=>{
        calls++;
        assert.equal(receivedSpec,spec);
        assert.notEqual(receivedConfig.workspace,workspace,
          'all writable OpenCode attempts execute in their own detached source workspace');
        assert.equal(execFileSync('git',['-C',receivedConfig.workspace,'rev-parse','HEAD'],
          {encoding:'utf8',windowsHide:true,shell:false}).trim(),job.source_sha);
        assert.equal(receivedJob.kind,'opencode_edit');
        assert.deepEqual(receivedJob.write_paths,['README.md']);
        assert.equal(attemptId,ATTEMPT);
        return {outcome:'OPENCODE_EDIT_CLI_EXIT_0_UNVERIFIED',exit_code:0,
          evidence_sha256:'c'.repeat(64),evidence_bytes:12};
      }});
    assert.equal(calls,1);
    assert.equal(outcome.terminal_state,'FINISHED');
    assert.match(outcome.outcome,/NOT_SEMANTIC_ACCEPTANCE/);
    const saved=JSON.parse(readFileSync(executorResultPath(f.descriptor.results_dir,
      job.request_id,ATTEMPT),'utf8'));
    assert.equal(saved.terminal.kind,'opencode_edit');
    assert.deepEqual(saved.terminal.write_paths,['README.md']);
    assert.equal(saved.terminal.outcome,'OPENCODE_EDIT_CLI_EXIT_0_UNVERIFIED');
    assert.equal(parseReceipt(RECEIPT_MARKER+JSON.stringify(saved.terminal)).state,'FINISHED');
  } finally {f.dispose();}
});

test('synthetic no-model OpenCode edit waits for process evidence, then reconciles diff and receipt', async t => {
  if (process.platform !== 'win32') return t.skip('the native Executor identity and process-tree contract is Windows-only');
  const f = fixture();
  const publisherWorkspace = join(f.root, 'publisher-workspace');
  const publisherState = join(f.root, 'publisher-state');
  mkdirSync(publisherWorkspace);
  mkdirSync(publisherState);
  try {
    const git = args => execFileSync('git', ['-C', publisherWorkspace, ...args], {
      encoding: 'utf8', windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    git(['init']);
    writeFileSync(join(publisherWorkspace, 'README.md'), 'public synthetic fixture\n');
    git(['add', 'README.md']);
    git(['-c', 'user.name=PTYSD synthetic test', '-c', 'user.email=synthetic@example.invalid',
      'commit', '-m', 'synthetic source']);
    const sourceSha = git(['rev-parse', 'HEAD']);
    const spec = 'Change README.md to the exact synthetic marker. Do not invoke an AI model.';
    const job = { ...editJob(spec,'PTYSD_NATIVE_EDIT_E2E_20261016'),source_sha:sourceSha };
    const taskComment = { id: 10, body: JOB_MARKER + JSON.stringify(job),
      user: { login: 'dispatcher' } };
    const comments = [taskComment];
    let nextCommentId = 11;
    let schedulerStarts = 0;
    let executorAuthReady = false;
    let syntheticProcessStarts = 0;
    const pendingRetriggers = [];
    let executeAttempt;
    let pendingExecutorRun = null;
    const config = { repo: REPO, project_id: PROJECT, host: hostname().toUpperCase(), issue: 407,
      workspace: publisherWorkspace, state_dir: publisherState, dispatchers: ['dispatcher'],
      enable_v2_edit_runs: true, allowed_edit_models: { 'opencode/spark': ['high'] },
      executor: f.descriptor };
    const readApi = endpoint => {
      if (endpoint === 'user') return { login: 'worker' };
      if (endpoint.endsWith('/issues/407')) return { title: ISSUE_TITLE, state: 'open' };
      if (endpoint.endsWith(`/issues/comments/${TEST_GOAL_REF.comment_id}`)) return {
        id: TEST_GOAL_REF.comment_id, body: TEST_GOAL_BODY,
        issue_url: `https://api.github.com/repos/${REPO}/issues/310`, user: { login: 'dispatcher' } };
      if (endpoint.includes('/git/ref/heads/main')) return { object: { sha: sourceSha } };
      if (endpoint.endsWith('/pulls/434')) return { number: 434, state: 'open',
        base: { ref: 'main', sha: sourceSha, repo: { id: REPO_ID, full_name: REPO } },
        head: { sha: sourceSha, repo: { id: REPO_ID, full_name: REPO } } };
      if (endpoint.includes('/contents/')) return { encoding: 'base64',
        content: Buffer.from(spec, 'utf8').toString('base64') };
      const match = endpoint.match(/\/issues\/comments\/(\d+)$/);
      if (match) return comments.find(item => item.id === Number(match[1]));
      throw new Error(`UNEXPECTED_SYNTHETIC_E2E_API:${endpoint}`);
    };
    const localPaths = localPathMap(f);
    const dispatch = (descriptor, manifest) => dispatchToExecutor(descriptor, manifest, {
      currentSid: f.currentSid, filesystemPath: localPaths, readTaskXml: f.readTaskXml,
      runTask: taskName => { assert.equal(taskName, f.descriptor.task_name); schedulerStarts++; },
    });
    const runPublisher = () => runWorker(config, {
      apiRead: readApi, commentsRead: () => comments, goalCommentsRead: () => [TEST_GOAL_COMMENT],
      writeReceipt: (_cfg, value, login) => comments.push({ id: nextCommentId++,
        body: RECEIPT_MARKER + JSON.stringify(value), user: { login } }),
      qualifyOpenCodeV2: () => ({ ready: true, bin: 'SYNTHETIC_NO_MODEL_EXECUTABLE' }),
      assertExecutorTaskReady: descriptor => assertExecutorTaskReady(descriptor, {
        currentSid: f.currentSid, filesystemPath: localPaths, readTaskXml: f.readTaskXml,
      }),
      createCandidateSourceBundle,
      dispatchToExecutor: dispatch,
      triggerPendingExecutorAttempt: (_descriptor, attemptId) => {
        pendingRetriggers.push(attemptId);
        assert.equal(executorAuthReady, true,
          'the retry trigger is sent only after executor eligibility is restored');
        pendingExecutorRun = executeAttempt();
        return { outcome: 'EXECUTOR_PENDING_ATTEMPT_TRIGGERED_NOT_ACCEPTANCE', attempt_id: attemptId };
      },
      log: () => {},
    });

    const dispatched = await runPublisher();
    assert.equal(dispatched.state, 'WAITING_EXECUTOR_START_EVIDENCE');
    assert.equal(schedulerStarts, 1);
    assert.equal(comments.filter(item => parseReceipt(item.body)?.request_id === job.request_id).length, 0,
      'a queued task has no STARTED receipt until the Executor records its spawned OS process');
    const attemptId = dispatched.attempt_id;
    const manifestPath = join(f.manifestDir, `${attemptId}.pending.json`);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const originalManifestBytes = readFileSync(manifestPath, 'utf8');
    assert.equal(manifest.source_sha, sourceSha);
    assert.deepEqual(manifest.job.write_paths, ['README.md']);

    const executorConfig = { project_id: PROJECT, repo: REPO, host: hostname().toUpperCase(),
      workspace: f.resultsDir, state_dir: f.resultsDir,
      enable_v2_edit_runs: true, allowed_edit_models: { 'opencode/spark': ['high'] },
      executor_runtime: { user_sid: EXECUTOR_SID, publisher_sid: PUBLISHER_SID,
        manifest_dir: f.descriptor.manifest_dir, results_dir: f.descriptor.results_dir } };
    executeAttempt = () => executePendingManifest({ config: executorConfig,
      manifestDir: f.manifestDir, currentSid: () => EXECUTOR_SID,
      execute: (receivedSpec, executionConfig, receivedJob, attemptId, processEvidence) =>
        runPlan(receivedSpec, executionConfig, receivedJob, attemptId, {
          currentSid: () => EXECUTOR_SID,
          qualifyOpenCodeV2: () => ({ ready: true, bin: 'SYNTHETIC_NO_MODEL_EXECUTABLE' }),
          readV2AuthReadiness: () => executorAuthReady
            ? { status: 'SAVED_ACCOUNT_RECORDS_PRESENT', saved_account_count: 1 }
            : { status: 'NO_SAVED_ACCOUNT_RECORDS', saved_account_count: 0 },
          runCapturedProcess: (_command, args, options) => {
            syntheticProcessStarts++;
            assert.equal(args[0], 'run');
            assert.equal(args[args.indexOf('--agent') + 1], 'ptysd-scoped-write');
            assert.equal(args[args.indexOf('--model') + 1], 'opencode/spark#high');
            assert.equal(args[args.indexOf('--format') + 1], 'json');
            assert.equal(args[args.indexOf('--title') + 1], receivedJob.request_id);
            assert.equal(args.includes('--dir'), false);
            assert.equal(options.cwd, executionConfig.workspace,
              'the CLI resolves the candidate from the exact isolated workspace cwd');
            return runCapturedProcess(process.execPath,
              ['-e', `setTimeout(() => { require('node:fs').writeFileSync('README.md', 'synthetic edit; no model called\\n'); console.log('SYNTHETIC_NO_MODEL'); }, 3000)`], options);
          },
          onProcessSpawn: processEvidence.onProcessSpawn,
        }),
    });

    const authWait = await executeAttempt();
    assert.equal(authWait.eligibility_state, 'WAITING');
    assert.equal(authWait.outcome, 'EXECUTOR_ATTEMPT_WAITING_REEVALUATE');
    assert.equal(syntheticProcessStarts, 0, 'missing executor auth never spawns the model CLI');
    assert.deepEqual(readdirSync(f.manifestDir).filter(name => /\.(?:pending|running)\.json$/.test(name)),
      [`${attemptId}.pending.json`], 'the exact attempt remains pending after a recoverable auth miss');
    assert.equal(readFileSync(manifestPath, 'utf8'), originalManifestBytes,
      'the original request and attempt bytes are restored without rewriting the task');
    assert.equal(comments.filter(item => parseReceipt(item.body)?.request_id === job.request_id).length, 0,
      'no STARTED or terminal receipt is published while executor auth is absent');

    executorAuthReady = true;
    const pendingPoll = await runPublisher();
    assert.equal(pendingPoll.state, 'NO_DELTA');
    assert.deepEqual(pendingRetriggers, [attemptId], 'the same pending attempt is retriggered once');
    assert.equal(comments.filter(item => parseReceipt(item.body)?.request_id === job.request_id).length, 0,
      'the dispatcher still does not claim model activity after a pending retrigger');

    const syntheticRun = await pendingExecutorRun;
    assert.equal(syntheticRun.outcome, 'EXECUTOR_RESULT_PERSISTED_NOT_SEMANTIC_ACCEPTANCE');
    const syntheticResult = JSON.parse(readFileSync(syntheticRun.result_path, 'utf8'));
    assert.equal(syntheticRun.terminal_state, 'FINISHED', JSON.stringify(syntheticResult));
    assert.equal(schedulerStarts, 1, 'the synthetic Executor runs once after the single dispatch');

    const reconciled = await runPublisher();
    assert.equal(reconciled.state, 'NO_DELTA');
    const startReceipts = comments.map(item => parseReceipt(item.body)).filter(value =>
      value?.request_id === job.request_id);
    assert.deepEqual(startReceipts.map(value => value.state), ['STARTED'],
      'the exact process marker is read back before STARTED is published');
    const terminalReconciled = await runPublisher();
    assert.equal(terminalReconciled.state, 'NO_DELTA');
    const receipts = comments.map(item => parseReceipt(item.body)).filter(value =>
      value?.request_id === job.request_id);
    assert.deepEqual(receipts.map(value => value.state), ['STARTED', 'FINISHED']);
    assert.deepEqual(receipts[1].changed_paths, ['README.md']);
    assert.match(receipts[1].outcome, /UNTRUSTED/);
    assert.equal(receipts[1].exit_code, 0);
    assert.equal(schedulerStarts, 1, 'receipt readback must not redispatch or repeat the synthetic attempt');
    assert.deepEqual(pendingRetriggers, [attemptId], 'auth recovery reuses the original attempt ID');
    assert.equal(syntheticProcessStarts, 1, 'only the recovered authorized attempt starts the synthetic child');
  } finally { f.dispose(); }
});

test('executor captures exact source-pinned scoped diff bytes for publisher readback', async t => {
  if (process.platform !== 'win32') return t.skip('Task Scheduler identity execution is Windows-only');
  const f=fixture();
  try {
    const workspace=join(f.root,'scoped-worktree');
    mkdirSync(workspace);
    const git=(args)=>execFileSync('git',['-C',workspace,...args],{
      encoding:'utf8',windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
    git(['init']);
    git(['-c','user.name=PTYSD test','-c','user.email=ptysd-test@example.invalid','config','core.autocrlf','false']);
    writeFileSync(join(workspace,'README.md'),'before\n');
    git(['add','README.md']);
    git(['-c','user.name=PTYSD test','-c','user.email=ptysd-test@example.invalid','commit','-m','fixture']);
    const sourceSha=git(['rev-parse','HEAD']).trim();
    const spec='Edit README.md with one reviewed line.';
    const job={...editJob(spec,'PTYSD_NATIVE_V2_EDIT_DIFF_20261015'),source_sha:sourceSha};
    const sourceBundleSha256=createSourceBundle(f,workspace,git);
    writeFileSync(join(f.manifestDir,`${ATTEMPT}.pending.json`),
      JSON.stringify(makeExecutorManifest(job,spec,ATTEMPT,sourceBundleSha256)),{flag:'wx'});
    const outcome=await executePendingManifest({manifestDir:f.descriptor.manifest_dir,
      currentSid:()=>EXECUTOR_SID,
      config:{project_id:PROJECT,repo:REPO,host:hostname().toUpperCase(),
        executor_runtime:{user_sid:EXECUTOR_SID,publisher_sid:PUBLISHER_SID,
          manifest_dir:f.descriptor.manifest_dir,results_dir:f.descriptor.results_dir},
        workspace,state_dir:f.descriptor.results_dir},
      execute:async(_receivedSpec,receivedConfig)=>{
        assert.notEqual(receivedConfig.workspace,workspace);
        writeFileSync(join(receivedConfig.workspace,'README.md'),'before\nafter\n');
        return {outcome:'OPENCODE_EDIT_CLI_EXIT_0_UNVERIFIED',exit_code:0,
          evidence_sha256:'e'.repeat(64),evidence_bytes:20};
      }});
    assert.equal(outcome.terminal_state,'FINISHED');
    const saved=JSON.parse(readFileSync(executorResultPath(f.descriptor.results_dir,
      job.request_id,ATTEMPT),'utf8'));
    assert.deepEqual(saved.terminal.changed_paths,['README.md']);
    assert.match(saved.terminal.diff_sha256,/^[a-f0-9]{64}$/);
    assert.equal(saved.diff_evidence.sha256,saved.terminal.diff_sha256);
    assert.equal(await verifyScopedEditEvidence(f.resultsDir,saved,job),true);
    const diffPath=join(f.resultsDir,saved.diff_evidence.file);
    assert.match(readFileSync(diffPath,'utf8'),/\+after/);
    assert.equal(readFileSync(join(workspace,'README.md'),'utf8'),'before\n',
      'the publisher/source worktree remains untouched by the edit attempt');
    writeFileSync(diffPath,'tampered diff');
    await assert.rejects(verifyScopedEditEvidence(f.resultsDir,saved,job),/SCOPED_EDIT_DIFF_HASH_MISMATCH/);
  } finally {f.dispose();}
});

test('candidate PR executor edits an isolated bundle-pinned workspace and captures its exact diff', async t => {
  if (process.platform !== 'win32') return t.skip('Task Scheduler identity execution is Windows-only');
  const f=fixture();
  try {
    const baseWorkspace=join(f.root,'base-workspace');
    const sourceRepo=join(f.root,'candidate-source');
    mkdirSync(baseWorkspace); mkdirSync(sourceRepo);
    const git=(repo,args)=>execFileSync('git',['-C',repo,...args],{
      encoding:'utf8',windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
    for (const repo of [baseWorkspace,sourceRepo]) {
      git(repo,['init','--initial-branch=main']);
      git(repo,['-c','user.name=PTYSD test','-c','user.email=ptysd-test@example.invalid','config','core.autocrlf','false']);
    }
    writeFileSync(join(baseWorkspace,'BASE.md'),'base tree remains untouched\n');
    git(baseWorkspace,['add','BASE.md']);
    git(baseWorkspace,['-c','user.name=PTYSD test','-c','user.email=ptysd-test@example.invalid','commit','-m','base fixture']);
    writeFileSync(join(sourceRepo,'README.md'),'candidate source\n');
    git(sourceRepo,['add','README.md']);
    git(sourceRepo,['-c','user.name=PTYSD test','-c','user.email=ptysd-test@example.invalid','commit','-m','candidate fixture']);
    const sourceSha=git(sourceRepo,['rev-parse','HEAD']).trim();
    const bundleRef=`refs/pty-native/candidate-bundles/${ATTEMPT}`;
    git(sourceRepo,['update-ref',bundleRef,sourceSha]);
    const bundleDir=join(f.manifestDir,'candidate-bundles');
    mkdirSync(bundleDir);
    const bundle=join(bundleDir,`${ATTEMPT}.bundle`);
    git(sourceRepo,['bundle','create',bundle,bundleRef]);
    git(sourceRepo,['bundle','verify',bundle]);
    const bundleSha=createHash('sha256').update(readFileSync(bundle)).digest('hex');
    const spec='Edit only README.md and return the scoped diff.';
    const goalBody='PTYSD_V53R4_DELETE_FIRST_AUTONOMY_GOAL_20261015\nsynthetic fixture';
    const goalRef={issue:310,comment_id:6188322050,marker:'PTYSD_V53R4_DELETE_FIRST_AUTONOMY_GOAL_20261015',
      body_sha256:createHash('sha256').update(goalBody).digest('hex')};
    const job={schema:6,project_id:PROJECT,host:hostname().toUpperCase(),
      request_id:'PTYSD_NATIVE_EDIT_PR434_20261016',kind:'opencode_edit',source_sha:sourceSha,
      spec_path:'native-bridge/tasks/scoped-edit.md',
      spec_sha256:createHash('sha256').update(spec).digest('hex'),
      model:'opencode/spark',variant:'high',write_paths:['README.md'],candidate_pr:434,goal_ref:goalRef};
    const pendingPath=join(f.manifestDir,`${ATTEMPT}.pending.json`);
    const manifestBytes=JSON.stringify(makeExecutorManifest(job,spec,ATTEMPT,bundleSha));
    writeFileSync(pendingPath,manifestBytes,{flag:'wx'});
    let calls=0;
    const config={project_id:PROJECT,repo:REPO,host:hostname().toUpperCase(),
      executor_runtime:{user_sid:EXECUTOR_SID,publisher_sid:PUBLISHER_SID,
        manifest_dir:f.descriptor.manifest_dir,results_dir:f.descriptor.results_dir},
      workspace:baseWorkspace,state_dir:f.descriptor.results_dir};
    const execute=async(_receivedSpec,executionConfig,receivedJob)=>{
      calls++;
      assert.equal(receivedJob.source_sha,sourceSha);
      assert.deepEqual(receivedJob.goal_ref,goalRef);
      assert.notEqual(executionConfig.workspace,baseWorkspace);
      assert.equal(git(executionConfig.workspace,['rev-parse','HEAD']).trim(),sourceSha);
      if (calls===1) return {outcome:'OPENCODE_V2_AUTH_NOT_READY',exit_code:null,
        eligibility_state:'WAITING',model_invoked:false,evidence_sha256:null,evidence_bytes:0};
      writeFileSync(join(executionConfig.workspace,'README.md'),'candidate source\nreviewed edit\n');
      return {outcome:'OPENCODE_EDIT_CLI_EXIT_0_UNVERIFIED',exit_code:0,
        evidence_sha256:'c'.repeat(64),evidence_bytes:18};
    };
    const waiting=await executePendingManifest({manifestDir:f.descriptor.manifest_dir,
      currentSid:()=>EXECUTOR_SID,config,execute});
    const isolated=join(f.resultsDir,'candidate-workspaces',ATTEMPT);
    assert.equal(waiting.eligibility_state,'WAITING');
    assert.equal(waiting.model_invoked,false);
    assert.equal(calls,1);
    assert.equal(existsSync(isolated),false,'recoverable auth wait removes the candidate checkout');
    assert.equal(readFileSync(pendingPath,'utf8'),manifestBytes,'the exact same attempt is restored');
    assert.equal(existsSync(executorResultPath(f.resultsDir,job.request_id,ATTEMPT)),false);

    const outcome=await executePendingManifest({manifestDir:f.descriptor.manifest_dir,
      currentSid:()=>EXECUTOR_SID,config,execute});
    assert.equal(calls,2);
    assert.equal(outcome.terminal_state,'FINISHED');
    assert.notEqual(git(baseWorkspace,['rev-parse','HEAD']).trim(),sourceSha,
      'the configured base workspace must not be replaced by the candidate source');
    assert.equal(existsSync(join(baseWorkspace,'README.md')),false);
    assert.equal(git(isolated,['rev-parse','HEAD']).trim(),sourceSha);
    const saved=JSON.parse(readFileSync(executorResultPath(f.resultsDir,job.request_id,ATTEMPT),'utf8'));
    assert.deepEqual(saved.terminal.changed_paths,['README.md']);
    assert.equal(await verifyScopedEditEvidence(f.resultsDir,saved,job),true);
    assert.match(readFileSync(join(f.resultsDir,saved.diff_evidence.file),'utf8'),/\+reviewed edit/);
  } finally {f.dispose();}
});

test('candidate bundle hash mismatch terminal-blocks without invoking OpenCode or retrying forever', async t => {
  if (process.platform !== 'win32') return t.skip('Task Scheduler identity execution is Windows-only');
  const f=fixture();
  try {
    const sourceRepo=join(f.root,'candidate-source');
    mkdirSync(sourceRepo);
    const git=(args)=>execFileSync('git',['-C',sourceRepo,...args],{
      encoding:'utf8',windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
    git(['init','--initial-branch=main']);
    writeFileSync(join(sourceRepo,'README.md'),'candidate source\n');
    git(['add','README.md']);
    git(['-c','user.name=PTYSD test','-c','user.email=ptysd-test@example.invalid','commit','-m','candidate fixture']);
    const sourceSha=git(['rev-parse','HEAD']).trim();
    git(['update-ref','refs/heads/pr-434',sourceSha]);
    const bundleDir=join(f.manifestDir,'candidate-bundles'); mkdirSync(bundleDir);
    const bundle=join(bundleDir,`${ATTEMPT}.bundle`);
    git(['bundle','create',bundle,'refs/heads/pr-434']);
    const spec='Edit only README.md.';
    const job={...editJob(spec,'PTYSD_NATIVE_EDIT_BADBUNDLE_20261016'),source_sha:sourceSha};
    writeFileSync(join(f.manifestDir,`${ATTEMPT}.pending.json`),
      JSON.stringify(makeExecutorManifest(job,spec,ATTEMPT,'a'.repeat(64))),{flag:'wx'});
    let calls=0;
    const outcome=await executePendingManifest({manifestDir:f.descriptor.manifest_dir,
      currentSid:()=>EXECUTOR_SID,
      config:{project_id:PROJECT,repo:REPO,host:hostname().toUpperCase(),
        executor_runtime:{user_sid:EXECUTOR_SID,publisher_sid:PUBLISHER_SID,
          manifest_dir:f.descriptor.manifest_dir,results_dir:f.descriptor.results_dir},
        workspace:sourceRepo,state_dir:f.descriptor.results_dir},
      execute:async()=>{calls++; return {outcome:'MUST_NOT_RUN',exit_code:0};}});
    assert.equal(calls,0);
    assert.equal(outcome.terminal_state,'BLOCKED');
    const saved=JSON.parse(readFileSync(executorResultPath(f.resultsDir,job.request_id,ATTEMPT),'utf8'));
    assert.match(saved.terminal.outcome,/CANDIDATE_SETUP_BLOCKED_CANDIDATE_SOURCE_BUNDLE_HASH_MISMATCH/);
    assert.equal(saved.terminal.model_invoked,false);
    assert.deepEqual(readdirSync(f.manifestDir).filter(name=>name.endsWith('.json')),
      [`${ATTEMPT}.running.json`]);
    assert.equal(existsSync(join(f.manifestDir,`${ATTEMPT}.pending.json`)),false);
  } finally {f.dispose();}
});

test('missing candidate bundle is terminally recorded and does not leave an unserviceable pending loop', async t => {
  if (process.platform !== 'win32') return t.skip('Task Scheduler identity execution is Windows-only');
  const f=fixture();
  try {
    const spec='Edit only README.md.';
    const sourceSha='d'.repeat(40);
    const job={...editJob(spec,'PTYSD_NATIVE_EDIT_NOBUNDLE_20261016'),source_sha:sourceSha};
    writeFileSync(join(f.manifestDir,`${ATTEMPT}.pending.json`),
      JSON.stringify(makeExecutorManifest(job,spec,ATTEMPT,'b'.repeat(64))),{flag:'wx'});
    let calls=0;
    const outcome=await executePendingManifest({manifestDir:f.descriptor.manifest_dir,
      currentSid:()=>EXECUTOR_SID,
      config:{project_id:PROJECT,repo:REPO,host:hostname().toUpperCase(),
        executor_runtime:{user_sid:EXECUTOR_SID,publisher_sid:PUBLISHER_SID,
          manifest_dir:f.descriptor.manifest_dir,results_dir:f.descriptor.results_dir},
        workspace:f.root,state_dir:f.descriptor.results_dir},
      execute:async()=>{calls++; return {outcome:'MUST_NOT_RUN',exit_code:0};}});
    assert.equal(calls,0);
    assert.equal(outcome.terminal_state,'BLOCKED');
    const saved=JSON.parse(readFileSync(executorResultPath(f.resultsDir,job.request_id,ATTEMPT),'utf8'));
    assert.match(saved.terminal.outcome,/CANDIDATE_SETUP_BLOCKED_CANDIDATE_SOURCE_BUNDLE_UNAVAILABLE/);
    assert.equal(saved.terminal.model_invoked,false);
    assert.equal(existsSync(join(f.manifestDir,`${ATTEMPT}.pending.json`)),false);
  } finally {f.dispose();}
});

test('pre-existing candidate attempt directory remains unresolved and is never reused or cleared', async t => {
  if (process.platform !== 'win32') return t.skip('Task Scheduler identity execution is Windows-only');
  const f=fixture();
  const attempt='00000000-0000-4000-8000-000000000002';
  try {
    const sourceRepo=join(f.root,'candidate-source'); mkdirSync(sourceRepo);
    const git=(args)=>execFileSync('git',['-C',sourceRepo,...args],{
      encoding:'utf8',windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
    git(['init','--initial-branch=main']);
    writeFileSync(join(sourceRepo,'README.md'),'candidate source\n');
    git(['add','README.md']);
    git(['-c','user.name=PTYSD test','-c','user.email=ptysd-test@example.invalid','commit','-m','candidate fixture']);
    const sourceSha=git(['rev-parse','HEAD']).trim();
    git(['update-ref','refs/heads/pr-434',sourceSha]);
    const bundleDir=join(f.manifestDir,'candidate-bundles'); mkdirSync(bundleDir);
    const bundle=join(bundleDir,`${attempt}.bundle`);
    git(['bundle','create',bundle,'refs/heads/pr-434']);
    const bundleSha=createHash('sha256').update(readFileSync(bundle)).digest('hex');
    const spec='Edit only README.md.';
    const job={...editJob(spec,'PTYSD_NATIVE_EDIT_ORPHAN_DIR_20261016'),source_sha:sourceSha};
    writeFileSync(join(f.manifestDir,`${attempt}.pending.json`),
      JSON.stringify(makeExecutorManifest(job,spec,attempt,bundleSha)),{flag:'wx'});
    const attemptDirectory=join(f.resultsDir,'candidate-workspaces',attempt);
    mkdirSync(attemptDirectory,{recursive:true});
    writeFileSync(join(attemptDirectory,'preserve.marker'),'unknown prior attempt state');
    let calls=0;
    const outcome=await executePendingManifest({manifestDir:f.descriptor.manifest_dir,
      currentSid:()=>EXECUTOR_SID,
      config:{project_id:PROJECT,repo:REPO,host:hostname().toUpperCase(),
        executor_runtime:{user_sid:EXECUTOR_SID,publisher_sid:PUBLISHER_SID,
          manifest_dir:f.descriptor.manifest_dir,results_dir:f.descriptor.results_dir},
        workspace:sourceRepo,state_dir:f.descriptor.results_dir},
      execute:async()=>{calls++; return {outcome:'MUST_NOT_RUN',exit_code:0};}});
    assert.equal(calls,0);
    assert.equal(outcome.eligibility_state,'UNKNOWN');
    assert.equal(outcome.reason,'CANDIDATE_WORKSPACE_ALREADY_EXISTS_NO_REUSE');
    assert.equal(existsSync(join(f.manifestDir,`${attempt}.running.json`)),true);
    assert.equal(existsSync(join(f.manifestDir,`${attempt}.pending.json`)),false);
    assert.equal(readFileSync(join(attemptDirectory,'preserve.marker'),'utf8'),'unknown prior attempt state');
    assert.equal(existsSync(executorResultPath(f.resultsDir,job.request_id,attempt)),false);
  } finally {f.dispose();}
});

test('executor records an out-of-scope edit as BLOCKED without publishing a diff success', async t => {
  if (process.platform !== 'win32') return t.skip('Task Scheduler identity execution is Windows-only');
  const f=fixture();
  try {
    const workspace=join(f.root,'out-of-scope-worktree');
    mkdirSync(workspace);
    const git=(args)=>execFileSync('git',['-C',workspace,...args],{
      encoding:'utf8',windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
    git(['init']);
    writeFileSync(join(workspace,'README.md'),'before\n');
    git(['add','README.md']);
    git(['-c','user.name=PTYSD test','-c','user.email=ptysd-test@example.invalid','commit','-m','fixture']);
    const spec='The mock executor attempts an out-of-scope write.';
    const job={...editJob(spec,'PTYSD_NATIVE_V2_EDIT_SCOPEFAIL_20261015'),
      source_sha:git(['rev-parse','HEAD']).trim()};
    const sourceBundleSha256=createSourceBundle(f,workspace,git);
    writeFileSync(join(f.manifestDir,`${ATTEMPT}.pending.json`),
      JSON.stringify(makeExecutorManifest(job,spec,ATTEMPT,sourceBundleSha256)),{flag:'wx'});
    const outcome=await executePendingManifest({manifestDir:f.descriptor.manifest_dir,
      currentSid:()=>EXECUTOR_SID,
      config:{project_id:PROJECT,repo:REPO,host:hostname().toUpperCase(),
        executor_runtime:{user_sid:EXECUTOR_SID,publisher_sid:PUBLISHER_SID,
          manifest_dir:f.descriptor.manifest_dir,results_dir:f.descriptor.results_dir},
        workspace,state_dir:f.descriptor.results_dir},
      execute:async(_receivedSpec,receivedConfig)=>{
        assert.notEqual(receivedConfig.workspace,workspace);
        writeFileSync(join(receivedConfig.workspace,'outside.mjs'),'out of scope\n');
        return {outcome:'OPENCODE_EDIT_CLI_EXIT_0_UNVERIFIED',exit_code:0,
          evidence_sha256:'f'.repeat(64),evidence_bytes:21};
      }});
    assert.equal(outcome.terminal_state,'BLOCKED');
    const saved=JSON.parse(readFileSync(executorResultPath(f.descriptor.results_dir,
      job.request_id,ATTEMPT),'utf8'));
    assert.equal(saved.terminal.outcome,'OPENCODE_EDIT_OUT_OF_SCOPE_CHANGE');
    assert.equal(saved.terminal.diff_sha256,null);
    assert.equal(saved.diff_evidence,null);
    assert.equal(await verifyScopedEditEvidence(f.resultsDir,saved,job),true,
      'the blocked attempt can be read back without treating it as a successful diff');
  } finally {f.dispose();}
});

test('executor identity mismatch does not claim or execute a pending model attempt', async t => {
  if (process.platform !== 'win32') return t.skip('Task Scheduler identity execution is Windows-only');
  const f = fixture();
  try {
    const workspace = join(f.root, 'workspace');
    mkdirSync(workspace);
    const spec = 'No model call in this test.';
    const job = modelJob(spec);
    writeFileSync(join(f.manifestDir, `${ATTEMPT}.pending.json`),
      JSON.stringify(legacyStoredPlanManifest(job, spec, ATTEMPT)), { flag: 'wx' });
    let calls = 0;
    await assert.rejects(executePendingManifest({
      manifestDir: f.descriptor.manifest_dir,
      currentSid: () => PUBLISHER_SID,
      config: { project_id: PROJECT, repo: REPO, host: hostname().toUpperCase(),
        executor_runtime: { user_sid: EXECUTOR_SID, publisher_sid: PUBLISHER_SID,
        manifest_dir: f.descriptor.manifest_dir, results_dir: f.descriptor.results_dir },
        workspace, state_dir: f.descriptor.results_dir },
      execute: async () => { calls++; },
    }), /EXECUTOR_RUNTIME_IDENTITY_MISMATCH/);
    assert.equal(calls, 0);
    assert.ok(readdirSync(f.manifestDir).includes(`${ATTEMPT}.pending.json`));
  } finally { f.dispose(); }
});

test('an OpenCode auth wait keeps the same attempt pending and reevaluates it once eligibility returns', async t => {
  if (process.platform !== 'win32') return t.skip('Task Scheduler executor contract is Windows-only');
  const f = fixture();
  try {
    const workspace = join(f.root, 'workspace');
    mkdirSync(workspace);
    const spec = 'Use a public fixture; no model call before explicit execution qualification.';
    const git = args => execFileSync('git', ['-C', workspace, ...args], {
      encoding: 'utf8', windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    });
    git(['init', '--initial-branch=main']);
    writeFileSync(join(workspace, 'README.md'), 'public executor fixture\n');
    git(['add', 'README.md']);
    git(['-c', 'user.name=PTYSD test', '-c', 'user.email=ptysd-test@example.invalid',
      'commit', '-m', 'auth-wait source fixture']);
    const job = { ...editJob(spec), source_sha: git(['rev-parse', 'HEAD']).trim() };
    const sourceBundleSha = createSourceBundle(f, workspace, git);
    const manifest = makeExecutorManifest(job, spec, ATTEMPT, sourceBundleSha);
    const original = JSON.stringify(manifest);
    const pendingPath = join(f.manifestDir, `${ATTEMPT}.pending.json`);
    writeFileSync(pendingPath, original, { flag: 'wx' });
    const config = { project_id: PROJECT, host: hostname().toUpperCase(), workspace,
      state_dir: f.descriptor.results_dir, enable_v2_edit_runs: true,
      allowed_edit_models: { 'opencode/spark': ['high'] },
      executor_runtime: { user_sid: EXECUTOR_SID, publisher_sid: PUBLISHER_SID,
        manifest_dir: f.descriptor.manifest_dir, results_dir: f.descriptor.results_dir } };
    let auth = { status: 'NO_SAVED_ACCOUNT_RECORDS', saved_account_count: 0 };
    let modelStarts = 0;
    const execute = (specText, executionConfig, parsedJob, attemptId) => runPlan(specText,
      executionConfig, parsedJob, attemptId, {
        currentSid: () => EXECUTOR_SID,
        qualifyOpenCodeV2: () => ({ ready: true, bin: 'C:\\OpenCode\\opencode-cli.exe' }),
        readV2AuthReadiness: () => auth,
        runCapturedProcess: async () => {
          modelStarts++;
          return { outcome: 'OPENCODE_V2_EXIT_0_UNTRUSTED', exit_code: 0,
            evidence_sha256: 'a'.repeat(64), evidence_bytes: 1,
            local_evidence: { stdout_sha256: 'b'.repeat(64), stdout_bytes: 1,
              stderr_sha256: 'c'.repeat(64), stderr_bytes: 0 } };
        },
      });
    const result = await executePendingManifest({
      manifestDir: f.descriptor.manifest_dir,
      currentSid: () => EXECUTOR_SID,
      config, execute,
    });
    assert.equal(result.eligibility_state, 'WAITING');
    assert.equal(modelStarts, 0);
    assert.deepEqual(readdirSync(f.manifestDir).filter(name => name.endsWith('.json')),
      [`${ATTEMPT}.pending.json`]);
    assert.ok(existsSync(join(f.manifestDir, 'candidate-bundles', `${ATTEMPT}.bundle`)),
      'the immutable source bundle remains available to the same waiting attempt');
    assert.equal(readFileSync(pendingPath, 'utf8'), original,
      'the same immutable attempt remains available for later eligibility re-evaluation');
    assert.equal(existsSync(executorResultPath(f.resultsDir, job.request_id, ATTEMPT)), false,
      'a recoverable preflight wait must not publish a terminal BLOCKED result');

    auth = { status: 'SAVED_ACCOUNT_RECORDS_PRESENT', saved_account_count: 1 };
    const resumed = await executePendingManifest({
      manifestDir: f.descriptor.manifest_dir,
      currentSid: () => EXECUTOR_SID,
      config, execute,
    });
    assert.equal(resumed.result_path, executorResultPath(f.resultsDir, job.request_id, ATTEMPT));
    assert.equal(resumed.terminal_state, 'FINISHED',
      'FINISHED remains this attempt lifecycle only; the saved outcome is still unverified');
    assert.equal(modelStarts, 1);
    assert.equal(existsSync(join(f.manifestDir, `${ATTEMPT}.pending.json`)), false);
    assert.equal(existsSync(executorResultPath(f.resultsDir, job.request_id, ATTEMPT)), true);
    const saved = JSON.parse(readFileSync(resumed.result_path, 'utf8'));
    assert.equal(saved.attempt_id, ATTEMPT);
    assert.equal(saved.terminal.outcome, 'OPENCODE_V2_EXIT_0_UNTRUSTED',
      'attempt FINISHED must retain the unverified semantic result');
  } finally { f.dispose(); }
});

test('OpenCode stays recoverably WAITING without saved executor auth and never spawns a model', async () => {
  const root=mkdtempSync(join(tmpdir(),'ptysd-opencode-auth-wait-'));
  try {
    const workspace=join(root,'workspace');
    const state=join(root,'state');
    mkdirSync(workspace); mkdirSync(state);
    const job=editJob('Edit only a public synthetic fixture.');
    const executorRuntime={user_sid:EXECUTOR_SID,publisher_sid:PUBLISHER_SID};
    const calls={auth:0,model:0};
    const result=await runPlan('Edit only a public synthetic fixture.',{
      workspace,state_dir:state,enable_v2_edit_runs:true,
      allowed_edit_models:{'opencode/spark':['high']},executor_runtime:executorRuntime,
    },job,ATTEMPT,{
      currentSid:()=>EXECUTOR_SID,
      qualifyOpenCodeV2:()=>({ready:true,bin:'C:\\OpenCode\\opencode-cli.exe'}),
      readV2AuthReadiness:()=>{calls.auth++;return {status:'NO_SAVED_ACCOUNT_RECORDS',saved_account_count:0};},
      runCapturedProcess:async()=>{calls.model++;throw new Error('MUST_NOT_SPAWN_WITHOUT_AUTH');},
    });
    assert.equal(result.eligibility_state,'WAITING');
    assert.equal(result.outcome,'OPENCODE_V2_AUTH_NOT_READY');
    assert.equal(result.model_invoked,false);
    assert.deepEqual(calls,{auth:1,model:0});
    assert.equal(existsSync(join(workspace,'opencode.json')),false,
      'eligibility is checked before preparing a model workspace or launching the CLI');
    const unknown=await runPlan('Edit only a public synthetic fixture.',{
      workspace,state_dir:state,enable_v2_edit_runs:true,
      allowed_edit_models:{'opencode/spark':['high']},executor_runtime:executorRuntime,
    },job,ATTEMPT,{
      currentSid:()=>EXECUTOR_SID,
      qualifyOpenCodeV2:()=>({ready:true,bin:'C:\\OpenCode\\opencode-cli.exe'}),
      readV2AuthReadiness:()=>{throw new Error('AUTH_READBACK_FAILED');},
      runCapturedProcess:async()=>{calls.model++;throw new Error('MUST_NOT_SPAWN_WITH_UNKNOWN_AUTH');},
    });
    assert.equal(unknown.eligibility_state,'WAITING');
    assert.equal(unknown.outcome,'OPENCODE_V2_AUTH_METADATA_UNKNOWN');
    assert.equal(unknown.model_invoked,false);
    assert.equal(calls.model,0);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('a waiting executor retry starts only the exact sole pending attempt', () => {
  const f = fixture();
  try {
    const spec = 'Read-only qualification fixture.';
    const job = modelJob(spec);
    writeFileSync(join(f.manifestDir, `${ATTEMPT}.pending.json`),
      JSON.stringify(legacyStoredPlanManifest(job, spec, ATTEMPT)), { flag: 'wx' });
    let starts = 0;
    const options = { currentSid: f.currentSid, filesystemPath: localPathMap(f),
      readTaskXml: f.readTaskXml, expectedJob: job,
      runTask: name => { starts++; assert.equal(name, f.descriptor.task_name); } };
    assert.equal(triggerPendingExecutorAttempt(f.descriptor, ATTEMPT, options).outcome,
      'EXECUTOR_PENDING_ATTEMPT_TRIGGERED_NOT_ACCEPTANCE');
    assert.equal(starts, 1);
    assert.throws(() => triggerPendingExecutorAttempt(f.descriptor, ATTEMPT,
      { ...options, expectedJob: { ...job, source_sha: 'b'.repeat(40) } }),
    /EXECUTOR_PENDING_MANIFEST_IDENTITY_MISMATCH/);
    assert.equal(starts, 1, 'a different trusted source job cannot trigger the pending attempt');
    assert.throws(() => triggerPendingExecutorAttempt(f.descriptor,
      '00000000-0000-4000-8000-000000000099', options), /EXECUTOR_ATTEMPT_NOT_EXPECTED_PENDING/);
    assert.equal(starts, 1, 'mismatched attempt identity is never triggered');
  } finally { f.dispose(); }
});

test('Worker integration keeps scoped OpenCode edit pending until process evidence and never awaits the model', async () => {
  const root = mkdtempSync(join(homedir(), '.ptysd-worker-dispatch-'));
  try {
    const workspace = join(root, 'workspace');
    const publisherState = join(root, 'publisher-state');
    const manifestDir = join(root, 'executor-inbox');
    const resultsDir = join(root, 'executor-results');
    for (const path of [workspace, publisherState, manifestDir, resultsDir]) mkdirSync(path);
    const git = args => execFileSync('git', ['-C', workspace, ...args], {
      encoding: 'utf8', windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    });
    git(['init', '--initial-branch=main']);
    writeFileSync(join(workspace, 'README.md'), 'public synthetic source\n');
    git(['add', 'README.md']);
    git(['-c', 'user.name=PTYSD test', '-c', 'user.email=ptysd-test@example.invalid',
      'commit', '-m', 'synthetic executor source']);
    const sourceSha = git(['rev-parse', 'HEAD']).trim();
    const spec = 'Edit only README.md in the isolated executor workspace.';
    const job = { ...editJob(spec,'PTYSD_NATIVE_V2_EDIT_DISPATCH_20261016'),source_sha:sourceSha };
    const originalBody = JOB_MARKER + JSON.stringify(job);
    let comments = [{ id: 1, body: originalBody, user: { login: 'dispatcher' } }];
    let nextId = 2;
    let verifyCalls = 0;
    let dispatchCalls = 0;
    let modelCalls = 0;
    const config = {
      repo: REPO, project_id: PROJECT, host: hostname().toUpperCase(), issue: 101,
      workspace, state_dir: publisherState, dispatchers: ['dispatcher'],
      allowed_edit_models: { 'opencode/spark': ['high'] }, enable_v2_edit_runs: true,
      executor: { task_name: '\\PTYSD\\OpenCodeExecutor', user_sid: EXECUTOR_SID,
        publisher_sid: PUBLISHER_SID, manifest_dir: manifestDir, results_dir: resultsDir,
        node_bin: 'C:\\Program Files\\nodejs\\node.exe',
        script_path: 'C:\\Users\\PTYSDExecutor\\executor.mjs',
        config_path: 'C:\\Users\\PTYSDExecutor\\executor.json',
        working_directory: 'C:\\Users\\PTYSDExecutor\\Work' },
    };
    const apiRead = uri => {
      if (uri === 'user') return { login: 'native-worker' };
      if (uri.endsWith('/issues/101')) return { title: '[PTYSD-NATIVE] OpenCode dispatch and receipts', state: 'open' };
      if (uri.endsWith(`/issues/comments/${TEST_GOAL_REF.comment_id}`)) return {
        id: TEST_GOAL_REF.comment_id, body: TEST_GOAL_BODY,
        issue_url: `https://api.github.com/repos/${REPO}/issues/310`, user: { login: 'dispatcher' } };
      if (uri.includes('/git/ref/heads/main')) return { object: { sha: job.source_sha } };
      if (uri.endsWith('/pulls/434')) return { number: 434, state: 'open',
        base: { ref: 'main', sha: job.source_sha, repo: { id: REPO_ID, full_name: REPO } },
        head: { sha: job.source_sha, repo: { id: REPO_ID, full_name: REPO } } };
      if (uri.endsWith('/issues/comments/1')) return { id: 1, body: originalBody };
      if (uri.includes('/contents/')) return { encoding: 'base64',
        content: Buffer.from(spec, 'utf8').toString('base64') };
      throw new Error(`UNEXPECTED_API_READ_${uri}`);
    };
    const adapters = {
      apiRead, commentsRead: () => comments, goalCommentsRead: () => [TEST_GOAL_COMMENT],
      writeReceipt: (_config, value, login) => {
        const body = RECEIPT_MARKER + JSON.stringify(value);
        comments.push({ id: nextId++, body, user: { login } });
      },
      assertExecutorTaskReady: descriptor => {
        verifyCalls++;
        assert.equal(descriptor, config.executor);
        return { ready: true };
      },
      dispatchToExecutor: (_descriptor, envelope) => {
        dispatchCalls++;
        assert.equal(envelope.job.request_id, job.request_id);
        assert.equal(envelope.job.kind, 'opencode_edit');
        assert.deepEqual(envelope.job.write_paths, ['README.md']);
        assert.equal(envelope.spec, spec);
        assert.match(envelope.source_bundle_sha256, /^[a-f0-9]{64}$/);
        const bundlePath = join(manifestDir, 'candidate-bundles', `${envelope.attempt_id}.bundle`);
        assert.equal(createHash('sha256').update(readFileSync(bundlePath)).digest('hex'),
          envelope.source_bundle_sha256, 'the executor receives the exact source bundle verified by the publisher');
        writeFileSync(join(manifestDir, `${envelope.attempt_id}.pending.json`),
          JSON.stringify(makeExecutorManifest(envelope.job, envelope.spec, envelope.attempt_id,
            envelope.source_bundle_sha256)), { flag: 'wx' });
        return { outcome: 'EXECUTOR_TASK_DISPATCHED_NOT_ACCEPTANCE', exit_code: 0 };
      },
      triggerPendingExecutorAttempt: (_descriptor, attemptId) => ({
        outcome: 'EXECUTOR_PENDING_ATTEMPT_TRIGGERED_NOT_ACCEPTANCE', attempt_id: attemptId,
      }),
      qualifyOpenCodeV2: () => ({ ready: true }),
      runPlan: async () => { modelCalls++; throw new Error('MUST_NOT_RUN_IN_DISPATCHER'); },
      log: () => {},
    };
    const first = await runWorker(config, adapters);
    assert.equal(first.state, 'WAITING_EXECUTOR_START_EVIDENCE');
    assert.equal(verifyCalls, 2,
      'executor identity is read before choosing the edit lane and again immediately before dispatch');
    assert.equal(dispatchCalls, 1);
    assert.equal(modelCalls, 0);
    assert.equal(comments.length, 1, 'a pending manifest is not a STARTED receipt');
    const second = await runWorker(config, adapters);
    assert.equal(second.state, 'NO_DELTA');
    assert.equal(dispatchCalls, 1, 'the same request remains blocked while its executor result is unknown');
    assert.equal(comments.length, 1);
    assert.equal(modelCalls, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unconfirmed child-tree termination keeps the model attempt unresolved while independent ping work proceeds', async () => {
  const root = mkdtempSync(join(homedir(), '.ptysd-orphan-reconcile-'));
  try {
    const workspace = join(root, 'workspace');
    const publisherState = join(root, 'publisher-state');
    const manifestDir = join(root, 'executor-inbox');
    const resultsDir = join(root, 'executor-results');
    for (const path of [workspace, publisherState, manifestDir, resultsDir]) mkdirSync(path);
    const spec = 'Inspect a public fixture without mutation.';
    const job = modelJob(spec);
    job.host = hostname().toUpperCase();
    const attemptId = ATTEMPT;
    const started = receipt(job.request_id, attemptId, 'STARTED', job);
    const ping = { schema: 1, project_id: PROJECT, host: hostname().toUpperCase(),
      request_id: 'PTYSD_NATIVE_ORPHAN_SAFE_PING', kind: 'ping', source_sha: job.source_sha,
      spec_path: null, spec_sha256: null };
    const comments = [
      { id: 1, body: JOB_MARKER + JSON.stringify(job), user: { login: 'dispatcher' } },
      { id: 2, body: RECEIPT_MARKER + JSON.stringify(started), user: { login: 'native-worker' } },
      { id: 3, body: JOB_MARKER + JSON.stringify(ping), user: { login: 'dispatcher' } },
    ];
    const resultTerminal = receipt(job.request_id, attemptId, 'BLOCKED', job,
      { outcome: 'EVIDENCE_STORAGE_FAILED', exit_code: -1, evidence_sha256: null, evidence_bytes: 0 });
    writeFileSync(executorResultPath(resultsDir, job.request_id, attemptId), JSON.stringify({
      request_id: job.request_id, attempt_id: attemptId, terminal: resultTerminal,
      local_evidence: { storage_error: 'EIO', capture_error: null, spawn_error: null,
        termination_state: 'ORPHAN_POSSIBLE' },
    }));
    const runningMarker = join(manifestDir, `${attemptId}.running.json`);
    writeFileSync(runningMarker, 'retained unresolved attempt');
    const config = {
      repo: REPO, project_id: PROJECT, host: hostname().toUpperCase(), issue: 101,
      workspace, state_dir: publisherState, dispatchers: ['dispatcher'],
      allowed_models: { 'opencode/spark': ['high'] }, enable_v2_model_runs: true,
      executor: { task_name: '\\PTYSD\\OpenCodeExecutor', user_sid: EXECUTOR_SID,
        publisher_sid: PUBLISHER_SID, manifest_dir: 'C:\\PTYSDTest\\inbox',
        results_dir: 'C:\\PTYSDTest\\results', node_bin: 'C:\\Program Files\\nodejs\\node.exe',
        script_path: 'C:\\PTYSDExecutor\\executor.mjs', config_path: 'C:\\PTYSDExecutor\\executor.json',
        working_directory: 'C:\\PTYSDExecutor\\Work' },
    };
    const logs = [];
    let dispatchCalls = 0;
    const apiRead = uri => {
      if (uri === 'user') return { login: 'native-worker' };
      if (uri.endsWith('/issues/101')) return { title: '[PTYSD-NATIVE] OpenCode dispatch and receipts', state: 'open' };
      if (uri.includes('/git/ref/heads/main')) return { object: { sha: job.source_sha } };
      if (uri.endsWith('/issues/comments/3')) return { id: 3, body: comments[2].body };
      throw new Error(`UNEXPECTED_API_READ_${uri}`);
    };
    const result = await runWorker(config, {
      apiRead, commentsRead: () => comments,
      executorResultsDir: () => resultsDir,
      writeReceipt: (_config, value, login) => comments.push({ id: comments.length + 1,
        body: RECEIPT_MARKER + JSON.stringify(value), user: { login } }),
      dispatchToExecutor: () => { dispatchCalls++; throw new Error('must not redispatch unresolved attempt'); },
      runPlan: async () => { throw new Error('must not inline model execution'); },
      log: value => logs.push(value),
    });
    assert.equal(result.request_id, ping.request_id);
    assert.equal(dispatchCalls, 0);
    assert.ok(logs.some(value => value === `EXECUTOR_PROCESS_TERMINATION_UNRESOLVED_${job.request_id}`));
    assert.ok(existsSync(runningMarker), 'uncertain attempt marker remains in place');
    assert.equal(comments.filter(value => parseReceipt(value.body)?.request_id === job.request_id).length, 1,
      'the unresolved plan has only its original STARTED receipt');
    assert.equal(parseReceipt(comments.at(-1).body)?.request_id, ping.request_id,
      'independent non-model work can continue');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing process-tree readback remains unresolved and does not clean the executor attempt', async () => {
  const root = mkdtempSync(join(homedir(), '.ptysd-missing-tree-readback-'));
  try {
    const workspace = join(root, 'workspace');
    const publisherState = join(root, 'publisher-state');
    const manifestDir = join(root, 'executor-inbox');
    const resultsDir = join(root, 'executor-results');
    for (const path of [workspace, publisherState, manifestDir, resultsDir]) mkdirSync(path);
    const spec = 'Inspect a public fixture without mutation.';
    const job = modelJob(spec);
    job.host = hostname().toUpperCase();
    const attemptId = ATTEMPT;
    const started = receipt(job.request_id, attemptId, 'STARTED', job);
    const ping = { schema: 1, project_id: PROJECT, host: hostname().toUpperCase(),
      request_id: 'PTYSD_NATIVE_MISSING_TREE_SAFE_PING', kind: 'ping', source_sha: job.source_sha,
      spec_path: null, spec_sha256: null };
    const comments = [
      { id: 1, body: JOB_MARKER + JSON.stringify(job), user: { login: 'dispatcher' } },
      { id: 2, body: RECEIPT_MARKER + JSON.stringify(started), user: { login: 'native-worker' } },
      { id: 3, body: JOB_MARKER + JSON.stringify(ping), user: { login: 'dispatcher' } },
    ];
    const resultTerminal = receipt(job.request_id, attemptId, 'BLOCKED', job,
      { outcome: 'EVIDENCE_STORAGE_FAILED', exit_code: -1, evidence_sha256: null, evidence_bytes: 0 });
    writeFileSync(executorResultPath(resultsDir, job.request_id, attemptId), JSON.stringify({
      request_id: job.request_id, attempt_id: attemptId, terminal: resultTerminal,
      // A legacy/corrupt result with neither a process-tree readback nor a
      // termination outcome must remain UNKNOWN, never imply that the child died.
      local_evidence: { storage_error: 'EIO', capture_error: null, spawn_error: null },
    }));
    const runningMarker = join(manifestDir, `${attemptId}.running.json`);
    writeFileSync(runningMarker, 'retain until process-tree termination is confirmed');
    const executor = {
      task_name: '\\PTYSD\\OpenCodeExecutor', user_sid: EXECUTOR_SID,
      publisher_sid: PUBLISHER_SID, manifest_dir: manifestDir,
      results_dir: resultsDir,
      node_bin: 'C:\\Program Files\\nodejs\\node.exe',
      script_path: 'C:\\PTYSDExecutor\\executor.mjs',
      config_path: 'C:\\PTYSDExecutor\\executor.json',
      working_directory: 'C:\\PTYSDExecutor\\Work',
    };
    const config = { repo: REPO, project_id: PROJECT, host: hostname().toUpperCase(), issue: 101,
      workspace, state_dir: publisherState, dispatchers: ['dispatcher'],
      allowed_models: { 'opencode/spark': ['high'] }, enable_v2_model_runs: true, executor };
    const logs = [];
    const result = await runWorker(config, {
      apiRead: uri => {
        if (uri === 'user') return { login: 'native-worker' };
        if (uri.endsWith('/issues/101')) return { title: '[PTYSD-NATIVE] OpenCode dispatch and receipts', state: 'open' };
        if (uri.includes('/git/ref/heads/main')) return { object: { sha: job.source_sha } };
        if (uri.endsWith('/issues/comments/3')) return { id: 3, body: comments[2].body };
        throw new Error(`UNEXPECTED_API_READ_${uri}`);
      },
      commentsRead: () => comments,
      writeReceipt: (_config, value, login) => comments.push({ id: comments.length + 1,
        body: RECEIPT_MARKER + JSON.stringify(value), user: { login } }),
      dispatchToExecutor: () => { throw new Error('must not redispatch unknown process effect'); },
      runPlan: async () => { throw new Error('must not inline model execution'); },
      log: value => logs.push(value),
    });
    assert.equal(result.request_id, ping.request_id,
      'an independent zero-token ping still proceeds');
    assert.ok(existsSync(runningMarker),
      'attempt state is not cleaned without process-tree termination evidence');
    assert.ok(logs.some(value => value === `EXECUTOR_PROCESS_TERMINATION_UNRESOLVED_${job.request_id}`));
    assert.equal(comments.filter(value => parseReceipt(value.body)?.request_id === job.request_id).length, 1,
      'unknown child effects do not produce a terminal receipt');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Publisher re-hashes executor stdout/stderr before accepting a terminal receipt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ptysd-evidence-readback-'));
  try {
    const stdout = Buffer.from('executor stdout\n');
    const stderr = Buffer.from('executor stderr\n');
    const separator = Buffer.from('\n--- STDERR ---\n');
    const stdoutFile = 'output-stdout.bin';
    const stderrFile = 'output-stderr.bin';
    writeFileSync(join(root, stdoutFile), stdout);
    writeFileSync(join(root, stderrFile), stderr);
    const hash = bytes => createHash('sha256').update(bytes).digest('hex');
    const combined = Buffer.concat([stdout, separator, stderr]);
    const result = { terminal: { state: 'FINISHED', outcome: 'OPENCODE_V2_EXIT_0_UNTRUSTED',
      evidence_sha256: hash(combined), evidence_bytes: combined.length },
      local_evidence: { stdout_file: stdoutFile, stdout_sha256: hash(stdout), stdout_bytes: stdout.length,
        stderr_file: stderrFile, stderr_sha256: hash(stderr), stderr_bytes: stderr.length,
        storage_error: null, capture_error: null, spawn_error: null } };
    assert.equal(await verifyCapturedEvidence(root, result), true);
    writeFileSync(join(root, stdoutFile), Buffer.concat([stdout, Buffer.from('tampered')]));
    await assert.rejects(verifyCapturedEvidence(root, result), /CAPTURED_EVIDENCE_FILE_HASH_MISMATCH/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
