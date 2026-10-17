import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import {
  CODEX_JOB_KEYS, CODEX_HUMAN_GOAL_JOB_KEYS, CODEX_HUMAN_GOAL_SPEC_PATH,
  NATIVE_JOB_MARKER, parseCodexJob, parseCodexReceipt,
  codexExecutionGate, codexTaskFingerprint, claimCodexAttempt,
  codexExecutorTaskArguments, validateCodexExecutorTaskXml, assertCodexExecutorTaskReady,
  releaseCodexAttempt,
  buildCodexExecArgs, codexSessionFromJsonl, codexRunOutcome,
  codexExecutorPrompt,
  makeCodexExecutorRequest, publishCodexExecutorRequest, validateCodexExecutorRequest,
  executorResultPath, validateCodexExecutorResult,
} from '../native-bridge/codex-continuation.mjs';
import { buildCodexChildEnvironment, changedPaths, runCodex, runExecutorOnce, takeNextRequest } from '../native-bridge/codex-executor.mjs';
import { codexTerminalReceipt, dispatchCodexJob, selectNext, selectNextWithCodexClaim,
  reconcileCodexExecutorResult, terminalStateForResult, writeCodexReceiptOnce } from '../native-bridge/worker.mjs';

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
    publisher_identity_sid: 'S-1-5-21-1000',
    executor_identity_sid: 'S-1-5-21-2000',
    codex_executor_task: 'PTYSD-Codex-Executor',
    codex_executor_task_user: 'DESKTOP-1B6PD2P\\PTYSDCODEXEXEC',
    codex_executor_wscript_path: 'C:\\Windows\\System32\\wscript.exe',
    codex_executor_launcher_path: 'C:\\ProgramData\\PTYSDNativeBridge\\HiddenCodexExecutor.vbs',
    codex_executor_node_path: 'C:\\Program Files\\nodejs\\node.exe',
    codex_executor_script_path: 'C:\\ProgramData\\PTYSDNativeBridge\\codex-executor.mjs',
    codex_executor_config_path: 'C:\\ProgramData\\PTYSDNativeBridge\\executor-config.json',
    codex_executor_working_directory: 'C:\\ProgramData\\PTYSDNativeBridge\\CodexSpool',
    allowed_codex_models: { 'gpt-6.1-sol': ['medium'] },
    ...overrides,
  };
}

function codexTaskXml(config, overrides = {}) {
  const values = {
    uri: '\\PTYSD-Codex-Executor', user: config.codex_executor_task_user,
    logon: 'Password', runLevel: 'LeastPrivilege', instances: 'IgnoreNew',
    timeLimit: 'PT0S', allowHardTerminate: 'false', enabled: 'true', hidden: 'true',
    command: config.codex_executor_wscript_path,
    arguments: codexExecutorTaskArguments(config),
    workingDirectory: config.codex_executor_working_directory,
    ...overrides,
  };
  return `<?xml version="1.0"?><Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">` +
    `<RegistrationInfo><URI>${values.uri}</URI></RegistrationInfo>` +
    `<Principals><Principal><UserId>${values.user}</UserId><LogonType>${values.logon}</LogonType>` +
    `<RunLevel>${values.runLevel}</RunLevel></Principal></Principals>` +
    `<Settings><MultipleInstancesPolicy>${values.instances}</MultipleInstancesPolicy>` +
    `<ExecutionTimeLimit>${values.timeLimit}</ExecutionTimeLimit>` +
    `<AllowHardTerminate>${values.allowHardTerminate}</AllowHardTerminate><Enabled>${values.enabled}</Enabled>` +
    `<Hidden>${values.hidden}</Hidden></Settings><Actions Context="Author"><Exec>` +
    `<Command>${values.command}</Command><Arguments>${values.arguments}</Arguments>` +
    `<WorkingDirectory>${values.workingDirectory}</WorkingDirectory></Exec></Actions></Task>`;
}

test('Codex dispatch task must match live identity, privilege, launch action and unbounded on-demand settings', () => {
  const config = readyConfig();
  const xml = codexTaskXml(config);
  assert.deepEqual(validateCodexExecutorTaskXml(xml, config), {
    ready: true, task_name: 'PTYSD-Codex-Executor', executor_user: config.codex_executor_task_user,
    run_level: 'LeastPrivilege', logon_type: 'Password', execution_time_limit: 'PT0S',
    allow_hard_terminate: false, multiple_instances: 'IgnoreNew',
  });
  assert.equal(validateCodexExecutorTaskXml(xml.replace(config.codex_executor_task_user,
    config.executor_identity_sid), config).ready, true,
  'Task Scheduler may serialize the verified account identity as its SID');
  assert.deepEqual(assertCodexExecutorTaskReady(config, {
    platform: 'win32', currentSid: () => config.publisher_identity_sid,
    readTaskXml: taskName => { assert.equal(taskName, 'PTYSD-Codex-Executor'); return xml; },
  }).ready, true);
  for (const invalid of [
    codexTaskXml(config, { user: 'DESKTOP-1B6PD2P\\OTHER' }),
    codexTaskXml(config, { logon: 'S4U' }),
    codexTaskXml(config, { runLevel: 'HighestAvailable' }),
    codexTaskXml(config, { instances: 'Parallel' }),
    codexTaskXml(config, { timeLimit: 'PT10M' }),
    codexTaskXml(config, { allowHardTerminate: 'true' }),
    codexTaskXml(config, { enabled: 'false' }),
    codexTaskXml(config, { hidden: 'false' }),
    codexTaskXml(config, { command: 'C:\\Windows\\System32\\cmd.exe' }),
    codexTaskXml(config, { arguments: 'unsafe.exe' }),
    codexTaskXml(config, { workingDirectory: 'C:\\Other' }),
    xml.replace('</Settings>', '<Triggers><LogonTrigger/></Triggers></Settings>'),
    xml.replace('</Actions>', '<Exec><Command>second.exe</Command></Exec></Actions>'),
  ]) assert.throws(() => validateCodexExecutorTaskXml(invalid, config));
  assert.throws(() => assertCodexExecutorTaskReady(config, {
    platform: 'win32', currentSid: () => config.executor_identity_sid, readTaskXml: () => xml,
  }), /CODEX_EXECUTOR_PUBLISHER_SID_MISMATCH/);
});

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
    job({ reasoning_effort: '' }),
    job({ reasoning_effort: 'high\nmodel="untrusted"' }),
  ]) assert.equal(parseCodexJob(body(invalid)), null);
  for (const effort of ['none', 'max', 'ultra', 'persistent', 'model-defined-tier-7'])
    assert.equal(parseCodexJob(body(job({ reasoning_effort: effort })))?.reasoning_effort, effort,
      'parse exact advertised effort strings without a stale local enum');
  assert.equal(codexExecutionGate(job({ reasoning_effort: 'model-defined-tier-7' }), readyConfig()).allowed, false,
    'a parseable effort still requires explicit per-model authorization');
  assert.equal(codexExecutionGate(job({ reasoning_effort: 'model-defined-tier-7' }), readyConfig({
    allowed_codex_models: { 'gpt-6.1-sol': ['medium', 'model-defined-tier-7'] },
  })).allowed, true, 'a model-defined effort can be authorized without changing the parser');
  assert.ok(parseCodexJob(body(job({ write_paths: ['.github/ISSUE_TEMPLATE/bug_report.yml'] }))));
  const broaderScope = Array.from({ length: 33 }, (_, index) =>
    `native-bridge/generated-${index}.mjs`);
  assert.equal(parseCodexJob(body(job({ write_paths: broaderScope })))?.write_paths.length, 33,
    'an explicit path scope is not capped at the former arbitrary 32 files');
  const longPath=`native-bridge/${'x'.repeat(175)}.mjs`;
  assert.ok(longPath.length>180);
  assert.equal(parseCodexJob(body(job({ write_paths: [longPath] })))?.write_paths[0],longPath,
    'a valid exact path is not rejected by an arbitrary character ceiling');
  assert.equal(parseCodexJob('PTYSD_NATIVE_JOB_V1\n{}'), null);
});

