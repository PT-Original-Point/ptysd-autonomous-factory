import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { hashFile, runCapturedProcess } from '../native-bridge/captured-process.mjs';
import { buildV2ScopedEditConfig } from '../native-bridge/opencode-v2.mjs';
import { terminalStateForResult } from '../native-bridge/worker.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');

test('shared evidence file hashing returns exact SHA-256 and byte count', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ptysd-evidence-hash-'));
  try {
    const path = join(home, 'evidence.bin');
    const bytes = Buffer.from('public synthetic evidence\n');
    writeFileSync(path, bytes);
    assert.deepEqual(await hashFile(path), { sha256:sha256(bytes), bytes:bytes.length });
  } finally {
    rmSync(home, { recursive:true, force:true });
  }
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

test('failed tree termination after evidence failure is preserved as possible orphan state', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ptysd-capture-orphan-'));
  try {
    const result = await runCapturedProcess(process.execPath,
      ['-e', 'setInterval(()=>process.stdout.write("x"),5)'], {
        cwd: home, env: process.env,
        stdoutPath: join(home, 'missing', 'stdout.bin'),
        stderrPath: join(home, 'missing', 'stderr.bin'),
        terminate: child => ({ rootOnly: child.kill(), error: 'TASKKILL_TREE_FAILED' }),
      });
    assert.equal(result.outcome, 'EVIDENCE_STORAGE_FAILED');
    assert.equal(result.local_evidence.termination_state, 'ORPHAN_POSSIBLE');
    assert.equal(result.local_evidence.termination_error, 'TASKKILL_TREE_FAILED');
    assert.notEqual(result.exit_code, 0, 'an evidence failure is not an accepted process result');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('zero child exit cannot turn an evidence-capture failure into a successful terminal state', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ptysd-capture-zero-exit-'));
  try {
    const missing = join(home, 'missing', 'stdout.bin');
    const result = await runCapturedProcess(process.execPath,
      ['-e', 'process.exit(0)'], {
        cwd: home, env: process.env,
        stdoutPath: missing, stderrPath: join(home, 'stderr.bin'),
      });
    assert.equal(result.exit_code, 0);
    assert.equal(result.outcome, 'EVIDENCE_STORAGE_FAILED');
    assert.equal(result.outcome.endsWith('_FAILED'), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('OpenCode scoped writer has no fixed iteration cap', () => {
  const home = mkdtempSync(join(tmpdir(), 'ptysd-no-step-cap-'));
  try {
    mkdirSync(join(home, 'src'));
    const writer = buildV2ScopedEditConfig(home, ['src/output.mjs']).agents['ptysd-scoped-write'];
    assert.equal(Object.hasOwn(writer, 'steps'), false);
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
