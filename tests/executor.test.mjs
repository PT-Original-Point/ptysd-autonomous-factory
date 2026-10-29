import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync,
  writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JOB_MARKER, PROJECT, RECEIPT_MARKER, REPO, parseReceipt, receipt, runWorker,
  captureScopedEditDiff, verifyCapturedEvidence } from '../native-bridge/worker.mjs';
import { executePendingManifest } from '../native-bridge/executor.mjs';
import { buildCodexChildEnvironment } from '../native-bridge/codex-executor.mjs';
import { safeErrorCode } from '../native-bridge/safe-error-code.mjs';
import {
  assertExecutorTaskReady, buildExecutorTaskXml, claimPendingManifest,
  candidateBundlePath, candidateWorkspacePath, cleanupExecutorAttempt,
  createExecutorSourceBundle, dispatchToExecutor, executorResultPath, makeExecutorManifest,
  getCurrentWindowsSid, triggerPendingExecutorAttempt,
  executorTaskArguments, validateExecutorRoutingMap, validateExecutorTaskXml,
  validateWindowsTaskAction,
} from '../native-bridge/windows-executor.mjs';

const PUBLISHER_SID = 'S-1-5-21-101-202-303-1001';
const EXECUTOR_SID = 'S-1-5-21-101-202-303-1002';
const ATTEMPT = '00000000-0000-4000-8000-000000000001';
const ATTEMPT_EDIT = '00000000-0000-4000-8000-000000000002';

test('error labels never expose arbitrary messages or untrusted code fields', () => {
  const providerError = new Error('bearer ghp_SYNTHETIC_NOT_A_REAL_CREDENTIAL');
  providerError.code = 'GH_TOKEN_SYNTHETIC_NOT_A_REAL_CREDENTIAL';
  assert.equal(safeErrorCode(providerError), 'UNKNOWN');
  assert.equal(safeErrorCode({ code: 'EACCES', message: 'do not log this value' }), 'EACCES');
  assert.equal(safeErrorCode({ code: 'ERR_INVALID_ARG_TYPE', message: 'private detail' }),
    'NODE_RUNTIME_ERROR');
  assert.equal(safeErrorCode(new Error('CODEX_RESULT_SCOPE_MISMATCH')),
    'CODEX_RESULT_SCOPE_MISMATCH');
  assert.equal(safeErrorCode(new Error('SCOPED_EDIT_PARENT_PATH_MISSING')),
    'SCOPED_EDIT_PARENT_PATH_MISSING');
  assert.equal(safeErrorCode(new Error('EDIT_GIT_HEAD_FAILED')),
    'EDIT_GIT_HEAD_FAILED');
  for (const code of ['PROCESS_TREE_IDENTITY_MISMATCH', 'PROCESS_TREE_IDENTITY_UNPROVEN'])
    assert.equal(safeErrorCode(new Error(code)), code,
      'bounded process identity outcomes must survive executor evidence sanitization');
  assert.equal(safeErrorCode(new Error('PROCESS_TREE_PRIVATE_PID_12345')), 'UNKNOWN',
    'the identity codes are exact allowlist entries, not an open-ended prefix');
  assert.equal(safeErrorCode(new Error('EDIT_PROVIDER_ACCESS_TOKEN_REJECTED')),
    'UNKNOWN', 'edit error labels must still redact credential-shaped codes');
  assert.equal(safeErrorCode(Object.assign(providerError, { ptySafeCode: true })), 'UNKNOWN',
    'a forgeable marker on an error object cannot authorize logging its code');
  assert.equal(safeErrorCode({ code: 'CODEX_LOGIN_NOT_READY' }), 'CODEX_LOGIN_NOT_READY');
  const privateFallback = 'Bearer ghp_SYNTHETIC_NOT_A_REAL_CREDENTIAL';
  assert.equal(safeErrorCode({}, privateFallback), 'UNKNOWN',
    'untrusted fallback text must be sanitized before it enters durable evidence');
  assert.equal(safeErrorCode({}, 'CODEX_FALLBACK'), 'CODEX_FALLBACK',
    'an allowlisted stable fallback code may be retained');
  for (const code of ['INVALID', 'IO_ERROR', 'PREFLIGHT_FAILED',
    'PROCESS_TREE_READBACK_FAILED', 'PROCESS_TREE_READBACK_UNKNOWN', 'UNKNOWN'])
    assert.equal(safeErrorCode({}, code), code, `existing fallback code ${code} remains available`);
});

