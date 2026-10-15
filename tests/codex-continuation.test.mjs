import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CODEX_JOB_KEYS, NATIVE_JOB_MARKER, parseCodexJob, parseCodexReceipt,
  codexExecutionGate, codexTaskFingerprint, claimCodexAttempt,
  releaseCodexAttempt,
  buildCodexExecArgs, codexSessionFromJsonl, codexRunOutcome,
  makeCodexExecutorRequest, publishCodexExecutorRequest, validateCodexExecutorRequest,
  executorResultPath, validateCodexExecutorResult,
} from '../native-bridge/codex-continuation.mjs';
import { buildCodexChildEnvironment, changedPaths, runExecutorOnce, takeNextRequest } from '../native-bridge/codex-executor.mjs';
import { codexTerminalReceipt, dispatchCodexJob, selectNext, selectNextWithCodexClaim,
  writeCodexReceiptOnce } from '../native-bridge/worker.mjs';

const sha = 'a'.repeat(40);
const taskHash = 'b'.repeat(64);
const RECEIPT_MARKER = 'PTYSD_NATIVE_RECEIPT_V1\n';
const worker = 'ptyworker';
const author = 't14210184';

function job(overrides = {}) {
  return {
    schema: 3,
    project_id: 'CHATGPT_GLOBAL_SKILL_GOVERNANCE',
    host: 'DESKTOP-1B6PD2P',
    request_id: 'PTYSD_CODEX_TASK_20261015',
    kind: 'codex_plan',
    source_sha: sha,
    spec_path: 'native-bridge/tasks/sample-codex-task.md',
    spec_sha256: taskHash,
    model: 'gpt-6.1-sol',
    reasoning_effort: 'medium',
    write_paths: ['native-bridge/sample.mjs'],
    ...overrides,
  };
}
function body(value) { return NATIVE_JOB_MARKER + JSON.stringify(value); }
function comment(id, text, login = author) { return { id, body: text, user: { login } }; }
function readyConfig(overrides = {}) {
  return {
    github_transport_verified: true,
    codex_cli_qualified: true,
    codex_login_verified: true,
    enable_codex_model_runs: true,
    codex_usage_authorized: true,
    codex_sandbox_boundary: 'VERIFIED_WORKSPACE_ONLY',
    publisher_identity_sid: 'S-1-5-21-PUBLISHER',
    executor_identity_sid: 'S-1-5-21-EXECUTOR',
    codex_executor_task: 'PTYSD-Codex-Executor',
    codex_executor_task_verified: true,
    codex_executor_is_standard_user: true,
    allowed_codex_models: { 'gpt-6.1-sol': ['medium'] },
    ...overrides,
  };
}