test('Codex Issue comments accept the GitHub-sized body boundary and reject larger bodies', () => {
  const exactBody = body(job()).padEnd(65_536, ' ');
  assert.equal(exactBody.length, 65_536);
  assert.equal(parseCodexJob(exactBody).request_id, job().request_id);
  assert.equal(parseCodexJob(`${exactBody} `), null);

  const receipt = {
    schema: 1, project_id: 'CHATGPT_GLOBAL_SKILL_GOVERNANCE',
    host: 'DESKTOP-1B6PD2P', request_id: 'PTYSD_CODEX_TASK_20261015',
    kind: 'codex_plan', source_sha: sha, state: 'FINISHED',
    attempt_id: 'e416334f-404c-4e61-9b0e-f9283ee07013', diagnostic: '',
  };
  const marker = 'PTYSD_NATIVE_RECEIPT_V1\n';
  const exactReceipt = (marker + JSON.stringify(receipt)).padEnd(65_536, ' ');
  assert.equal(exactReceipt.length, 65_536);
  assert.deepEqual(parseCodexReceipt(exactReceipt), JSON.parse(exactReceipt.slice(marker.length)));
  assert.equal(parseCodexReceipt(`${exactReceipt} `), null);
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
  assert.equal(codexExecutionGate(job(), readyConfig({ codex_executor_task_verified: false,
    codex_executor_is_standard_user: false })).allowed, true,
  'installer booleans are not live Task Scheduler evidence');
  for (const config of [
    readyConfig({ enable_codex_model_runs: false }),
    readyConfig({ codex_usage_authorized: false }),
    readyConfig({ codex_sandbox_boundary: 'UNKNOWN' }),
    readyConfig({ executor_identity_sid: 'S-1-5-21-PUBLISHER' }),
    readyConfig({ codex_executor_task: 'PTYSD-Native-OpenCode' }),
    readyConfig({ codex_executor_config_path: undefined }),
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
    '--config', 'approval_policy=never', '--config', 'model_reasoning_effort="medium"',
    '-C', 'C:\\isolated\\attempt', '-']);
  assert.equal(buildCodexExecArgs(job({ reasoning_effort: 'model-defined-tier-7' }),
    'C:\\isolated\\attempt')[9], 'model_reasoning_effort="model-defined-tier-7"');
  assert.equal(args.includes('--approve-for-me'), false,
    'scheduled execution must not invoke an unapproved automatic review model');
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

test('Human Issue #310 goal context is bound to exact author, comment bytes and source-only Codex prompt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-codex-human-goal-'));
  try {
    const spec = '# Source-only Human goal execution\nDo one bounded source task.\n';
    const goalBody = '# P0\nPTYSD_V53R4_P0_ISSUE310_407_CODEX_DELIVERY_RECOVERY_20261016\nDo source-only work.\n';
    const marker = 'PTYSD_V53R4_P0_ISSUE310_407_CODEX_DELIVERY_RECOVERY_20261016';
    const commentId = 6219236273;
    const goalSha = createHash('sha256').update(goalBody).digest('hex');
    const specSha = createHash('sha256').update(spec).digest('hex');
    const bundle = join(dir, 'source.bundle');
    writeFileSync(bundle, 'synthetic source bundle');
    const bundleSha = createHash('sha256').update(readFileSync(bundle)).digest('hex');
    const bodyBoundRequestId = `PTYSD_HUMAN_GOAL_${commentId}_${goalSha.slice(0, 42).toUpperCase()}`;
    const picked = job({ schema: 4, request_id: bodyBoundRequestId,
      spec_path: CODEX_HUMAN_GOAL_SPEC_PATH, spec_sha256: specSha,
      write_paths: ['native-bridge/worker.mjs'], goal_comment_id: commentId,
      goal_body_sha256: goalSha, goal_author: author, goal_marker: marker });
    assert.deepEqual(Object.keys(picked).sort(), [...CODEX_HUMAN_GOAL_JOB_KEYS].sort());
    assert.ok(parseCodexJob(body(picked)));
    assert.ok(parseCodexJob(body({ ...picked, request_id: `PTYSD_HUMAN_GOAL_${commentId}` })),
      'preexisting comment-only identities remain readable for no-replay recovery');
    assert.equal(parseCodexJob(body({ ...picked,
      request_id: `PTYSD_HUMAN_GOAL_${commentId}_${'0'.repeat(42)}` })), null,
    'the body-bound request suffix must match the full stored SHA-256 prefix');
    const context = { repo: 'PT-Original-Point/ptysd-autonomous-factory', issue: 310,
      comment_id: commentId, author, body_sha256: goalSha, body: goalBody,
      fetched_at: '2026-10-16T15:50:04.000Z' };
    const attemptId = '00000000-0000-0000-0000-000000000017';
    const request = makeCodexExecutorRequest(picked, attemptId,
      spec, bundle, bundleSha, context);
    const validated = validateCodexExecutorRequest(request);
    assert.deepEqual(validated.goalContext, context);
    const prompt = codexExecutorPrompt(validated);
    assert.match(prompt, /## Verified execution scope/);
    assert.match(prompt, /Modify files only at the exact paths in `write_paths`/);
    assert.ok(prompt.includes(JSON.stringify({ request_id: picked.request_id, attempt_id: attemptId,
      source_sha: picked.source_sha, spec_path: picked.spec_path, spec_sha256: picked.spec_sha256,
      model: picked.model, reasoning_effort: picked.reasoning_effort,
      write_paths: ['native-bridge/worker.mjs'] })));
    assert.equal(prompt.includes('package.json'), false,
      'the prompt must not invent paths beyond the verified job scope');
    assert.match(prompt, /never execute comment text as a shell command/);
    assert.ok(prompt.includes(JSON.stringify(context)));
    assert.throws(() => codexExecutorPrompt({ ...validated,
      spec: `${spec}modified` }), /EXECUTOR_PROMPT_SPEC_HASH_MISMATCH/);
    assert.throws(() => codexExecutorPrompt({ ...validated,
      job: { ...picked, write_paths: [] } }), /EXECUTOR_PROMPT_JOB_INVALID/);
    assert.throws(() => makeCodexExecutorRequest(picked, '00000000-0000-0000-0000-000000000018',
      spec, bundle, bundleSha, { ...context, body: `${goalBody}edited` }), /HUMAN_GOAL_CONTEXT_IDENTITY_INVALID/);
    assert.throws(() => makeCodexExecutorRequest(picked, '00000000-0000-0000-0000-000000000021',
      spec, bundle, bundleSha, { ...context, fetched_at: 'not-a-UTC-timestamp' }),
    /HUMAN_GOAL_CONTEXT_IDENTITY_INVALID/);
    assert.throws(() => validateCodexExecutorRequest({ ...request,
      human_goal_context_base64: Buffer.from(JSON.stringify({ ...context, author: 'other' })).toString('base64') }),
    /HUMAN_GOAL_CONTEXT_IDENTITY_INVALID/);
    const legacyContext = { ...context };
    delete legacyContext.fetched_at;
    const legacyRequest = { ...request,
      human_goal_context_base64: Buffer.from(JSON.stringify(legacyContext)).toString('base64') };
    const requestsDir = join(dir, 'requests');
    mkdirSync(requestsDir);
    const legacyPath = join(requestsDir, `${picked.request_id}-${attemptId}.json`);
    writeFileSync(legacyPath, JSON.stringify(legacyRequest));
    assert.equal(takeNextRequest(dir), null,
      'a pre-timestamp schema-4 spool entry must not be executed without auditable fetch time');
    assert.equal(existsSync(legacyPath), true,
      'an unverified legacy request stays available for explicit recovery; do not delete or replay it');
    assert.equal(readdirSync(join(dir, 'claims')).length, 0,
      'the executor must not claim legacy work lacking exact source-readback time');
    assert.throws(() => makeCodexExecutorRequest(job({ spec_sha256: specSha }), '00000000-0000-0000-0000-000000000019',
      spec, bundle, bundleSha, context), /UNEXPECTED_HUMAN_GOAL_CONTEXT/);
    assert.equal(validateCodexExecutorRequest(makeCodexExecutorRequest(job({ spec_sha256: specSha }),
      '00000000-0000-0000-0000-000000000020', spec, bundle, bundleSha)).goalContext, null);
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

test('Codex dispatch uses the shared verifier to bundle only the exact job commit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-codex-exact-source-bundle-'));
  const git = (workspace, ...args) => execFileSync('git', ['-C', workspace, ...args], {
    encoding: 'utf8', windowsHide: true, shell: false,
  }).trim();
  try {
    const workspace = join(dir, 'source');
    mkdirSync(workspace);
    git(workspace, 'init', '-q');
    git(workspace, 'config', 'user.name', 'PTYSD test');
    git(workspace, 'config', 'user.email', 'ptysd-test@example.invalid');
    git(workspace, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(workspace, 'sample.mjs'), 'export const version = 1;\n');
    git(workspace, 'add', 'sample.mjs');
    git(workspace, 'commit', '-q', '-m', 'pinned source');
    const sourceSha = git(workspace, 'rev-parse', 'HEAD');
    writeFileSync(join(workspace, 'sample.mjs'), 'export const version = 2;\n');
    git(workspace, 'commit', '-am', 'later source');
    const laterSha = git(workspace, 'rev-parse', 'HEAD');
    assert.notEqual(sourceSha, laterSha);

    const spec = '# Exact source bundle test\n';
    const picked = job({ request_id: 'PTYSD_CODEX_EXACT_BUNDLE_20261017', source_sha: sourceSha,
      spec_sha256: createHash('sha256').update(spec).digest('hex') });
    const spool = join(dir, 'spool');
    const state = join(dir, 'state');
    mkdirSync(spool); mkdirSync(state);
    const attemptId = '00000000-0000-4000-8000-000000000201';
    let triggers = 0;
    const dispatched = await dispatchCodexJob({ config: {
      codex_spool: spool, state_dir: state, workspace,
    }, job: picked, spec, workerLogin: worker, attemptId,
    publishStarted: async () => true, trigger: async () => { triggers++; },
    });
    assert.equal(dispatched.state, 'CODEX_EXECUTOR_REQUESTED');
    assert.equal(triggers, 1);
    const request = JSON.parse(readFileSync(dispatched.requestPath, 'utf8'));
    assert.equal(request.source_sha, sourceSha);
    assert.equal(createHash('sha256').update(readFileSync(request.bundle_path)).digest('hex'),
      request.bundle_sha256, 'the published request binds the bytes of the verified bundle');
    const heads = git(workspace, 'bundle', 'list-heads', request.bundle_path).split(/\r?\n/);
    assert.deepEqual(heads, [`${sourceSha} refs/pty-native/codex-bundles/${attemptId}`]);
    assert.ok(!heads.some(line => line.includes(laterSha)), 'later workspace HEAD must not enter the pinned bundle');
    assert.throws(() => execFileSync('git', ['-C', workspace, 'show-ref', '--verify',
      `refs/pty-native/codex-bundles/${attemptId}`], {
      encoding: 'utf8', windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'ignore'],
    }), error => error.status !== 0, 'the temporary Git ref is removed after bundle verification');
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

test('STARTED receipt recovery retriggers the exact unclaimed request at most once without reposting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-codex-started-recovery-'));
  try {
    const spool = join(dir, 'spool');
    for (const name of ['requests', 'bundles', 'claims', 'locks', 'results'])
      mkdirSync(join(spool, name), { recursive: true });
    const spec = '# Same attempt only; no task replay in this test.\n';
    const picked = job({ request_id: 'PTYSD_CODEX_START_RECOVERY_20261015',
      spec_sha256: createHash('sha256').update(spec).digest('hex') });
    const attemptId = '00000000-0000-0000-0000-000000000037';
    const bundlePath = join(spool, 'bundles', `${picked.request_id}-${attemptId}.bundle`);
    writeFileSync(bundlePath, 'immutable source bundle');
    const request = makeCodexExecutorRequest(picked, attemptId, spec, bundlePath,
      createHash('sha256').update(readFileSync(bundlePath)).digest('hex'));
    writeFileSync(join(spool, 'requests', `${picked.request_id}-${attemptId}.json`), JSON.stringify(request));
    const started = { schema: 1, project_id: picked.project_id, host: picked.host,
      request_id: picked.request_id, attempt_id: attemptId, state: 'STARTED', kind: 'codex_plan',
      source_sha: picked.source_sha, model: picked.model, reasoning_effort: picked.reasoning_effort,
      task_fingerprint: request.fingerprint };
    const calls = { trigger: 0, receipt: 0 };
    const blocked = new Set();
    const deps = {
      triggerExecutor: async config => { calls.trigger++; assert.equal(config.codex_spool, spool); },
      writeReceiptOnce: async () => { calls.receipt++; },
    };

    assert.deepEqual(await reconcileCodexExecutorResult(started, { codex_spool: spool },
      worker, blocked, deps), { status: 'RETRIGGERED' });
    assert.deepEqual(await reconcileCodexExecutorResult(started, { codex_spool: spool },
      worker, blocked, deps), { status: 'WAITING', reason: 'RECOVERY_TRIGGER_ALREADY_ATTEMPTED' });
    assert.equal(calls.trigger, 1);
    assert.equal(calls.receipt, 0, 'recovery must not publish another STARTED receipt');
    assert.ok(blocked.has('codex_plan'));
    assert.equal(existsSync(join(spool, 'locks',
      `retrigger-${picked.request_id}-${attemptId}.json`)), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('STARTED receipt recovery never retriggers an executor-claimed attempt or ambiguous trigger', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-codex-started-claimed-'));
  try {
    const spool = join(dir, 'spool');
    for (const name of ['requests', 'bundles', 'claims', 'locks', 'results'])
      mkdirSync(join(spool, name), { recursive: true });
    const spec = '# Existing claim means possible model side effects.\n';
    const picked = job({ request_id: 'PTYSD_CODEX_START_CLAIMED_20261015',
      spec_sha256: createHash('sha256').update(spec).digest('hex') });
    const attemptId = '00000000-0000-0000-0000-000000000038';
    const bundlePath = join(spool, 'bundles', `${picked.request_id}-${attemptId}.bundle`);
    writeFileSync(bundlePath, 'immutable source bundle');
    const request = makeCodexExecutorRequest(picked, attemptId, spec, bundlePath,
      createHash('sha256').update(readFileSync(bundlePath)).digest('hex'));
    writeFileSync(join(spool, 'requests', `${picked.request_id}-${attemptId}.json`), JSON.stringify(request));
    const started = { schema: 1, project_id: picked.project_id, host: picked.host,
      request_id: picked.request_id, attempt_id: attemptId, state: 'STARTED', kind: 'codex_plan',
      source_sha: picked.source_sha, model: picked.model, reasoning_effort: picked.reasoning_effort,
      task_fingerprint: request.fingerprint };
    writeFileSync(join(spool, 'claims', `${picked.request_id}-${attemptId}.json`),
      JSON.stringify({ request_id: picked.request_id, attempt_id: attemptId }));
    let triggers = 0;
    const waiting = await reconcileCodexExecutorResult(started, { codex_spool: spool },
      worker, new Set(), { triggerExecutor: async () => { triggers++; } });
    assert.deepEqual(waiting, { status: 'WAITING', reason: 'EXECUTOR_ATTEMPT_CLAIMED_NO_RESULT' });
    assert.equal(triggers, 0);

    rmSync(join(spool, 'claims', `${picked.request_id}-${attemptId}.json`));
    const ambiguous = await reconcileCodexExecutorResult(started, { codex_spool: spool },
      worker, new Set(), { triggerExecutor: async () => {
        triggers++;
        throw Object.assign(new Error('scheduler acknowledgement unknown'), { code: 'TRIGGER_UNKNOWN' });
      } });
    assert.deepEqual(ambiguous, { status: 'UNKNOWN_NO_REPLAY', reason: 'TRIGGER_UNKNOWN' });
    const retry = await reconcileCodexExecutorResult(started, { codex_spool: spool },
      worker, new Set(), { triggerExecutor: async () => { triggers++; } });
    assert.deepEqual(retry, { status: 'WAITING', reason: 'RECOVERY_TRIGGER_ALREADY_ATTEMPTED' });
    assert.equal(triggers, 1);
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

test('synthetic no-model worker-to-executor keeps ineligible work waiting and exposes an independent task', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-codex-full-loop-'));
  try {
    const spool = join(dir, 'spool'), state = join(dir, 'publisher-state');
    mkdirSync(spool); mkdirSync(state);
    const spec = '# Synthetic gated request\n';
    const picked = job({ request_id: 'PTYSD_CODEX_LOOP_FIRST_20261015',
      spec_sha256: createHash('sha256').update(spec).digest('hex') });
    const comments = [comment(1, body(picked))];
    const config = { codex_spool: spool, state_dir: state, workspace: 'unused' };
    const dispatched = await dispatchCodexJob({ config, job: picked, spec, workerLogin: worker,
      attemptId: '00000000-0000-0000-0000-000000000041',
      createBundle: async path => writeFileSync(path, 'synthetic immutable bundle'),
      publishStarted: async value => {
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
      codex_sandbox_boundary: 'UNKNOWN' });
    Object.assign(executorConfig, { spool_dir: spool, workspace_root: join(dir, 'workspaces'),
      codex_executable: join(dir, 'codex.exe') });
    const execution = await runExecutorOnce(executorConfig, {
      currentSid: executorConfig.executor_identity_sid, environment: {},
    });
    assert.equal(execution.state, 'WAITING');
    assert.equal(execution.model_invoked, false);
    assert.equal(existsSync(executorResultPath(spool, picked.request_id, dispatched.attemptId)), false,
      'missing policy does not publish a terminal result for the model attempt');
    assert.equal(existsSync(join(spool, 'requests', `${picked.request_id}-${dispatched.attemptId}.json`)), true);
    const nextJob = { schema: 1, project_id: picked.project_id, host: picked.host,
      request_id: 'PTYSD_NATIVE_PING_AFTER_CODEX_WAIT_20261015', kind: 'ping',
      source_sha: sha, spec_path: null, spec_sha256: null };
    comments.push(comment(3, body(nextJob)));
    const next = selectNext(comments, [author], worker, picked.host, sha);
    assert.equal(next.job.request_id, nextJob.request_id);
    assert.equal(comments.filter(entry => parseCodexReceipt(entry.body)?.request_id === picked.request_id).length, 1,
      'only the original STARTED receipt exists; no duplicate terminal receipt was written');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Codex login preflight WAITING releases only the no-effect attempt so the same task can be reevaluated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-codex-login-waiting-'));
  try {
    const source = join(dir, 'source');
    mkdirSync(source);
    execFileSync('git', ['-C', source, 'init', '-q'], { windowsHide: true, shell: false });
    execFileSync('git', ['-C', source, 'config', 'user.name', 'PTYSD test'], { windowsHide: true, shell: false });
    execFileSync('git', ['-C', source, 'config', 'user.email', 'ptysd-test@example.invalid'], {
      windowsHide: true, shell: false,
    });
    writeFileSync(join(source, 'sample.mjs'), 'export const ready = true;\n');
    execFileSync('git', ['-C', source, 'add', 'sample.mjs'], { windowsHide: true, shell: false });
    execFileSync('git', ['-C', source, 'commit', '-q', '-m', 'test source'], { windowsHide: true, shell: false });
    const sourceSha = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], {
      encoding: 'utf8', windowsHide: true, shell: false,
    }).trim();
    const spec = '# Recoverable Codex request\n';
    const picked = job({ request_id: 'PTYSD_CODEX_LOGIN_WAIT_20261016', source_sha: sourceSha,
      spec_sha256: createHash('sha256').update(spec).digest('hex') });
    const spool = join(dir, 'spool');
    const state = join(dir, 'publisher-state');
    mkdirSync(spool); mkdirSync(state);
    let started;
    let startReceipts = 0;
    let triggerCalls = 0;
    const dispatched = await dispatchCodexJob({ config: {
      codex_spool: spool, state_dir: state, workspace: source,
    }, job: picked, spec, workerLogin: worker,
    attemptId: '00000000-0000-0000-0000-000000000126',
    createBundle: async path => execFileSync('git', ['-C', source, 'bundle', 'create', path, '--all'], {
      windowsHide: true, shell: false,
    }),
    publishStarted: async value => { started = value; startReceipts++; },
    trigger: async () => { triggerCalls++; },
    });
    assert.equal(dispatched.state, 'CODEX_EXECUTOR_REQUESTED');
    assert.equal(startReceipts, 1);

    const config = readyConfig();
    Object.assign(config, { spool_dir: spool, workspace_root: join(dir, 'workspaces'),
      codex_executable: join(dir, 'codex.exe') });
    const retryPath = join(spool, 'locks',
      `retrigger-${picked.request_id}-${dispatched.attemptId}.json`);
    let qualifyCalls = 0;
    let modelRunnerCalls = 0;
    const preflightMiss = async () => {
      qualifyCalls++;
      throw Object.assign(new Error('login not ready'), { code: 'CODEX_LOGIN_NOT_READY' });
    };
    const first = await runExecutorOnce(config, { currentSid: config.executor_identity_sid,
      environment: {}, qualifyCodex: preflightMiss });
    assert.equal(first.state, 'WAITING');
    assert.deepEqual(first.reasons, ['CODEX_LOGIN_NOT_READY']);
    assert.equal(first.model_invoked, false);
    assert.equal(existsSync(executorResultPath(spool, picked.request_id, dispatched.attemptId)), false);
    assert.equal(existsSync(join(spool, 'claims', `${picked.request_id}-${dispatched.attemptId}.json`)), false);
    assert.equal(existsSync(join(spool, 'requests', `${picked.request_id}-${dispatched.attemptId}.json`)), true);
    assert.equal(existsSync(join(spool, 'locks', 'executor.active')), false);

    const blockedKinds = new Set();
    const retryOnce = () => reconcileCodexExecutorResult(started, { codex_spool: spool }, worker,
      blockedKinds, { triggerExecutor: async () => { triggerCalls++; } });
    assert.deepEqual(await retryOnce(), { status: 'RETRIGGERED' });
    assert.equal(existsSync(retryPath), true);

    const second = await runExecutorOnce(config, { currentSid: config.executor_identity_sid,
      environment: {}, qualifyCodex: preflightMiss });
    assert.equal(second.state, 'WAITING');
    assert.equal(second.request_id, picked.request_id);
    assert.equal(second.attempt_id, dispatched.attemptId);
    assert.equal(existsSync(retryPath), false,
      'a confirmed pre-model login miss releases only this attempt retry marker');
    assert.equal(existsSync(executorResultPath(spool, picked.request_id, dispatched.attemptId)), false);
    assert.deepEqual(await retryOnce(), { status: 'RETRIGGERED' },
      'the same source-bound request remains eligible after a confirmed no-effect wait');

    const emptyHash = createHash('sha256').update('').digest('hex');
    const restored = await runExecutorOnce(config, {
      currentSid: config.executor_identity_sid,
      environment: {},
      qualifyCodex: async () => { qualifyCalls++; },
      runCodex: async (_request, _config, worktree) => {
        modelRunnerCalls++;
        assert.equal(execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], {
          encoding: 'utf8', windowsHide: true, shell: false,
        }).trim(), sourceSha);
        return { exit_code: 0, outcome: 'CODEX_SESSION_ID_MISSING_UNVERIFIED',
          session_id: null, session_started: false, provider_usage_evidence: 'UNKNOWN',
          model_activity_evidence: 'UNKNOWN', tool_execution_evidence: 'UNKNOWN',
          tool_execution_count: 0, file_change_tool_evidence: 'UNKNOWN',
          file_change_tool_completed_count: 0, file_change_tool_failed_count: 0,
          file_change_tool_incomplete_count: 0, model_invoked: false,
          process_tree_state: 'NOT_STARTED', termination_state: 'NOT_STARTED',
          stdout_sha256: emptyHash, stderr_sha256: emptyHash, stdout_bytes: 0, stderr_bytes: 0 };
      },
    });
    assert.equal(restored.state, 'RESULT_SAVED');
    assert.equal(restored.model_invoked, false,
      'the test proves re-evaluation without invoking an external model');
    assert.equal(qualifyCalls, 3);
    assert.equal(modelRunnerCalls, 1);
    assert.equal(startReceipts, 1, 're-evaluation does not duplicate the STARTED receipt');
    assert.equal(triggerCalls, 3, 'one initial and two bounded dispatcher recovery triggers');
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

test('executor keeps a no-effect request WAITING until identity and cost gates are ready', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-codex-executor-gate-'));
  try {
    const source = join(dir, 'source');
    mkdirSync(source);
    execFileSync('git', ['-C', source, 'init', '-q'], { windowsHide: true, shell: false });
    execFileSync('git', ['-C', source, 'config', 'user.name', 'PTYSD test'], { windowsHide: true, shell: false });
    execFileSync('git', ['-C', source, 'config', 'user.email', 'ptysd-test@example.invalid'], {
      windowsHide: true, shell: false,
    });
    writeFileSync(join(source, 'sample.mjs'), 'export const ready = true;\n');
    execFileSync('git', ['-C', source, 'add', 'sample.mjs'], { windowsHide: true, shell: false });
    execFileSync('git', ['-C', source, 'commit', '-q', '-m', 'test source'], { windowsHide: true, shell: false });
    const sourceSha = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], {
      encoding: 'utf8', windowsHide: true, shell: false,
    }).trim();
    const spec = '# No model call in this test\n';
    const bundleDir = join(dir, 'bundles');
    mkdirSync(bundleDir);
    const bundle = join(bundleDir, 'source.bundle');
    execFileSync('git', ['-C', source, 'bundle', 'create', bundle, '--all'], { windowsHide: true, shell: false });
    const specSha = createHash('sha256').update(spec).digest('hex');
    const bundleSha = createHash('sha256').update(readFileSync(bundle)).digest('hex');
    const picked = job({ request_id: 'PTYSD_CODEX_GATE_20261015', source_sha: sourceSha, spec_sha256: specSha });
    const request = makeCodexExecutorRequest(picked, '00000000-0000-0000-0000-000000000012', spec, bundle, bundleSha);
    publishCodexExecutorRequest(dir, request);
    const config = readyConfig({ enable_codex_model_runs: false, codex_usage_authorized: false,
      codex_sandbox_boundary: 'UNKNOWN', codex_cli_qualified: false, codex_login_verified: false,
    });
    config.spool_dir = dir;
    config.workspace_root = join(dir, 'workspaces');
    config.codex_executable = 'codex.exe';
    const executorPreflight = await runExecutorOnce(config, {
      currentSid: config.executor_identity_sid, environment: {},
    });
    assert.equal(executorPreflight.state, 'WAITING');
    assert.ok(executorPreflight.reasons.includes('CODEX_EXECUTABLE_INVALID'));
    assert.equal(executorPreflight.model_invoked, false);
    assert.equal(existsSync(join(dir, 'locks', 'executor.active')), false);
    assert.equal(existsSync(executorResultPath(dir, picked.request_id, request.attempt_id)), false,
      'a missing execution entitlement does not consume the task as a terminal result');
    assert.equal(existsSync(join(dir, 'claims', `${picked.request_id}-${request.attempt_id}.json`)), false,
      'only the exact proven pre-model claim is released');
    const requestPath = join(dir, 'requests', `${picked.request_id}-${request.attempt_id}.json`);
    assert.equal(existsSync(requestPath), true, 'the same immutable attempt remains pending');

    config.codex_executable = join(dir, 'codex.exe');
    const policyPreflight = await runExecutorOnce(config, {
      currentSid: config.executor_identity_sid, environment: {},
    });
    assert.equal(policyPreflight.state, 'WAITING');
    assert.ok(policyPreflight.reasons.includes('MODEL_RUNS_NOT_ENABLED'));
    assert.ok(policyPreflight.reasons.includes('USAGE_AUTHORIZATION_UNKNOWN'));
    assert.equal(policyPreflight.model_invoked, false);
    assert.equal(existsSync(executorResultPath(dir, picked.request_id, request.attempt_id)), false);
    assert.equal(existsSync(join(dir, 'claims', `${picked.request_id}-${request.attempt_id}.json`)), false);
    assert.equal(existsSync(requestPath), true, 'policy unavailability also retains the same pending attempt');

    const ready = readyConfig();
    Object.assign(ready, { spool_dir: dir, workspace_root: config.workspace_root,
      codex_executable: config.codex_executable });
    const emptyHash = createHash('sha256').update('').digest('hex');
    const resumed = await runExecutorOnce(ready, {
      currentSid: ready.executor_identity_sid, environment: {}, qualifyCodex: async () => {},
      runCodex: async (_request, _config, worktree) => {
        assert.equal(execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], {
          encoding: 'utf8', windowsHide: true, shell: false,
        }).trim(), sourceSha);
        return { exit_code: 0, outcome: 'CODEX_SESSION_ID_MISSING_UNVERIFIED',
          session_id: null, session_started: false, provider_usage_evidence: 'UNKNOWN',
          model_activity_evidence: 'UNKNOWN', tool_execution_evidence: 'UNKNOWN', tool_execution_count: 0,
          file_change_tool_evidence: 'UNKNOWN', file_change_tool_completed_count: 0,
          file_change_tool_failed_count: 0, file_change_tool_incomplete_count: 0, model_invoked: false,
          process_tree_state: 'NOT_STARTED', termination_state: 'NOT_STARTED',
          stdout_sha256: emptyHash, stderr_sha256: emptyHash, stdout_bytes: 0, stderr_bytes: 0 };
      },
    });
    assert.equal(resumed.state, 'RESULT_SAVED');
    assert.equal(resumed.request_id, picked.request_id);
    assert.equal(resumed.attempt_id, request.attempt_id);
    assert.equal(resumed.model_invoked, false, 'the resume path does not invoke an external model');
    assert.equal(existsSync(requestPath), true, 'the immutable request remains alongside its durable claim');
    assert.equal(existsSync(join(dir, 'claims', `${picked.request_id}-${request.attempt_id}.json`)), true,
      'the exact pending attempt is claimed after eligibility returns');

    const stored = JSON.parse(readFileSync(executorResultPath(dir, picked.request_id, request.attempt_id), 'utf8'));
    validateCodexExecutorResult(stored, { request_id: picked.request_id, attempt_id: request.attempt_id,
      source_sha: picked.source_sha, task_fingerprint: request.fingerprint });
    assert.equal(stored.outcome, 'CODEX_SESSION_ID_MISSING_UNVERIFIED');
    assert.equal(stored.exit_code, 0);
    assert.equal(stored.tests, 'NOT_RUN');
    assert.equal(stored.pr_url, null);
    const terminal = codexTerminalReceipt({ schema: 1, project_id: picked.project_id, host: picked.host,
      request_id: picked.request_id, kind: picked.kind, source_sha: picked.source_sha,
      attempt_id: request.attempt_id, model: picked.model, reasoning_effort: picked.reasoning_effort,
      task_fingerprint: request.fingerprint, state: 'STARTED' }, stored);
    assert.equal(terminal.state, 'BLOCKED', 'exit 0 without a session remains semantically unverified');
    assert.equal(terminal.outcome, 'CODEX_SESSION_ID_MISSING_UNVERIFIED');
    assert.equal(terminal.model_invoked, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('executor terminal receipt keeps model_invoked false when CLI spawn produced no session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-codex-spawn-result-'));
  try {
    const source = join(dir, 'source');
    mkdirSync(source);
    const git = (...args) => execFileSync('git', ['-C', source, ...args], {
      encoding: 'utf8', windowsHide: true, shell: false,
    }).trim();
    git('init', '-q');
    git('config', 'user.name', 'PTYSD test');
    git('config', 'user.email', 'ptysd-test@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(source, 'sample.mjs'), 'export const baseline = true;\n');
    git('add', 'sample.mjs');
    git('commit', '-q', '-m', 'synthetic source baseline');
    const sourceSha = git('rev-parse', 'HEAD');

    const spool = join(dir, 'spool');
    const bundles = join(spool, 'bundles');
    mkdirSync(bundles, { recursive: true });
    const bundlePath = join(bundles, 'spawn-failure.bundle');
    git('bundle', 'create', bundlePath, 'HEAD');
    const spec = '# Synthetic spawn failure only; never invokes a model.\n';
    const picked = job({ request_id: 'PTYSD_CODEX_SPAWN_FAILURE_RESULT_20261015',
      source_sha: sourceSha, spec_sha256: createHash('sha256').update(spec).digest('hex') });
    const attemptId = '00000000-0000-0000-0000-000000000083';
    const request = makeCodexExecutorRequest(picked, attemptId, spec, bundlePath,
      createHash('sha256').update(readFileSync(bundlePath)).digest('hex'));
    publishCodexExecutorRequest(spool, request);

    const config = readyConfig();
    Object.assign(config, { spool_dir: spool, workspace_root: join(dir, 'workspaces'),
      codex_executable: join(dir, 'codex.exe') });
    const execution = await runExecutorOnce(config, {
      currentSid: config.executor_identity_sid,
      environment: {},
      qualifyCodex: async () => {},
      runCodex: async () => ({ exit_code: -1, signal: null,
        session_id: null, model_invoked: false,
        outcome: 'CODEX_SPAWN_FAILED', stdout_sha256: '0'.repeat(64),
        stderr_sha256: '1'.repeat(64), stdout_bytes: 0, stderr_bytes: 0,
        input_error: null, capture_error: null, storage_error: null,
        termination_state: 'NOT_REQUESTED', termination_error: null }),
    });
    assert.equal(execution.state, 'RESULT_SAVED');
    assert.equal(execution.model_invoked, false);
    const saved = JSON.parse(readFileSync(executorResultPath(spool, picked.request_id, attemptId), 'utf8'));
    assert.equal(saved.outcome, 'CODEX_SPAWN_FAILED');
    assert.equal(saved.session_id, null);
    assert.equal(saved.model_invoked, false);
    validateCodexExecutorResult(saved, { request_id: picked.request_id,
      attempt_id: attemptId, source_sha: sourceSha, task_fingerprint: request.fingerprint });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('executor retains the conflict lock when the model process tree termination is unconfirmed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-codex-orphan-lock-'));
  try {
    const source = join(dir, 'source');
    mkdirSync(source);
    const git = (...args) => execFileSync('git', ['-C', source, ...args], {
      encoding: 'utf8', windowsHide: true, shell: false,
    }).trim();
    git('init', '-q');
    git('config', 'user.name', 'PTYSD test');
    git('config', 'user.email', 'ptysd-test@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(source, 'sample.mjs'), 'export const baseline = true;\n');
    git('add', 'sample.mjs');
    git('commit', '-q', '-m', 'synthetic source baseline');
    const sourceSha = git('rev-parse', 'HEAD');

    const spool = join(dir, 'spool');
    const bundles = join(spool, 'bundles');
    mkdirSync(bundles, { recursive: true });
    const bundlePath = join(bundles, 'orphan.bundle');
    git('bundle', 'create', bundlePath, 'HEAD');
    const spec = '# Synthetic termination uncertainty; no model is invoked.\n';
    const picked = job({ request_id: 'PTYSD_CODEX_ORPHAN_TREE_LOCK_20261016',
      source_sha: sourceSha, spec_sha256: createHash('sha256').update(spec).digest('hex') });
    const attemptId = '00000000-0000-0000-0000-000000000093';
    const request = makeCodexExecutorRequest(picked, attemptId, spec, bundlePath,
      createHash('sha256').update(readFileSync(bundlePath)).digest('hex'));
    publishCodexExecutorRequest(spool, request);

    const config = readyConfig();
    Object.assign(config, { spool_dir: spool, workspace_root: join(dir, 'workspaces'),
      codex_executable: join(dir, 'codex.exe') });
    const execution = await runExecutorOnce(config, {
      currentSid: config.executor_identity_sid,
      environment: {},
      qualifyCodex: async () => {},
      runCodex: async (_request, _config, _worktree, _evidenceDir, hooks) => {
        hooks.onProcessSpawn(54321);
        return { exit_code: null, signal: null, session_id: 'thread_orphan',
          model_invoked: false, outcome: 'CODEX_TERMINATION_UNCONFIRMED',
          stdout_sha256: '0'.repeat(64), stderr_sha256: '1'.repeat(64),
          stdout_bytes: 0, stderr_bytes: 0, input_error: null,
          capture_error: 'PROCESS_TREE_READBACK_DENIED', storage_error: null,
          termination_state: 'ORPHAN_POSSIBLE', termination_error: 'TREE_READBACK_DENIED',
          provider_usage_evidence: 'UNKNOWN', model_activity_evidence: 'UNKNOWN',
          token_usage: null, tool_execution_evidence: 'UNKNOWN', tool_execution_count: 0,
          file_change_tool_evidence: 'UNKNOWN', file_change_tool_completed_count: 0,
          file_change_tool_failed_count: 0, file_change_tool_incomplete_count: 0 };
      },
    });

    assert.equal(execution.state, 'RESULT_SAVED');
    assert.equal(execution.model_invoked, false);
    const lockPath = join(spool, 'locks', 'executor.active');
    assert.equal(existsSync(lockPath), true,
      'unconfirmed descendant termination must retain the conflict lock');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.equal(lock.phase, 'MODEL_TERMINATION_UNCONFIRMED');
    assert.equal(lock.request_id, picked.request_id);
    assert.equal(lock.attempt_id, attemptId);
    assert.equal(lock.model_pid, 54321);
    await assert.rejects(runExecutorOnce(config, { currentSid: config.executor_identity_sid,
      environment: {} }), /EEXIST/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Codex process capture shares the native evidence path and blocks incomplete stdin with unconfirmed tree termination', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-codex-capture-'));
  try {
    const spec = '# Captured task input\n';
    const bundle = join(dir, 'source.bundle');
    writeFileSync(bundle, 'synthetic source bundle');
    const picked = job({ spec_sha256: createHash('sha256').update(spec).digest('hex') });
    const request = makeCodexExecutorRequest(picked, '00000000-0000-0000-0000-000000000091', spec,
      bundle, createHash('sha256').update(readFileSync(bundle)).digest('hex'));
    const evidenceDir = join(dir, 'evidence');
    mkdirSync(evidenceDir);
    let captureIndex = 0;

    async function execute({ rejectInput = false, spawnFailure = false, termination, output = null,
      request: taskRequest = request }) {
      const child = new EventEmitter();
      child.pid = 12345;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = rejectInput ? new Writable({
        write(_chunk, _encoding, callback) {
          const error = new Error('synthetic stdin closed');
          error.code = 'EPIPE';
          setImmediate(() => callback(error));
        },
      }) : new PassThrough();
      let delivered = '';
      let spawnedPid = null;
      if (!rejectInput) child.stdin.on('data', chunk => { delivered += chunk.toString(); });

      const spawnProcess = (_command, _args, options) => {
        assert.equal(options.shell, false);
        assert.equal(options.windowsHide, true);
        assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
        const finish = () => setImmediate(() => child.emit('close', spawnFailure ? null : 0, null));
        child.stdin.once(rejectInput ? 'error' : 'finish', finish);
        setImmediate(() => {
          if (spawnFailure) {
            const error = new Error('synthetic executable missing');
            error.code = 'ENOENT';
            child.emit('error', error);
            child.stdout.end('');
            child.stderr.end('');
            return;
          }
          child.emit('spawn');
          child.stdout.end(rejectInput ? '' : output ??
            `${JSON.stringify({ type: 'thread.started', thread_id: 'thread_test_123' })}\n`);
          child.stderr.end('');
        });
        return child;
      };
      const taskEvidenceDir = join(evidenceDir, `capture-${++captureIndex}`);
      mkdirSync(taskEvidenceDir);
      const result = await runCodex(taskRequest, { codex_executable: 'C:\\codex.exe' }, dir, taskEvidenceDir, {
        environment: {}, spawnProcess, terminate: () => termination,
        onProcessSpawn: pid => { spawnedPid = pid; },
      });
      return { result, delivered, spawnedPid };
    }

    const good = await execute({ rejectInput: false, termination: { treeConfirmed: true } });
    const expectedStdout = `${JSON.stringify({ type: 'thread.started', thread_id: 'thread_test_123' })}\n`;
    assert.equal(good.delivered, spec);
    assert.equal(good.spawnedPid, 12345,
      'the spawned CLI PID must be persisted before a later process-tree readback');
    assert.equal(good.result.session_id, 'thread_test_123');
    assert.equal(good.result.exit_code, 0);
    assert.equal(good.result.stdout_sha256, createHash('sha256').update(expectedStdout).digest('hex'));
    assert.equal(good.result.stderr_sha256, createHash('sha256').update('').digest('hex'));
    assert.equal(good.result.stdout_bytes, Buffer.byteLength(expectedStdout));
    assert.equal(good.result.stderr_bytes, 0);
    assert.equal(good.result.outcome, 'CODEX_CLI_EXIT_0_UNVERIFIED');
    assert.equal(good.result.session_started, true);
    assert.equal(good.result.provider_usage_evidence, 'UNKNOWN',
      'thread.started alone does not prove provider usage');
    assert.equal(good.result.model_activity_evidence, 'UNKNOWN',
      'a session identifier is not inference evidence');

    const goalBody = 'PTYSD_V53R4_P0_ISSUE310_407_CODEX_DELIVERY_RECOVERY_20261016\nSource-only request.\n';
    const goalMarker = 'PTYSD_V53R4_P0_ISSUE310_407_CODEX_DELIVERY_RECOVERY_20261016';
    const goalSha = createHash('sha256').update(goalBody).digest('hex');
    const humanJob = job({ schema: 4, request_id: 'PTYSD_HUMAN_GOAL_6219236273',
      spec_path: CODEX_HUMAN_GOAL_SPEC_PATH, spec_sha256: createHash('sha256').update(spec).digest('hex'),
      write_paths: ['native-bridge/worker.mjs'], goal_comment_id: 6219236273,
      goal_body_sha256: goalSha, goal_author: author, goal_marker: goalMarker });
    const humanContext = { repo: 'PT-Original-Point/ptysd-autonomous-factory', issue: 310,
      comment_id: 6219236273, author, body_sha256: goalSha, body: goalBody,
      fetched_at: '2026-10-16T15:50:04.000Z' };
    const humanRequest = makeCodexExecutorRequest(humanJob, '00000000-0000-0000-0000-000000000092',
      spec, bundle, createHash('sha256').update(readFileSync(bundle)).digest('hex'), humanContext);
    const humanRun = await execute({ termination: { treeConfirmed: true }, request: humanRequest });
    assert.ok(humanRun.delivered.includes('"write_paths":["native-bridge/worker.mjs"]'),
      'the exact allowed write scope must reach the actual Codex stdin, not only the request spool');
    assert.ok(humanRun.delivered.includes(JSON.stringify(humanContext)),
      'the exact verified Human directive must reach the actual Codex stdin');
    assert.equal(good.result.tool_execution_evidence, 'UNKNOWN');
    assert.equal(good.result.model_invoked, false);
    assert.equal(terminalStateForResult(good.result), 'FINISHED');

    const started = { schema: 1, project_id: picked.project_id, host: picked.host,
      request_id: picked.request_id, attempt_id: request.attemptId, state: 'STARTED',
      kind: 'codex_plan', source_sha: picked.source_sha, model: picked.model,
      reasoning_effort: picked.reasoning_effort, task_fingerprint: request.fingerprint };
    const toResult = execution => ({ schema: 1, kind: 'codex_plan',
      request_id: picked.request_id, attempt_id: request.attemptId, source_sha: picked.source_sha,
      fingerprint: request.fingerprint, exit_code: 0, outcome: execution.outcome,
      session_id: execution.session_id, diff_sha256: null,
      stdout_sha256: execution.stdout_sha256, stderr_sha256: execution.stderr_sha256,
      model_invoked: execution.model_invoked, session_started: execution.session_started,
      provider_usage_evidence: execution.provider_usage_evidence,
      model_activity_evidence: execution.model_activity_evidence,
      token_usage: execution.token_usage, tool_execution_evidence: execution.tool_execution_evidence,
      tool_execution_count: execution.tool_execution_count,
      file_change_tool_evidence: execution.file_change_tool_evidence,
      file_change_tool_completed_count: execution.file_change_tool_completed_count,
      file_change_tool_failed_count: execution.file_change_tool_failed_count,
      file_change_tool_incomplete_count: execution.file_change_tool_incomplete_count,
      changed_paths: [], out_of_scope_paths: [], tests: 'NOT_RUN', pr_url: null });
    const noUsageReceipt = codexTerminalReceipt(started, toResult(good.result));
    assert.equal(noUsageReceipt.state, 'BLOCKED',
      'a created session without provider usage cannot publish a completed execution receipt');
    assert.equal(noUsageReceipt.provider_usage_evidence, 'UNKNOWN');
    assert.throws(() => validateCodexExecutorResult({ ...toResult(good.result), model_invoked: true }, started),
      /EXECUTOR_RESULT_IDENTITY_INVALID/,
      'a caller cannot override UNKNOWN provider evidence with a positive model_invoked flag');

    const inferenceEvents = [
      { type: 'thread.started', thread_id: 'thread_test_123' },
      { type: 'item.completed', item: { id: 'cmd-1', type: 'command_execution' } },
      { type: 'item.started', item: { id: 'patch-1', type: 'file_change', status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'patch-1', type: 'file_change', status: 'completed' } },
      { type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 4,
        cached_input_tokens: 0, reasoning_output_tokens: 0 } },
    ].map(event => JSON.stringify(event)).join('\n') + '\n';
    const inferred = await execute({ rejectInput: false,
      termination: { treeConfirmed: true }, output: inferenceEvents });
    assert.equal(inferred.result.session_started, true);
    assert.equal(inferred.result.provider_usage_evidence, 'CONFIRMED');
    assert.equal(inferred.result.model_activity_evidence, 'CONFIRMED');
    assert.equal(inferred.result.model_invoked, true);
    assert.equal(inferred.result.tool_execution_evidence, 'OBSERVED');
    assert.equal(inferred.result.tool_execution_count, 2);
    assert.equal(inferred.result.file_change_tool_evidence, 'COMPLETED');
    assert.equal(inferred.result.file_change_tool_completed_count, 1);
    assert.equal(inferred.result.diff_sha256, undefined,
      'CLI file-change events are not a Git diff digest');
    const usageReceipt = codexTerminalReceipt(started, toResult(inferred.result));
    assert.equal(usageReceipt.state, 'FINISHED',
      'FINISHED remains only this execution attempt terminal state');
    assert.equal(usageReceipt.outcome, 'CODEX_CLI_EXIT_0_UNVERIFIED');

    const failed = await execute({ rejectInput: true,
      termination: { rootOnly: true, error: 'TASKKILL_TREE_FAILED' } });
    assert.equal(failed.result.exit_code, 0, 'preserve the child close code as independent evidence');
    assert.equal(failed.result.input_error, 'EPIPE');
    assert.equal(failed.result.termination_state, 'ORPHAN_POSSIBLE');
    assert.equal(failed.result.outcome, 'CODEX_PROCESS_TERMINATION_FAILED');
    assert.equal(failed.result.session_id, null);
    assert.equal(failed.result.model_invoked, false, 'input failure before session evidence is not a model invocation');
    assert.equal(terminalStateForResult(failed.result), 'BLOCKED');

    const requested = await execute({ rejectInput: true, termination: { requested: true } });
    assert.equal(requested.result.termination_state, 'TERMINATION_REQUESTED');
    assert.equal(requested.result.outcome, 'CODEX_PROCESS_TERMINATION_FAILED',
      'a termination request without tree confirmation is unresolved, not a normal input failure');

    const spawnFailed = await execute({ spawnFailure: true,
      termination: { treeConfirmed: true } });
    assert.equal(spawnFailed.result.session_id, null);
    assert.equal(spawnFailed.result.outcome, 'CODEX_SPAWN_FAILED');
    assert.equal(spawnFailed.result.model_invoked, false, 'failed spawn must not be reported as model execution');
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

test('empty executor poll returns IDLE without reading identity, qualifying, or starting a model', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-codex-idle-poll-'));
  let identityReads = 0;
  let qualifications = 0;
  let modelRuns = 0;
  try {
    const result = await runExecutorOnce({ spool_dir: dir }, {
      readCurrentSid: () => { identityReads++; throw new Error('IDLE_POLL_READ_IDENTITY'); },
      qualifyCodex: async () => { qualifications++; throw new Error('IDLE_POLL_QUALIFIED_CODEX'); },
      runCodex: async () => { modelRuns++; throw new Error('IDLE_POLL_STARTED_MODEL'); },
    });
    assert.deepEqual(result, { state: 'IDLE', model_invoked: false });
    assert.equal(identityReads, 0);
    assert.equal(qualifications, 0);
    assert.equal(modelRuns, 0);
    assert.equal(existsSync(join(dir, 'locks', 'executor.active')), false);
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

test('executor archives a prior-boot lock but preserves the old attempt claim and never replays it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-codex-reboot-lock-'));
  try {
    for (const name of ['locks', 'requests', 'bundles', 'claims', 'results'])
      mkdirSync(join(dir, name), { recursive: true });
    const spec = '# Reboot recovery leaves the uncertain attempt un-replayed.\n';
    const oldJob = job({ request_id: 'PTYSD_CODEX_OLD_REBOOT_20261015',
      spec_sha256: createHash('sha256').update(spec).digest('hex') });
    const oldAttempt = '00000000-0000-0000-0000-000000000081';
    const oldBundle = join(dir, 'bundles', 'old.bundle');
    writeFileSync(oldBundle, 'old immutable bundle');
    const oldRequest = makeCodexExecutorRequest(oldJob, oldAttempt, spec, oldBundle,
      createHash('sha256').update(readFileSync(oldBundle)).digest('hex'));
    writeFileSync(join(dir, 'requests', `${oldJob.request_id}-${oldAttempt}.json`), JSON.stringify(oldRequest));
    writeFileSync(join(dir, 'claims', `${oldJob.request_id}-${oldAttempt}.json`),
      JSON.stringify({ request_id: oldJob.request_id, attempt_id: oldAttempt }));

    const nextJob = job({ request_id: 'PTYSD_CODEX_NEXT_REBOOT_20261015',
      spec_sha256: createHash('sha256').update(spec).digest('hex') });
    const nextAttempt = '00000000-0000-0000-0000-000000000082';
    const nextBundle = join(dir, 'bundles', 'next.bundle');
    writeFileSync(nextBundle, 'next immutable bundle');
    const nextRequest = makeCodexExecutorRequest(nextJob, nextAttempt, spec, nextBundle,
      createHash('sha256').update(readFileSync(nextBundle)).digest('hex'));
    writeFileSync(join(dir, 'requests', `${nextJob.request_id}-${nextAttempt}.json`), JSON.stringify(nextRequest));

    writeFileSync(join(dir, 'locks', 'executor.active'), JSON.stringify({ schema: 1,
      pid: 5001, started_at: new Date().toISOString(), boot_uptime_seconds: 900,
      phase: 'MODEL_RUNNING', request_id: oldJob.request_id, attempt_id: oldAttempt }));
    const config = readyConfig({ enable_codex_model_runs: false, codex_usage_authorized: false });
    Object.assign(config, { spool_dir: dir, workspace_root: join(dir, 'workspaces'),
      codex_executable: join(dir, 'codex.exe') });
    const recovered = await runExecutorOnce(config, { currentSid: config.executor_identity_sid,
      environment: {}, uptimeSeconds: () => 10, isProcessAlive: () => true });
    assert.equal(recovered.state, 'WAITING');
    assert.equal(recovered.model_invoked, false);
    assert.equal(existsSync(join(dir, 'claims', `${oldJob.request_id}-${oldAttempt}.json`)), true);
    assert.equal(existsSync(executorResultPath(dir, oldJob.request_id, oldAttempt)), false);
    assert.equal(existsSync(executorResultPath(dir, nextJob.request_id, nextAttempt)), false);
    assert.equal(existsSync(join(dir, 'requests', `${nextJob.request_id}-${nextAttempt}.json`)), true);
    assert.equal(existsSync(join(dir, 'claims', `${nextJob.request_id}-${nextAttempt}.json`)), false);
    assert.ok(readdirSync(join(dir, 'locks')).some(name => name.startsWith('executor.stale-')));
    assert.equal(existsSync(join(dir, 'locks', 'executor.active')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('executor keeps a same-boot stale model-running lock fail-closed and releases only known pre-model state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-codex-stale-lock-'));
  try {
    const locks = join(dir, 'locks');
    mkdirSync(locks);
    const activePath = join(locks, 'executor.active');
    const writeLock = phase => writeFileSync(activePath, JSON.stringify({ schema: 1,
      pid: 5002, started_at: new Date().toISOString(), boot_uptime_seconds: 100,
      phase, request_id: null, attempt_id: null }));

    writeLock('MODEL_RUNNING');
    await assert.rejects(runExecutorOnce({ spool_dir: dir }, { uptimeSeconds: () => 120,
      isProcessAlive: () => false }), /EXECUTOR_LOCK_STALE_MODEL_EFFECTS_UNKNOWN/);
    assert.equal(existsSync(activePath), true, 'unknown model effects keep the lock intact');

    rmSync(activePath);
    writeLock('DISPATCHER');
    const idle = await runExecutorOnce({ spool_dir: dir }, { uptimeSeconds: () => 120,
      isProcessAlive: () => false });
    assert.equal(idle.state, 'IDLE');
    assert.equal(existsSync(activePath), false);
    assert.ok(readdirSync(locks).some(name => name.startsWith('executor.stale-')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('executor recovers an uncertain same-boot lock only after process-tree readback proves absence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-codex-tree-readback-'));
  try {
    const locks = join(dir, 'locks');
    mkdirSync(locks);
    const activePath = join(locks, 'executor.active');
    const writeLock = modelPid => writeFileSync(activePath, JSON.stringify({ schema: 1,
      pid: 5003, started_at: new Date().toISOString(), boot_uptime_seconds: 100,
      phase: 'MODEL_TERMINATION_UNCONFIRMED', request_id: 'PTYSD_CODEX_TREE_RECOVERY',
      attempt_id: '00000000-0000-0000-0000-000000000094', model_pid: modelPid }));

    writeLock(5004);
    await assert.rejects(runExecutorOnce({ spool_dir: dir }, { uptimeSeconds: () => 120,
      isProcessAlive: () => false, readProcessTree: () => ({ root_pid: 5004,
        state: 'ALIVE', process_ids: [5004, 5005] }) }),
    /EXECUTOR_LOCK_MODEL_TREE_UNKNOWN/);
    assert.equal(existsSync(activePath), true, 'a live descendant keeps the shared conflict lock');

    await assert.rejects(runExecutorOnce({ spool_dir: dir }, { uptimeSeconds: () => 120,
      isProcessAlive: () => false, readProcessTree: () => ({ root_pid: 5004,
        state: 'UNKNOWN', process_ids: [] }) }),
    /EXECUTOR_LOCK_MODEL_TREE_UNKNOWN/);
    assert.equal(existsSync(activePath), true, 'an unavailable OS readback keeps the lock');

    const recovered = await runExecutorOnce({ spool_dir: dir }, { uptimeSeconds: () => 120,
      isProcessAlive: () => false, readProcessTree: () => ({ root_pid: 5004,
        state: 'DEAD', process_ids: [] }) });
    assert.equal(recovered.state, 'IDLE');
    assert.equal(existsSync(activePath), false, 'only a negative process-tree readback releases the lock');
    assert.ok(readdirSync(locks).some(name => name.startsWith('executor.stale-')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Windows CIM readback retains a live model process tree and clears an absent one', {
  skip: process.platform !== 'win32',
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-codex-win32-tree-readback-'));
  try {
    const locks = join(dir, 'locks');
    mkdirSync(locks);
    const activePath = join(locks, 'executor.active');
    const writeLock = modelPid => writeFileSync(activePath, JSON.stringify({ schema: 1,
      pid: 5006, started_at: new Date().toISOString(), boot_uptime_seconds: 100,
      phase: 'MODEL_TERMINATION_UNCONFIRMED', request_id: 'PTYSD_CODEX_WIN32_TREE_READBACK',
      attempt_id: '00000000-0000-0000-0000-000000000095', model_pid: modelPid }));

    writeLock(process.pid);
    await assert.rejects(runExecutorOnce({ spool_dir: dir }, { uptimeSeconds: () => 120,
      isProcessAlive: () => false }), /EXECUTOR_LOCK_MODEL_TREE_UNKNOWN/);
    assert.equal(existsSync(activePath), true, 'Win32 CIM sees this live Node process');

    writeLock(2147483000);
    const recovered = await runExecutorOnce({ spool_dir: dir }, { uptimeSeconds: () => 120,
      isProcessAlive: () => false });
    assert.equal(recovered.state, 'IDLE');
    assert.equal(existsSync(activePath), false,
      'a successful native snapshot with no matching PID tree permits recovery');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Codex output storage failure with unconfirmed tree termination remains a recoverable blocked result', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-codex-storage-orphan-'));
  try {
    const spec = '# Synthetic output-storage failure; no Codex model is started.\n';
    const bundle = join(dir, 'source.bundle');
    writeFileSync(bundle, 'synthetic immutable source bundle');
    const picked = job({ spec_sha256: createHash('sha256').update(spec).digest('hex') });
    const request = makeCodexExecutorRequest(picked, '00000000-0000-0000-0000-000000000096', spec,
      bundle, createHash('sha256').update(readFileSync(bundle)).digest('hex'));
    const evidenceDir = join(dir, 'evidence');
    mkdirSync(evidenceDir);
    const stdoutPath = join(evidenceDir, `${picked.request_id}-${request.attempt_id}.stdout.jsonl`);
    mkdirSync(stdoutPath);

    const result = await runCodex(request, { codex_executable: process.execPath }, dir, evidenceDir, {
      environment: {},
      spawnProcess: () => {
        const child = new EventEmitter();
        child.pid = 12345;
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        queueMicrotask(() => {
          child.emit('spawn');
          child.stdout.end('{"type":"thread.started","thread_id":"synthetic"}\n');
          child.stderr.end('');
          child.emit('close', 0, null);
        });
        return child;
      },
      terminate: () => ({ rootOnly: true, error: 'TASKKILL_TREE_FAILED' }),
    });

    assert.equal(result.outcome, 'CODEX_PROCESS_TERMINATION_FAILED');
    assert.equal(result.termination_state, 'ORPHAN_POSSIBLE');
    assert.equal(result.termination_error, 'TASKKILL_TREE_FAILED');
    assert.ok(result.storage_error, 'preserve the output-storage failure alongside termination uncertainty');
    assert.equal(result.session_id, null, 'unreadable output cannot prove a session or model activity');
    assert.equal(result.provider_usage_evidence, 'UNKNOWN');
    assert.equal(result.model_activity_evidence, 'UNKNOWN');
    assert.equal(result.model_invoked, false);
    assert.equal(terminalStateForResult(result), 'BLOCKED');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Codex result scope is recomputed against the immutable request before receipt publication', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-codex-result-scope-'));
  try {
    const spool = join(dir, 'spool');
    for (const name of ['requests', 'bundles', 'claims', 'locks', 'results'])
      mkdirSync(join(spool, name), { recursive: true });
    const spec = '# Exact source scope\n';
    const picked = job({ request_id: 'PTYSD_CODEX_SCOPE_RECONCILE_20261017',
      spec_sha256: createHash('sha256').update(spec).digest('hex'),
      write_paths: ['native-bridge/worker.mjs'] });
    const attemptId = '22222222-2222-4222-8222-222222222222';
    const bundlePath = join(spool, 'bundles', 'source.bundle');
    writeFileSync(bundlePath, 'immutable source bundle');
    const request = makeCodexExecutorRequest(picked, attemptId, spec, bundlePath,
      createHash('sha256').update(readFileSync(bundlePath)).digest('hex'));
    writeFileSync(join(spool, 'requests', `${picked.request_id}-${attemptId}.json`),
      JSON.stringify(request));
    const started = { schema: 1, project_id: picked.project_id, host: picked.host,
      request_id: picked.request_id, attempt_id: attemptId, state: 'STARTED', kind: 'codex_plan',
      source_sha: picked.source_sha, model: picked.model, reasoning_effort: picked.reasoning_effort,
      task_fingerprint: request.fingerprint };
    const resultPath = executorResultPath(spool, picked.request_id, attemptId);
    const result = { schema: 1, kind: 'codex_plan', request_id: picked.request_id,
      attempt_id: attemptId, source_sha: picked.source_sha, exit_code: 0,
      fingerprint: request.fingerprint, session_id: 'session_12345678', diff_sha256: null,
      stdout_sha256: taskHash, stderr_sha256: taskHash, outcome: 'CODEX_CLI_EXIT_0_UNVERIFIED',
      model_invoked: true, changed_paths: ['package.json'], out_of_scope_paths: [],
      pr_url: null, tests: 'NOT_RUN' };
    writeFileSync(resultPath, JSON.stringify(result));
    const receipts = [];
    const rejected = await reconcileCodexExecutorResult(started, { codex_spool: spool }, worker,
      new Set(), { writeReceiptOnce: async (_config, value) => receipts.push(value) });
    assert.deepEqual(rejected, { status: 'UNKNOWN_NO_REPLAY', reason: 'CODEX_RESULT_SCOPE_MISMATCH' });
    assert.deepEqual(receipts, [], 'a self-reported empty out-of-scope list cannot publish a receipt');

    const accurate = { ...result, outcome: 'WRITE_SCOPE_VIOLATION',
      out_of_scope_paths: ['package.json'] };
    writeFileSync(resultPath, JSON.stringify(accurate));
    const recovered = await reconcileCodexExecutorResult(started, { codex_spool: spool }, worker,
      new Set(), { writeReceiptOnce: async (_config, value) => receipts.push(value) });
    assert.deepEqual(recovered, { status: 'RECOVERED' });
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].state, 'BLOCKED');
    assert.equal(receipts[0].outcome, 'WRITE_SCOPE_VIOLATION');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
