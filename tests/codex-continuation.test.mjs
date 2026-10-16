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
  CODEX_JOB_KEYS, NATIVE_JOB_MARKER, parseCodexJob, parseCodexReceipt,
  codexExecutionGate, codexTaskFingerprint, claimCodexAttempt,
  codexExecutorTaskArguments, validateCodexExecutorTaskXml, assertCodexExecutorTaskReady,
  releaseCodexAttempt,
  buildCodexExecArgs, codexSessionFromJsonl, codexRunOutcome,
  makeCodexExecutorRequest, publishCodexExecutorRequest, validateCodexExecutorRequest,
  executorResultPath, validateCodexExecutorResult,
} from '../native-bridge/codex-continuation.mjs';
import { buildCodexChildEnvironment, changedPaths, outOfScopeCodexPaths, runCodex, runExecutorOnce, takeNextRequest,
} from '../native-bridge/codex-executor.mjs';
import { readWindowsProcessTree, runCapturedProcess, terminateProcessTree } from '../native-bridge/captured-process.mjs';
import { codexTerminalReceipt, dispatchCodexJob, selectNext, selectNextWithCodexClaim,
  reconcileCodexExecutorResult, terminalStateForResult, writeCodexReceiptOnce } from '../native-bridge/worker.mjs';

const sha = 'a'.repeat(40);
const taskHash = 'b'.repeat(64);
const RECEIPT_MARKER = 'PTYSD_NATIVE_RECEIPT_V1\n';
const worker = 'ptyworker';
const author = 't14210184';

test('shared taskkill failure fallback keeps a live descendant process tree unresolved', () => {
  const calls = [];
  const child = { pid: 4321, kill() { calls.push('child.kill'); } };
  const result = terminateProcessTree(child, {
    platformName: 'win32',
    runTaskkill: (command, args, options) => {
      calls.push('taskkill');
      assert.equal(command, 'taskkill.exe');
      assert.deepEqual(args, ['/PID', '4321', '/T', '/F']);
      assert.equal(options.windowsHide, true);
      const error = new Error('synthetic taskkill access denied');
      error.code = 'EACCES';
      throw error;
    },
    readProcessTree: pid => {
      calls.push('process-tree-readback');
      assert.equal(pid, 4321);
      return { state: 'ALIVE', root_pid: pid, process_ids: [pid, 9876] };
    },
  });
  assert.deepEqual(calls, ['taskkill', 'child.kill', 'process-tree-readback']);
  assert.deepEqual(result, { rootOnly: true, processTreeState: 'ALIVE', error: 'TASKKILL_TREE_FAILED' });
});

