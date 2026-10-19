import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { readWindowsProcessTree, runCapturedProcess, terminateProcessTree }
  from '../native-bridge/captured-process.mjs';
import { buildV2ReadOnlyConfig, buildV2ScopedEditConfig } from '../native-bridge/opencode-v2.mjs';
import { terminalStateForResult } from '../native-bridge/worker.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');

test('shared Windows process-tree reader distinguishes live, dead, and unknown readbacks', () => {
  const calls = [];
  const run = (file, args, options) => {
    calls.push({ file, args, options });
    return { trim: () => JSON.stringify({ state: 'ALIVE', process_ids: [42, 43],
      census_complete: true,
      root_created_at: '2026-10-16T12:00:00.000Z' }) };
  };
  const alive = readWindowsProcessTree(42, run, 'win32');
  assert.equal(alive.state, 'ALIVE');
  assert.equal(alive.root_pid, 42);
  assert.deepEqual(alive.process_ids, [42, 43]);
  assert.equal(alive.root_created_at, '2026-10-16T12:00:00.000Z');
  assert.equal(calls[0].file, 'powershell.exe');
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.shell, false);
  assert.match(calls[0].args.at(-1), /Get-CimInstance/);
  assert.doesNotMatch(calls[0].args.at(-1), /Get-Process/,
    'do not compare separately timed process lists and turn routine process churn into UNKNOWN');
  assert.match(calls[0].args.at(-1), /processSet\.Contains\(\$PID\)/,
    'the single CIM census must include the reader process before it can prove absence');

  const dead = readWindowsProcessTree(42, () => ({ trim: () =>
    JSON.stringify({ state: 'DEAD', process_ids: [], census_complete: true }) }), 'win32');
  assert.equal(dead.state, 'DEAD');
  assert.deepEqual(dead.process_ids, []);

  let incompleteCalls = 0;
  const incomplete = readWindowsProcessTree(42, () => ({ trim: () => {
    incompleteCalls++;
    return JSON.stringify({ state: 'UNKNOWN', process_ids: [], census_complete: false,
      error: 'EXECUTOR_PROCESS_CENSUS_INCOMPLETE' });
  } }), 'win32');
  assert.equal(incomplete.state, 'UNKNOWN',
    'an empty descendant list is not proof of termination unless the OS process census is complete');
  assert.equal(incomplete.error, 'EXECUTOR_PROCESS_CENSUS_INCOMPLETE');
  assert.equal(incompleteCalls, 2, 'only one bounded readback retry is allowed');

  let transientCalls = 0;
  const recovered = readWindowsProcessTree(42, () => ({ trim: () => {
    transientCalls++;
    return JSON.stringify(transientCalls === 1
      ? { state: 'UNKNOWN', process_ids: [], census_complete: false,
          error: 'EXECUTOR_PROCESS_CENSUS_INCOMPLETE' }
      : { state: 'DEAD', process_ids: [], census_complete: true, error: null });
  } }), 'win32');
  assert.equal(recovered.state, 'DEAD');
  assert.equal(transientCalls, 2, 'retry once after a transient incomplete census');

  const malformed = readWindowsProcessTree(42, () => ({ trim: () =>
    JSON.stringify({ state: 'DEAD', process_ids: [42] }) }), 'win32');
  assert.equal(malformed.state, 'UNKNOWN');
  assert.equal(malformed.error, 'PROCESS_TREE_READBACK_FAILED');
  const unavailable = readWindowsProcessTree(42, () => { throw new Error('offline'); }, 'win32');
  assert.equal(unavailable.state, 'UNKNOWN');
});

test('positive process-tree evidence remains ALIVE when an unrelated process makes the census incomplete', () => {
  const live = readWindowsProcessTree(42, () => ({ trim: () => JSON.stringify({
    state: 'ALIVE', process_ids: [42, 43], census_complete: false,
    root_created_at: '2026-10-19T00:00:00.000Z', error: null,
  }) }), 'win32');
  assert.equal(live.state, 'ALIVE',
    'a known matching process tree proves liveness even if unrelated PIDs raced the census');
  assert.deepEqual(live.process_ids, [42, 43]);
  assert.equal(live.error, null);
});

