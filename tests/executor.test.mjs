import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { JOB_MARKER, PROJECT, RECEIPT_MARKER, REPO, parseReceipt, receipt, runWorker, verifyCapturedEvidence } from '../native-bridge/worker.mjs';
import { executePendingManifest } from '../native-bridge/executor.mjs';
import {
  assertExecutorTaskReady, buildExecutorTaskXml, claimPendingManifest,
  dispatchToExecutor, executorResultPath, makeExecutorManifest,
  validateExecutorTaskXml,
} from '../native-bridge/windows-executor.mjs';

const PUBLISHER_SID = 'S-1-5-21-101-202-303-1001';
const EXECUTOR_SID = 'S-1-5-21-101-202-303-1002';
const ATTEMPT = '00000000-0000-4000-8000-000000000001';

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

function localPathMap(f) {
  const paths = new Map([
    [f.descriptor.manifest_dir.toLowerCase(), f.manifestDir],
    [f.descriptor.results_dir.toLowerCase(), f.resultsDir],
  ]);
  return value => paths.get(value.toLowerCase()) ?? value;
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
    const job = modelJob(spec);
    let starts = 0;
    const result = dispatchToExecutor(f.descriptor, {
      request_id: job.request_id, attempt_id: ATTEMPT, source_sha: job.source_sha, job, spec,
    }, { currentSid: f.currentSid, readTaskXml: f.readTaskXml, filesystemPath,
      runTask: taskName => { assert.equal(taskName, f.descriptor.task_name); starts++; } });
    assert.equal(result.outcome, 'EXECUTOR_TASK_DISPATCHED_NOT_ACCEPTANCE');
    assert.equal(result.exit_code, 0);
    assert.equal(starts, 1);
    assert.deepEqual(readdirSync(f.manifestDir), [`${ATTEMPT}.pending.json`]);
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
    const job = modelJob(spec);
    let starts = 0;
    const manifest = { request_id: job.request_id, attempt_id: ATTEMPT,
      source_sha: job.source_sha, job, spec };
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

test('executor claims exactly one manifest and records terminal lifecycle separately from semantic acceptance', async t => {
  if (process.platform !== 'win32') return t.skip('Task Scheduler identity execution is Windows-only');
  const f = fixture();
  try {
    const workspace = join(f.root, 'workspace');
    mkdirSync(workspace);
    const spec = 'Inspect one public text fixture.';
    const job = modelJob(spec);
    const manifest = makeExecutorManifest(job, spec, ATTEMPT);
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

test('executor identity mismatch does not claim or execute a pending model attempt', async t => {
  if (process.platform !== 'win32') return t.skip('Task Scheduler identity execution is Windows-only');
  const f = fixture();
  try {
    const workspace = join(f.root, 'workspace');
    mkdirSync(workspace);
    const spec = 'No model call in this test.';
    const job = modelJob(spec);
    writeFileSync(join(f.manifestDir, `${ATTEMPT}.pending.json`),
      JSON.stringify(makeExecutorManifest(job, spec, ATTEMPT)), { flag: 'wx' });
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

test('Worker integration publishes one STARTED receipt, dispatches the executor, and never awaits the model', async () => {
  const root = mkdtempSync(join(homedir(), '.ptysd-worker-dispatch-'));
  try {
    const workspace = join(root, 'workspace');
    const publisherState = join(root, 'publisher-state');
    const manifestDir = join(root, 'executor-inbox');
    const resultsDir = join(root, 'executor-results');
    for (const path of [workspace, publisherState, manifestDir, resultsDir]) mkdirSync(path);
    const spec = 'Review a public text fixture; do not mutate anything.';
    const job = modelJob(spec);
    job.host = hostname().toUpperCase();
    const originalBody = JOB_MARKER + JSON.stringify(job);
    let comments = [{ id: 1, body: originalBody, user: { login: 'dispatcher' } }];
    let nextId = 2;
    let verifyCalls = 0;
    let dispatchCalls = 0;
    let modelCalls = 0;
    const config = {
      repo: REPO, project_id: PROJECT, host: hostname().toUpperCase(), issue: 101,
      workspace, state_dir: publisherState, dispatchers: ['dispatcher'],
      allowed_models: { 'opencode/spark': ['high'] }, enable_v2_model_runs: true,
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
      if (uri.includes('/git/ref/heads/main')) return { object: { sha: job.source_sha } };
      if (uri.endsWith('/issues/comments/1')) return { id: 1, body: originalBody };
      if (uri.includes('/contents/')) return { encoding: 'base64',
        content: Buffer.from(spec, 'utf8').toString('base64') };
      throw new Error(`UNEXPECTED_API_READ_${uri}`);
    };
    const adapters = {
      apiRead, commentsRead: () => comments,
      writeReceipt: (_config, value, login) => {
        const body = RECEIPT_MARKER + JSON.stringify(value);
        comments.push({ id: nextId++, body, user: { login } });
      },
      assertExecutorTaskReady: descriptor => { verifyCalls++; assert.equal(descriptor, config.executor); },
      dispatchToExecutor: (_descriptor, envelope) => {
        dispatchCalls++;
        assert.equal(envelope.job.request_id, job.request_id);
        assert.equal(envelope.spec, spec);
        return { outcome: 'EXECUTOR_TASK_DISPATCHED_NOT_ACCEPTANCE', exit_code: 0 };
      },
      runPlan: async () => { modelCalls++; throw new Error('MUST_NOT_RUN_IN_DISPATCHER'); },
      log: () => {},
    };
    const first = await runWorker(config, adapters);
    assert.equal(first.state, 'DISPATCHED');
    assert.equal(verifyCalls, 1);
    assert.equal(dispatchCalls, 1);
    assert.equal(modelCalls, 0);
    assert.equal(comments.length, 2);
    const start = parseReceipt(comments[1].body);
    assert.equal(start.state, 'STARTED');
    assert.equal(start.outcome, 'DISPATCH_ACK_NOT_ACCEPTANCE');
    assert.equal(start.request_id, job.request_id);
    const second = await runWorker(config, adapters);
    assert.equal(second.state, 'NO_DELTA');
    assert.equal(dispatchCalls, 1, 'the same request remains blocked while its executor result is unknown');
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