test('capture retries tree termination when output storage fails before child spawn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-capture-pre-spawn-storage-error-'));
  try {
    const child = new EventEmitter();
    child.pid = undefined;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    const terminatePids = [];
    const run = runCapturedProcess('synthetic-child.exe', [], {
      cwd: dir, env: {},
      stdoutPath: join(dir, 'missing-parent', 'stdout.bin'),
      stderrPath: join(dir, 'stderr.bin'),
      spawnProcess: () => {
        setTimeout(() => {
          child.pid = 13579;
          child.emit('spawn');
          child.stdout.end('partial stdout');
          child.stderr.end('partial stderr');
        }, 100);
        return child;
      },
      terminate: process => {
        terminatePids.push(process.pid ?? null);
        if (!Number.isSafeInteger(process.pid))
          return { processTreeState: 'UNKNOWN', error: 'PROCESS_PID_UNAVAILABLE' };
        process.emit('close', 143, 'SIGTERM');
        return { treeConfirmed: true, processTreeState: 'DEAD' };
      },
    });
    const timeout = Symbol('capture timed out before process termination');
    let timeoutHandle;
    const winner = await Promise.race([run, new Promise(resolve => {
      timeoutHandle = setTimeout(() => resolve(timeout), 500);
    })]);
    clearTimeout(timeoutHandle);
    if (winner === timeout) child.emit('close', 143, 'SIGTERM');
    const result = await run;
    assert.notEqual(winner, timeout, 'storage failure must terminate after the PID becomes available');
    assert.deepEqual(terminatePids, [13579]);
    assert.equal(result.local_evidence.storage_error, 'ENOENT');
    assert.equal(result.local_evidence.termination_state, 'TERMINATION_CONFIRMED');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Codex output persistence failure uses the real hidden tree terminator and preserves unresolved process evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-codex-tree-kill-wiring-'));
  try {
    const spec = '# Synthetic storage failure; no model process is started.\n';
    const bundlePath = join(dir, 'source.bundle');
    writeFileSync(bundlePath, 'synthetic immutable bundle');
    const picked = job({ request_id: 'PTYSD_CODEX_TREE_KILL_WIRING_20261016',
      spec_sha256: createHash('sha256').update(spec).digest('hex') });
    const attemptId = '00000000-0000-0000-0000-000000000093';
    const request = makeCodexExecutorRequest(picked, attemptId, spec, bundlePath,
      createHash('sha256').update(readFileSync(bundlePath)).digest('hex'));
    const evidenceDir = join(dir, 'evidence');
    mkdirSync(evidenceDir);
    const stdoutPath = join(evidenceDir, `${picked.request_id}-${attemptId}.stdout.jsonl`);
    writeFileSync(stdoutPath, '', { flag: 'wx' });

    const child = new EventEmitter();
    child.pid = 54321;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    let rootKillCalls = 0, taskkillCalls = 0, treeReadbacks = 0;
    child.kill = () => { rootKillCalls++; };
    const spawnProcess = (_command, _args, options) => {
      assert.equal(options.shell, false);
      assert.equal(options.windowsHide, true);
      child.stdin.once('finish', () => setImmediate(() => child.emit('close', 0, null)));
      setImmediate(() => {
        child.emit('spawn');
        child.stdout.end('');
        child.stderr.end('');
      });
      return child;
    };
    const result = await runCodex(request, { codex_executable: 'C:\\OpenCode\\codex.exe' },
      dir, evidenceDir, {
        environment: {}, spawnProcess,
        runTaskkill(command, args, options) {
          taskkillCalls++;
          assert.equal(command, 'taskkill.exe');
          assert.deepEqual(args, ['/PID', '54321', '/T', '/F']);
          assert.equal(options.windowsHide, true);
          const error = new Error('synthetic taskkill access denied');
          error.code = 'EACCES';
          throw error;
        },
        readProcessTree(pid) {
          treeReadbacks++;
          return { state: 'ALIVE', root_pid: pid, process_ids: [pid, 65432],
            observed_at: '2026-10-16T00:00:00.000Z' };
        },
        platformName: 'win32',
      });

    assert.equal(taskkillCalls, 1);
    assert.equal(rootKillCalls, 1);
    assert.equal(treeReadbacks, 1);
    assert.equal(result.storage_error, 'EEXIST');
    assert.equal(result.termination_state, 'ORPHAN_POSSIBLE');
    assert.equal(result.process_tree_state, 'ALIVE');
    assert.equal(result.outcome, 'CODEX_PROCESS_TERMINATION_FAILED');
    assert.equal(result.model_invoked, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

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

test('empty Codex executor poll exits IDLE without reading identity, authorization, GitHub, or launching a model', async () => {
  const dir=mkdtempSync(join(tmpdir(),'pty-codex-idle-no-model-'));
  const calls=[];
  try {
    const deps={uptimeSeconds:()=>120,
      qualifyCodex:async()=>{calls.push('qualifyCodex');throw new Error('MUST_NOT_QUALIFY_EMPTY_QUEUE');},
      runCodex:async()=>{calls.push('runCodex');throw new Error('MUST_NOT_RUN_EMPTY_QUEUE');},
      triggerExecutor:async()=>{calls.push('triggerExecutor');throw new Error('MUST_NOT_TRIGGER_EMPTY_QUEUE');},
      readGitHub:async()=>{calls.push('readGitHub');throw new Error('MUST_NOT_READ_GITHUB_FROM_EXECUTOR_IDLE');},
      writeReceiptOnce:async()=>{calls.push('writeReceiptOnce');throw new Error('MUST_NOT_WRITE_RECEIPT_EMPTY_QUEUE');}};
    Object.defineProperty(deps,'currentSid',{get(){calls.push('currentSid');return 'S-1-5-21-test';}});
    Object.defineProperty(deps,'environment',{get(){calls.push('environment');return {};}});
    const result=await runExecutorOnce({spool_dir:dir},deps);
    assert.deepEqual(result,{state:'IDLE',model_invoked:false});
    assert.deepEqual(calls,[],'empty queue must return before identity/auth/API/provider execution');
    assert.equal(existsSync(join(dir,'requests')),false,'idle poll does not create a request queue');
    assert.equal(existsSync(join(dir,'claims')),false,'idle poll does not create claim state');
    assert.deepEqual(readdirSync(join(dir,'locks')),[],'idle invocation leaves no active lock');
    assert.equal(existsSync(join(dir,'evidence')),false);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

function codexTaskXml(config, overrides = {}) {
  const values = {
    uri: '\\PTYSD-Codex-Executor', user: config.executor_identity_sid,
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
    executor_sid: config.executor_identity_sid,
    run_level: 'LeastPrivilege', logon_type: 'Password', execution_time_limit: 'PT0S',
    allow_hard_terminate: false, multiple_instances: 'IgnoreNew',
  });
  assert.throws(() => validateCodexExecutorTaskXml(codexTaskXml(config, {
    user: config.codex_executor_task_user,
  }), config), /CODEX_EXECUTOR_TASK/,
  'a matching account-name string does not prove that Task Scheduler runs as the configured executor SID');
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

test('executor scope inventory includes committed changes from source and ignored untracked files', async () => {
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

    assert.deepEqual(await changedPaths(dir, sourceSha), [
      'committed-out-of-scope.mjs', 'private.generated',
    ]);
    await assert.rejects(changedPaths(dir, 'not-a-source-sha'), /WORKSPACE_SOURCE_SHA_INVALID/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Codex changed-path inventory streams more than the former 16 MiB buffer without truncation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-codex-large-path-stream-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8', windowsHide: true, shell: false,
  }).trim();
  try {
    git('init', '-q');
    git('config', 'user.name', 'PTYSD test');
    git('config', 'user.email', 'ptysd-test@example.invalid');
    writeFileSync(join(dir, 'base.txt'), 'baseline\n');
    git('add', 'base.txt');
    git('commit', '-q', '-m', 'baseline');
    const sourceSha = git('rev-parse', 'HEAD');
    const repeatedPath = Buffer.from('README.md\0'.repeat(8192));
    const splitAt = 65_537;
    const repeatCount = Math.ceil((16 * 1024 * 1024 + 1) / repeatedPath.length);
    let commandCount = 0;
    const spawnProcess = (command, args, options) => {
      assert.equal(command, 'git');
      assert.equal(options.shell, false);
      assert.equal(options.windowsHide, true);
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      const isDiff = args.includes('diff');
      commandCount++;
      setImmediate(() => {
        void (async () => {
          const stdoutEnded = new Promise(resolve => child.stdout.once('end', resolve));
          const stderrEnded = new Promise(resolve => child.stderr.once('end', resolve));
          if (isDiff) {
            for (let index = 0; index < repeatCount; index++) {
              for (const chunk of [repeatedPath.subarray(0, splitAt), repeatedPath.subarray(splitAt)]) {
                if (!child.stdout.write(chunk))
                  await new Promise(resolve => child.stdout.once('drain', resolve));
              }
            }
          }
          child.stdout.end();
          child.stderr.end();
          await Promise.all([stdoutEnded, stderrEnded]);
          child.emit('close', 0, null);
        })().catch(error => child.emit('error', error));
      });
      return child;
    };

    assert.deepEqual(await changedPaths(dir, sourceSha, { spawnProcess }), ['README.md']);
    assert.equal(commandCount, 2, 'tracked and untracked inventories both complete');
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
    job({ write_paths: ['native-bridge/invalid?.mjs'] }),
    job({ write_paths: ['governance/canonical.json'] }),
    job({ write_paths: ['.git/config'] }),
    job({ write_paths: ['.github/workflows/release.yml'] }),
    job({ write_paths: ['.github/actions/credential-step/action.yml'] }),
    job({ write_paths: ['.GITHUB/ACTIONS/credential-step/action.yml'] }),
    job({ write_paths: ['.env'] }),
    job({ write_paths: ['.env.local'] }),
    job({ write_paths: ['native-bridge/opencode.jsonc'] }),
    job({ write_paths: ['src/provider-token.json'] }),
    job({ write_paths: ['src/credentials.json'] }),
    job({ write_paths: ['src/auth.json'] }),
    job({ write_paths: ['native-bridge/csg-trusted-pr-verifier.mjs'] }),
    job({ write_paths: ['native-bridge/csg-trusted-pr-verifier-cli.mjs'] }),
    job({ write_paths: ['native-bridge/install.ps1'] }),
    job({ write_paths: ['native-bridge/install-codex-executor.ps1'] }),
    job({ write_paths: ['native-bridge/HiddenWorker.vbs'] }),
    job({ write_paths: ['native-bridge/HiddenCodexExecutor.vbs'] }),
    job({ write_paths: ['native-bridge/windows-executor.mjs'] }),
    job({ write_paths: ['native-bridge/sample.mjs', 'native-bridge/sample.mjs'] }),
    job({ model: 'https://untrusted.example/model' }),
    job({ reasoning_effort: '' }),
    job({ reasoning_effort: '   ' }),
    job({ reasoning_effort: null }),
    job({ reasoning_effort: 'high\nadditional_config="injected"' }),
  ]) assert.equal(parseCodexJob(body(invalid)), null);
  const caseAliases=job({write_paths:['native-bridge/worker.mjs','NATIVE-BRIDGE/WORKER.MJS']});
  if (process.platform === 'win32') assert.equal(parseCodexJob(body(caseAliases)),null,
    'NTFS-equivalent write paths cannot create two spellings for one allowed file');
  else assert.ok(parseCodexJob(body(caseAliases)),
    'case-distinct paths remain distinct on case-sensitive source hosts');
  if (process.platform === 'win32') {
    for (const path of ['native-bridge/CON.txt', 'native-bridge/trailing./file.mjs',
      'native-bridge/trailing /file.mjs'])
      assert.equal(parseCodexJob(body(job({ write_paths: [path] }))), null,
        'Win32 aliases cannot be represented as distinct writable paths');
    assert.deepEqual(outOfScopeCodexPaths(['NATIVE-BRIDGE/WORKER.MJS'], ['native-bridge/worker.mjs']), [],
      'scope readback uses the same NTFS path identity as request validation');
  } else {
    assert.deepEqual(outOfScopeCodexPaths(['NATIVE-BRIDGE/WORKER.MJS'], ['native-bridge/worker.mjs']),
      ['NATIVE-BRIDGE/WORKER.MJS'], 'case-distinct paths stay distinct on case-sensitive hosts');
  }
  for (const reasoning_effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    assert.ok(parseCodexJob(body(job({ reasoning_effort }))), reasoning_effort);
  assert.ok(parseCodexJob(body(job({ write_paths: ['native-bridge/worker.mjs'] }))),
    'ordinary native bridge source remains individually scopeable');
  assert.ok(parseCodexJob(body(job({ write_paths: ['native-bridge/codex-executor-install-state.psm1'] }))),
    'the removed private installer-state module is not retained as a permanent path ban');
  assert.ok(parseCodexJob(body(job({ write_paths: ['native-bridge/tokenizer.mjs'] }))),
    'a source filename containing the word tokenizer is not a credential file');
  assert.ok(parseCodexJob(body(job({ write_paths: ['.github/ISSUE_TEMPLATE/bug_report.yml'] }))));
  const longRepoPath = `native-bridge/${'x'.repeat(170)}.mjs`;
  assert.ok(longRepoPath.length > 180);
  assert.ok(parseCodexJob(body(job({ write_paths: [longRepoPath] }))),
    'a valid repository path is not rejected by a fixed path-character ceiling');
  assert.ok(parseCodexJob(body(job({ write_paths: Array.from({ length: 33 }, (_, index) =>
    `native-bridge/reviewed-${index}.mjs`) }))),
  'an exact scoped path set is not restricted by the former arbitrary 32-path ceiling');
  const broadPaths = Array.from({ length: 80 }, (_, index) =>
    `native-bridge/reviewed-${String(index).padStart(3, '0')}-${'x'.repeat(90)}.mjs`);
  const broadBody = body(job({ write_paths: broadPaths }));
  assert.ok(broadBody.length > 6000, 'regression fixture exceeds the former parser body ceiling');
  assert.ok(parseCodexJob(broadBody), 'valid exact scopes are not rejected by a smaller local body ceiling');
  assert.equal(selectNext([comment(3, broadBody)], [author], worker, job().host, sha)
    .job.write_paths.length, broadPaths.length, 'the dispatcher can select the full reviewed scope');
  const broadReceipt = RECEIPT_MARKER + JSON.stringify({ schema: 1,
    project_id: 'CHATGPT_GLOBAL_SKILL_GOVERNANCE', host: job().host,
    request_id: job().request_id, attempt_id: '00000000-0000-0000-0000-000000000001',
    state: 'FINISHED', kind: 'codex_plan', source_sha: sha, changed_paths: broadPaths });
  assert.ok(broadReceipt.length > 8000, 'regression fixture exceeds the former receipt body ceiling');
  assert.ok(parseCodexReceipt(broadReceipt), 'a valid receipt is not rejected by a local serialized-size ceiling');
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

test('reasoning effort is authorized per exact model instead of a global fixed vocabulary', () => {
  const maxEffortJob = job({ reasoning_effort: 'max' });
  assert.ok(parseCodexJob(body(maxEffortJob)), 'provider-supported effort values parse structurally');
  assert.equal(codexExecutionGate(maxEffortJob, readyConfig({
    allowed_codex_models: { 'gpt-6.1-sol': ['max'] },
  })).allowed, true, 'the exact model-specific allowlist authorizes the selected effort');
  assert.equal(codexExecutionGate(maxEffortJob, readyConfig()).allowed, false,
    'parsing does not authorize an effort omitted from the model-specific allowlist');

  const unknownEffortJob = job({ reasoning_effort: 'future-provider-effort' });
  assert.ok(parseCodexJob(body(unknownEffortJob)), 'the parser does not invent a global provider vocabulary');
  assert.equal(codexExecutionGate(unknownEffortJob, readyConfig()).allowed, false,
    'unadvertised effort remains blocked by exact model authorization');
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
      codex_sandbox_boundary: 'UNKNOWN' });
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

test('executor does not claim or write a terminal receipt when the live executor SID is wrong', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-codex-wrong-sid-'));
  try {
    const spec = '# Wrong identity must not consume this request\n';
    const bundle = join(dir, 'source.bundle');
    writeFileSync(bundle, 'synthetic bundle');
    const picked = job({ request_id: 'PTYSD_CODEX_WRONG_SID_20261016',
      spec_sha256: createHash('sha256').update(spec).digest('hex') });
    const attemptId = '00000000-0000-0000-0000-000000000124';
    const request = makeCodexExecutorRequest(picked, attemptId, spec, bundle,
      createHash('sha256').update(readFileSync(bundle)).digest('hex'));
    publishCodexExecutorRequest(dir, request);

    const config = readyConfig({ enable_codex_model_runs: false, codex_usage_authorized: false });
    Object.assign(config, { spool_dir: dir, workspace_root: join(dir, 'workspaces'),
      codex_executable: join(dir, 'codex.exe') });
    const wrongIdentity = await runExecutorOnce(config, {
      currentSid: 'S-1-5-21-WRONG', environment: {},
    });
    assert.deepEqual(wrongIdentity, { state: 'WAITING',
      reasons: ['EXECUTOR_SID_MISMATCH'], model_invoked: false });
    assert.equal(existsSync(join(dir, 'claims')), false,
      'a mismatched OS identity must not create an attempt claim');
    assert.equal(existsSync(executorResultPath(dir, picked.request_id, attemptId)), false,
      'a mismatched OS identity must not consume the request with a terminal receipt');

    const correctIdentity = await runExecutorOnce(config, {
      currentSid: config.executor_identity_sid, environment: {},
    });
    assert.equal(correctIdentity.state, 'BLOCKED',
      'the same request remains available for re-evaluation by the configured identity');
    assert.equal(correctIdentity.model_invoked, false);
    assert.equal(existsSync(join(dir, 'claims', `${picked.request_id}-${attemptId}.json`)), true);
    assert.equal(existsSync(executorResultPath(dir, picked.request_id, attemptId)), true);
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
    });
    config.spool_dir = dir;
    config.workspace_root = join(dir, 'workspaces');
    config.codex_executable = join(dir, 'codex.exe');
    const executorDependencies = { environment: {} };
    Object.defineProperty(executorDependencies, 'currentSid', { get() {
      const claimsPath = join(dir, 'claims');
      assert.equal(existsSync(claimsPath) ? readdirSync(claimsPath).length : 0, 0,
        'executor identity must be checked before any request is claimed');
      return config.executor_identity_sid;
    } });
    const result = await runExecutorOnce(config, executorDependencies);
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

    async function execute({ rejectInput = false, spawnFailure = false, termination,
      output = `${JSON.stringify({ type: 'thread.started', thread_id: 'thread_test_123' })}\n` }) {
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
          child.stdout.end(rejectInput ? '' : output);
          child.stderr.end('');
        });
        return child;
      };
      const taskEvidenceDir = join(evidenceDir, `capture-${++captureIndex}`);
      mkdirSync(taskEvidenceDir);
      const result = await runCodex(request, { codex_executable: 'C:\\codex.exe' }, dir, taskEvidenceDir, {
        environment: {}, spawnProcess, terminate: () => termination,
        readProcessTree: pid => ({ state: termination?.rootOnly ? 'ALIVE' : 'DEAD',
          root_pid: pid, process_ids: termination?.rootOnly ? [pid] : [], observed_at: new Date().toISOString() }),
      });
      return { result, delivered };
    }

    const good = await execute({ rejectInput: false, termination: { treeConfirmed: true } });
    const expectedStdout = `${JSON.stringify({ type: 'thread.started', thread_id: 'thread_test_123' })}\n`;
    assert.equal(good.delivered, spec);
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
      'thread.started proves a session, not provider inference');
    assert.equal(good.result.tool_execution_evidence, 'UNKNOWN');
    assert.equal(good.result.tool_execution_count, 0);
    assert.equal(good.result.model_invoked, false);
    assert.equal(good.result.process_tree_state, 'DEAD');

    const inferenceEvents = [
      { type: 'thread.started', thread_id: 'thread_test_123' },
      { type: 'item.completed', item: { id: 'cmd-1', type: 'command_execution' } },
      { type: 'item.started', item: { id: 'patch-1', type: 'file_change',
        changes: [{ path: 'src/worker.mjs', kind: 'update' }], status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'patch-1', type: 'file_change',
        changes: [{ path: 'src/worker.mjs', kind: 'update' }], status: 'completed' } },
      { type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 4,
        cached_input_tokens: 0, reasoning_output_tokens: 0 } },
    ].map(event => JSON.stringify(event)).join('\n') + '\n';
    const inferred = await execute({ rejectInput: false, termination: { treeConfirmed: true },
      output: inferenceEvents });
    assert.equal(inferred.result.session_started, true);
    assert.equal(inferred.result.provider_usage_evidence, 'CONFIRMED');
    assert.equal(inferred.result.model_activity_evidence, 'CONFIRMED');
    assert.equal(inferred.result.model_invoked, true);
    assert.equal(inferred.result.tool_execution_evidence, 'OBSERVED');
    assert.equal(inferred.result.tool_execution_count, 2,
      'aggregate tool execution count includes the completed command and file-change event');
    assert.equal(inferred.result.file_change_tool_evidence, 'COMPLETED',
      'a completed Codex file_change event is separate evidence from command execution');
    assert.equal(inferred.result.file_change_tool_completed_count, 1);
    assert.equal(inferred.result.file_change_tool_failed_count, 0);
    assert.equal(inferred.result.file_change_tool_incomplete_count, 0);
    assert.equal(inferred.result.process_tree_state, 'DEAD');

    const incompleteFileChange = await execute({ rejectInput: false,
      termination: { treeConfirmed: true }, output: `${JSON.stringify({
        type: 'item.started', item: { id: 'patch-open', type: 'file_change',
          changes: [{ path: 'src/worker.mjs', kind: 'update' }], status: 'in_progress' },
      })}\n` });
    assert.equal(incompleteFileChange.result.file_change_tool_evidence, 'INCOMPLETE',
      'a started patch without item.completed is not evidence of a completed tool write');
    assert.equal(incompleteFileChange.result.file_change_tool_completed_count, 0);
    assert.equal(incompleteFileChange.result.model_activity_evidence, 'UNKNOWN');

    const fileChangeOnly = await execute({ rejectInput: false,
      termination: { treeConfirmed: true }, output: [
        { type: 'thread.started', thread_id: 'thread_test_123' },
        { type: 'item.started', item: { id: 'patch-only', type: 'file_change',
          changes: [{ path: 'src/worker.mjs', kind: 'update' }], status: 'in_progress' } },
        { type: 'item.completed', item: { id: 'patch-only', type: 'file_change',
          changes: [{ path: 'src/worker.mjs', kind: 'update' }], status: 'completed' } },
        { type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 2,
          cached_input_tokens: 0, reasoning_output_tokens: 0 } },
      ].map(event => JSON.stringify(event)).join('\n') + '\n' });
    assert.equal(fileChangeOnly.result.tool_execution_evidence, 'OBSERVED',
      'the native file_change tool is execution evidence even when no shell command ran');
    assert.equal(fileChangeOnly.result.tool_execution_count, 1);
    assert.equal(fileChangeOnly.result.file_change_tool_evidence, 'COMPLETED');
    assert.equal(fileChangeOnly.result.model_activity_evidence, 'CONFIRMED');

    const failedFileChange = await execute({ rejectInput: false,
      termination: { treeConfirmed: true }, output: `${JSON.stringify({
        type: 'item.completed', item: { id: 'patch-failed', type: 'file_change',
          changes: [{ path: 'src/worker.mjs', kind: 'update' }], status: 'failed' },
      })}\n` });
    assert.equal(failedFileChange.result.file_change_tool_evidence, 'FAILED');
    assert.equal(failedFileChange.result.file_change_tool_failed_count, 1);
    assert.equal(failedFileChange.result.file_change_tool_completed_count, 0);

    const failed = await execute({ rejectInput: true,
      termination: { rootOnly: true, error: 'TASKKILL_TREE_FAILED' } });
    assert.equal(failed.result.exit_code, 0, 'preserve the child close code as independent evidence');
    assert.equal(failed.result.input_error, 'EPIPE');
    assert.equal(failed.result.termination_state, 'ORPHAN_POSSIBLE');
    assert.equal(failed.result.outcome, 'CODEX_PROCESS_TERMINATION_FAILED');
    assert.equal(failed.result.session_id, null);
    assert.equal(failed.result.model_invoked, false, 'input failure before session evidence is not a model invocation');
    assert.equal(failed.result.process_tree_state, 'ALIVE');

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
    assert.equal(recovered.state, 'BLOCKED');
    assert.equal(recovered.model_invoked, false);
    assert.equal(existsSync(join(dir, 'claims', `${oldJob.request_id}-${oldAttempt}.json`)), true);
    assert.equal(existsSync(executorResultPath(dir, oldJob.request_id, oldAttempt)), false);
    assert.equal(existsSync(executorResultPath(dir, nextJob.request_id, nextAttempt)), true);
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
    currentSid: 'S-1-5-21-test', isProcessAlive: () => false }), /EXECUTOR_PROCESS_TREE_IDENTITY_UNKNOWN/);
    assert.equal(existsSync(activePath), true, 'unknown model effects keep the lock intact');

    rmSync(activePath);
    writeLock('DISPATCHER');
    const idle = await runExecutorOnce({ spool_dir: dir }, { uptimeSeconds: () => 120,
    currentSid: 'S-1-5-21-test', isProcessAlive: () => false });
    assert.equal(idle.state, 'IDLE');
    assert.equal(existsSync(activePath), false);
    assert.ok(readdirSync(locks).some(name => name.startsWith('executor.stale-')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('same-boot model lock stays held until an exact OS process-tree readback confirms death', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-codex-tree-lock-'));
  try {
    const locks = join(dir, 'locks');
    mkdirSync(locks);
    const activePath = join(locks, 'executor.active');
    const lock = { schema: 1, pid: 5003, child_pid: 6003,
      started_at: new Date().toISOString(), boot_uptime_seconds: 100,
      phase: 'MODEL_RUNNING', request_id: 'PTYSD_CODEX_TREE_LOCK_20261015',
      attempt_id: '11111111-1111-4111-8111-111111111114' };
    writeFileSync(activePath, JSON.stringify(lock));
    const baseDeps = { uptimeSeconds: () => 120, currentSid: 'S-1-5-21-test',
      isProcessAlive: () => false };
    await assert.rejects(runExecutorOnce({ spool_dir: dir }, { ...baseDeps,
      readProcessTree: pid => ({ state: 'ALIVE', root_pid: pid, process_ids: [pid] }) }),
    /EXECUTOR_PROCESS_TREE_STILL_ACTIVE/);
    assert.deepEqual(JSON.parse(readFileSync(activePath, 'utf8')), lock,
      'an alive child preserves the exact conflict lock and attempt identity');

    assert.deepEqual(await runExecutorOnce({ spool_dir: dir }, { ...baseDeps,
      readProcessTree: pid => ({ state: 'DEAD', root_pid: pid, process_ids: [],
        observed_at: '2026-10-15T00:00:00.000Z' }) }), { state: 'IDLE', model_invoked: false });
    assert.equal(existsSync(activePath), false);
    const archivedName = readdirSync(locks).find(name => name.startsWith('executor.stale-'));
    const archived = JSON.parse(readFileSync(join(locks, archivedName), 'utf8'));
    assert.equal(archived.child_pid, 6003);
    assert.deepEqual(archived.process_tree_readback,
      { state: 'DEAD', root_pid: 6003, process_ids: [], observed_at: '2026-10-15T00:00:00.000Z' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('executor retains an unresolved child lock after a run and only releases it after OS death readback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-codex-returned-orphan-lock-'));
  try {
    const source = join(dir, 'source');
    const spool = join(dir, 'spool');
    const bundleDir = join(spool, 'bundles');
    mkdirSync(source); mkdirSync(bundleDir, { recursive: true });
    for (const name of ['requests', 'claims', 'locks', 'results'])
      mkdirSync(join(spool, name), { recursive: true });

    const git = (...args) => execFileSync('git', ['-C', source, ...args], {
      encoding: 'utf8', windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    git('init', '-q');
    git('config', 'user.name', 'PTYSD test');
    git('config', 'user.email', 'ptysd-test@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(source, 'sample.mjs'), 'export const baseline = true;\n');
    git('add', 'sample.mjs');
    git('commit', '-q', '-m', 'synthetic lock fixture');
    const sourceSha = git('rev-parse', 'HEAD');

    const spec = '# Synthetic orphan-lock test; no model process is started.\n';
    const picked = job({ request_id: 'PTYSD_CODEX_RETURNED_ORPHAN_LOCK_20261016',
      source_sha: sourceSha, spec_sha256: createHash('sha256').update(spec).digest('hex') });
    const attemptId = '00000000-0000-4000-8000-000000000094';
    const bundlePath = join(bundleDir, `${attemptId}.bundle`);
    git('bundle', 'create', bundlePath, 'HEAD');
    const request = makeCodexExecutorRequest(picked, attemptId, spec, bundlePath,
      createHash('sha256').update(readFileSync(bundlePath)).digest('hex'));
    publishCodexExecutorRequest(spool, request);

    const config = readyConfig();
    Object.assign(config, { spool_dir: spool, workspace_root: join(dir, 'workspaces'),
      codex_executable: join(dir, 'codex.exe') });
    const execution = await runExecutorOnce(config, {
      uptimeSeconds: () => 1000,
      currentSid: config.executor_identity_sid,
      environment: {},
      qualifyCodex: async () => {},
      runCodex: async () => ({ exit_code: null, signal: null,
        session_id: 'session_synthetic_orphan', session_started: true,
        provider_usage_evidence: 'UNKNOWN', model_activity_evidence: 'UNKNOWN',
        tool_execution_evidence: 'UNKNOWN', tool_execution_count: 0,
        file_change_tool_evidence: 'UNKNOWN', file_change_tool_completed_count: 0,
        file_change_tool_failed_count: 0, file_change_tool_incomplete_count: 0,
        child_pid: 6003, process_tree_state: 'ALIVE', model_invoked: false,
        outcome: 'CODEX_PROCESS_TERMINATION_FAILED',
        stdout_sha256: '0'.repeat(64), stderr_sha256: '1'.repeat(64),
        stdout_bytes: 0, stderr_bytes: 0, input_error: null, capture_error: null,
        storage_error: null, termination_state: 'ORPHAN_POSSIBLE',
        termination_error: 'TASKKILL_TREE_FAILED' }),
    });
    assert.equal(execution.state, 'RESULT_SAVED');
    assert.equal(execution.model_invoked, false);
    const activePath = join(spool, 'locks', 'executor.active');
    const active = JSON.parse(readFileSync(activePath, 'utf8'));
    assert.equal(active.phase, 'MODEL_TERMINATION_UNCONFIRMED');
    assert.equal(active.attempt_id, attemptId);
    assert.equal(active.child_pid, 6003);
    assert.equal(active.process_tree_state, 'ALIVE');
    assert.equal(JSON.parse(readFileSync(executorResultPath(spool, picked.request_id, attemptId), 'utf8'))
      .process_tree_state, 'ALIVE');

    // Model the executor process ending while its child tree remains alive.
    // The only release path is a fresh exact process-tree readback.
    writeFileSync(activePath, JSON.stringify({ ...active, pid: 999999 }));
    const deadExecutorDeps = { uptimeSeconds: () => 1100,
      currentSid: config.executor_identity_sid, environment: {}, isProcessAlive: () => false };
    await assert.rejects(runExecutorOnce(config, { ...deadExecutorDeps,
      readProcessTree: pid => ({ state: 'ALIVE', root_pid: pid, process_ids: [pid, 7004] }) }),
    /EXECUTOR_PROCESS_TREE_STILL_ACTIVE/);
    assert.deepEqual(JSON.parse(readFileSync(activePath, 'utf8')), { ...active, pid: 999999 },
      'an alive descendant preserves the exact attempt conflict lock');
    assert.equal(existsSync(join(spool, 'claims', `${picked.request_id}-${attemptId}.json`)), true,
      'the uncertain model attempt remains claimed and cannot replay');

    assert.deepEqual(await runExecutorOnce(config, { ...deadExecutorDeps,
      readProcessTree: pid => ({ state: 'DEAD', root_pid: pid, process_ids: [],
        observed_at: '2026-10-16T00:00:00.000Z' }) }), { state: 'IDLE', model_invoked: false });
    assert.equal(existsSync(activePath), false);
    const archivedName = readdirSync(join(spool, 'locks')).find(name => name.startsWith('executor.stale-'));
    const archived = JSON.parse(readFileSync(join(spool, 'locks', archivedName), 'utf8'));
    assert.equal(archived.attempt_id, attemptId);
    assert.deepEqual(archived.process_tree_readback, { state: 'DEAD', root_pid: 6003,
      process_ids: [], observed_at: '2026-10-16T00:00:00.000Z' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Windows process-tree reader reports only exact validated OS readback', () => {
  const calls = [];
  const alive = readWindowsProcessTree(7331, (file, args, options) => {
    calls.push({ file, args, options });
    return '{"state":"ALIVE","process_ids":[7331,7332]}';
  }, 'win32');
  assert.equal(alive.state, 'ALIVE');
  assert.equal(alive.root_pid, 7331);
  assert.deepEqual(alive.process_ids, [7331, 7332]);
  assert.equal(calls[0].file, 'powershell.exe');
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.shell, false);
  assert.match(calls[0].args.at(-1), /\$rootPid=7331/);
  const malformed = readWindowsProcessTree(7331,
    () => '{"state":"DEAD","process_ids":[7332]}', 'win32');
  assert.equal(malformed.state, 'UNKNOWN');
});