test('tree termination requires OS readback after taskkill and when the root has exited', () => {
  const child = { pid: 52, exitCode: null, signalCode: null, kill() {} };
  const taskkillCalls = [];
  const alive = terminateProcessTree(child, {
    platformName: 'win32',
    runTaskkill: (...args) => { taskkillCalls.push(args); },
    readProcessTree: pid => ({ root_pid: pid, state: 'ALIVE', process_ids: [pid, pid + 1] }),
  });
  assert.equal(taskkillCalls.length, 1);
  assert.equal(taskkillCalls[0][0], 'taskkill.exe');
  assert.deepEqual(taskkillCalls[0][1], ['/PID', '52', '/T', '/F']);
  assert.equal(alive.treeConfirmed, undefined,
    'taskkill exit 0 is not evidence that the process tree is gone');
  assert.equal(alive.processTreeState, 'ALIVE');
  assert.equal(alive.rootOnly, true,
    'a root that is still running under a requested termination keeps an evidenced orphan');
  assert.equal(alive.error, 'PROCESS_TREE_STILL_ACTIVE');

  const dead = terminateProcessTree(child, {
    platformName: 'win32', runTaskkill: () => {},
    readProcessTree: pid => ({ root_pid: pid, state: 'DEAD', process_ids: [] }),
  });
  assert.equal(dead.treeConfirmed, true);

  const exitedAndDead = terminateProcessTree({ ...child, exitCode: 0 }, {
    platformName: 'win32', runTaskkill: () => assert.fail('do not signal a reused PID after root exit'),
    readProcessTree: pid => ({ root_pid: pid, state: 'DEAD', process_ids: [] }),
  });
  assert.equal(exitedAndDead.treeConfirmed, true);
  assert.equal(exitedAndDead.processTreeState, 'DEAD');
  assert.equal(exitedAndDead.error, null,
    'a confirming OS readback must replace the earlier unknown state after root exit');

  let taskkillAfterExit = false;
  const exitedWithChild = terminateProcessTree({ ...child, exitCode: 0 }, {
    platformName: 'win32', runTaskkill: () => { taskkillAfterExit = true; },
    readProcessTree: pid => ({ root_pid: pid, state: 'ALIVE', process_ids: [pid + 1] }),
  });
  assert.equal(taskkillAfterExit, false,
    'do not send a stale PID to taskkill after Node observed root exit');
  assert.equal(exitedWithChild.rootOnly, undefined,
    'a child-only tree after root exit cannot be proven to belong to this attempt');
  assert.equal(exitedWithChild.processTreeState, 'UNKNOWN');
  assert.equal(exitedWithChild.error, 'PROCESS_TREE_IDENTITY_UNPROVEN',
    'an unprovable surviving tree is reported as unknown, never as this attempt orphan');

  const unknown = terminateProcessTree(child, {
    platformName: 'win32', runTaskkill: () => {},
    readProcessTree: pid => ({ root_pid: pid, state: 'UNKNOWN', process_ids: [] }),
  });
  assert.equal(unknown.treeConfirmed, undefined);
  assert.equal(unknown.processTreeState, 'UNKNOWN');
});

test('a reused root PID with descendants is never attributed to the exited attempt', () => {
  // The root process is known to have closed, yet the OS readback finds the same
  // PID alive with its own descendant and a fresh creation time. That proves the
  // PID was recycled by an unrelated process, so the tree must not be associated
  // with this attempt nor signalled.
  const child = { pid: 61, exitCode: 0, signalCode: null, kill() {} };
  let taskkillCalls = 0;
  const reused = terminateProcessTree(child, {
    platformName: 'win32',
    runTaskkill: () => { taskkillCalls += 1; },
    readProcessTree: pid => ({ root_pid: pid, state: 'ALIVE',
      process_ids: [pid, pid + 1], root_created_at: '2026-10-19T00:00:00.000Z' }),
  });
  assert.equal(taskkillCalls, 0, 'never signal a possibly reused PID');
  assert.equal(reused.treeConfirmed, undefined);
  assert.equal(reused.rootOnly, undefined,
    'a live root at the closed attempt PID proves reuse, not a surviving descendant');
  assert.equal(reused.processTreeState, 'UNKNOWN');
  assert.equal(reused.error, 'PROCESS_TREE_IDENTITY_MISMATCH');

  // Reuse is still detected from the root PID appearing in the read-back tree
  // when the reader does not surface the creation time.
  const reusedWithoutCreationTime = terminateProcessTree(child, {
    platformName: 'win32',
    runTaskkill: () => { taskkillCalls += 1; },
    readProcessTree: pid => ({ root_pid: pid, state: 'ALIVE', process_ids: [pid, pid + 1] }),
  });
  assert.equal(taskkillCalls, 0, 'never signal a possibly reused PID');
  assert.equal(reusedWithoutCreationTime.rootOnly, undefined);
  assert.equal(reusedWithoutCreationTime.treeConfirmed, undefined);
  assert.equal(reusedWithoutCreationTime.processTreeState, 'UNKNOWN');
});