test('Codex child isolates GitHub publisher credentials from Git and gh', () => {
  const root = mkdtempSync(join(tmpdir(), 'ptysd-codex-git-auth-'));
  try {
    const evidenceDir = join(root, 'evidence');
    const repoDir = join(root, 'repo');
    mkdirSync(evidenceDir);
    mkdirSync(repoDir);
    const request = { job: { request_id: 'PTYSD_GIT_CREDENTIAL_ISOLATION_TEST' },
      attempt_id: ATTEMPT };
    const { env, ghConfigDir } = buildCodexChildEnvironment(request, evidenceDir, {
      PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT || 'C:\\Windows',
      USERPROFILE: root, GH_TOKEN: 'SYNTHETIC_PUBLISHER_TOKEN',
      GITHUB_TOKEN: 'SYNTHETIC_PUBLISHER_TOKEN', GIT_CONFIG_NOSYSTEM: '0',
      GIT_CONFIG_GLOBAL: 'untrusted-global-config', GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: 'untrusted-helper',
    });
    const isolatedSystemConfig = join(root, 'synthetic-system-config');
    writeFileSync(isolatedSystemConfig, '');
    // If the production isolation regresses, Git still must not read the host
    // system helper while this test exercises a credential lookup.
    env.GIT_CONFIG_SYSTEM = isolatedSystemConfig;

    assert.equal(env.GH_CONFIG_DIR, ghConfigDir);
    assert.equal(env.GH_PROMPT_DISABLED, '1');
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(env.GIT_CONFIG_SYSTEM, isolatedSystemConfig);
    assert.equal(env.GIT_CONFIG_GLOBAL, join(ghConfigDir, 'gitconfig'));
    assert.equal(readFileSync(env.GIT_CONFIG_GLOBAL, 'utf8'), '');
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(env.GCM_INTERACTIVE, 'never');
    assert.equal(env.GIT_CONFIG_COUNT, '4');
    assert.deepEqual(Array.from({ length: 4 }, (_, index) => env[`GIT_CONFIG_KEY_${index}`]), [
      'credential.helper', 'credential.https://github.com.helper',
      'http.extraheader', 'http.https://github.com/.extraheader',
    ]);
    assert.deepEqual(Array.from({ length: 4 }, (_, index) => env[`GIT_CONFIG_VALUE_${index}`]),
      ['', '', '', '']);

    execFileSync('git', ['init', '--quiet'], { cwd: repoDir, windowsHide: true });
    const fakeCredentialFile = join(root, 'synthetic-credentials');
    const fakeCredentialPath = fakeCredentialFile.replaceAll(String.fromCharCode(92), '/');
    writeFileSync(fakeCredentialFile,
      'https://synthetic-user:SYNTHETIC_PUBLISHER_TOKEN@github.com\n');
    execFileSync('git', ['config', 'credential.helper',
      `store --file=${fakeCredentialPath}`],
    { cwd: repoDir, windowsHide: true });
    execFileSync('git', ['config', 'credential.https://github.com.helper',
      `store --file=${fakeCredentialPath}`],
    { cwd: repoDir, windowsHide: true });
    execFileSync('git', ['config', 'http.extraheader', 'SYNTHETIC_PUBLISHER_HEADER'],
      { cwd: repoDir, windowsHide: true });
    execFileSync('git', ['config', 'http.https://github.com/.extraheader',
      'SYNTHETIC_PUBLISHER_HEADER'], { cwd: repoDir, windowsHide: true });

    const credential = spawnSync('git', ['credential', 'fill'], {
      cwd: repoDir, env, input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8', windowsHide: true,
    });
    assert.notEqual(credential.status, 0,
      'a publisher credential helper must not satisfy a model-child credential request');
    assert.doesNotMatch(credential.stdout || '', /SYNTHETIC_PUBLISHER_TOKEN/);
    const header = spawnSync('git', ['config', '--get-urlmatch', 'http.extraheader',
      'https://github.com'], { cwd: repoDir, env, encoding: 'utf8', windowsHide: true });
    assert.equal(header.stdout.trim(), '', 'a repository-local publisher header must be cleared');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('shared executor SID readback uses bounded hidden whoami and returns a validated SID', t => {
  if (process.platform !== 'win32') return t.skip('Windows SID process execution is Windows-only');
  let invocation;
  const sid=getCurrentWindowsSid({systemRoot:'C:\\Windows',execFile:(file,args,options)=>{
    invocation={file,args,options};
    return '"User Name","SID"\r\n"HOST\\worker","S-1-5-21-101-202-303-1002"\r\n';
  }});
  assert.equal(sid,'S-1-5-21-101-202-303-1002');
  assert.equal(invocation.file,'C:\\Windows\\System32\\whoami.exe');
  assert.deepEqual(invocation.args,['/user','/fo','csv','/nh']);
  assert.equal(invocation.options.windowsHide,true);
  assert.notEqual(invocation.options.shell,true);
  assert.equal(invocation.options.timeout,5000);
  assert.throws(()=>getCurrentWindowsSid({systemRoot:'C:\\Windows',execFile:()=> 'no SID'}),
    /EXECUTOR_WINDOWS_IDENTITY_UNAVAILABLE/);
});

function fixture() {
  const root = mkdtempSync(join(homedir(), 'ptysd-executor-'));
  const manifestDir = join(root, 'inbox');
  const resultsDir = join(root, 'results');
  mkdirSync(manifestDir);
  mkdirSync(resultsDir);
  const descriptor = {
    task_name: '\\PTYSD\\OpenCodeExecutor', user_sid: EXECUTOR_SID,
    publisher_sid: PUBLISHER_SID, wscript_path: 'C:\\Windows\\System32\\wscript.exe',
    launcher_path: 'C:\\ProgramData\\PTYSDNativeBridge\\HiddenCodexExecutor.vbs',
    node_bin: 'C:\\Program Files\\nodejs\\node.exe',
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

function sourceRepository(root, name = 'source-workspace') {
  const workspace = join(root, name);
  mkdirSync(workspace);
  const git = args => execFileSync('git', ['-C', workspace, ...args], {
    encoding: 'utf8', windowsHide: true, shell: false, timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  git(['init', '--quiet']);
  git(['config', 'user.name', 'PTYSD synthetic test']);
  git(['config', 'user.email', 'ptysd-test@example.invalid']);
  writeFileSync(join(workspace, 'README.md'), 'pinned source fixture\n');
  git(['add', 'README.md']);
  git(['commit', '--quiet', '-m', 'source fixture']);
  return { workspace, sourceSha: git(['rev-parse', 'HEAD']).trim(), git };
}

test('executor task template pins a distinct standard identity, PT0S, IgnoreNew, and exact hidden action', () => {
  const f = fixture();
  try {
    const xml = buildExecutorTaskXml(f.descriptor);
    const result = validateExecutorTaskXml(xml, f.descriptor);
    assert.deepEqual(result, { ready: true, user_sid: EXECUTOR_SID, logon_type: 'Password',
      run_level: 'LeastPrivilege', execution_time_limit: 'PT0S', multiple_instances: 'IgnoreNew' });
    assert.ok(xml.includes('<Command>C:\\Windows\\System32\\wscript.exe</Command>'));
    assert.equal(executorTaskArguments(f.descriptor),
      '//B //NoLogo "C:\\ProgramData\\PTYSDNativeBridge\\HiddenCodexExecutor.vbs" ' +
      '"C:\\Program Files\\nodejs\\node.exe" ' +
      '"C:\\Users\\PTYSDExecutor\\AppData\\Local\\PTYSD\\executor.mjs" ' +
      '"C:\\Users\\PTYSDExecutor\\AppData\\Local\\PTYSD\\executor.json" ' +
      `"${f.descriptor.manifest_dir}"`);
    assert.throws(() => validateExecutorTaskXml(xml.replace(
      '<Command>C:\\Windows\\System32\\wscript.exe</Command>',
      '<Command>C:\\Program Files\\nodejs\\node.exe</Command>'), f.descriptor),
    /EXECUTOR_TASK_COMMAND_MISMATCH/);
    assert.throws(() => validateExecutorTaskXml(xml.replace('<ExecutionTimeLimit>PT0S',
      '<ExecutionTimeLimit>PT15M'), f.descriptor), /EXECUTOR_TASK_TIME_LIMIT_NOT_UNBOUNDED/);
    assert.throws(() => validateExecutorTaskXml(xml.replace('<RunLevel>LeastPrivilege',
      '<RunLevel>HighestAvailable'), f.descriptor), /EXECUTOR_TASK_RUNLEVEL_UNSAFE/);
    assert.throws(() => validateExecutorTaskXml(xml.replace('<LogonType>Password',
      '<LogonType>S4U'), f.descriptor), /EXECUTOR_TASK_LOGON_TYPE_UNSAFE/);
    assert.throws(() => validateWindowsTaskAction(xml.replace('<LogonType>Password',
      '<LogonType>S4U'), { taskName: f.descriptor.task_name, userIds: [f.descriptor.user_sid],
      command: f.descriptor.wscript_path, argumentsText: executorTaskArguments(f.descriptor),
      workingDirectory: f.descriptor.working_directory, expectedLogonType: 'S4U' }),
    /TASK_EXPECTED_LOGON_TYPE_UNSAFE/);
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

test('executor task descriptor rejects built-in and service identities', () => {
  const f = fixture();
  try {
    for (const sid of ['S-1-5-18', 'S-1-5-19', 'S-1-5-20', 'S-1-5-80-123456']) {
      assert.throws(() => buildExecutorTaskXml({ ...f.descriptor, user_sid: sid }),
        error => error.code === 'EXECUTOR_USER_SID_INVALID');
      assert.throws(() => buildExecutorTaskXml({ ...f.descriptor, publisher_sid: sid }),
        error => error.code === 'PUBLISHER_USER_SID_INVALID');
    }
  } finally { f.dispose(); }
});

test('Task Scheduler XML string does not claim a byte encoding', () => {
  const f = fixture();
  try {
    const xml = buildExecutorTaskXml(f.descriptor);
    assert.doesNotMatch(xml, /^\s*<\?xml[^?]*\bencoding\s*=/i,
      'Register-ScheduledTask receives a .NET string, so a UTF-8 byte declaration is invalid');
  } finally { f.dispose(); }
});

test('WIN11_TRANSITION accepts the current publisher SID with an interactive token while VM mode remains isolated', () => {
  const f = fixture();
  try {
    const descriptor = { ...f.descriptor, user_sid: PUBLISHER_SID,
      execution_phase: 'WIN11_TRANSITION' };
    const xml = buildExecutorTaskXml(descriptor);
    assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
    assert.throws(() => validateExecutorTaskXml(xml.replace('InteractiveToken', 'Password'), descriptor),
      /LOGON_TYPE_UNSAFE/);
    assert.throws(() => buildExecutorTaskXml({ ...descriptor, user_sid: EXECUTOR_SID }),
      /EXECUTOR_TRANSITION_IDENTITY_MISMATCH/);
    assert.deepEqual(validateExecutorTaskXml(xml, descriptor), {
      ready: true, user_sid: PUBLISHER_SID, logon_type: 'InteractiveToken',
      run_level: 'LeastPrivilege', execution_time_limit: 'PT0S', multiple_instances: 'IgnoreNew',
    });
    assert.equal(assertExecutorTaskReady(descriptor, {
      currentSid: () => PUBLISHER_SID,
      filesystemPath: localPathMap(f),
      readTaskXml: () => xml,
    }).ready, true);
    assert.throws(() => buildExecutorTaskXml({ ...descriptor, execution_phase: 'VM_ISOLATED' }),
      /EXECUTOR_IDENTITY_NOT_SEPARATE/);
    assert.throws(() => buildExecutorTaskXml({ ...descriptor, execution_phase: 'UNKNOWN' }),
      /EXECUTOR_EXECUTION_PHASE_INVALID/);
  } finally { f.dispose(); }
});

test('WIN11_TRANSITION permits W1 and W2 on one SID only with distinct tasks and writable paths', () => {
  const f = fixture();
  try {
    const base = { ...f.descriptor, user_sid: PUBLISHER_SID, execution_phase: 'WIN11_TRANSITION' };
    const opencode = { ...base, task_name: '\\PTYSD-OpenCode-Executor',
      config_path: 'C:\\Users\\x\\AppData\\Local\\PTYSDNativeBridge\\opencode.json',
      manifest_dir: 'C:\\Users\\x\\AppData\\Local\\PTYSDNativeBridge\\opencode-requests',
      results_dir: 'C:\\Users\\x\\AppData\\Local\\PTYSDNativeBridge\\opencode-results',
      working_directory: 'C:\\Users\\x\\Documents\\PTYSD\\opencode-workspace' };
    const antigravity = { ...base, task_name: '\\PTYSD-Antigravity-Executor',
      config_path: 'C:\\Users\\x\\AppData\\Local\\PTYSDNativeBridge\\antigravity.json',
      manifest_dir: 'C:\\Users\\x\\AppData\\Local\\PTYSDNativeBridge\\antigravity-requests',
      results_dir: 'C:\\Users\\x\\AppData\\Local\\PTYSDNativeBridge\\antigravity-results',
      working_directory: 'C:\\Users\\x\\Documents\\PTYSD\\antigravity-workspace' };
    assert.doesNotThrow(() => validateExecutorRoutingMap({ opencode, antigravity }));
    assert.throws(() => validateExecutorRoutingMap({
      opencode: { ...opencode, execution_phase: 'VM_ISOLATED' },
      antigravity: { ...antigravity, execution_phase: 'VM_ISOLATED' },
    }), /EXECUTOR_IDENTITY_NOT_SEPARATE/);
    assert.throws(() => validateExecutorRoutingMap({ opencode,
      antigravity: { ...antigravity, results_dir: opencode.results_dir } }),
    /EXECUTOR_LANE_PATH_COLLISION/);
  } finally { f.dispose(); }
});

test('WIN11_TRANSITION dispatch creates one pending manifest and triggers the exact task once', () => {
  const f = fixture();
  try {
    const descriptor = { ...f.descriptor, user_sid: PUBLISHER_SID,
      execution_phase: 'WIN11_TRANSITION' };
    const xml = buildExecutorTaskXml(descriptor);
    const filesystemPath = localPathMap(f);
    const job = modelJob('Make one bounded source edit in the authorized candidate workspace.');
    let starts = 0;
    const dispatched = dispatchToExecutor(descriptor, {
      request_id: job.request_id, attempt_id: ATTEMPT, source_sha: job.source_sha,
      job, spec: 'Pinned synthetic task specification.',
    }, { currentSid: () => PUBLISHER_SID, filesystemPath,
      readTaskXml: taskName => { assert.equal(taskName, descriptor.task_name); return xml; },
      runTask: taskName => { assert.equal(taskName, descriptor.task_name); starts++; } });
    assert.equal(dispatched.outcome, 'EXECUTOR_TASK_DISPATCHED_NOT_ACCEPTANCE');
    assert.equal(starts, 1);
    assert.equal(readdirSync(filesystemPath(descriptor.manifest_dir))
      .filter(name => name.endsWith('.pending.json')).length, 1);
  } finally { f.dispose(); }
});

test('hidden executor launcher validates arguments, forwards manifest directory, waits, and preserves child exit code on Windows', t => {
  if (process.platform !== 'win32') return t.skip('Windows Script Host behavior is a Windows-only check');
  const systemRoot = process.env.SystemRoot;
  const cscript = join(systemRoot, 'System32', 'cscript.exe');
  if (!existsSync(cscript)) return t.skip('cscript.exe is unavailable');
  const root = mkdtempSync(join(tmpdir(), 'ptysd-hidden-launcher-'));
  try {
    const marker = join(root, 'child-args.txt');
    const child = join(root, 'child.vbs');
    const launcher = fileURLToPath(new URL('../native-bridge/HiddenCodexExecutor.vbs', import.meta.url));
    writeFileSync(child,
      'Option Explicit\r\nDim fso, output, i\r\nSet fso = CreateObject("Scripting.FileSystemObject")\r\n' +
      `Set output = fso.CreateTextFile("${marker}", True)\r\n` +
      'For i = 0 To WScript.Arguments.Count - 1\r\n' +
      '  If i > 0 Then output.Write "|"\r\n' +
      '  output.Write WScript.Arguments(i)\r\n' +
      'Next\r\noutput.Close\r\nWScript.Quit 23\r\n');
    const run = args => {
      try {
        execFileSync(cscript, ['//NoLogo', launcher, cscript, child, ...args], {
          encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
        });
        assert.fail('launcher must propagate the child exit code');
      } catch (error) {
        assert.equal(error.status, 23);
      }
      return readFileSync(marker, 'utf8');
    };
    assert.equal(run(['config path.json']), '--config|config path.json');
    assert.equal(run(['config path.json', 'manifest path']),
      '--config|config path.json|--manifest-dir|manifest path');
    try {
      execFileSync(cscript, ['//NoLogo', launcher, cscript, child], {
        encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
      });
      assert.fail('invalid launcher arity must exit with its validation code');
    } catch (error) {
      assert.equal(error.status, 64);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
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

test('attempt source bundle pins one exact commit and is attached to the Task Scheduler manifest', () => {
  const f = fixture();
  try {
    const source = sourceRepository(f.root);
    const spec = 'Inspect the pinned public source only.';
    const job = { ...modelJob(spec), source_sha: source.sourceSha };
    const bundle = createExecutorSourceBundle({ workspace: source.workspace,
      descriptor: f.descriptor, job, attemptId: ATTEMPT, filesystemPath: localPathMap(f) });
    assert.equal(bundle.attempt_id, ATTEMPT);
    assert.equal(bundle.source_sha, source.sourceSha);
    assert.match(bundle.sha256, /^[a-f0-9]{64}$/);
    const listed = execFileSync('git', ['bundle', 'list-heads', bundle.bundle_path], {
      encoding: 'utf8', windowsHide: true, shell: false,
    });
    assert.ok(listed.includes(`${source.sourceSha} refs/pty-native/executor-bundles/${ATTEMPT}`));
    assert.throws(() => source.git(['show-ref', '--verify',
      `refs/pty-native/executor-bundles/${ATTEMPT}`]), error => error.status !== 0,
    'the temporary source ref is removed after bundle creation');

    let starts = 0;
    const result = dispatchToExecutor(f.descriptor, {
      request_id: job.request_id, attempt_id: ATTEMPT, source_sha: job.source_sha, job, spec,
      source_bundle_sha256: bundle.sha256,
    }, { currentSid: f.currentSid, readTaskXml: f.readTaskXml,
      filesystemPath: localPathMap(f), runTask: () => { starts++; } });
    assert.equal(starts, 1);
    assert.equal(result.attempt_id, ATTEMPT);
    const pending = JSON.parse(readFileSync(join(f.manifestDir, `${ATTEMPT}.pending.json`), 'utf8'));
    assert.equal(pending.source_bundle_sha256, bundle.sha256);
    // The descriptor intentionally carries Windows paths for Task Scheduler.
    // CI runs this fixture on POSIX, so cleanup must target the mapped fixture
    // directories rather than the Windows-form descriptor strings.
    cleanupExecutorAttempt({ ...f.descriptor, manifest_dir: f.manifestDir,
      results_dir: f.resultsDir }, ATTEMPT);

    const editJob = { ...job, schema:4, kind:'opencode_edit', request_id:'PTYSD_NATIVE_V2_EDIT_BUNDLE_20261016',
      edit_paths:['README.md'] };
    const editBundle=createExecutorSourceBundle({workspace:source.workspace,descriptor:f.descriptor,
      job:editJob,attemptId:ATTEMPT_EDIT,filesystemPath:localPathMap(f)});
    const editDispatch=dispatchToExecutor(f.descriptor,{request_id:editJob.request_id,
      attempt_id:ATTEMPT_EDIT,source_sha:editJob.source_sha,job:editJob,spec,
      source_bundle_sha256:editBundle.sha256},{currentSid:f.currentSid,readTaskXml:f.readTaskXml,
      filesystemPath:localPathMap(f),runTask:()=>{starts++;}});
    assert.equal(editDispatch.attempt_id,ATTEMPT_EDIT);
    const editPending=JSON.parse(readFileSync(join(f.manifestDir,`${ATTEMPT_EDIT}.pending.json`),'utf8'));
    assert.equal(editPending.job.kind,'opencode_edit');
    assert.deepEqual(editPending.job.edit_paths,['README.md']);
    assert.equal(editPending.source_bundle_sha256,editBundle.sha256);
  } finally { f.dispose(); }
});

test('source bundle from a shallow workspace is made portable before executor dispatch', () => {
  const f = fixture();
  try {
    const full = sourceRepository(f.root, 'complete-source');
    for (let index = 1; index <= 3; index++) {
      writeFileSync(join(full.workspace, 'README.md'), 'source history ' + index + '\n');
      full.git(['add', 'README.md']);
      full.git(['commit', '--quiet', '-m', 'source history ' + index]);
    }
    const bare = join(f.root, 'source-origin.git');
    execFileSync('git', ['init', '--bare', '--quiet', bare], { encoding: 'utf8', windowsHide: true });
    full.git(['branch', '-M', 'main']);
    full.git(['remote', 'add', 'origin', pathToFileURL(bare).href]);
    full.git(['push', '--quiet', '--set-upstream', 'origin', 'main']);

    const shallowWorkspace = join(f.root, 'shallow-source');
    execFileSync('git', ['clone', '--quiet', '--depth=1', '--branch', 'main',
      pathToFileURL(bare).href, shallowWorkspace], { encoding: 'utf8', windowsHide: true });
    const shallowGit = args => execFileSync('git', ['-C', shallowWorkspace, ...args], {
      encoding: 'utf8', windowsHide: true, shell: false, timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    assert.equal(shallowGit(['rev-parse', '--is-shallow-repository']), 'true');

    const spec = 'Create an isolated source snapshot for a test; do not invoke a model.';
    const job = { ...modelJob(spec, 'antigravity_edit'), source_sha: shallowGit(['rev-parse', 'HEAD']) };
    const bundle = createExecutorSourceBundle({ workspace: shallowWorkspace,
      descriptor: f.descriptor, job, attemptId: ATTEMPT, filesystemPath: localPathMap(f) });
    assert.equal(shallowGit(['rev-parse', '--is-shallow-repository']), 'false',
      'the source history must be complete before a standalone bundle is created');

    const consumer = join(f.root, 'empty-executor-repository');
    execFileSync('git', ['init', '--quiet', consumer], { encoding: 'utf8', windowsHide: true });
    const ref = 'refs/pty-native/executor-bundles/' + ATTEMPT;
    execFileSync('git', ['-C', consumer, 'fetch', '--quiet', '--no-tags', bundle.bundle_path,
      ref + ':' + ref], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 30000 });
    execFileSync('git', ['-C', consumer, 'checkout', '--quiet', '--detach', job.source_sha], {
      encoding: 'utf8', windowsHide: true, shell: false, timeout: 30000,
    });
    assert.equal(execFileSync('git', ['-C', consumer, 'rev-parse', 'HEAD'], {
      encoding: 'utf8', windowsHide: true,
    }).trim(), job.source_sha);
    assert.equal(readFileSync(join(consumer, 'README.md'), 'utf8').replaceAll('\r\n', '\n'),
      'source history 3\n');
  } finally { f.dispose(); }
});

test('executor runs on a disposable attempt workspace pinned to the verified bundle commit', async t => {
  if (process.platform !== 'win32') return t.skip('Task Scheduler identity execution is Windows-only');
  const f = fixture();
  try {
    const source = sourceRepository(f.root);
    const spec = 'Inspect the pinned source without writing or invoking a model in this test.';
    const job = { ...modelJob(spec), source_sha: source.sourceSha,
      request_id: 'PTYSD_NATIVE_SOURCE_WORKSPACE_TEST' };
    const bundle = createExecutorSourceBundle({ workspace: source.workspace,
      descriptor: f.descriptor, job, attemptId: ATTEMPT, filesystemPath: localPathMap(f) });
    writeFileSync(join(f.manifestDir, `${ATTEMPT}.pending.json`), JSON.stringify(
      makeExecutorManifest(job, spec, ATTEMPT, bundle.sha256)), { flag: 'wx' });
    let calls = 0;
    const outcome = await executePendingManifest({ manifestDir: f.descriptor.manifest_dir,
      currentSid: () => EXECUTOR_SID,
      config: { project_id: PROJECT, repo: REPO, host: hostname().toUpperCase(),
        executor_runtime: { user_sid: EXECUTOR_SID, publisher_sid: PUBLISHER_SID,
          manifest_dir: f.descriptor.manifest_dir, results_dir: f.descriptor.results_dir },
        workspace: source.workspace, state_dir: f.descriptor.results_dir },
      execute: async (_receivedSpec, executionConfig, receivedJob) => {
        calls++;
        assert.notEqual(executionConfig.workspace, source.workspace);
        assert.equal(execFileSync('git', ['-C', executionConfig.workspace, 'rev-parse', 'HEAD'], {
          encoding: 'utf8', windowsHide: true, shell: false,
        }).trim(), source.sourceSha);
        assert.equal(receivedJob.source_sha, source.sourceSha);
        return { outcome: 'OPENCODE_V2_EXIT_0_UNTRUSTED', exit_code: 0,
          evidence_sha256: 'b'.repeat(64), evidence_bytes: 7 };
      },
    });
    assert.equal(calls, 1, JSON.stringify({ outcome,
      saved: JSON.parse(readFileSync(executorResultPath(f.descriptor.results_dir,
        job.request_id, ATTEMPT), 'utf8')).terminal }));
    assert.equal(outcome.terminal_state, 'FINISHED');
    const workspace = candidateWorkspacePath(f.descriptor.results_dir, ATTEMPT);
    assert.ok(existsSync(workspace), 'attempt workspace remains available until receipt reconciliation');
    cleanupExecutorAttempt(f.descriptor, ATTEMPT);
    assert.equal(existsSync(workspace), false);
    assert.equal(existsSync(candidateBundlePath(f.manifestDir, ATTEMPT)), false);
  } finally { f.dispose(); }
});

test('executor accepts a scoped OpenCode edit manifest and materializes only its pinned source commit', async t => {
  if (process.platform !== 'win32') return t.skip('Task Scheduler identity execution is Windows-only');
  const f=fixture();
  try {
    const source=sourceRepository(f.root);
    const spec='Change only the allowlisted README file; the test executor is synthetic.';
    const job={...modelJob(spec),schema:4,kind:'opencode_edit',
      request_id:'PTYSD_NATIVE_V2_EDIT_EXECUTOR_20261016',source_sha:source.sourceSha,
      edit_paths:['README.md']};
    const bundle=createExecutorSourceBundle({workspace:source.workspace,descriptor:f.descriptor,
      job,attemptId:ATTEMPT_EDIT,filesystemPath:localPathMap(f)});
    writeFileSync(join(f.manifestDir,`${ATTEMPT_EDIT}.pending.json`),JSON.stringify(
      makeExecutorManifest(job,spec,ATTEMPT_EDIT,bundle.sha256)),{flag:'wx'});
    let calls=0;
    const result=await executePendingManifest({manifestDir:f.descriptor.manifest_dir,
      currentSid:()=>EXECUTOR_SID,
      config:{project_id:PROJECT,repo:REPO,host:hostname().toUpperCase(),
        executor_runtime:{user_sid:EXECUTOR_SID,publisher_sid:PUBLISHER_SID,
          manifest_dir:f.descriptor.manifest_dir,results_dir:f.descriptor.results_dir},
        workspace:source.workspace,state_dir:f.descriptor.results_dir},
      execute:async(_spec,executionConfig,receivedJob)=>{
        calls++;
        assert.equal(receivedJob.kind,'opencode_edit');
        assert.deepEqual(receivedJob.edit_paths,['README.md']);
        assert.notEqual(executionConfig.workspace,source.workspace);
        assert.equal(execFileSync('git',['-C',executionConfig.workspace,'rev-parse','HEAD'],{
          encoding:'utf8',windowsHide:true,shell:false}).trim(),source.sourceSha);
        return {outcome:'SYNTHETIC_EDIT_EXECUTOR_EXIT_0_NOT_ACCEPTANCE',exit_code:0,
          evidence_sha256:'d'.repeat(64),evidence_bytes:12};
      },
    });
    assert.equal(calls,1);
    assert.equal(result.terminal_state,'FINISHED');
    const saved=JSON.parse(readFileSync(executorResultPath(f.descriptor.results_dir,
      job.request_id,ATTEMPT_EDIT),'utf8'));
    assert.equal(saved.terminal.kind,'opencode_edit');
    assert.equal(saved.terminal.outcome,'SYNTHETIC_EDIT_EXECUTOR_EXIT_0_NOT_ACCEPTANCE');
    cleanupExecutorAttempt(f.descriptor,ATTEMPT_EDIT);
  } finally { f.dispose(); }
});

test('executor persists a recoverable Antigravity preflight wait for the exact pinned source attempt', async t => {
  if (process.platform !== 'win32') return t.skip('Task Scheduler executor lifecycle is Windows-only');
  const f=fixture();
  try {
    const source=sourceRepository(f.root);
    const spec='Synthetic W2 preflight; no model invocation is permitted.';
    const job={schema:6,project_id:PROJECT,host:hostname().toUpperCase(),
      request_id:'PTYSD_ANTIGRAVITY_EXECUTOR_WAIT_20261018',kind:'antigravity_edit',
      source_sha:source.sourceSha,spec_path:'native-bridge/tasks/w2-review.md',
      spec_sha256:createHash('sha256').update(spec).digest('hex'),
      model:'gemini-3.8-flash-high',variant:'high',edit_paths:['README.md'],source_pr:448,
      goal_comment_id:6188322050,goal_body_sha256:'c'.repeat(64)};
    const bundle=createExecutorSourceBundle({workspace:source.workspace,descriptor:f.descriptor,
      job,attemptId:ATTEMPT_EDIT,filesystemPath:localPathMap(f)});
    writeFileSync(join(f.manifestDir,`${ATTEMPT_EDIT}.pending.json`),JSON.stringify(
      makeExecutorManifest(job,spec,ATTEMPT_EDIT,bundle.sha256)),{flag:'wx'});
    let executeCalls=0;
    const result=await executePendingManifest({manifestDir:f.manifestDir,
      currentSid:()=>EXECUTOR_SID,filesystemPath:localPathMap(f),
      config:{project_id:PROJECT,repo:REPO,host:hostname().toUpperCase(),
        executor_runtime:{user_sid:EXECUTOR_SID,publisher_sid:PUBLISHER_SID,
          manifest_dir:f.manifestDir,results_dir:f.resultsDir},
        workspace:source.workspace,state_dir:f.resultsDir},
      execute:async(_spec,executionConfig,receivedJob)=>{
        executeCalls++;
        assert.equal(receivedJob.kind,'antigravity_edit');
        assert.equal(executionConfig.antigravity_project_root,source.workspace,
          'the executor must preserve the registered outer project root separately from the attempt checkout');
        assert.equal(executionConfig.workspace,join(f.resultsDir,'candidate-workspaces',ATTEMPT_EDIT),
          'the attempt checkout must be outside the registered source project');
        assert.equal(execFileSync('git',['-C',executionConfig.workspace,'rev-parse','HEAD'],{
          encoding:'utf8',windowsHide:true,shell:false}).trim(),source.sourceSha);
        return {outcome:'ANTIGRAVITY_CREDIT_FALLBACK_SETTING_UNKNOWN',exit_code:48,
          eligibility_state:'WAITING',model_invoked:false,evidence_sha256:null,evidence_bytes:0};
      }});
    assert.equal(executeCalls,1);
    assert.equal(result.terminal_state,'WAITING');
    const saved=JSON.parse(readFileSync(executorResultPath(f.resultsDir,job.request_id,ATTEMPT_EDIT),'utf8'));
    assert.equal(saved.terminal.kind,'antigravity_edit');
    assert.equal(saved.terminal.model,'gemini-3.8-flash-high');
    assert.equal(saved.terminal.model_invoked,false);
    assert.equal(parseReceipt(RECEIPT_MARKER+JSON.stringify(saved.terminal)).state,'WAITING');
    const workspace=join(f.resultsDir,'candidate-workspaces',ATTEMPT_EDIT);
    assert.ok(existsSync(workspace),'the candidate remains available until receipt reconciliation');
    cleanupExecutorAttempt({...f.descriptor,manifest_dir:f.manifestDir,results_dir:f.resultsDir},
      ATTEMPT_EDIT);
    assert.equal(existsSync(workspace),false,'receipt reconciliation removes the exact attempt workspace');
    assert.equal(readFileSync(join(source.workspace,'README.md'),'utf8'),'pinned source fixture\n');
  } finally { f.dispose(); }
});

test('Antigravity attempt stays outside the registered project and cleanup refuses its legacy junction path', async t => {
  if (process.platform !== 'win32') return t.skip('Task Scheduler executor lifecycle is Windows-only');
  const f=fixture();
  try {
    const source=sourceRepository(f.root);
    const outside=join(f.root,'external-project-root');
    mkdirSync(outside);
    const executorRoot=join(source.workspace,'.pty-native-executor');
    try { symlinkSync(outside,executorRoot,'junction'); }
    catch (error) {
      if (['EPERM','EACCES','ENOTSUP'].includes(error.code)) {
        t.skip(`Windows junction creation is unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    const spec='Synthetic W2 junction-boundary rejection; no model invocation is permitted.';
    const job={schema:6,project_id:PROJECT,host:hostname().toUpperCase(),
      request_id:'PTYSD_ANTIGRAVITY_JUNCTION_BOUNDARY_20261022',kind:'antigravity_edit',
      source_sha:source.sourceSha,spec_path:'native-bridge/tasks/w2-review.md',
      spec_sha256:createHash('sha256').update(spec).digest('hex'),
      model:'gemini-3.8-flash-high',variant:'high',edit_paths:['README.md'],source_pr:448,
      goal_comment_id:6188322050,goal_body_sha256:'c'.repeat(64)};
    const bundle=createExecutorSourceBundle({workspace:source.workspace,descriptor:f.descriptor,
      job,attemptId:ATTEMPT_EDIT,filesystemPath:localPathMap(f)});
    writeFileSync(join(f.manifestDir,`${ATTEMPT_EDIT}.pending.json`),JSON.stringify(
      makeExecutorManifest(job,spec,ATTEMPT_EDIT,bundle.sha256)),{flag:'wx'});
    let executeCalls=0;
    const outcome=await executePendingManifest({manifestDir:f.manifestDir,
      currentSid:()=>EXECUTOR_SID,filesystemPath:localPathMap(f),
      config:{project_id:PROJECT,repo:REPO,host:hostname().toUpperCase(),
        executor_runtime:{user_sid:EXECUTOR_SID,publisher_sid:PUBLISHER_SID,
          manifest_dir:f.manifestDir,results_dir:f.resultsDir},
        workspace:source.workspace,state_dir:f.resultsDir},
      execute:async(_spec,executionConfig)=>{
        executeCalls++;
        assert.equal(executionConfig.workspace,candidateWorkspacePath(f.resultsDir,ATTEMPT_EDIT));
        return {outcome:'ANTIGRAVITY_CREDIT_FALLBACK_SETTING_UNKNOWN',exit_code:48,
          eligibility_state:'WAITING',model_invoked:false,evidence_sha256:null,evidence_bytes:0};
      }});
    assert.equal(executeCalls,1,'the registered-project junction cannot block an external attempt checkout');
    assert.equal(outcome.terminal_state,'WAITING');
    assert.equal(existsSync(join(outside,'candidate-workspaces')),false,
      'the executor must not traverse or create candidate data through a project-root junction');
    assert.equal(existsSync(candidateWorkspacePath(f.resultsDir,ATTEMPT_EDIT)),true);
    cleanupExecutorAttempt({...f.descriptor,manifest_dir:f.manifestDir,results_dir:f.resultsDir},ATTEMPT_EDIT);
    assert.equal(existsSync(candidateWorkspacePath(f.resultsDir,ATTEMPT_EDIT)),false,
      'the exact external attempt checkout is removed only after its receipt is persisted');

    const attempt=join(outside,'candidate-workspaces',ATTEMPT_EDIT);
    mkdirSync(attempt,{recursive:true});
    const marker=join(attempt,'preserve.txt');
    writeFileSync(marker,'outside data must survive');
    assert.throws(()=>cleanupExecutorAttempt({...f.descriptor,manifest_dir:f.manifestDir,
      results_dir:f.resultsDir},ATTEMPT_EDIT,undefined,{candidateWorkspaceRoot:source.workspace}),
    /EXECUTOR_PROJECT_WORKSPACE_BASE_NOT_PHYSICAL/);
    assert.equal(readFileSync(marker,'utf8'),'outside data must survive');
  } finally { f.dispose(); }
});

test('executor rejects registered project root writes when the attempt candidate has no diff', async t => {
  if (process.platform !== 'win32') return t.skip('Task Scheduler identity execution is Windows-only');
  const f = fixture();
  try {
    const source = sourceRepository(f.root, 'registered-root-mismatch');
    const spec = 'Synthetic root mismatch; no provider or model is invoked by this test.';
    const job = { ...modelJob(spec), schema: 6, project_id: PROJECT,
      host: hostname().toUpperCase(), kind: 'antigravity_edit',
      request_id: 'PTYSD_ANTIGRAVITY_REGISTERED_ROOT_MISMATCH',
      source_sha: source.sourceSha, spec_path: 'native-bridge/tasks/w2-review.md',
      spec_sha256: createHash('sha256').update(spec).digest('hex'),
      model: 'gemini-3.8-flash-high', variant: 'high', edit_paths: ['README.md'],
      source_pr: 461, goal_comment_id: 6188322050, goal_body_sha256: 'c'.repeat(64) };
    const bundle = createExecutorSourceBundle({ workspace: source.workspace,
      descriptor: f.descriptor, job, attemptId: ATTEMPT_EDIT,
      filesystemPath: localPathMap(f) });
    writeFileSync(join(f.manifestDir, `${ATTEMPT_EDIT}.pending.json`), JSON.stringify(
      makeExecutorManifest(job, spec, ATTEMPT_EDIT, bundle.sha256)), { flag: 'wx' });
    let executeCalls = 0;
    const result = await executePendingManifest({ manifestDir: f.descriptor.manifest_dir,
      currentSid: () => EXECUTOR_SID,
      config: { project_id: PROJECT, repo: REPO, host: hostname().toUpperCase(),
        executor_runtime: { user_sid: EXECUTOR_SID, publisher_sid: PUBLISHER_SID,
          manifest_dir: f.descriptor.manifest_dir, results_dir: f.descriptor.results_dir },
        workspace: source.workspace, state_dir: f.descriptor.results_dir,
        enable_antigravity_model_runs: true },
      execute: async (_receivedSpec, executionConfig) => {
        executeCalls++;
        assert.notEqual(executionConfig.workspace, source.workspace);
        writeFileSync(join(source.workspace, 'README.md'), 'written to registered project root\n');
        return { outcome: 'SYNTHETIC_ZERO_CANDIDATE_DIFF', exit_code: 0,
          scope_valid: true, external_effects: 'NONE', diff_bytes: 0,
          changed_files_count: 0, model_invoked: true };
      },
    });
    const saved = JSON.parse(readFileSync(executorResultPath(f.resultsDir,
      job.request_id, ATTEMPT_EDIT), 'utf8'));
    assert.equal(executeCalls, 1);
    assert.equal(saved.terminal.outcome, 'EXECUTOR_EDIT_REGISTERED_ROOT_CHANGED');
    assert.equal(saved.terminal.scope_valid, false);
    assert.equal(saved.terminal.external_effects, 'UNKNOWN');
    assert.ok(parseReceipt(RECEIPT_MARKER + JSON.stringify(saved.terminal)),
      'the scope-failure receipt remains valid under the published schema');
    assert.equal(saved.terminal.diff_bytes, null,
      'a zero candidate diff must not hide writes to the configured project root');
    assert.equal(readFileSync(join(source.workspace, 'README.md'), 'utf8'),
      'written to registered project root\n', 'unexpected effects are preserved for recovery');
    assert.equal(result.terminal_state, 'BLOCKED');
  } finally { f.dispose(); }
});

test('executor blocks a dirty registered-root path before starting a scoped attempt', async t => {
  if (process.platform !== 'win32') return t.skip('Task Scheduler identity execution is Windows-only');
  const f = fixture();
  try {
    const source = sourceRepository(f.root, 'registered-root-dirty-conflict');
    writeFileSync(join(source.workspace, 'README.md'), 'preserved pre-existing W2 work\n');
    const spec = 'Synthetic dirty-root conflict; no provider or model is invoked.';
    const job = { ...modelJob(spec), schema: 6, project_id: PROJECT,
      host: hostname().toUpperCase(), kind: 'antigravity_edit',
      request_id: 'PTYSD_ANTIGRAVITY_DIRTY_ROOT_SCOPE_CONFLICT', source_sha: source.sourceSha,
      spec_path: 'native-bridge/tasks/w2-review.md',
      spec_sha256: createHash('sha256').update(spec).digest('hex'),
      model: 'gemini-3.8-flash-high', variant: 'high', edit_paths: ['README.md'],
      source_pr: 461, goal_comment_id: 6188322050, goal_body_sha256: 'c'.repeat(64) };
    const bundle = createExecutorSourceBundle({ workspace: source.workspace,
      descriptor: f.descriptor, job, attemptId: ATTEMPT_EDIT,
      filesystemPath: localPathMap(f) });
    writeFileSync(join(f.manifestDir, `${ATTEMPT_EDIT}.pending.json`), JSON.stringify(
      makeExecutorManifest(job, spec, ATTEMPT_EDIT, bundle.sha256)), { flag: 'wx' });
    let executeCalls = 0;
    const result = await executePendingManifest({ manifestDir: f.manifestDir,
      currentSid: () => EXECUTOR_SID,
      config: { project_id: PROJECT, repo: REPO, host: hostname().toUpperCase(),
        executor_runtime: { user_sid: EXECUTOR_SID, publisher_sid: PUBLISHER_SID,
          manifest_dir: f.manifestDir, results_dir: f.resultsDir },
        workspace: source.workspace, state_dir: f.resultsDir,
        enable_antigravity_model_runs: true },
      execute: async () => { executeCalls++; throw new Error('must not start a conflicted write'); },
    });
    const saved = JSON.parse(readFileSync(executorResultPath(f.resultsDir,
      job.request_id, ATTEMPT_EDIT), 'utf8'));
    assert.equal(executeCalls, 0);
    assert.equal(result.terminal_state, 'BLOCKED');
    assert.equal(saved.terminal.outcome, 'EXECUTOR_EDIT_WORKSPACE_PRECHECK_BLOCKED');
    assert.equal(saved.local_evidence.executor_workspace_guard.error,
      'EXECUTOR_EDIT_REGISTERED_ROOT_DIRTY_SCOPE_CONFLICT');
    assert.equal(saved.terminal.model_invoked, false);
    assert.equal(readFileSync(join(source.workspace, 'README.md'), 'utf8'),
      'preserved pre-existing W2 work\n');
  } finally { f.dispose(); }
});

test('executor reconciles tracked and untracked candidate changes against the captured diff', async t => {
  if (process.platform !== 'win32') return t.skip('Task Scheduler identity execution is Windows-only');
  const f = fixture();
  try {
    const source = sourceRepository(f.root, 'candidate-three-file-diff');
    writeFileSync(join(source.workspace, 'package.json'), '{"name":"pinned"}\n');
    source.git(['add', 'package.json']);
    source.git(['commit', '--quiet', '-m', 'add tracked package fixture']);
    const sourceSha = source.git(['rev-parse', 'HEAD']).trim();
    const spec = 'Synthetic candidate diff; provider and model are not invoked.';
    const paths = ['package.json', 'src/w2-first.mjs', 'tests/w2-second.test.mjs'];
    const job = { ...modelJob(spec), schema: 6, project_id: PROJECT,
      host: hostname().toUpperCase(), kind: 'antigravity_edit',
      request_id: 'PTYSD_ANTIGRAVITY_CANDIDATE_THREE_FILE_DIFF', source_sha: sourceSha,
      spec_path: 'native-bridge/tasks/w2-review.md',
      spec_sha256: createHash('sha256').update(spec).digest('hex'),
      model: 'gemini-3.8-flash-high', variant: 'high', edit_paths: paths,
      source_pr: 461, goal_comment_id: 6188322050, goal_body_sha256: 'c'.repeat(64) };
    const bundle = createExecutorSourceBundle({ workspace: source.workspace,
      descriptor: f.descriptor, job, attemptId: ATTEMPT_EDIT,
      filesystemPath: localPathMap(f) });
    writeFileSync(join(f.manifestDir, `${ATTEMPT_EDIT}.pending.json`), JSON.stringify(
      makeExecutorManifest(job, spec, ATTEMPT_EDIT, bundle.sha256)), { flag: 'wx' });
    let captured;
    const result = await executePendingManifest({ manifestDir: f.manifestDir,
      currentSid: () => EXECUTOR_SID,
      config: { project_id: PROJECT, repo: REPO, host: hostname().toUpperCase(),
        executor_runtime: { user_sid: EXECUTOR_SID, publisher_sid: PUBLISHER_SID,
          manifest_dir: f.manifestDir, results_dir: f.resultsDir },
        workspace: source.workspace, state_dir: f.resultsDir,
        enable_antigravity_model_runs: true },
      execute: async (_receivedSpec, executionConfig) => {
        mkdirSync(join(executionConfig.workspace, 'src'));
        mkdirSync(join(executionConfig.workspace, 'tests'));
        writeFileSync(join(executionConfig.workspace, 'package.json'), '{"name":"edited"}\n');
        writeFileSync(join(executionConfig.workspace, paths[1]), 'export const w2 = true;\n');
        writeFileSync(join(executionConfig.workspace, paths[2]), 'import test from "node:test";\n');
        captured = await captureScopedEditDiff({ workspace: executionConfig.workspace,
          state_dir: f.resultsDir, job, attempt_id: ATTEMPT_EDIT });
        return { outcome: 'SYNTHETIC_SCOPED_DIFF_UNVERIFIED', exit_code: 0,
          scope_valid: captured.scope_valid, diff_sha256: captured.sha256,
          diff_bytes: captured.bytes, changed_files: captured.changed_files,
          local_evidence: { edit_diff: { file: captured.file, sha256: captured.sha256,
            bytes: captured.bytes, changed_files: captured.changed_files,
            allowed_paths: paths, scope_valid: captured.scope_valid } } };
      },
    });
    const saved = JSON.parse(readFileSync(executorResultPath(f.resultsDir,
      job.request_id, ATTEMPT_EDIT), 'utf8'));
    assert.equal(result.terminal_state, 'FINISHED');
    assert.equal(captured.scope_valid, true);
    assert.equal(saved.terminal.scope_valid, true);
    assert.equal(saved.terminal.diff_sha256, captured.sha256);
    assert.equal(saved.terminal.diff_bytes, captured.bytes);
    assert.equal(saved.terminal.changed_files_count, 3);
    assert.deepEqual(saved.local_evidence.edit_diff.changed_files.slice().sort(), paths.slice().sort());
    assert.equal(saved.local_evidence.executor_workspace_guard.readback, 'COMPLETE');
    assert.equal(saved.local_evidence.executor_workspace_guard.registered_root_state_sha256,
      saved.local_evidence.executor_workspace_guard.registered_root_after_sha256);
    assert.equal(saved.terminal.task_acceptance, 'UNKNOWN',
      'captured source diff is not semantic or CI acceptance');
    cleanupExecutorAttempt({ ...f.descriptor, manifest_dir: f.manifestDir,
      results_dir: f.resultsDir }, ATTEMPT_EDIT);
  } finally { f.dispose(); }
});

test('executor fails closed when a candidate write traverses a junction outside its physical root', async t => {
  if (process.platform !== 'win32') return t.skip('NTFS junction verification is Windows-only');
  const f = fixture();
  try {
    const source = sourceRepository(f.root, 'candidate-junction-escape');
    const spec = 'Synthetic junction escape; no provider or model is invoked.';
    const job = { ...modelJob(spec), schema: 6, project_id: PROJECT,
      host: hostname().toUpperCase(), kind: 'antigravity_edit',
      request_id: 'PTYSD_ANTIGRAVITY_JUNCTION_ESCAPE', source_sha: source.sourceSha,
      spec_path: 'native-bridge/tasks/w2-review.md',
      spec_sha256: createHash('sha256').update(spec).digest('hex'),
      model: 'gemini-3.8-flash-high', variant: 'high', edit_paths: ['README.md'],
      source_pr: 461, goal_comment_id: 6188322050, goal_body_sha256: 'c'.repeat(64) };
    const bundle = createExecutorSourceBundle({ workspace: source.workspace,
      descriptor: f.descriptor, job, attemptId: ATTEMPT_EDIT,
      filesystemPath: localPathMap(f) });
    writeFileSync(join(f.manifestDir, `${ATTEMPT_EDIT}.pending.json`), JSON.stringify(
      makeExecutorManifest(job, spec, ATTEMPT_EDIT, bundle.sha256)), { flag: 'wx' });
    let junctionCreated = false;
    const outside = join(f.root, 'outside-root');
    mkdirSync(outside);
    const result = await executePendingManifest({ manifestDir: f.manifestDir,
      currentSid: () => EXECUTOR_SID,
      config: { project_id: PROJECT, repo: REPO, host: hostname().toUpperCase(),
        executor_runtime: { user_sid: EXECUTOR_SID, publisher_sid: PUBLISHER_SID,
          manifest_dir: f.manifestDir, results_dir: f.resultsDir },
        workspace: source.workspace, state_dir: f.resultsDir,
        enable_antigravity_model_runs: true },
      execute: async (_receivedSpec, executionConfig) => {
        const junction = join(executionConfig.workspace, 'escape');
        try {
          symlinkSync(outside, junction, 'junction');
          junctionCreated = true;
        } catch { return { outcome: 'SYNTHETIC_JUNCTION_UNAVAILABLE', exit_code: 0,
          scope_valid: true, diff_bytes: 0, changed_files: [] }; }
        writeFileSync(join(junction, 'escaped.mjs'), 'export const escaped = true;\n');
        return { outcome: 'SYNTHETIC_FALSE_ZERO_DIFF', exit_code: 0,
          scope_valid: true, external_effects: 'NONE', diff_bytes: 0,
          changed_files: [], model_invoked: true };
      },
    });
    if (!junctionCreated) return t.skip('the current Windows identity cannot create a synthetic junction');
    const saved = JSON.parse(readFileSync(executorResultPath(f.resultsDir,
      job.request_id, ATTEMPT_EDIT), 'utf8'));
    assert.notEqual(saved.terminal.scope_valid, true,
      'a lexical path inside the candidate must not authorize an external physical target');
    assert.equal(saved.terminal.external_effects, 'UNKNOWN');
    assert.notEqual(result.terminal_state, 'FINISHED');
    assert.equal(readFileSync(join(outside, 'escaped.mjs'), 'utf8'),
      'export const escaped = true;\n', 'the unexpected external write is preserved');
  } finally { f.dispose(); }
});

test('executor preserves ambiguity when the candidate workspace disappears before readback', async t => {
  if (process.platform !== 'win32') return t.skip('Task Scheduler identity execution is Windows-only');
  const f = fixture();
  try {
    const source = sourceRepository(f.root, 'candidate-disappears');
    const spec = 'Synthetic lost workspace; provider and model are not invoked.';
    const job = { ...modelJob(spec), schema: 6, project_id: PROJECT,
      host: hostname().toUpperCase(), kind: 'antigravity_edit',
      request_id: 'PTYSD_ANTIGRAVITY_CANDIDATE_DISAPPEARS', source_sha: source.sourceSha,
      spec_path: 'native-bridge/tasks/w2-review.md',
      spec_sha256: createHash('sha256').update(spec).digest('hex'),
      model: 'gemini-3.8-flash-high', variant: 'high', edit_paths: ['README.md'],
      source_pr: 461, goal_comment_id: 6188322050, goal_body_sha256: 'c'.repeat(64) };
    const bundle = createExecutorSourceBundle({ workspace: source.workspace,
      descriptor: f.descriptor, job, attemptId: ATTEMPT_EDIT,
      filesystemPath: localPathMap(f) });
    writeFileSync(join(f.manifestDir, `${ATTEMPT_EDIT}.pending.json`), JSON.stringify(
      makeExecutorManifest(job, spec, ATTEMPT_EDIT, bundle.sha256)), { flag: 'wx' });
    let executeCalls = 0;
    const config = { project_id: PROJECT, repo: REPO, host: hostname().toUpperCase(),
      executor_runtime: { user_sid: EXECUTOR_SID, publisher_sid: PUBLISHER_SID,
        manifest_dir: f.manifestDir, results_dir: f.resultsDir },
      workspace: source.workspace, state_dir: f.resultsDir, enable_antigravity_model_runs: true };
    const result = await executePendingManifest({ manifestDir: f.manifestDir,
      currentSid: () => EXECUTOR_SID, config,
      execute: async (_receivedSpec, executionConfig) => {
        executeCalls++;
        rmSync(executionConfig.workspace, { recursive: true, force: false });
        return { outcome: 'SYNTHETIC_CANDIDATE_REMOVED', exit_code: 0,
          scope_valid: true, diff_bytes: 0, changed_files: [], model_invoked: true,
          local_evidence: { termination_state: 'NOT_REQUESTED' } };
      },
    });
    const saved = JSON.parse(readFileSync(executorResultPath(f.resultsDir,
      job.request_id, ATTEMPT_EDIT), 'utf8'));
    assert.equal(result.terminal_state, 'BLOCKED');
    assert.equal(saved.terminal.outcome, 'EXECUTOR_EDIT_WORKSPACE_READBACK_UNKNOWN');
    assert.equal(saved.terminal.scope_valid, false);
    assert.equal(saved.terminal.external_effects, 'UNKNOWN');
    assert.equal(saved.terminal.diff_bytes, null);
    assert.equal(existsSync(candidateWorkspacePath(f.resultsDir, ATTEMPT_EDIT)), false,
      'Executor does not fabricate or recreate the missing attempt workspace');
    await assert.rejects(executePendingManifest({ manifestDir: f.manifestDir,
      currentSid: () => EXECUTOR_SID, config,
      execute: async () => { executeCalls++; throw new Error('must not replay'); },
    }), /EXECUTOR_ATTEMPT_ALREADY_RUNNING/);
    assert.equal(executeCalls, 1);
  } finally { f.dispose(); }
});

test('executor leaves an attempt unresolved when its process tree may still write', async t => {
  if (process.platform !== 'win32') return t.skip('Task Scheduler identity execution is Windows-only');
  const f = fixture();
  try {
    const source = sourceRepository(f.root, 'candidate-orphan-possible');
    const spec = 'Synthetic orphan; no real provider or model is invoked.';
    const job = { ...modelJob(spec), schema: 6, project_id: PROJECT,
      host: hostname().toUpperCase(), kind: 'antigravity_edit',
      request_id: 'PTYSD_ANTIGRAVITY_CANDIDATE_ORPHAN', source_sha: source.sourceSha,
      spec_path: 'native-bridge/tasks/w2-review.md',
      spec_sha256: createHash('sha256').update(spec).digest('hex'),
      model: 'gemini-3.8-flash-high', variant: 'high', edit_paths: ['README.md'],
      source_pr: 461, goal_comment_id: 6188322050, goal_body_sha256: 'c'.repeat(64) };
    const bundle = createExecutorSourceBundle({ workspace: source.workspace,
      descriptor: f.descriptor, job, attemptId: ATTEMPT_EDIT,
      filesystemPath: localPathMap(f) });
    writeFileSync(join(f.manifestDir, `${ATTEMPT_EDIT}.pending.json`), JSON.stringify(
      makeExecutorManifest(job, spec, ATTEMPT_EDIT, bundle.sha256)), { flag: 'wx' });
    const result = await executePendingManifest({ manifestDir: f.manifestDir,
      currentSid: () => EXECUTOR_SID,
      config: { project_id: PROJECT, repo: REPO, host: hostname().toUpperCase(),
        executor_runtime: { user_sid: EXECUTOR_SID, publisher_sid: PUBLISHER_SID,
          manifest_dir: f.manifestDir, results_dir: f.resultsDir },
        workspace: source.workspace, state_dir: f.resultsDir,
        enable_antigravity_model_runs: true },
      execute: async (_receivedSpec, executionConfig) => {
        writeFileSync(join(executionConfig.workspace, 'README.md'), 'possibly still being written\n');
        return { outcome: 'SYNTHETIC_ORPHAN', exit_code: -1, scope_valid: true,
          diff_bytes: 0, changed_files: [], model_invoked: true,
          local_evidence: { termination_state: 'ORPHAN_POSSIBLE' } };
      },
    });
    const saved = JSON.parse(readFileSync(executorResultPath(f.resultsDir,
      job.request_id, ATTEMPT_EDIT), 'utf8'));
    assert.equal(result.terminal_state, 'BLOCKED');
    assert.equal(saved.terminal.outcome,
      'EXECUTOR_EDIT_WORKSPACE_READBACK_SKIPPED_PROCESS_UNCONFIRMED');
    assert.equal(saved.terminal.external_effects, 'UNKNOWN');
    assert.equal(saved.terminal.scope_valid, false);
    assert.equal(readFileSync(join(candidateWorkspacePath(f.resultsDir, ATTEMPT_EDIT),
      'README.md'), 'utf8'), 'possibly still being written\n');
    assert.equal(existsSync(join(f.manifestDir, `${ATTEMPT_EDIT}.running.json`)), true,
      'unconfirmed model attempt is not converted into a retryable pending manifest');
  } finally { f.dispose(); }
});

test('executor result readback failure preserves the running attempt and prevents replay', async t => {
  if (process.platform !== 'win32') return t.skip('Task Scheduler identity execution is Windows-only');
  const f = fixture();
  try {
    const source = sourceRepository(f.root, 'candidate-result-readback-fails');
    const spec = 'Synthetic result readback failure; no provider is invoked.';
    const job = { ...modelJob(spec), schema: 6, project_id: PROJECT,
      host: hostname().toUpperCase(), kind: 'antigravity_edit',
      request_id: 'PTYSD_ANTIGRAVITY_RESULT_READBACK_FAILS', source_sha: source.sourceSha,
      spec_path: 'native-bridge/tasks/w2-review.md',
      spec_sha256: createHash('sha256').update(spec).digest('hex'),
      model: 'gemini-3.8-flash-high', variant: 'high', edit_paths: ['README.md'],
      source_pr: 461, goal_comment_id: 6188322050, goal_body_sha256: 'c'.repeat(64) };
    const bundle = createExecutorSourceBundle({ workspace: source.workspace,
      descriptor: f.descriptor, job, attemptId: ATTEMPT_EDIT,
      filesystemPath: localPathMap(f) });
    writeFileSync(join(f.manifestDir, `${ATTEMPT_EDIT}.pending.json`), JSON.stringify(
      makeExecutorManifest(job, spec, ATTEMPT_EDIT, bundle.sha256)), { flag: 'wx' });
    let executeCalls = 0;
    const config = { project_id: PROJECT, repo: REPO, host: hostname().toUpperCase(),
      executor_runtime: { user_sid: EXECUTOR_SID, publisher_sid: PUBLISHER_SID,
        manifest_dir: f.manifestDir, results_dir: f.resultsDir },
      workspace: source.workspace, state_dir: f.resultsDir, enable_antigravity_model_runs: true };
    await assert.rejects(executePendingManifest({ manifestDir: f.manifestDir,
      currentSid: () => EXECUTOR_SID, config,
      readPersisted: () => { throw new Error('synthetic readback denial'); },
      execute: async () => { executeCalls++; return { outcome: 'SYNTHETIC_TERMINAL',
        exit_code: 0, model_invoked: false, local_evidence: { termination_state: 'NOT_REQUESTED' } }; },
    }), /EXECUTOR_RESULT_READBACK_FAILED/);
    assert.equal(executeCalls, 1);
    assert.equal(existsSync(join(f.manifestDir, `${ATTEMPT_EDIT}.running.json`)), true);
    assert.equal(existsSync(executorResultPath(f.resultsDir, job.request_id, ATTEMPT_EDIT)), true);
    const relaunched = await executePendingManifest({ manifestDir: f.manifestDir,
      currentSid: () => EXECUTOR_SID, config,
      execute: async () => { executeCalls++; throw new Error('must not replay'); },
    });
    assert.equal(relaunched.outcome, 'NO_PENDING_EXECUTOR_MANIFEST');
    assert.equal(existsSync(join(f.manifestDir, `${ATTEMPT_EDIT}.running.json`)), true);
    assert.equal(existsSync(executorResultPath(f.resultsDir, job.request_id, ATTEMPT_EDIT)), true);
    assert.equal(executeCalls, 1);
  } finally { f.dispose(); }
});

test('executor refuses a source bundle hash mismatch without invoking OpenCode', async t => {
  if (process.platform !== 'win32') return t.skip('Task Scheduler identity execution is Windows-only');
  const f = fixture();
  try {
    const source = sourceRepository(f.root);
    const spec = 'Hash mismatch negative test; no model call is permitted.';
    const job = { ...modelJob(spec), source_sha: source.sourceSha,
      request_id: 'PTYSD_NATIVE_SOURCE_HASH_NEGATIVE' };
    createExecutorSourceBundle({ workspace: source.workspace, descriptor: f.descriptor,
      job, attemptId: ATTEMPT, filesystemPath: localPathMap(f) });
    writeFileSync(join(f.manifestDir, `${ATTEMPT}.pending.json`), JSON.stringify(
      makeExecutorManifest(job, spec, ATTEMPT, 'f'.repeat(64))), { flag: 'wx' });
    let calls = 0;
    const outcome = await executePendingManifest({ manifestDir: f.descriptor.manifest_dir,
      currentSid: () => EXECUTOR_SID,
      config: { project_id: PROJECT, repo: REPO, host: hostname().toUpperCase(),
        executor_runtime: { user_sid: EXECUTOR_SID, publisher_sid: PUBLISHER_SID,
          manifest_dir: f.descriptor.manifest_dir, results_dir: f.descriptor.results_dir },
        workspace: source.workspace, state_dir: f.descriptor.results_dir },
      execute: async () => { calls++; throw new Error('MUST_NOT_INVOKE'); },
    });
    assert.equal(calls, 0);
    assert.equal(outcome.terminal_state, 'BLOCKED');
    const saved = JSON.parse(readFileSync(executorResultPath(f.resultsDir,
      job.request_id, ATTEMPT), 'utf8'));
    assert.match(saved.terminal.outcome,
      /CANDIDATE_WORKSPACE_SETUP_BLOCKED_CANDIDATE_SOURCE_BUNDLE_HASH_MISMATCH/);
    assert.equal(existsSync(candidateWorkspacePath(f.resultsDir, ATTEMPT)), false);
  } finally { f.dispose(); }
});

test('executor refuses W1 and W2 edit manifests without an attempt-pinned workspace', async t => {
  if (process.platform !== 'win32') return t.skip('Task Scheduler identity execution is Windows-only');
  for (const lane of ['opencode', 'antigravity']) {
    const f = fixture();
    try {
      const source = sourceRepository(f.root, `source-${lane}`);
      const spec = `Synthetic ${lane} edit; no model invocation is permitted.`;
      const baseJob = { ...modelJob(spec), source_sha: source.sourceSha,
        request_id: `PTYSD_${lane.toUpperCase()}_REQUIRES_SOURCE_BUNDLE_20261022` };
      const job = lane === 'opencode'
        ? { ...baseJob, schema: 4, kind: 'opencode_edit', edit_paths: ['README.md'] }
        : { schema: 6, project_id: PROJECT, host: hostname().toUpperCase(),
          request_id: baseJob.request_id, kind: 'antigravity_edit', source_sha: source.sourceSha,
          spec_path: 'native-bridge/tasks/w2-review.md', spec_sha256: baseJob.spec_sha256,
          model: 'gemini-3.8-flash-high', variant: 'high', edit_paths: ['README.md'],
          source_pr: 461, goal_comment_id: 6188322050, goal_body_sha256: 'c'.repeat(64) };
      writeFileSync(join(f.manifestDir, `${ATTEMPT}.pending.json`), JSON.stringify(
        makeExecutorManifest(job, spec, ATTEMPT)), { flag: 'wx' });
      let modelCalls = 0;
      const outcome = await executePendingManifest({ manifestDir: f.descriptor.manifest_dir,
        currentSid: () => EXECUTOR_SID,
        config: { project_id: PROJECT, repo: REPO, host: hostname().toUpperCase(),
          executor_runtime: { user_sid: EXECUTOR_SID, publisher_sid: PUBLISHER_SID,
            manifest_dir: f.descriptor.manifest_dir, results_dir: f.descriptor.results_dir },
          workspace: source.workspace, state_dir: f.descriptor.results_dir,
          ...(lane === 'opencode' ? { enable_v2_model_runs: true } : { enable_antigravity_model_runs: true }) },
        execute: async () => { modelCalls++; throw new Error('MODEL_MUST_NOT_RUN'); },
      });
      assert.equal(modelCalls, 0, `${lane} cannot execute against the configured source workspace`);
      assert.equal(outcome.terminal_state, 'BLOCKED');
      const saved = JSON.parse(readFileSync(executorResultPath(f.resultsDir,
        job.request_id, ATTEMPT), 'utf8'));
      assert.equal(saved.terminal.outcome, 'EXECUTOR_EDIT_SOURCE_BUNDLE_REQUIRED');
      assert.equal(saved.terminal.model_invoked, false);
      assert.equal(saved.terminal.coding_state, 'NOT_STARTED');
      assert.equal(existsSync(candidateWorkspacePath(f.resultsDir, ATTEMPT)), false);
      assert.equal(readFileSync(join(source.workspace, 'README.md'), 'utf8'), 'pinned source fixture\n');
    } finally { f.dispose(); }
  }
});

test('Worker will not start an edit attempt when its Executor lacks per-attempt source bundles', async () => {
  const f = fixture();
  try {
    const source = sourceRepository(f.root);
    const spec = 'Synthetic edit; the executor must be configured for an attempt-pinned workspace.';
    const job = { ...modelJob(spec), schema: 4, kind: 'opencode_edit',
      request_id: 'PTYSD_EXECUTOR_BUNDLE_REQUIRED_BEFORE_START_20261022',
      source_sha: source.sourceSha, edit_paths: ['README.md'] };
    const comments = [{ id: 1, body: JOB_MARKER + JSON.stringify(job),
      user: { login: 'dispatcher' } }];
    const receipts = [];
    let bundleCalls = 0, dispatchCalls = 0, modelCalls = 0;
    const config = { repo: REPO, project_id: PROJECT, host: hostname().toUpperCase(), issue: 407,
      workspace: source.workspace, state_dir: f.resultsDir, dispatchers: ['dispatcher'],
      allowed_models: { 'opencode/spark': ['high'] }, enable_v2_model_runs: true,
      executor: { ...f.descriptor, source_bundle_per_attempt: false } };
    const result = await runWorker(config, {
      apiRead(uri) {
        if (uri === 'user') return { login: 'native-worker' };
        if (uri.endsWith('/issues/407'))
          return { title: '[PTYSD-NATIVE] OpenCode dispatch and receipts', state: 'open' };
        if (uri.includes('/git/ref/heads/main')) return { object: { sha: source.sourceSha } };
        const match = uri.match(/\/issues\/comments\/(\d+)$/);
        if (match) return comments.find(comment => comment.id === Number(match[1]));
        if (uri.includes('/contents/')) return { encoding: 'base64',
          content: Buffer.from(spec, 'utf8').toString('base64') };
        throw new Error(`UNEXPECTED_API_READ_${uri}`);
      },
      commentsRead: () => comments,
      goalCommentsRead: () => [],
      assertExecutorTaskReady: () => ({ ready: true }),
      createExecutorSourceBundle: () => { bundleCalls++; throw new Error('MUST_NOT_CREATE_BUNDLE'); },
      dispatchToExecutor: () => { dispatchCalls++; throw new Error('MUST_NOT_DISPATCH'); },
      runPlan: async () => { modelCalls++; throw new Error('MUST_NOT_RUN_MODEL'); },
      writeReceipt: (_config, receipt, login) => {
        receipts.push(receipt);
        comments.push({ id: comments.length + 1, body: RECEIPT_MARKER + JSON.stringify(receipt),
          user: { login } });
      },
      observationDependencies: { collectWindowsObservation: () => ({ status: 'UNKNOWN' }) },
      log: () => {},
    });
    assert.equal(result.state, 'WAITING_ELIGIBILITY');
    assert.equal(bundleCalls, 0);
    assert.equal(dispatchCalls, 0);
    assert.equal(modelCalls, 0);
    assert.equal(receipts.length, 0, 'a malformed edit executor is rejected before STARTED');
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
    const source = sourceRepository(root);
    const workspace = source.workspace;
    const publisherState = join(root, 'publisher-state');
    const manifestDir = join(root, 'executor-inbox');
    const resultsDir = join(root, 'executor-results');
    for (const path of [publisherState, manifestDir, resultsDir]) mkdirSync(path);
    const spec = 'Bounded synthetic edit to the README fixture; this dispatcher test never invokes a model.';
    const job = { ...modelJob(spec), schema: 4, request_id: 'PTYSD_NATIVE_V2_EDIT_DISPATCH_20261017',
      kind: 'opencode_edit', edit_paths: ['README.md'], source_sha: source.sourceSha };
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
        publisher_sid: PUBLISHER_SID, wscript_path: 'C:\\Windows\\System32\\wscript.exe',
        launcher_path: 'C:\\ProgramData\\PTYSDNativeBridge\\HiddenCodexExecutor.vbs',
        manifest_dir: manifestDir, results_dir: resultsDir,
        source_bundle_per_attempt: true,
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
      apiRead, commentsRead: () => comments, goalCommentsRead: () => [],
      writeReceipt: (_config, value, login) => {
        const body = RECEIPT_MARKER + JSON.stringify(value);
        comments.push({ id: nextId++, body, user: { login } });
      },
      assertExecutorTaskReady: descriptor => { verifyCalls++; assert.equal(descriptor, config.executor); },
      dispatchToExecutor: (_descriptor, envelope) => {
        dispatchCalls++;
        assert.equal(envelope.job.request_id, job.request_id);
        assert.equal(envelope.spec, spec);
        assert.match(envelope.source_bundle_sha256, /^[a-f0-9]{64}$/);
        assert.ok(existsSync(candidateBundlePath(manifestDir, envelope.attempt_id)));
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

test('source-bundle qualification failure leaves OpenCode unstarted and allows an independent ping', async () => {
  const root = mkdtempSync(join(homedir(), '.ptysd-worker-bundle-wait-'));
  try {
    const workspace = join(root, 'workspace');
    const publisherState = join(root, 'publisher-state');
    const manifestDir = join(root, 'executor-inbox');
    const resultsDir = join(root, 'executor-results');
    for (const path of [workspace, publisherState, manifestDir, resultsDir]) mkdirSync(path);
    const spec = 'This source workspace is deliberately not a Git repository.';
    const job = modelJob(spec);
    job.host = hostname().toUpperCase();
    const ping = { schema: 1, project_id: PROJECT, host: job.host,
      request_id: 'PTYSD_NATIVE_BUNDLE_WAIT_PING', kind: 'ping', source_sha: job.source_sha,
      spec_path: null, spec_sha256: null };
    const comments = [
      { id: 1, body: JOB_MARKER + JSON.stringify(job), user: { login: 'dispatcher' } },
      { id: 2, body: JOB_MARKER + JSON.stringify(ping), user: { login: 'dispatcher' } },
    ];
    let nextId = 3;
    let dispatchCalls = 0;
    const config = {
      repo: REPO, project_id: PROJECT, host: job.host, issue: 101,
      workspace, state_dir: publisherState, dispatchers: ['dispatcher'],
      allowed_models: { 'opencode/spark': ['high'] }, enable_v2_model_runs: true,
      executor: { task_name: '\\PTYSD\\OpenCodeExecutor', user_sid: EXECUTOR_SID,
        publisher_sid: PUBLISHER_SID, wscript_path: 'C:\\Windows\\System32\\wscript.exe',
        launcher_path: 'C:\\ProgramData\\PTYSDNativeBridge\\HiddenCodexExecutor.vbs',
        manifest_dir: manifestDir, results_dir: resultsDir,
        source_bundle_per_attempt: true,
        node_bin: 'C:\\Program Files\\nodejs\\node.exe',
        script_path: 'C:\\Users\\PTYSDExecutor\\executor.mjs',
        config_path: 'C:\\Users\\PTYSDExecutor\\executor.json',
        working_directory: 'C:\\Users\\PTYSDExecutor\\Work' },
    };
    const apiRead = uri => {
      if (uri === 'user') return { login: 'native-worker' };
      if (uri.endsWith('/issues/101')) return { title: '[PTYSD-NATIVE] OpenCode dispatch and receipts', state: 'open' };
      if (uri.includes('/git/ref/heads/main')) return { object: { sha: job.source_sha } };
      const comment = uri.match(/\/issues\/comments\/(\d+)$/);
      if (comment) return comments.find(item => item.id === Number(comment[1]));
      if (uri.includes('/contents/')) return { encoding: 'base64',
        content: Buffer.from(spec, 'utf8').toString('base64') };
      throw new Error(`UNEXPECTED_API_READ_${uri}`);
    };
    const adapters = {
      apiRead, commentsRead: () => comments, goalCommentsRead: () => [],
      writeReceipt: (_config, value, login) => {
        comments.push({ id: nextId++, body: RECEIPT_MARKER + JSON.stringify(value), user: { login } });
      },
      assertExecutorTaskReady: () => ({ ready: true }),
      dispatchToExecutor: () => { dispatchCalls++; throw new Error('OpenCode must not be dispatched'); },
      log: () => {},
    };
    const result = await runWorker(config, adapters);
    assert.equal(result.state, 'FINISHED', 'independent ping can complete after OpenCode waits');
    assert.equal(dispatchCalls, 0);
    const receipts = comments.map(item => parseReceipt(item.body)).filter(Boolean);
    assert.deepEqual(receipts.map(item => item.request_id),
      ['PTYSD_NATIVE_BUNDLE_WAIT_PING', 'PTYSD_NATIVE_BUNDLE_WAIT_PING']);
    assert.deepEqual(receipts.map(item => item.state), ['STARTED', 'FINISHED']);
    assert.equal(readdirSync(manifestDir).some(name => name.endsWith('.bundle')), false,
      'failed source qualification leaves no dispatch bundle');
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
        publisher_sid: PUBLISHER_SID, wscript_path: 'C:\\Windows\\System32\\wscript.exe',
        launcher_path: 'C:\\ProgramData\\PTYSDNativeBridge\\HiddenCodexExecutor.vbs',
        manifest_dir: 'C:\\PTYSDTest\\inbox',
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
      apiRead, commentsRead: () => comments, goalCommentsRead: () => [],
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

test('effect-free OpenCode preflight WAITING persists a publisher-readable receipt without a terminal model result', async t => {
  if (process.platform !== 'win32') return t.skip('Task Scheduler identity execution is Windows-only');
  const f = fixture();
  try {
    const workspace = join(f.root, 'workspace');
    mkdirSync(workspace);
    const spec = 'Synthetic credential-readiness transition; never invoke a model.';
    const job = { ...modelJob(spec), schema: 4, kind: 'opencode_edit',
      request_id: 'PTYSD_EXECUTOR_PREFLIGHT_WAIT_20261017', edit_paths: ['README.md'] };
    const manifest = makeExecutorManifest(job, spec, ATTEMPT);
    const pendingPath = join(f.manifestDir, `${ATTEMPT}.pending.json`);
    const originalBytes = Buffer.from(JSON.stringify(manifest));
    writeFileSync(pendingPath, originalBytes, { flag: 'wx' });
    const outcome = await executePendingManifest({
      manifestDir: f.descriptor.manifest_dir,
      currentSid: () => EXECUTOR_SID,
      config: { project_id: PROJECT, repo: REPO, host: hostname().toUpperCase(),
        executor_runtime: { user_sid: EXECUTOR_SID, publisher_sid: PUBLISHER_SID,
          manifest_dir: f.descriptor.manifest_dir, results_dir: f.descriptor.results_dir },
        workspace, state_dir: f.descriptor.results_dir, enable_v2_model_runs: false },
    });
    assert.equal(outcome.terminal_state, 'WAITING');
    assert.equal(outcome.outcome, 'EXECUTOR_WAITING_PREFLIGHT_PERSISTED');
    assert.deepEqual(readdirSync(f.manifestDir), [`${ATTEMPT}.running.json`]);
    assert.deepEqual(readFileSync(join(f.manifestDir, `${ATTEMPT}.running.json`)), originalBytes,
      'the exact running attempt remains available until the publisher reads its WAITING result');
    const resultPath = executorResultPath(f.resultsDir, job.request_id, ATTEMPT);
    const persisted = JSON.parse(readFileSync(resultPath, 'utf8'));
    assert.equal(persisted.terminal.state, 'WAITING');
    assert.equal(persisted.terminal.outcome, 'V2_MODEL_EXECUTION_NOT_YET_APPROVED');
    assert.equal(persisted.terminal.eligibility_state, 'WAITING');
    assert.equal(persisted.terminal.model_invoked, false);
    assert.equal(persisted.local_evidence, null);
    assert.equal(existsSync(pendingPath), false,
      'preflight wait does not create a second runnable manifest for the same attempt');
  } finally { f.dispose(); }
});

test('pending OpenCode recovery triggers only the exact same attempt and refuses a running attempt', () => {
  const f = fixture();
  try {
    const filesystemPath = localPathMap(f);
    const spec = 'Synthetic readiness retry; no model invocation.';
    const job = { ...modelJob(spec), schema: 4, kind: 'opencode_edit',
      request_id: 'PTYSD_EXECUTOR_PENDING_RECOVERY_20261017', edit_paths: ['README.md'] };
    const manifest = makeExecutorManifest(job, spec, ATTEMPT);
    const pendingPath = join(f.manifestDir, `${ATTEMPT}.pending.json`);
    const originalBytes = Buffer.from(JSON.stringify(manifest));
    writeFileSync(pendingPath, originalBytes, { flag: 'wx' });
    let starts = 0;
    const dependencies = { expectedJob: job, currentSid: f.currentSid,
      readTaskXml: f.readTaskXml, filesystemPath,
      runTask: taskName => { assert.equal(taskName, f.descriptor.task_name); starts++; } };

    const result = triggerPendingExecutorAttempt(f.descriptor, ATTEMPT, dependencies);
    assert.equal(result.outcome, 'EXECUTOR_PENDING_ATTEMPT_TRIGGERED_NOT_ACCEPTANCE');
    assert.equal(result.attempt_id, ATTEMPT);
    assert.equal(starts, 1);
    assert.deepEqual(readFileSync(pendingPath), originalBytes,
      'dispatch retry does not rewrite or replace the immutable attempt manifest');
    assert.equal(existsSync(executorResultPath(f.resultsDir, job.request_id, ATTEMPT)), false);

    assert.equal(claimPendingManifest(f.manifestDir), join(f.manifestDir, `${ATTEMPT}.running.json`));
    assert.throws(() => triggerPendingExecutorAttempt(f.descriptor, ATTEMPT, dependencies),
      /EXECUTOR_ATTEMPT_NOT_EXACT_PENDING/);
    assert.equal(starts, 1, 'an attempt already claimed by the executor is never started again');
  } finally { f.dispose(); }
});

test('executor rejects registered project root writes when the attempt candidate has no diff', async t => {
  if (process.platform !== 'win32') return t.skip('Task Scheduler identity execution is Windows-only');
  const f = fixture();
  try {
    const source = sourceRepository(f.root, 'registered-root-mismatch');
    const spec = 'Synthetic root mismatch; no provider or model is invoked by this test.';
    const job = { ...modelJob(spec), schema: 6, project_id: PROJECT,
      host: hostname().toUpperCase(), kind: 'antigravity_edit',
      request_id: 'PTYSD_ANTIGRAVITY_REGISTERED_ROOT_MISMATCH',
      source_sha: source.sourceSha, spec_path: 'native-bridge/tasks/w2-review.md',
      spec_sha256: createHash('sha256').update(spec).digest('hex'),
      model: 'gemini-3.8-flash-high', variant: 'high', edit_paths: ['README.md'],
      source_pr: 461, goal_comment_id: 6188322050, goal_body_sha256: 'c'.repeat(64) };
    const bundle = createExecutorSourceBundle({ workspace: source.workspace,
      descriptor: f.descriptor, job, attemptId: ATTEMPT_EDIT,
      filesystemPath: localPathMap(f) });
    writeFileSync(join(f.manifestDir, `${ATTEMPT_EDIT}.pending.json`), JSON.stringify(
      makeExecutorManifest(job, spec, ATTEMPT_EDIT, bundle.sha256)), { flag: 'wx' });
    let executeCalls = 0;
    const result = await executePendingManifest({ manifestDir: f.descriptor.manifest_dir,
      currentSid: () => EXECUTOR_SID,
      config: { project_id: PROJECT, repo: REPO, host: hostname().toUpperCase(),
        executor_runtime: { user_sid: EXECUTOR_SID, publisher_sid: PUBLISHER_SID,
          manifest_dir: f.descriptor.manifest_dir, results_dir: f.descriptor.results_dir },
        workspace: source.workspace, state_dir: f.descriptor.results_dir,
        enable_antigravity_model_runs: true },
      execute: async (_receivedSpec, executionConfig) => {
        executeCalls++;
        assert.notEqual(executionConfig.workspace, source.workspace);
        writeFileSync(join(source.workspace, 'README.md'), 'written to registered project root\n');
        return { outcome: 'SYNTHETIC_ZERO_CANDIDATE_DIFF', exit_code: 0,
          scope_valid: true, external_effects: 'NONE', diff_bytes: 0,
          changed_files_count: 0, model_invoked: true };
      },
    });
    const saved = JSON.parse(readFileSync(executorResultPath(f.resultsDir,
      job.request_id, ATTEMPT_EDIT), 'utf8'));
    assert.equal(executeCalls, 1);
    assert.equal(saved.terminal.outcome, 'EXECUTOR_EDIT_REGISTERED_ROOT_CHANGED');
    assert.equal(saved.terminal.scope_valid, false);
    assert.equal(saved.terminal.external_effects, 'UNKNOWN');
    assert.ok(parseReceipt(RECEIPT_MARKER + JSON.stringify(saved.terminal)),
      'the scope-failure receipt remains valid under the published schema');
    assert.equal(saved.terminal.diff_bytes, null,
      'a zero candidate diff must not hide writes to the configured project root');
    assert.equal(readFileSync(join(source.workspace, 'README.md'), 'utf8'),
      'written to registered project root\n', 'unexpected effects are preserved for recovery');
    assert.equal(result.terminal_state, 'BLOCKED');
  } finally { f.dispose(); }
});

test('executor blocks a dirty registered-root path before starting a scoped attempt', async t => {
  if (process.platform !== 'win32') return t.skip('Task Scheduler identity execution is Windows-only');
  const f = fixture();
  try {
    const source = sourceRepository(f.root, 'registered-root-dirty-conflict');
    writeFileSync(join(source.workspace, 'README.md'), 'preserved pre-existing W2 work\n');
    const spec = 'Synthetic dirty-root conflict; no provider or model is invoked.';
    const job = { ...modelJob(spec), schema: 6, project_id: PROJECT,
      host: hostname().toUpperCase(), kind: 'antigravity_edit',
      request_id: 'PTYSD_ANTIGRAVITY_DIRTY_ROOT_SCOPE_CONFLICT', source_sha: source.sourceSha,
      spec_path: 'native-bridge/tasks/w2-review.md',
      spec_sha256: createHash('sha256').update(spec).digest('hex'),
      model: 'gemini-3.8-flash-high', variant: 'high', edit_paths: ['README.md'],
      source_pr: 461, goal_comment_id: 6188322050, goal_body_sha256: 'c'.repeat(64) };
    const bundle = createExecutorSourceBundle({ workspace: source.workspace,
      descriptor: f.descriptor, job, attemptId: ATTEMPT_EDIT,
      filesystemPath: localPathMap(f) });
    writeFileSync(join(f.manifestDir, `${ATTEMPT_EDIT}.pending.json`), JSON.stringify(
      makeExecutorManifest(job, spec, ATTEMPT_EDIT, bundle.sha256)), { flag: 'wx' });
    let executeCalls = 0;
    const result = await executePendingManifest({ manifestDir: f.manifestDir,
      currentSid: () => EXECUTOR_SID,
      config: { project_id: PROJECT, repo: REPO, host: hostname().toUpperCase(),
        executor_runtime: { user_sid: EXECUTOR_SID, publisher_sid: PUBLISHER_SID,
          manifest_dir: f.manifestDir, results_dir: f.resultsDir },
        workspace: source.workspace, state_dir: f.resultsDir,
        enable_antigravity_model_runs: true },
      execute: async () => { executeCalls++; throw new Error('must not start a conflicted write'); },
    });
    const saved = JSON.parse(readFileSync(executorResultPath(f.resultsDir,
      job.request_id, ATTEMPT_EDIT), 'utf8'));
    assert.equal(executeCalls, 0);
    assert.equal(result.terminal_state, 'BLOCKED');
    assert.equal(saved.terminal.outcome, 'EXECUTOR_EDIT_WORKSPACE_PRECHECK_BLOCKED');
    assert.equal(saved.local_evidence.executor_workspace_guard.error,
      'EXECUTOR_EDIT_REGISTERED_ROOT_DIRTY_SCOPE_CONFLICT');
    assert.equal(saved.terminal.model_invoked, false);
    assert.equal(readFileSync(join(source.workspace, 'README.md'), 'utf8'),
      'preserved pre-existing W2 work\n');
  } finally { f.dispose(); }
});

test('executor reconciles tracked, untracked, and ignored candidate changes against the captured diff', async t => {
  if (process.platform !== 'win32') return t.skip('Task Scheduler identity execution is Windows-only');
  const f = fixture();
  try {
    const source = sourceRepository(f.root, 'candidate-three-file-diff');
    writeFileSync(join(source.workspace, '.gitignore'), 'dist/\n');
    source.git(['add', '.gitignore']);
    source.git(['commit', '--quiet', '-m', 'add ignored output fixture']);
    writeFileSync(join(source.workspace, 'package.json'), '{"name":"pinned"}\n');
    source.git(['add', 'package.json']);
    source.git(['commit', '--quiet', '-m', 'add tracked package fixture']);
    const sourceSha = source.git(['rev-parse', 'HEAD']).trim();
    const spec = 'Synthetic candidate diff; provider and model are not invoked.';
    const paths = ['package.json', 'src/w2-first.mjs', 'tests/w2-second.test.mjs',
      'dist/generated.w2.mjs'];
    const job = { ...modelJob(spec), schema: 6, project_id: PROJECT,
      host: hostname().toUpperCase(), kind: 'antigravity_edit',
      request_id: 'PTYSD_ANTIGRAVITY_CANDIDATE_THREE_FILE_DIFF', source_sha: sourceSha,
      spec_path: 'native-bridge/tasks/w2-review.md',
      spec_sha256: createHash('sha256').update(spec).digest('hex'),
      model: 'gemini-3.8-flash-high', variant: 'high', edit_paths: paths,
      source_pr: 461, goal_comment_id: 6188322050, goal_body_sha256: 'c'.repeat(64) };
    const bundle = createExecutorSourceBundle({ workspace: source.workspace,
      descriptor: f.descriptor, job, attemptId: ATTEMPT_EDIT,
      filesystemPath: localPathMap(f) });
    writeFileSync(join(f.manifestDir, `${ATTEMPT_EDIT}.pending.json`), JSON.stringify(
      makeExecutorManifest(job, spec, ATTEMPT_EDIT, bundle.sha256)), { flag: 'wx' });
    let captured;
    const result = await executePendingManifest({ manifestDir: f.manifestDir,
      currentSid: () => EXECUTOR_SID,
      config: { project_id: PROJECT, repo: REPO, host: hostname().toUpperCase(),
        executor_runtime: { user_sid: EXECUTOR_SID, publisher_sid: PUBLISHER_SID,
          manifest_dir: f.manifestDir, results_dir: f.resultsDir },
        workspace: source.workspace, state_dir: f.resultsDir,
        enable_antigravity_model_runs: true },
      execute: async (_receivedSpec, executionConfig) => {
        mkdirSync(join(executionConfig.workspace, 'src'));
        mkdirSync(join(executionConfig.workspace, 'tests'));
        mkdirSync(join(executionConfig.workspace, 'dist'));
        writeFileSync(join(executionConfig.workspace, 'package.json'), '{"name":"edited"}\n');
        writeFileSync(join(executionConfig.workspace, paths[1]), 'export const w2 = true;\n');
        writeFileSync(join(executionConfig.workspace, paths[2]), 'import test from "node:test";\n');
        writeFileSync(join(executionConfig.workspace, paths[3]), 'export const ignored = true;\n');
        captured = await captureScopedEditDiff({ workspace: executionConfig.workspace,
          state_dir: f.resultsDir, job, attempt_id: ATTEMPT_EDIT });
        return { outcome: 'SYNTHETIC_SCOPED_DIFF_UNVERIFIED', exit_code: 0,
          scope_valid: captured.scope_valid, diff_sha256: captured.sha256,
          diff_bytes: captured.bytes, changed_files: captured.changed_files,
          local_evidence: { edit_diff: { file: captured.file, sha256: captured.sha256,
            bytes: captured.bytes, changed_files: captured.changed_files,
            allowed_paths: paths, scope_valid: captured.scope_valid } } };
      },
    });
    const saved = JSON.parse(readFileSync(executorResultPath(f.resultsDir,
      job.request_id, ATTEMPT_EDIT), 'utf8'));
    assert.equal(result.terminal_state, 'FINISHED');
    assert.equal(captured.scope_valid, true);
    assert.equal(saved.terminal.scope_valid, true);
    assert.equal(saved.terminal.diff_sha256, captured.sha256);
    assert.equal(saved.terminal.diff_bytes, captured.bytes);
    assert.equal(saved.terminal.changed_files_count, 4);
    assert.deepEqual(saved.local_evidence.edit_diff.changed_files.slice().sort(), paths.slice().sort());
    assert.match(readFileSync(join(f.resultsDir, captured.file), 'utf8'), /dist\/generated\.w2\.mjs/);
    assert.equal(saved.local_evidence.executor_workspace_guard.readback, 'COMPLETE');
    assert.equal(saved.local_evidence.executor_workspace_guard.registered_root_state_sha256,
      saved.local_evidence.executor_workspace_guard.registered_root_after_sha256);
    assert.equal(saved.terminal.task_acceptance, 'UNKNOWN',
      'captured source diff is not semantic or CI acceptance');
    cleanupExecutorAttempt({ ...f.descriptor, manifest_dir: f.manifestDir,
      results_dir: f.resultsDir }, ATTEMPT_EDIT);
  } finally { f.dispose(); }
});

test('executor fails closed when a candidate write traverses a junction outside its physical root', async t => {
  if (process.platform !== 'win32') return t.skip('NTFS junction verification is Windows-only');
  const f = fixture();
  try {
    const source = sourceRepository(f.root, 'candidate-junction-escape');
    const spec = 'Synthetic junction escape; no provider or model is invoked.';
    const job = { ...modelJob(spec), schema: 6, project_id: PROJECT,
      host: hostname().toUpperCase(), kind: 'antigravity_edit',
      request_id: 'PTYSD_ANTIGRAVITY_JUNCTION_ESCAPE', source_sha: source.sourceSha,
      spec_path: 'native-bridge/tasks/w2-review.md',
      spec_sha256: createHash('sha256').update(spec).digest('hex'),
      model: 'gemini-3.8-flash-high', variant: 'high', edit_paths: ['README.md'],
      source_pr: 461, goal_comment_id: 6188322050, goal_body_sha256: 'c'.repeat(64) };
    const bundle = createExecutorSourceBundle({ workspace: source.workspace,
      descriptor: f.descriptor, job, attemptId: ATTEMPT_EDIT,
      filesystemPath: localPathMap(f) });
    writeFileSync(join(f.manifestDir, `${ATTEMPT_EDIT}.pending.json`), JSON.stringify(
      makeExecutorManifest(job, spec, ATTEMPT_EDIT, bundle.sha256)), { flag: 'wx' });
    let junctionCreated = false;
    const outside = join(f.root, 'outside-root');
    mkdirSync(outside);
    const result = await executePendingManifest({ manifestDir: f.manifestDir,
      currentSid: () => EXECUTOR_SID,
      config: { project_id: PROJECT, repo: REPO, host: hostname().toUpperCase(),
        executor_runtime: { user_sid: EXECUTOR_SID, publisher_sid: PUBLISHER_SID,
          manifest_dir: f.manifestDir, results_dir: f.resultsDir },
        workspace: source.workspace, state_dir: f.resultsDir,
        enable_antigravity_model_runs: true },
      execute: async (_receivedSpec, executionConfig) => {
        const junction = join(executionConfig.workspace, 'escape');
        try {
          symlinkSync(outside, junction, 'junction');
          junctionCreated = true;
        } catch { return { outcome: 'SYNTHETIC_JUNCTION_UNAVAILABLE', exit_code: 0,
          scope_valid: true, diff_bytes: 0, changed_files: [] }; }
        writeFileSync(join(junction, 'escaped.mjs'), 'export const escaped = true;\n');
        return { outcome: 'SYNTHETIC_FALSE_ZERO_DIFF', exit_code: 0,
          scope_valid: true, external_effects: 'NONE', diff_bytes: 0,
          changed_files: [], model_invoked: true };
      },
    });
    if (!junctionCreated) return t.skip('the current Windows identity cannot create a synthetic junction');
    const saved = JSON.parse(readFileSync(executorResultPath(f.resultsDir,
      job.request_id, ATTEMPT_EDIT), 'utf8'));
    assert.notEqual(saved.terminal.scope_valid, true,
      'a lexical path inside the candidate must not authorize an external physical target');
    assert.equal(saved.terminal.external_effects, 'UNKNOWN');
    assert.notEqual(result.terminal_state, 'FINISHED');
    assert.equal(readFileSync(join(outside, 'escaped.mjs'), 'utf8'),
      'export const escaped = true;\n', 'the unexpected external write is preserved');
  } finally { f.dispose(); }
});

test('executor preserves ambiguity when the candidate workspace disappears before readback', async t => {
  if (process.platform !== 'win32') return t.skip('Task Scheduler identity execution is Windows-only');
  const f = fixture();
  try {
    const source = sourceRepository(f.root, 'candidate-disappears');
    const spec = 'Synthetic lost workspace; provider and model are not invoked.';
    const job = { ...modelJob(spec), schema: 6, project_id: PROJECT,
      host: hostname().toUpperCase(), kind: 'antigravity_edit',
      request_id: 'PTYSD_ANTIGRAVITY_CANDIDATE_DISAPPEARS', source_sha: source.sourceSha,
      spec_path: 'native-bridge/tasks/w2-review.md',
      spec_sha256: createHash('sha256').update(spec).digest('hex'),
      model: 'gemini-3.8-flash-high', variant: 'high', edit_paths: ['README.md'],
      source_pr: 461, goal_comment_id: 6188322050, goal_body_sha256: 'c'.repeat(64) };
    const bundle = createExecutorSourceBundle({ workspace: source.workspace,
      descriptor: f.descriptor, job, attemptId: ATTEMPT_EDIT,
      filesystemPath: localPathMap(f) });
    writeFileSync(join(f.manifestDir, `${ATTEMPT_EDIT}.pending.json`), JSON.stringify(
      makeExecutorManifest(job, spec, ATTEMPT_EDIT, bundle.sha256)), { flag: 'wx' });
    let executeCalls = 0;
    const config = { project_id: PROJECT, repo: REPO, host: hostname().toUpperCase(),
      executor_runtime: { user_sid: EXECUTOR_SID, publisher_sid: PUBLISHER_SID,
        manifest_dir: f.manifestDir, results_dir: f.resultsDir },
      workspace: source.workspace, state_dir: f.resultsDir, enable_antigravity_model_runs: true };
    const result = await executePendingManifest({ manifestDir: f.manifestDir,
      currentSid: () => EXECUTOR_SID, config,
      execute: async (_receivedSpec, executionConfig) => {
        executeCalls++;
        rmSync(executionConfig.workspace, { recursive: true, force: false });
        return { outcome: 'SYNTHETIC_CANDIDATE_REMOVED', exit_code: 0,
          scope_valid: true, diff_bytes: 0, changed_files: [], model_invoked: true,
          local_evidence: { termination_state: 'NOT_REQUESTED' } };
      },
    });
    const saved = JSON.parse(readFileSync(executorResultPath(f.resultsDir,
      job.request_id, ATTEMPT_EDIT), 'utf8'));
    assert.equal(result.terminal_state, 'BLOCKED');
    assert.equal(saved.terminal.outcome, 'EXECUTOR_EDIT_WORKSPACE_READBACK_UNKNOWN');
    assert.equal(saved.terminal.scope_valid, false);
    assert.equal(saved.terminal.external_effects, 'UNKNOWN');
    assert.equal(saved.terminal.diff_bytes, null);
    assert.equal(existsSync(candidateWorkspacePath(f.resultsDir, ATTEMPT_EDIT)), false,
      'Executor does not fabricate or recreate the missing attempt workspace');
    await assert.rejects(executePendingManifest({ manifestDir: f.manifestDir,
      currentSid: () => EXECUTOR_SID, config,
      execute: async () => { executeCalls++; throw new Error('must not replay'); },
    }), /EXECUTOR_ATTEMPT_ALREADY_RUNNING/);
    assert.equal(executeCalls, 1);
  } finally { f.dispose(); }
});

test('executor leaves an attempt unresolved when its process tree may still write', async t => {
  if (process.platform !== 'win32') return t.skip('Task Scheduler identity execution is Windows-only');
  const f = fixture();
  try {
    const source = sourceRepository(f.root, 'candidate-orphan-possible');
    const spec = 'Synthetic orphan; no real provider or model is invoked.';
    const job = { ...modelJob(spec), schema: 6, project_id: PROJECT,
      host: hostname().toUpperCase(), kind: 'antigravity_edit',
      request_id: 'PTYSD_ANTIGRAVITY_CANDIDATE_ORPHAN', source_sha: source.sourceSha,
      spec_path: 'native-bridge/tasks/w2-review.md',
      spec_sha256: createHash('sha256').update(spec).digest('hex'),
      model: 'gemini-3.8-flash-high', variant: 'high', edit_paths: ['README.md'],
      source_pr: 461, goal_comment_id: 6188322050, goal_body_sha256: 'c'.repeat(64) };
    const bundle = createExecutorSourceBundle({ workspace: source.workspace,
      descriptor: f.descriptor, job, attemptId: ATTEMPT_EDIT,
      filesystemPath: localPathMap(f) });
    writeFileSync(join(f.manifestDir, `${ATTEMPT_EDIT}.pending.json`), JSON.stringify(
      makeExecutorManifest(job, spec, ATTEMPT_EDIT, bundle.sha256)), { flag: 'wx' });
    const result = await executePendingManifest({ manifestDir: f.manifestDir,
      currentSid: () => EXECUTOR_SID,
      config: { project_id: PROJECT, repo: REPO, host: hostname().toUpperCase(),
        executor_runtime: { user_sid: EXECUTOR_SID, publisher_sid: PUBLISHER_SID,
          manifest_dir: f.manifestDir, results_dir: f.resultsDir },
        workspace: source.workspace, state_dir: f.resultsDir,
        enable_antigravity_model_runs: true },
      execute: async (_receivedSpec, executionConfig) => {
        writeFileSync(join(executionConfig.workspace, 'README.md'), 'possibly still being written\n');
        return { outcome: 'SYNTHETIC_ORPHAN', exit_code: -1, scope_valid: true,
          diff_bytes: 0, changed_files: [], model_invoked: true,
          local_evidence: { termination_state: 'ORPHAN_POSSIBLE' } };
      },
    });
    const saved = JSON.parse(readFileSync(executorResultPath(f.resultsDir,
      job.request_id, ATTEMPT_EDIT), 'utf8'));
    assert.equal(result.terminal_state, 'BLOCKED');
    assert.equal(saved.terminal.outcome,
      'EXECUTOR_EDIT_WORKSPACE_READBACK_SKIPPED_PROCESS_UNCONFIRMED');
    assert.equal(saved.terminal.external_effects, 'UNKNOWN');
    assert.equal(saved.terminal.scope_valid, false);
    assert.equal(readFileSync(join(candidateWorkspacePath(f.resultsDir, ATTEMPT_EDIT),
      'README.md'), 'utf8'), 'possibly still being written\n');
    assert.equal(existsSync(join(f.manifestDir, `${ATTEMPT_EDIT}.running.json`)), true,
      'unconfirmed model attempt is not converted into a retryable pending manifest');
  } finally { f.dispose(); }
});

test('executor result readback failure preserves the running attempt and prevents replay', async t => {
  if (process.platform !== 'win32') return t.skip('Task Scheduler identity execution is Windows-only');
  const f = fixture();
  try {
    const source = sourceRepository(f.root, 'candidate-result-readback-fails');
    const spec = 'Synthetic result readback failure; no provider is invoked.';
    const job = { ...modelJob(spec), schema: 6, project_id: PROJECT,
      host: hostname().toUpperCase(), kind: 'antigravity_edit',
      request_id: 'PTYSD_ANTIGRAVITY_RESULT_READBACK_FAILS', source_sha: source.sourceSha,
      spec_path: 'native-bridge/tasks/w2-review.md',
      spec_sha256: createHash('sha256').update(spec).digest('hex'),
      model: 'gemini-3.8-flash-high', variant: 'high', edit_paths: ['README.md'],
      source_pr: 461, goal_comment_id: 6188322050, goal_body_sha256: 'c'.repeat(64) };
    const bundle = createExecutorSourceBundle({ workspace: source.workspace,
      descriptor: f.descriptor, job, attemptId: ATTEMPT_EDIT,
      filesystemPath: localPathMap(f) });
    writeFileSync(join(f.manifestDir, `${ATTEMPT_EDIT}.pending.json`), JSON.stringify(
      makeExecutorManifest(job, spec, ATTEMPT_EDIT, bundle.sha256)), { flag: 'wx' });
    let executeCalls = 0;
    const config = { project_id: PROJECT, repo: REPO, host: hostname().toUpperCase(),
      executor_runtime: { user_sid: EXECUTOR_SID, publisher_sid: PUBLISHER_SID,
        manifest_dir: f.manifestDir, results_dir: f.resultsDir },
      workspace: source.workspace, state_dir: f.resultsDir, enable_antigravity_model_runs: true };
    await assert.rejects(executePendingManifest({ manifestDir: f.manifestDir,
      currentSid: () => EXECUTOR_SID, config,
      readPersisted: () => { throw new Error('synthetic readback denial'); },
      execute: async () => { executeCalls++; return { outcome: 'SYNTHETIC_TERMINAL',
        exit_code: 0, model_invoked: false, local_evidence: { termination_state: 'NOT_REQUESTED' } }; },
    }), /EXECUTOR_RESULT_READBACK_FAILED/);
    assert.equal(executeCalls, 1);
    assert.equal(existsSync(join(f.manifestDir, `${ATTEMPT_EDIT}.running.json`)), true);
    assert.equal(existsSync(executorResultPath(f.resultsDir, job.request_id, ATTEMPT_EDIT)), true);
    const relaunched = await executePendingManifest({ manifestDir: f.manifestDir,
      currentSid: () => EXECUTOR_SID, config,
      execute: async () => { executeCalls++; throw new Error('must not replay'); },
    });
    assert.equal(relaunched.outcome, 'NO_PENDING_EXECUTOR_MANIFEST');
    assert.equal(existsSync(join(f.manifestDir, `${ATTEMPT_EDIT}.running.json`)), true);
    assert.equal(existsSync(executorResultPath(f.resultsDir, job.request_id, ATTEMPT_EDIT)), true);
    assert.equal(executeCalls, 1);
  } finally { f.dispose(); }
});


test('completed W2 antigravity_edit attempt is not executed again after executor task relaunch', async t => {
  if (process.platform !== 'win32') return t.skip('Task Scheduler executor lifecycle is Windows-only');
  const f = fixture();
  const attemptId = '00000000-0000-4000-8000-000000000099';
  let source;
  try {
    source = sourceRepository(f.root, 'antigravity-restart-recovery');
    const spec = 'Synthetic W2 one-shot restart recovery; no model invocation is permitted.';
    const job = {
      schema: 6,
      project_id: PROJECT,
      host: hostname().toUpperCase(),
      request_id: 'PTYSD_ANTIGRAVITY_ONE_SHOT_RECOVERY_20261020',
      kind: 'antigravity_edit',
      source_sha: source.sourceSha,
      spec_path: 'native-bridge/tasks/w2-review.md',
      spec_sha256: createHash('sha256').update(spec).digest('hex'),
      model: 'gemini-3.8-flash-high',
      variant: 'high',
      edit_paths: ['README.md'],
      source_pr: 461,
      goal_comment_id: 6188322050,
      goal_body_sha256: 'c'.repeat(64),
    };
    const bundle = createExecutorSourceBundle({
      workspace: source.workspace,
      descriptor: f.descriptor,
      job,
      attemptId,
      filesystemPath: localPathMap(f),
    });
    const pendingPath = join(f.manifestDir, `${attemptId}.pending.json`);
    writeFileSync(pendingPath, JSON.stringify(
      makeExecutorManifest(job, spec, attemptId, bundle.sha256)), { flag: 'wx' });

    let executeCalls = 0;
    let captured;
    const config = {
      project_id: PROJECT,
      repo: REPO,
      host: hostname().toUpperCase(),
      executor_runtime: {
        user_sid: EXECUTOR_SID,
        publisher_sid: PUBLISHER_SID,
        manifest_dir: f.manifestDir,
        results_dir: f.resultsDir,
      },
      workspace: source.workspace,
      state_dir: f.resultsDir,
      enable_antigravity_model_runs: true,
    };

    const firstResult = await executePendingManifest({
      manifestDir: f.manifestDir,
      currentSid: () => EXECUTOR_SID,
      filesystemPath: localPathMap(f),
      config,
      execute: async (_receivedSpec, executionConfig, receivedJob, receivedAttemptId) => {
        executeCalls++;
        assert.equal(receivedJob.kind, 'antigravity_edit');
        assert.equal(receivedJob.request_id, job.request_id);
        assert.equal(receivedAttemptId, attemptId);
        assert.equal(executionConfig.antigravity_project_root, source.workspace,
          'registered project root is preserved separately from attempt checkout');
        assert.equal(executionConfig.workspace, candidateWorkspacePath(f.resultsDir, attemptId),
          'attempt checkout is outside the registered source project');
        assert.equal(execFileSync('git', ['-C', executionConfig.workspace, 'rev-parse', 'HEAD'], {
          encoding: 'utf8', windowsHide: true, shell: false,
        }).trim(), source.sourceSha);

        writeFileSync(join(executionConfig.workspace, 'README.md'), 'pinned source fixture with edit\n');
        captured = await captureScopedEditDiff({
          workspace: executionConfig.workspace,
          state_dir: f.resultsDir,
          job,
          attempt_id: attemptId,
        });

        return {
          outcome: 'ANTIGRAVITY_EDIT_COMPLETED',
          exit_code: 0,
          scope_valid: captured.scope_valid,
          diff_sha256: captured.sha256,
          diff_bytes: captured.bytes,
          changed_files: captured.changed_files,
          model_invoked: true,
          external_effects: 'UNKNOWN',
          task_acceptance: 'UNKNOWN',
          local_evidence: {
            edit_diff: {
              file: captured.file,
              sha256: captured.sha256,
              bytes: captured.bytes,
              changed_files: captured.changed_files,
              allowed_paths: ['README.md'],
              scope_valid: captured.scope_valid,
            },
          },
        };
      },
    });

    assert.equal(executeCalls, 1, 'first execution consumes attempt exactly once');
    assert.equal(firstResult.terminal_state, 'FINISHED');
    assert.equal(firstResult.outcome, 'EXECUTOR_RESULT_PERSISTED_NOT_SEMANTIC_ACCEPTANCE');
    assert.equal(existsSync(pendingPath), false, 'pending manifest is consumed');
    const runningPath = join(f.manifestDir, `${attemptId}.running.json`);
    assert.equal(existsSync(runningPath), true, 'running marker persists on disk until reconciliation');

    const resultPath = executorResultPath(f.resultsDir, job.request_id, attemptId);
    assert.equal(firstResult.result_path, resultPath);
    assert.ok(existsSync(resultPath), 'terminal result exists at configured results path');

    const saved = JSON.parse(readFileSync(resultPath, 'utf8'));
    assert.equal(saved.request_id, job.request_id);
    assert.equal(saved.attempt_id, attemptId);
    assert.equal(saved.terminal.state, 'FINISHED');
    assert.equal(saved.terminal.outcome, 'ANTIGRAVITY_EDIT_COMPLETED');
    assert.equal(saved.terminal.model, 'gemini-3.8-flash-high');
    assert.equal(saved.terminal.variant, 'high');
    assert.equal(saved.terminal.model_invoked, true);
    assert.equal(saved.terminal.scope_valid, true);
    assert.equal(saved.terminal.diff_sha256, captured.sha256);
    assert.equal(saved.terminal.diff_bytes, captured.bytes);
    assert.equal(saved.terminal.changed_files_count, 1);
    assert.equal(saved.terminal.source_sha, source.sourceSha);
    assert.equal(saved.terminal.source_pr, 461);
    assert.equal(saved.terminal.goal_comment_id, 6188322050);
    assert.equal(saved.terminal.goal_body_sha256, 'c'.repeat(64));
    assert.equal(saved.terminal.external_effects, 'UNKNOWN');
    assert.equal(saved.terminal.task_acceptance, 'UNKNOWN');
    assert.ok(parseReceipt(RECEIPT_MARKER + JSON.stringify(saved.terminal)),
      'persisted result is a valid receipt under schema-1');

    const runningBytesBefore = readFileSync(runningPath);
    const resultBytesBefore = readFileSync(resultPath);

    // Simulate new Task Scheduler process relaunching the executor task
    const secondResult = await executePendingManifest({
      manifestDir: f.manifestDir,
      currentSid: () => EXECUTOR_SID,
      filesystemPath: localPathMap(f),
      config,
      execute: async () => {
        executeCalls++;
        throw new Error('must not re-execute completed attempt');
      },
    });

    assert.equal(secondResult.outcome, 'NO_PENDING_EXECUTOR_MANIFEST',
      'relaunched process reports no pending manifest');
    assert.equal(secondResult.exit_code, 0);
    assert.equal(executeCalls, 1, 'stub is never called a second time');

    const activeAttempts = readdirSync(f.manifestDir).filter(name =>
      /^[a-f0-9-]{36}\.(?:pending|running)\.json$/i.test(name));
    assert.deepEqual(activeAttempts, [`${attemptId}.running.json`],
      'no new attempt is created in the mailbox');

    assert.deepEqual(readFileSync(runningPath), runningBytesBefore,
      'original .running.json bytes remain unchanged');
    assert.deepEqual(readFileSync(resultPath), resultBytesBefore,
      'original result file bytes remain unchanged');

    rmSync(resultPath);
    await assert.rejects(() => executePendingManifest({
      manifestDir: f.manifestDir, currentSid: () => EXECUTOR_SID,
      filesystemPath: localPathMap(f), config,
      execute: async () => { executeCalls++; throw new Error('must not replay an unresolved attempt'); },
    }), error => error.code === 'EXECUTOR_ATTEMPT_ALREADY_RUNNING');
    writeFileSync(resultPath, resultBytesBefore, { flag: 'wx' });

    const mismatchedResult = JSON.parse(resultBytesBefore.toString('utf8'));
    mismatchedResult.attempt_id = '00000000-0000-4000-8000-000000000098';
    writeFileSync(resultPath, JSON.stringify(mismatchedResult));
    await assert.rejects(() => executePendingManifest({
      manifestDir: f.manifestDir, currentSid: () => EXECUTOR_SID,
      filesystemPath: localPathMap(f), config,
      execute: async () => { executeCalls++; throw new Error('must not replay a mismatched result'); },
    }), error => error.code === 'EXECUTOR_RUNNING_RESULT_IDENTITY_MISMATCH');
    writeFileSync(resultPath, resultBytesBefore);
    assert.equal(executeCalls, 1, 'missing or mismatched terminal results never replay the model');
    assert.deepEqual(readFileSync(runningPath), runningBytesBefore,
      'original running marker stays unchanged after fail-closed recovery');
    assert.deepEqual(readFileSync(resultPath), resultBytesBefore,
      'exact terminal result is restored unchanged after negative checks');

    const nextAttemptId = '00000000-0000-4000-8000-000000000100';
    const nextSpec = 'A distinct W2 request proceeds after the prior exact FINISHED result.';
    const nextJob = { ...job, request_id: 'PTYSD_ANTIGRAVITY_ONE_SHOT_RECOVERY_NEXT_20261020',
      spec_sha256: createHash('sha256').update(nextSpec).digest('hex') };
    const nextBundle = createExecutorSourceBundle({ workspace: source.workspace,
      descriptor: f.descriptor, job: nextJob, attemptId: nextAttemptId,
      filesystemPath: localPathMap(f) });
    writeFileSync(join(f.manifestDir, `${nextAttemptId}.pending.json`), JSON.stringify(
      makeExecutorManifest(nextJob, nextSpec, nextAttemptId, nextBundle.sha256)), { flag: 'wx' });
    let nextCalls = 0;
    const nextResult = await executePendingManifest({ manifestDir: f.manifestDir,
      currentSid: () => EXECUTOR_SID, filesystemPath: localPathMap(f), config,
      execute: async (_receivedSpec, executionConfig, receivedJob, receivedAttemptId) => {
        nextCalls++;
        assert.equal(receivedJob.request_id, nextJob.request_id);
        assert.equal(receivedAttemptId, nextAttemptId);
        writeFileSync(join(executionConfig.workspace, 'README.md'), 'distinct W2 attempt diff\n');
        const nextDiff = await captureScopedEditDiff({ workspace: executionConfig.workspace,
          state_dir: f.resultsDir, job: nextJob, attempt_id: nextAttemptId });
        return { outcome: 'ANTIGRAVITY_EDIT_COMPLETED', exit_code: 0,
          scope_valid: nextDiff.scope_valid, diff_sha256: nextDiff.sha256,
          diff_bytes: nextDiff.bytes, changed_files: nextDiff.changed_files,
          model_invoked: true, external_effects: 'UNKNOWN', task_acceptance: 'UNKNOWN',
          local_evidence: { edit_diff: { file: nextDiff.file, sha256: nextDiff.sha256,
            bytes: nextDiff.bytes, changed_files: nextDiff.changed_files,
            allowed_paths: ['README.md'], scope_valid: nextDiff.scope_valid } } };
      },
    });
    assert.equal(nextResult.terminal_state, 'FINISHED');
    assert.equal(nextCalls, 1, 'one distinct request is accepted behind an exact completed marker');
    assert.deepEqual(readFileSync(runningPath), runningBytesBefore,
      'advancing the mailbox preserves the prior attempt marker');
    const nextRunningPath = join(f.manifestDir, `${nextAttemptId}.running.json`);
    assert.equal(existsSync(nextRunningPath), true);
    const finalRelaunch = await executePendingManifest({ manifestDir: f.manifestDir,
      currentSid: () => EXECUTOR_SID, filesystemPath: localPathMap(f), config,
      execute: async () => { nextCalls++; throw new Error('must not replay either completed attempt'); },
    });
    assert.equal(finalRelaunch.outcome, 'NO_PENDING_EXECUTOR_MANIFEST');
    assert.equal(nextCalls, 1);

    cleanupExecutorAttempt({ ...f.descriptor, manifest_dir: f.manifestDir, results_dir: f.resultsDir }, attemptId);
    cleanupExecutorAttempt({ ...f.descriptor, manifest_dir: f.manifestDir, results_dir: f.resultsDir }, nextAttemptId);
    assert.equal(existsSync(candidateWorkspacePath(f.resultsDir, attemptId)), false,
      'cleanup removes attempt workspace');
    assert.equal(existsSync(candidateBundlePath(f.manifestDir, attemptId)), false,
      'cleanup removes candidate bundle');
    assert.equal(existsSync(runningPath), false, 'cleanup removes running manifest');
    assert.equal(existsSync(nextRunningPath), false, 'test cleanup removes next running manifest');
    assert.equal(readFileSync(join(source.workspace, 'README.md'), 'utf8'), 'pinned source fixture\n',
      'registered source checkout was not modified');
  } finally {
    if (source) {
      try {
        cleanupExecutorAttempt({ ...f.descriptor, manifest_dir: f.manifestDir, results_dir: f.resultsDir }, attemptId);
      } catch {}
    }
    f.dispose();
  }
});