test('executor scope inventory includes committed changes from source and ignored untracked files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-codex-changed-paths-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8', windowsHide: true, shell: false,
  }).trim();
  try {
    git('init', '-q');
    git('config', 'user.name', 'PTYSD test');
    git('config', 'user.email', 'ptysd-test@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(dir, '.gitignore'), '*.generated\n');
    writeFileSync(join(dir, 'base.txt'), 'baseline\n');
    git('add', '.gitignore', 'base.txt');
    git('commit', '-q', '-m', 'baseline');
    const sourceSha = git('rev-parse', 'HEAD');

    writeFileSync(join(dir, 'committed-out-of-scope.mjs'), 'export const changed = true;\n');
    git('add', 'committed-out-of-scope.mjs');
    git('commit', '-q', '-m', 'candidate committed output');
    writeFileSync(join(dir, 'private.generated'), 'ignored but still present\n');

    assert.deepEqual(changedPaths(dir, sourceSha), [
      'committed-out-of-scope.mjs', 'private.generated',
    ]);
    assert.throws(() => changedPaths(dir, 'not-a-source-sha'), /WORKSPACE_SOURCE_SHA_INVALID/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Codex task schema is exact, immutable-source-bound and path-scoped', () => {
  const parsed = parseCodexJob(body(job()));
  assert.deepEqual(Object.keys(parsed).sort(), [...CODEX_JOB_KEYS].sort());
  assert.equal(parsed.request_id, job().request_id);
  for (const invalid of [
    job({ shell: 'cmd.exe /c whoami' }),
    job({ source_sha: 'not-a-commit' }),
    job({ spec_path: '../secrets.txt' }),
    job({ write_paths: ['../outside.txt'] }),
    job({ write_paths: ['governance/canonical.json'] }),
    job({ write_paths: ['.git/config'] }),
    job({ write_paths: ['.github/workflows/release.yml'] }),
    job({ write_paths: ['.github/actions/credential-step/action.yml'] }),
    job({ write_paths: ['.GITHUB/ACTIONS/credential-step/action.yml'] }),
    job({ write_paths: ['native-bridge/sample.mjs', 'native-bridge/sample.mjs'] }),
    job({ model: 'https://untrusted.example/model' }),
    job({ reasoning_effort: 'unbounded' }),
  ]) assert.equal(parseCodexJob(body(invalid)), null);
  assert.ok(parseCodexJob(body(job({ write_paths: ['.github/ISSUE_TEMPLATE/bug_report.yml'] }))));
  assert.equal(parseCodexJob('PTYSD_NATIVE_JOB_V1\n{}'), null);
});

test('selection requires trusted author, exact host and current main; duplicate or started requests never replay', () => {
  const valid = comment(1, body(job()));
  assert.equal(selectNext([comment(1, body(job()), 'stranger')], [author], worker,
    job().host, sha), null);
  assert.equal(selectNext([valid], [author], worker, 'OTHER-HOST', sha), null);
  assert.equal(selectNext([valid], [author], worker, job().host, 'c'.repeat(40)), null);
  assert.equal(selectNext([valid, comment(2, body(job({ spec_sha256: 'c'.repeat(64) })))],
    [author], worker, job().host, sha), null);
  const started = { schema: 1, project_id: 'CHATGPT_GLOBAL_SKILL_GOVERNANCE',
    host: job().host, request_id: job().request_id, attempt_id: '00000000-0000-0000-0000-000000000001',
    state: 'STARTED', kind: 'codex_plan', source_sha: sha };
  assert.equal(parseCodexReceipt(RECEIPT_MARKER + JSON.stringify(started)).state, 'STARTED');
  assert.equal(selectNext([valid, comment(2, RECEIPT_MARKER + JSON.stringify(started), worker)],
    [author], worker, job().host, sha), null);
});

test('unreconciled Codex claim blocks replay but does not starve independent native work', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-codex-claim-lane-'));
  try {
    const codex = job();
    claimCodexAttempt(dir, codex, '00000000-0000-0000-0000-000000000002');
    const ping = { schema: 1, project_id: 'CHATGPT_GLOBAL_SKILL_GOVERNANCE',
      host: codex.host, request_id: 'PTYSD_NATIVE_PING_AFTER_CLAIM_20261015',
      kind: 'ping', source_sha: sha, spec_path: null, spec_sha256: null };
    const selected = selectNextWithCodexClaim([
      comment(1, body(codex)), comment(2, `PTYSD_NATIVE_JOB_V1\n${JSON.stringify(ping)}`),
    ], [author], worker, codex.host, sha, dir);
    assert.equal(selected.unresolvedRequestId, codex.request_id);
    assert.equal(selected.next.job.request_id, ping.request_id);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('execution gate fails closed on missing cost, identity, sandbox, provider or model authorization', () => {
  const ready = codexExecutionGate(job(), readyConfig());
  assert.deepEqual(ready, { allowed: true, reasons: [] });
  for (const config of [
    readyConfig({ enable_codex_model_runs: false }),
    readyConfig({ codex_usage_authorized: false }),
    readyConfig({ codex_sandbox_boundary: 'UNKNOWN' }),
    readyConfig({ executor_identity_sid: 'S-1-5-21-PUBLISHER' }),
    readyConfig({ codex_executor_task: 'PTYSD-Native-OpenCode' }),
    readyConfig({ codex_login_verified: false }),
    readyConfig({ github_transport_verified: false }),
    readyConfig({ allowed_codex_models: {} }),
  ]) assert.equal(codexExecutionGate(job(), config).allowed, false);
  assert.ok(codexExecutionGate(job(), readyConfig({ codex_usage_authorized: false }))
    .reasons.includes('USAGE_AUTHORIZATION_UNKNOWN'));
});

test('task fingerprint binds scope, model and source without credentials', () => {
  const base = codexTaskFingerprint(job());
  assert.match(base, /^[a-f0-9]{64}$/);
  assert.notEqual(base, codexTaskFingerprint(job({ model: 'gpt-6.1-sol-next' })));
  assert.notEqual(base, codexTaskFingerprint(job({ write_paths: ['native-bridge/other.mjs'] })));
  assert.equal(base.includes('S-1-5'), false);
});

test('atomic attempt claim admits one process and refuses duplicates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-codex-claim-'));
  try {
    const attempts = await Promise.all([
      Promise.resolve().then(() => claimCodexAttempt(dir, job(), '00000000-0000-0000-0000-000000000001')),
      Promise.resolve().then(() => claimCodexAttempt(dir, job(), '00000000-0000-0000-0000-000000000002')),
    ]);
    assert.equal(attempts.filter(result => result.claimed).length, 1);
    assert.equal(attempts.filter(result => !result.claimed && result.reason === 'CLAIM_EXISTS_NO_REPLAY').length, 1);
    const claim = JSON.parse(readFileSync(join(dir, `codex-claim-${job().request_id}.json`), 'utf8'));
    assert.equal(claim.request_id, job().request_id);
    assert.equal(claim.source_sha, sha);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('claim can be released only for the exact attempt before publication', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-codex-claim-release-'));
  try {
    const claimed = claimCodexAttempt(dir, job(), '00000000-0000-0000-0000-000000000021');
    assert.equal(releaseCodexAttempt(job({ model: 'other-model' }), claimed), false);
    assert.equal(existsSync(claimed.path), true);
    assert.equal(releaseCodexAttempt(job(), claimed), true);
    assert.equal(existsSync(claimed.path), false);
    assert.equal(releaseCodexAttempt(job(), claimed), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Codex CLI args use noninteractive JSONL and workspace-write sandbox without shell or fallback', () => {
  const args = buildCodexExecArgs(job(), 'C:\\isolated\\attempt');
  assert.deepEqual(args, ['exec', '--json', '--sandbox', 'workspace-write', '--model', 'gpt-6.1-sol',
    '--config', 'model_reasoning_effort=medium', '-C', 'C:\\isolated\\attempt', '-']);
  assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
  assert.equal(args.includes('--oss'), false);
  assert.equal(args.includes('cmd.exe'), false);
});

test('Codex child gets no token environment or inherited GitHub CLI config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-codex-child-env-'));
  try {
    const request = { job: job(), attempt_id: '00000000-0000-0000-0000-000000000051' };
    const source = { PATH: 'C:\\Windows\\System32', GH_TOKEN: 'not-a-real-token',
      GITHUB_TOKEN: 'not-a-real-token', GH_ENTERPRISE_TOKEN: 'not-a-real-token',
      CODEX_API_KEY: 'not-a-real-key', OPENAI_API_KEY: 'not-a-real-key',
      APPDATA: 'C:\\Users\\publisher\\AppData\\Roaming' };
    const { env, ghConfigDir } = buildCodexChildEnvironment(request, dir, source);
    assert.equal(env.PATH, source.PATH);
    assert.equal(env.APPDATA, source.APPDATA);
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN',
      'GITHUB_ENTERPRISE_TOKEN', 'CODEX_API_KEY', 'OPENAI_API_KEY']) assert.equal(env[name], undefined);
    assert.equal(env.GH_CONFIG_DIR, ghConfigDir);
    assert.equal(env.GH_PROMPT_DISABLED, '1');
    assert.deepEqual(readdirSync(ghConfigDir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI session evidence is distinct from semantic completion', () => {
  const jsonl = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread_20261015_abc123' }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 3 } }),
  ].join('\n');
  assert.equal(codexSessionFromJsonl(jsonl), 'thread_20261015_abc123');
  assert.equal(codexSessionFromJsonl('not-json'), null);
  assert.equal(codexRunOutcome(0, 'thread_20261015_abc123'), 'CODEX_CLI_EXIT_0_UNVERIFIED');
  assert.equal(codexRunOutcome(0, null), 'CODEX_SESSION_ID_MISSING_UNVERIFIED');
  assert.equal(codexRunOutcome(null, null), 'CODEX_CLI_EXIT_UNKNOWN');
});

test('executor request binds the exact task bytes and immutable source bundle without credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-codex-request-'));
  try {
    const spec = '# Reviewed task\nModify only native-bridge/sample.mjs.\n';
    const bundle = join(dir, 'source.bundle');
    writeFileSync(bundle, 'synthetic git bundle bytes');
    const specSha = createHash('sha256').update(spec).digest('hex');
    const bundleSha = createHash('sha256').update(readFileSync(bundle)).digest('hex');
    const picked = job({ spec_sha256: specSha });
    const request = makeCodexExecutorRequest(picked, '00000000-0000-0000-0000-000000000011', spec, bundle, bundleSha);
    assert.equal(validateCodexExecutorRequest(request).spec, spec);
    assert.equal(request.spec_base64.includes('token'), false);
    const path = publishCodexExecutorRequest(dir, request);
    assert.equal(existsSync(path), true);
    assert.throws(() => publishCodexExecutorRequest(dir, request), error => error.code === 'EEXIST');
    assert.throws(() => validateCodexExecutorRequest({ ...request,
      spec_base64: Buffer.from('changed task').toString('base64') }), /EXECUTOR_SPEC_HASH_MISMATCH/);
    assert.throws(() => validateCodexExecutorRequest({ ...request, fingerprint: '0'.repeat(64) }),
      /EXECUTOR_REQUEST_IDENTITY_INVALID/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('production worker dispatch prepares immutable source before claim and triggers only after receipt readback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-codex-worker-dispatch-'));
  try {
    const spool = join(dir, 'spool');
    const state = join(dir, 'state');
    mkdirSync(spool); mkdirSync(state);
    const spec = '# Exact candidate task\n';
    const specSha = createHash('sha256').update(spec).digest('hex');
    const picked = job({ request_id: 'PTYSD_CODEX_PRODUCTION_DISPATCH_20261015', spec_sha256: specSha });
    const config = { codex_spool: spool, state_dir: state, workspace: 'unused-by-injected-bundle-builder' };
    const events = [];
    const dispatched = await dispatchCodexJob({ config, job: picked, spec, workerLogin: worker,
      attemptId: '00000000-0000-0000-0000-000000000031',
      createBundle: async (path, sourceSha) => {
        events.push(`bundle:${sourceSha}`); writeFileSync(path, 'real local candidate bundle bytes');
      },
      claim: (...args) => { events.push('claim'); return claimCodexAttempt(...args); },
      publishRequest: (...args) => { events.push('request'); return publishCodexExecutorRequest(...args); },
      publishStarted: async started => { events.push(`started:${started.outcome}`); return true; },
      trigger: async () => { events.push('trigger'); },
    });
    assert.equal(dispatched.state, 'CODEX_EXECUTOR_REQUESTED');
    assert.deepEqual(events.map(event => event.split(':')[0]), ['bundle', 'claim', 'request', 'started', 'trigger']);
    const request = JSON.parse(readFileSync(dispatched.requestPath, 'utf8'));
    assert.equal(validateCodexExecutorRequest(request).spec, spec);
    assert.equal(request.source_sha, sha);
    assert.equal(existsSync(join(state, `codex-claim-${picked.request_id}.json`)), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('production worker dispatch bundle failure creates no claim, receipt or executor trigger', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-codex-worker-prep-fail-'));
  try {
    const spool = join(dir, 'spool'), state = join(dir, 'state');
    mkdirSync(spool); mkdirSync(state);
    const config = { codex_spool: spool, state_dir: state, workspace: 'unused' };
    const spec = '# Task\n';
    const picked = job({ request_id: 'PTYSD_CODEX_BUNDLE_FAIL_20261015',
      spec_sha256: createHash('sha256').update(spec).digest('hex') });
    let claims = 0, receipts = 0, triggers = 0;
    await assert.rejects(dispatchCodexJob({ config, job: picked, spec, workerLogin: worker,
      attemptId: '00000000-0000-0000-0000-000000000032',
      createBundle: async () => { throw new Error('synthetic bundle failure'); },
      claim: (...args) => { claims++; return claimCodexAttempt(...args); },
      publishStarted: async () => { receipts++; }, trigger: async () => { triggers++; },
    }), /synthetic bundle failure/);
    assert.equal(claims, 0); assert.equal(receipts, 0); assert.equal(triggers, 0);
    assert.equal(existsSync(join(state, `codex-claim-${picked.request_id}.json`)), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('production worker dispatch readback ambiguity leaves one claim and never triggers or retries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-codex-worker-ambiguous-'));
  try {
    const spool = join(dir, 'spool'), state = join(dir, 'state');
    mkdirSync(spool); mkdirSync(state);
    const config = { codex_spool: spool, state_dir: state, workspace: 'unused' };
    const spec = '# Task\n';
    const picked = job({ request_id: 'PTYSD_CODEX_START_AMBIGUOUS_20261015',
      spec_sha256: createHash('sha256').update(spec).digest('hex') });
    const calls = { start: 0, trigger: 0 };
    const args = { config, job: picked, spec, workerLogin: worker,
      createBundle: async path => writeFileSync(path, 'bundle'),
      publishStarted: async () => { calls.start++; throw new Error('readback unknown'); },
      trigger: async () => { calls.trigger++; },
    };
    await assert.rejects(dispatchCodexJob({ ...args,
      attemptId: '00000000-0000-0000-0000-000000000033' }), /readback unknown/);
    assert.equal(calls.start, 1); assert.equal(calls.trigger, 0);
    assert.equal(readdirSync(join(spool, 'requests')).length, 1);
    const second = await dispatchCodexJob({ ...args,
      attemptId: '00000000-0000-0000-0000-000000000034',
      publishStarted: async () => { calls.start++; },
    });
    assert.equal(second.state, 'CODEX_ATTEMPT_AMBIGUOUS');
    assert.equal(calls.start, 1); assert.equal(calls.trigger, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Codex receipt post ambiguity is reconciled by exact readback without duplicate writes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-codex-receipt-idempotent-'));
  try {
    const config = { state_dir: dir, issue: 407 };
    const receipt = { schema: 1, project_id: 'CHATGPT_GLOBAL_SKILL_GOVERNANCE', host: job().host,
      request_id: job().request_id, attempt_id: '00000000-0000-0000-0000-000000000035',
      state: 'STARTED', kind: 'codex_plan', source_sha: job().source_sha,
      outcome: 'CODEX_EXECUTOR_DISPATCH_ACK_NOT_ACCEPTANCE' };
    const remote = [];
    let posts = 0;
    const deps = {
      readComments: async () => remote,
      post: async bodyText => {
        posts++;
        remote.push(comment(1, bodyText, worker));
        throw new Error('synthetic transport broke after remote write');
      },
    };
    await assert.rejects(writeCodexReceiptOnce(config, receipt, worker, deps),
      /CODEX_RECEIPT_POST_UNKNOWN_NO_REPLAY/);
    assert.equal((await writeCodexReceiptOnce(config, receipt, worker, deps)).state, 'ALREADY_READ_BACK');
    assert.equal(posts, 1);
    assert.equal(remote.length, 1);

    const unknownReceipt = { ...receipt, attempt_id: '00000000-0000-0000-0000-000000000036' };
    const absentRemote = { readComments: async () => [], post: async () => {
      posts++; throw new Error('outcome unknown, no visible readback');
    } };
    await assert.rejects(writeCodexReceiptOnce(config, unknownReceipt, worker, absentRemote),
      /CODEX_RECEIPT_POST_UNKNOWN_NO_REPLAY/);
    await assert.rejects(writeCodexReceiptOnce(config, unknownReceipt, worker, absentRemote),
      /CODEX_RECEIPT_ALREADY_CLAIMED_NO_REPLAY/);
    assert.equal(posts, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('synthetic no-model worker-to-executor receipt closes one attempt and exposes the next task', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-codex-full-loop-'));
  try {
    const spool = join(dir, 'spool'), state = join(dir, 'publisher-state');
    mkdirSync(spool); mkdirSync(state);
    const spec = '# Synthetic gated request\n';
    const picked = job({ request_id: 'PTYSD_CODEX_LOOP_FIRST_20261015',
      spec_sha256: createHash('sha256').update(spec).digest('hex') });
    const comments = [comment(1, body(picked))];
    const config = { codex_spool: spool, state_dir: state, workspace: 'unused' };
    let started;
    const dispatched = await dispatchCodexJob({ config, job: picked, spec, workerLogin: worker,
      attemptId: '00000000-0000-0000-0000-000000000041',
      createBundle: async path => writeFileSync(path, 'synthetic immutable bundle'),
      publishStarted: async value => {
        started = value;
        await writeCodexReceiptOnce({ ...config, issue: 407 }, value, worker, {
          readComments: async () => comments,
          post: async bodyText => { comments.push(comment(2, bodyText, worker)); },
        });
      },
      trigger: async () => {},
    });
    assert.equal(dispatched.state, 'CODEX_EXECUTOR_REQUESTED');

    const executorConfig = readyConfig({ github_transport_verified: false,
      codex_cli_qualified: false, codex_login_verified: false,
      enable_codex_model_runs: false, codex_usage_authorized: false,
      codex_sandbox_boundary: 'UNKNOWN', codex_executor_task_verified: false });
    Object.assign(executorConfig, { spool_dir: spool, workspace_root: join(dir, 'workspaces'),
      codex_executable: join(dir, 'codex.exe') });
    const execution = await runExecutorOnce(executorConfig, {
      currentSid: executorConfig.executor_identity_sid, environment: {},
    });
    assert.equal(execution.state, 'BLOCKED');
    assert.equal(execution.model_invoked, false);
    const result = JSON.parse(readFileSync(executorResultPath(spool, picked.request_id,
      dispatched.attemptId), 'utf8'));
    const terminal = codexTerminalReceipt(started, result);
    assert.equal(terminal.state, 'BLOCKED');
    assert.equal(terminal.outcome, 'CODEX_EXECUTION_GATE_BLOCKED');
    assert.equal(terminal.tests, 'NOT_RUN');
    await writeCodexReceiptOnce({ ...config, issue: 407 }, terminal, worker, {
      readComments: async () => comments,
      post: async bodyText => { comments.push(comment(3, bodyText, worker)); },
    });

    const nextJob = job({ request_id: 'PTYSD_CODEX_LOOP_NEXT_20261015' });
    comments.push(comment(4, body(nextJob)));
    const next = selectNext(comments, [author], worker, picked.host, sha);
    assert.equal(next.job.request_id, nextJob.request_id);
    assert.equal(comments.filter(entry => parseCodexReceipt(entry.body)?.request_id === picked.request_id).length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('request publication collision preserves the pre-existing attempt file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-codex-request-fail-'));
  try {
    const requests = join(dir, 'requests');
    mkdirSync(requests);
    const spec = '# Exact task\n';
    const bundle = join(dir, 'source.bundle');
    writeFileSync(bundle, 'bundle');
    const specSha = createHash('sha256').update(spec).digest('hex');
    const bundleSha = createHash('sha256').update(readFileSync(bundle)).digest('hex');
    const picked = job({ request_id: 'PTYSD_CODEX_WRITE_FAILURE_20261015', spec_sha256: specSha });
    const attempt = '00000000-0000-0000-0000-000000000022';
    const request = makeCodexExecutorRequest(picked, attempt, spec, bundle, bundleSha);
    const target = join(requests, `${picked.request_id}-${attempt}.json`);
    writeFileSync(target, 'pre-existing different object');
    assert.throws(() => publishCodexExecutorRequest(dir, request), error => error.code === 'EEXIST');
    assert.equal(readFileSync(target, 'utf8'), 'pre-existing different object');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('executor consumes a request into an explicit blocked receipt when identity or cost gates are not ready', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-codex-executor-gate-'));
  try {
    const spec = '# No model call in this test\n';
    const bundle = join(dir, 'source.bundle');
    writeFileSync(bundle, 'synthetic bundle');
    const specSha = createHash('sha256').update(spec).digest('hex');
    const bundleSha = createHash('sha256').update(readFileSync(bundle)).digest('hex');
    const picked = job({ request_id: 'PTYSD_CODEX_GATE_20261015', spec_sha256: specSha });
    const request = makeCodexExecutorRequest(picked, '00000000-0000-0000-0000-000000000012', spec, bundle, bundleSha);
    publishCodexExecutorRequest(dir, request);
    const config = readyConfig({ enable_codex_model_runs: false, codex_usage_authorized: false,
      codex_sandbox_boundary: 'UNKNOWN', codex_cli_qualified: false, codex_login_verified: false,
      codex_executor_task_verified: false });
    config.spool_dir = dir;
    config.workspace_root = join(dir, 'workspaces');
    config.codex_executable = join(dir, 'codex.exe');
    const result = await runExecutorOnce(config, { currentSid: config.executor_identity_sid, environment: {} });
    assert.equal(result.state, 'BLOCKED');
    assert.equal(result.model_invoked, false);
    assert.equal(existsSync(join(dir, 'locks', 'executor.active')), false);
    const stored = JSON.parse(readFileSync(executorResultPath(dir, picked.request_id, request.attempt_id), 'utf8'));
    validateCodexExecutorResult(stored, { request_id: picked.request_id, attempt_id: request.attempt_id,
      source_sha: picked.source_sha, task_fingerprint: request.fingerprint });
    assert.equal(stored.outcome, 'CODEX_EXECUTION_GATE_BLOCKED');
    assert.equal(stored.exit_code, 45);
    assert.equal(stored.tests, 'NOT_RUN');
    assert.equal(stored.pr_url, null);
    assert.throws(() => validateCodexExecutorResult(stored, { request_id: picked.request_id,
      attempt_id: request.attempt_id, source_sha: picked.source_sha }), /EXECUTOR_RESULT_IDENTITY_INVALID/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('executor queue keeps publisher requests immutable and durable claims expose the next request once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-codex-queue-'));
  try {
    const requests = join(dir, 'requests');
    const bundles = join(dir, 'bundles');
    mkdirSync(requests); mkdirSync(bundles);
    writeFileSync(join(requests, '000-invalid.json'), '{not-json');
    const makeRequest = suffix => {
      const spec = `# ${suffix}\n`;
      const bundlePath = join(bundles, `${suffix}.bundle`);
      writeFileSync(bundlePath, `${suffix} bundle`);
      const picked = job({ request_id: `PTYSD_CODEX_QUEUE_${suffix}_20261015`,
        spec_sha256: createHash('sha256').update(spec).digest('hex') });
      const bundleSha = createHash('sha256').update(readFileSync(bundlePath)).digest('hex');
      return makeCodexExecutorRequest(picked, `00000000-0000-0000-0000-0000000000${suffix === 'A' ? '61' : '62'}`,
        spec, bundlePath, bundleSha);
    };
    const first = makeRequest('A'), second = makeRequest('B');
    const firstName = `${first.request_id}-${first.attempt_id}.json`;
    const secondName = `${second.request_id}-${second.attempt_id}.json`;
    writeFileSync(join(requests, firstName), JSON.stringify(first));
    writeFileSync(join(requests, secondName), JSON.stringify(second));

    const pickedFirst = takeNextRequest(dir);
    assert.equal(pickedFirst.request.request_id, first.request_id);
    assert.equal(existsSync(join(requests, firstName)), true, 'request remains in publisher-owned queue');
    assert.equal(existsSync(join(dir, 'running')), false, 'executor never moves/modifies publisher queue');
    assert.equal(takeNextRequest(dir).request.request_id, second.request_id);
    assert.equal(takeNextRequest(dir), null, 'durable per-attempt claims prevent replay');
    assert.equal(readdirSync(join(dir, 'claims')).length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('duplicate or restarted executor refuses an existing active lock without consuming work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-codex-active-lock-'));
  try {
    const locks = join(dir, 'locks'), requests = join(dir, 'requests');
    mkdirSync(locks); mkdirSync(requests);
    writeFileSync(join(locks, 'executor.active'), JSON.stringify({ pid: 999999, started_at: 'unknown' }));
    const pending = join(requests, 'PTYSD_CODEX_PENDING_20261015-00000000-0000-0000-0000-000000000071.json');
    writeFileSync(pending, '{"preserve":"pending"}');
    await assert.rejects(runExecutorOnce({ spool_dir: dir }, {
      currentSid: 'S-1-5-21-EXECUTOR', environment: {},
    }), /EEXIST/);
    assert.equal(existsSync(join(locks, 'executor.active')), true);
    assert.equal(readFileSync(pending, 'utf8'), '{"preserve":"pending"}');
    assert.equal(existsSync(join(dir, 'results')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