test('child-only ALIVE readback after the root exits cannot prove attempt identity', () => {
  // The attempt root has exited and the OS read-back lists only a descendant:
  // the root PID is absent and there is no creation time. With no spawn-time
  // identity captured, the surviving tree may belong to an unrelated process
  // that reused the PID, so it must never be credited as this attempt orphan.
  const child = { pid: 71, exitCode: 0, signalCode: null, kill() {} };
  let taskkillCalls = 0;
  const survivor = terminateProcessTree(child, {
    platformName: 'win32',
    runTaskkill: () => { taskkillCalls += 1; },
    readProcessTree: pid => ({ root_pid: pid, state: 'ALIVE', process_ids: [pid + 1] }),
  });
  assert.equal(taskkillCalls, 0, 'never signal after the root has exited');
  assert.equal(survivor.treeConfirmed, undefined);
  assert.equal(survivor.rootOnly, undefined,
    'an unproven surviving tree is not this attempt evidenced orphan');
  assert.equal(survivor.processTreeState, 'UNKNOWN');
  assert.equal(survivor.error, 'PROCESS_TREE_IDENTITY_UNPROVEN');
});

test('captured process streams output larger than 2 MiB without terminating and preserves hashes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ptysd-capture-large-'));
  try {
    const stdoutPath = join(home, 'stdout.bin');
    const stderrPath = join(home, 'stderr.bin');
    const script = [
      'const block=Buffer.alloc(65536,65);',
      'const err=Buffer.alloc(65536,69);',
      'async function write(stream,data){if(!stream.write(data)) await new Promise(r=>stream.once("drain",r));}',
      '(async()=>{for(let i=0;i<40;i++) await write(process.stdout,block);',
      'await write(process.stdout,Buffer.from("OUT_END\\n"));',
      'for(let i=0;i<8;i++) await write(process.stderr,err);',
      'await write(process.stderr,Buffer.from("ERR_END\\n"));})().catch(e=>{console.error(e);process.exitCode=9});',
    ].join('');
    let spawnOptions;
    let terminateCalls = 0;
    const result = await runCapturedProcess(process.execPath, ['-e', script], {
      cwd: home, env: process.env, stdoutPath, stderrPath,
      spawnProcess: (command, args, options) => {
        spawnOptions = options;
        return spawn(command, args, options);
      },
      terminate: () => { terminateCalls += 1; },
    });
    const stdout = readFileSync(stdoutPath);
    const stderr = readFileSync(stderrPath);
    const expectedOut = Buffer.concat([Buffer.alloc(40 * 65536, 65), Buffer.from('OUT_END\n')]);
    const expectedErr = Buffer.concat([Buffer.alloc(8 * 65536, 69), Buffer.from('ERR_END\n')]);
    assert.equal(result.exit_code, 0);
    assert.equal(result.outcome, 'OPENCODE_V2_EXIT_0_UNTRUSTED');
    assert.equal(stdout.length + stderr.length, 48 * 65536 + 16);
    assert.ok(stdout.length + stderr.length > 2 * 1024 * 1024);
    assert.deepEqual(stdout, expectedOut);
    assert.deepEqual(stderr, expectedErr);
    assert.equal(result.evidence_sha256, sha256(Buffer.concat([stdout, Buffer.from('\n--- STDERR ---\n'), stderr])));
    assert.equal(result.local_evidence.stdout_sha256, sha256(stdout));
    assert.equal(result.local_evidence.stderr_sha256, sha256(stderr));
    assert.equal(terminateCalls, 0);
    assert.equal(spawnOptions.shell, false);
    assert.equal(spawnOptions.windowsHide, true);
    assert.deepEqual(spawnOptions.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(Object.hasOwn(result, 'stdout'), false);
    assert.equal(Object.hasOwn(result, 'stderr'), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('captured process preserves a nonzero native exit code', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ptysd-capture-exit-'));
  try {
    const result = await runCapturedProcess(process.execPath,
      ['-e', 'process.stdout.write("failed safely\\n");process.exit(23)'], {
        cwd: home, env: process.env,
        stdoutPath: join(home, 'stdout.bin'), stderrPath: join(home, 'stderr.bin'),
      });
    assert.equal(result.exit_code, 23);
    assert.equal(result.outcome, 'OPENCODE_V2_FAILED');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

for (const scenario of [
  { label:'unprovable root-exited descendant', state:'ALIVE', ids:[4243],
    expected:'TERMINATION_UNCONFIRMED', expectedTree:'UNKNOWN',
    error:'PROCESS_TREE_READBACK_UNKNOWN' },
  { label:'no surviving process', state:'DEAD', ids:[], expected:'NOT_REQUESTED',
    expectedTree:'DEAD', error:null },
  { label:'unavailable process readback', state:'UNKNOWN', ids:[], expected:'TERMINATION_UNCONFIRMED',
    expectedTree:'UNKNOWN', error:'PROCESS_TREE_READBACK_UNKNOWN' },
  { label:'reused root PID with descendant', state:'ALIVE', ids:[], includeRootPid:true,
    expected:'TERMINATION_UNCONFIRMED', expectedTree:'UNKNOWN',
    error:'PROCESS_TREE_READBACK_UNKNOWN' },
]) {
  test(`captured process reads the process tree after normal close: ${scenario.label}`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'ptysd-capture-normal-close-tree-'));
    const stdoutPath = join(home, 'stdout.bin');
    try {
      let readbackCalls = 0;
      const result = await runCapturedProcess(process.execPath,
        ['-e', 'process.stdout.write("root finished\\n")'], {
          cwd: home, env: process.env, stdoutPath, stderrPath: join(home, 'stderr.bin'),
          platformName:'win32',
          readProcessTree: pid => {
            readbackCalls++;
            assert.ok(pid > 0);
            assert.equal(readFileSync(stdoutPath, 'utf8'), 'root finished\n',
              'process-tree readback follows child close and output persistence');
            return { root_pid:pid, state:scenario.state,
              process_ids: scenario.includeRootPid ? [pid, pid + 1] : scenario.ids };
          },
        });
      assert.equal(readbackCalls, 1, 'a normal close still requires final OS process-tree readback');
      assert.equal(result.local_evidence.process_tree_state, scenario.expectedTree);
      assert.equal(result.local_evidence.termination_state, scenario.expected);
      assert.equal(result.local_evidence.termination_error, scenario.error);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}

test('Win32 readback independently detects a hidden detached descendant without crediting the exited root attempt', {
  skip:platform() !== 'win32',
}, async () => {
  const home = mkdtempSync(join(tmpdir(), 'ptysd-live-detached-descendant-'));
  const stdoutPath = join(home, 'stdout.bin');
  const releasePath = join(home, 'release-child');
  let childPid = null;
  let childCreatedAt = null;
  const waitForOriginalChildExit = async () => {
    if (!Number.isSafeInteger(childPid) || childPid < 1) return null;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const current = readWindowsProcessTree(childPid);
      if (current.state === 'DEAD' ||
          (childCreatedAt && current.state === 'ALIVE' && current.root_created_at !== childCreatedAt))
        return current;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return readWindowsProcessTree(childPid);
  };
  try {
    const childCode = `const fs=require('node:fs');const release=${JSON.stringify(releasePath)};` +
      `const poll=setInterval(()=>{if(fs.existsSync(release)){clearInterval(poll);process.exit(0)}},25);` +
      'setTimeout(()=>process.exit(0),15000).unref();';
    const parentCode = `const {spawn}=require('node:child_process');` +
      `const child=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],` +
      `{stdio:'ignore',windowsHide:true,detached:true});child.unref();` +
      `process.stdout.write(String(process.pid)+','+String(child.pid)+String.fromCharCode(10));`;
    const result = await runCapturedProcess(process.execPath, ['-e', parentCode], {
      cwd:home, env:process.env, stdoutPath, stderrPath:join(home,'stderr.bin'),
    });
    const [rootPid, parsedChildPid] = readFileSync(stdoutPath, 'utf8').trim().split(',').map(Number);
    childPid = parsedChildPid;
    assert.ok(Number.isSafeInteger(rootPid) && rootPid > 0);
    assert.ok(Number.isSafeInteger(childPid) && childPid > 0);
    const liveTree = readWindowsProcessTree(childPid);
    childCreatedAt = liveTree.root_created_at;
    assert.equal(liveTree.state, 'ALIVE', 'the detached child must still be running after its parent exits');
    // The exited root attempt cannot prove the surviving tree is its own: its PID
    // may have been reused, so the attempt is not credited with the live child.
    assert.equal(result.local_evidence.process_tree_state, 'UNKNOWN');
    assert.equal(result.local_evidence.termination_state, 'TERMINATION_UNCONFIRMED');
    assert.notEqual(result.local_evidence.termination_state, 'ORPHAN_POSSIBLE',
      'a root-exited attempt must not claim identity of an unprovable descendant');

    writeFileSync(releasePath, 'exit');
    const stoppedTree = await waitForOriginalChildExit();
    assert.ok(stoppedTree.state === 'DEAD' ||
      (childCreatedAt && stoppedTree.root_created_at !== childCreatedAt),
    'the identified child must exit naturally after the release signal');
  } finally {
    try { writeFileSync(releasePath, 'exit'); } catch { /* Temporary directory may already be absent. */ }
    await waitForOriginalChildExit();
    rmSync(home, { recursive:true, force:true });
  }
});

test('failed spawn preserves its error without misclassifying absent output pipes or terminating a child', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ptysd-capture-spawn-failure-'));
  try {
    let terminateCalls = 0;
    const result = await runCapturedProcess(join(home, 'missing-opencode-executable'), [], {
      cwd: home, env: process.env,
      stdoutPath: join(home, 'stdout.bin'), stderrPath: join(home, 'stderr.bin'),
      terminate: child => {
        terminateCalls += 1;
        assert.equal(child.pid, undefined, 'a failed spawn has no child PID');
      },
    });
    assert.notEqual(result.exit_code, 0, 'a failed spawn is not a successful child exit');
    assert.equal(result.outcome, 'OPENCODE_SPAWN_FAILED');
    assert.equal(result.local_evidence.spawn_error, 'ENOENT');
    assert.equal(result.local_evidence.capture_error, null);
    assert.equal(result.local_evidence.storage_error, null);
    assert.equal(result.local_evidence.termination_state, 'NOT_REQUESTED');
    assert.equal(terminateCalls, 0);
    assert.match(result.evidence_sha256, /^[a-f0-9]{64}$/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('captured process redacts credential-shaped provider error codes from evidence', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ptysd-capture-secret-error-code-'));
  const secretCode = 'GHO_SUPERSECRET0123456789';
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 1234;
  try {
    const result = await runCapturedProcess('synthetic-executable', [], {
      cwd: home, env: process.env,
      stdoutPath: join(home, 'stdout.bin'), stderrPath: join(home, 'stderr.bin'),
      platformName:'win32',
      readProcessTree: pid => ({ root_pid:pid, state:'DEAD', process_ids:[] }),
      spawnProcess: () => {
        queueMicrotask(() => {
          child.emit('spawn');
          child.stdout.end();
          child.stderr.end();
          const error = new Error('provider launch failed');
          error.code = secretCode;
          child.emit('error', error);
          child.emit('close', 0, null);
        });
        return child;
      },
    });
    assert.equal(result.local_evidence.process_error, 'IO_ERROR');
    assert.equal(JSON.stringify(result.local_evidence).includes(secretCode), false);
    assert.equal(readWindowsProcessTree(42, () => {
      const error = new Error('process tree query failed');
      error.code = secretCode;
      throw error;
    }, 'win32').error, 'PROCESS_TREE_READBACK_FAILED');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('an error after spawn is not mislabeled as a spawn failure or accepted on exit zero', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ptysd-capture-post-spawn-error-'));
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 1234;
  try {
    const result = await runCapturedProcess('synthetic-executable', [], {
      cwd: home, env: process.env,
      stdoutPath: join(home, 'stdout.bin'), stderrPath: join(home, 'stderr.bin'),
      spawnProcess: () => {
        queueMicrotask(() => {
          child.emit('spawn');
          child.stdout.end('captured before process error\\n');
          child.stderr.end();
          const error = new Error('synthetic post-spawn process failure');
          error.code = 'EPERM';
          child.emit('error', error);
          child.emit('close', 0, null);
        });
        return child;
      },
    });
    assert.equal(result.exit_code, 0, 'retain the native close code as separate evidence');
    assert.equal(result.outcome, 'OPENCODE_PROCESS_FAILED');
    assert.equal(result.local_evidence.spawn_error, null);
    assert.equal(result.local_evidence.process_error, 'EPERM');
    assert.equal(terminalStateForResult(result), 'BLOCKED', 'exit zero cannot erase a process error');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('evidence storage failure is explicit and does not report model success', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ptysd-capture-storage-'));
  try {
    const missing = join(home, 'missing', 'stdout.bin');
    let child;
    const result = await runCapturedProcess(process.execPath,
      ['-e', 'setInterval(()=>process.stdout.write("synthetic\\n"),5)'], {
        cwd: home, env: process.env,
        stdoutPath: missing, stderrPath: join(home, 'stderr.bin'),
        spawnProcess: (command, args, options) => (child = spawn(command, args, options)),
        terminate: process => { if (process.pid) process.kill(); },
      });
    assert.ok(child);
    assert.equal(result.outcome, 'EVIDENCE_STORAGE_FAILED');
    assert.notEqual(result.exit_code, 0);
    assert.match(result.local_evidence.storage_error, /^(?:ENOENT|EACCES|EPERM)$/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('capture storage failure defaults to process-tree termination instead of leaving the child alive', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ptysd-capture-default-termination-'));
  let child;
  let watchdogForcedClose = false;
  try {
    const resultPromise = runCapturedProcess('synthetic-child', [], {
      cwd: home, env: process.env,
      stdoutPath: join(home, 'missing', 'stdout.bin'), stderrPath: join(home, 'stderr.bin'),
      spawnProcess: () => {
        child = new EventEmitter();
        child.pid = 2147483647;
        child.exitCode = null;
        child.signalCode = null;
        child.killCalls = 0;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => {
          child.killCalls += 1;
          child.exitCode = 1;
          child.stdout.end();
          child.stderr.end();
          setImmediate(() => child.emit('close', 1, null));
          return true;
        };
        setImmediate(() => {
          child.emit('spawn');
          child.stdout.end('synthetic output');
          child.stderr.end();
        });
        return child;
      },
    });
    const watchdog = setTimeout(() => {
      if (child && child.exitCode === null) {
        watchdogForcedClose = true;
        child.exitCode = 1;
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 1, null);
      }
    }, 1200);
    const result = await resultPromise;
    clearTimeout(watchdog);
    assert.equal(watchdogForcedClose, false, 'the helper must terminate the child without an external watchdog');
    assert.notEqual(result.local_evidence.termination_state, 'TERMINATION_UNCONFIRMED');
    assert.equal(result.outcome, 'EVIDENCE_STORAGE_FAILED');
  } finally {
    if (child && child.exitCode === null) {
      child.exitCode = 1;
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 1, null);
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test('capture failure before spawn defers termination until the child PID exists', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ptysd-capture-before-spawn-'));
  try {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = null;
    child.pid = undefined;
    const terminationPids = [];
    const resultPromise = runCapturedProcess('synthetic-child', [], {
      cwd: home, env: process.env,
      stdoutPath: join(home, 'stdout.bin'), stderrPath: join(home, 'stderr.bin'),
      spawnProcess: () => {
        process.nextTick(() => child.stdout.destroy(Object.assign(new Error('synthetic output fault'), { code: 'EIO' })));
        setTimeout(() => {
          child.pid = 4242;
          child.emit('spawn');
          setImmediate(() => {
            child.stderr.end();
            child.emit('close', 143, null);
          });
        }, 25);
        return child;
      },
      terminate: processInfo => {
        terminationPids.push(processInfo.pid ?? null);
        return Number.isSafeInteger(processInfo.pid)
          ? { requested: true }
          : { error: 'PID_NOT_AVAILABLE' };
      },
    });

    const result = await resultPromise;
    assert.deepEqual(terminationPids, [4242],
      'a pre-spawn capture failure must be acted on after a PID becomes available');
    assert.equal(result.local_evidence.storage_error, 'EIO');
    assert.equal(result.outcome, 'EVIDENCE_STORAGE_FAILED');
    assert.equal(result.local_evidence.termination_state, 'TERMINATION_CONFIRMED',
      'the post-close OS readback supersedes the earlier termination request');
    assert.equal(result.local_evidence.termination_error, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('failed tree termination after evidence failure is not credited after the root exits', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ptysd-capture-orphan-'));
  try {
    const result = await runCapturedProcess(process.execPath,
      ['-e', 'setInterval(()=>process.stdout.write("x"),5)'], {
        cwd: home, env: process.env,
        stdoutPath: join(home, 'missing', 'stdout.bin'),
        stderrPath: join(home, 'missing', 'stderr.bin'),
        platformName:'win32',
        readProcessTree: pid => ({ root_pid:pid, state:'ALIVE', process_ids:[pid + 1] }),
        terminate: child => ({ rootOnly: child.kill(), error: 'TASKKILL_TREE_FAILED' }),
      });
    assert.equal(result.outcome, 'EVIDENCE_STORAGE_FAILED');
    assert.equal(result.local_evidence.termination_state, 'TERMINATION_UNCONFIRMED',
      'after the root exits an unprovable surviving tree is never credited to this attempt');
    assert.equal(result.local_evidence.termination_error, 'PROCESS_TREE_READBACK_UNKNOWN');
    assert.notEqual(result.exit_code, 0, 'an evidence failure is not an accepted process result');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('zero child exit cannot turn an evidence-capture failure into a successful terminal state', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ptysd-capture-zero-exit-'));
  try {
    let terminationRequests = 0;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 1234;
    child.exitCode = null;
    child.signalCode = null;
    const result = await runCapturedProcess('synthetic-executable', [], {
      cwd: home, env: process.env,
      stdoutPath: join(home, 'missing', 'stdout.bin'),
      stderrPath: join(home, 'stderr.bin'),
      spawnProcess: () => {
        queueMicrotask(() => child.emit('spawn'));
        return child;
      },
      terminate: () => {
        terminationRequests += 1;
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 0, null);
        return { requested: true };
      },
    });
    assert.equal(terminationRequests, 1, 'exactly one termination request is issued');
    assert.equal(result.exit_code, 0);
    assert.equal(result.outcome, 'EVIDENCE_STORAGE_FAILED');
    assert.equal(result.outcome.endsWith('_FAILED'), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('OpenCode agents no longer carry a fixed iteration cap', () => {
  const readonly = buildV2ReadOnlyConfig().agents['ptysd-readonly'];
  const home = mkdtempSync(join(tmpdir(), 'ptysd-no-step-cap-'));
  try {
    mkdirSync(join(home, 'src'));
    const writer = buildV2ScopedEditConfig(home, ['src/output.mjs']).agents['ptysd-scoped-write'];
    assert.equal(Object.hasOwn(readonly, 'steps'), false);
    assert.equal(Object.hasOwn(writer, 'steps'), false);
    assert.equal(readonly.permissions.find(x => x.action === 'shell')?.effect, 'deny');
    assert.equal(writer.permissions[0].action, '*');
    assert.equal(writer.permissions[0].effect, 'deny');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('synthetic child survives beyond the former 600-second cap', {
  skip: process.env.PTYSD_RUN_LONG_TEST !== '1',
}, async () => {
  const home = mkdtempSync(join(tmpdir(), 'ptysd-capture-long-'));
  try {
    const stdoutPath = join(home, 'stdout.bin');
    const stderrPath = join(home, 'stderr.bin');
    let child;
    const run = runCapturedProcess(process.execPath,
      ['-e', 'setInterval(()=>process.stdout.write("still-running\\n"),30000);setTimeout(()=>{process.stdout.write("OVER_600_SECONDS\\n");process.exit(0)},610000)'], {
        cwd: home, env: process.env,
        stdoutPath, stderrPath,
        spawnProcess: (command, args, options) => (child = spawn(command, args, options)),
      });
    await new Promise(resolve => setTimeout(resolve, 600500));
    assert.ok(child);
    assert.equal(child.exitCode, null, 'child must remain alive after 600 seconds');
    const result = await run;
    assert.equal(result.exit_code, 0);
    assert.match(readFileSync(stdoutPath, 'utf8'), /OVER_600_SECONDS/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
