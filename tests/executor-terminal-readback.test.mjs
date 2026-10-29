// Focused tests for the executor's terminal-result readback. They prove that a
// non-WAITING result is only reported persisted after the exact persisted bytes
// are read back and match, and that any readback failure never reruns the model
// and never deletes the already-written result.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROJECT, RECEIPT_MARKER, REPO, parseReceipt } from '../native-bridge/worker.mjs';
import { executePendingManifest, readPersistedResult } from '../native-bridge/executor.mjs';
import { executorResultPath, makeExecutorManifest } from '../native-bridge/windows-executor.mjs';

const PUBLISHER_SID = 'S-1-5-21-101-202-303-1001';
const EXECUTOR_SID = 'S-1-5-21-101-202-303-1002';
const ATTEMPT = '00000000-0000-4000-8000-000000000001';
const REQUEST_ID = 'PTYSD_NATIVE_V2_PLAN_20261015';
const TERMINAL_RESULT = Object.freeze({ outcome: 'OPENCODE_V2_EXIT_0_UNTRUSTED', exit_code: 0,
  evidence_sha256: 'b'.repeat(64), evidence_bytes: 7 });

function modelJob(spec) {
  const specHash = createHash('sha256').update(spec).digest('hex');
  return { schema: 2, project_id: PROJECT, host: hostname().toUpperCase(),
    request_id: REQUEST_ID, kind: 'opencode_plan', source_sha: 'a'.repeat(40),
    spec_path: 'native-bridge/tasks/read-only-check.md', spec_sha256: specHash,
    model: 'opencode/spark', variant: 'high' };
}

function fixture({ spec = 'Read-only synthetic fixture; this test never invokes a model.',
  makeJob = modelJob } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ptysd-executor-readback-'));
  const manifestDir = join(root, 'inbox');
  const resultsDir = join(root, 'results');
  const workspace = join(root, 'workspace');
  for (const dir of [manifestDir, resultsDir, workspace]) mkdirSync(dir);
  const job = makeJob(spec);
  writeFileSync(join(manifestDir, `${ATTEMPT}.pending.json`),
    JSON.stringify(makeExecutorManifest(job, spec, ATTEMPT)), { flag: 'wx' });
  const config = {
    project_id: PROJECT, repo: REPO, host: hostname().toUpperCase(),
    executor_runtime: { user_sid: EXECUTOR_SID, publisher_sid: PUBLISHER_SID,
      manifest_dir: manifestDir, results_dir: resultsDir },
    workspace, state_dir: resultsDir,
  };
  return { root, manifestDir, resultsDir, job, config,
    resultPath: executorResultPath(resultsDir, job.request_id, ATTEMPT),
    dispose: () => rmSync(root, { recursive: true, force: true }) };
}

function persistTerminalResult(f, readPersisted, result = TERMINAL_RESULT) {
  let calls = 0;
  const run = executePendingManifest({
    manifestDir: f.manifestDir, currentSid: () => EXECUTOR_SID, config: f.config,
    ...(readPersisted ? { readPersisted } : {}),
    execute: async () => { calls++; return { ...result }; },
  });
  return { run, calls: () => calls };
}

test('WIN11_TRANSITION executes a synthetic pending manifest under the publisher SID without invoking a real model', async t => {
  if (skipUnlessWindows(t)) return;
  const f = fixture();
  try {
    f.config.executor_runtime = { ...f.config.executor_runtime,
      user_sid: PUBLISHER_SID, execution_phase: 'WIN11_TRANSITION' };
    let calls = 0;
    const outcome = await executePendingManifest({ manifestDir: f.manifestDir,
      currentSid: () => PUBLISHER_SID, config: f.config,
      execute: async () => { calls++; return { ...TERMINAL_RESULT }; } });
    assert.equal(calls, 1);
    assert.equal(outcome.outcome, 'EXECUTOR_RESULT_PERSISTED_NOT_SEMANTIC_ACCEPTANCE');
    assert.equal(outcome.terminal_state, 'FINISHED');
  } finally { f.dispose(); }
});

test('VM_ISOLATED remains the default and rejects same-SID manifests before claiming them', async t => {
  if (skipUnlessWindows(t)) return;
  const f = fixture();
  try {
    f.config.executor_runtime = { ...f.config.executor_runtime, user_sid: PUBLISHER_SID };
    let calls = 0;
    await assert.rejects(executePendingManifest({ manifestDir: f.manifestDir,
      currentSid: () => PUBLISHER_SID, config: f.config,
      execute: async () => { calls++; return { ...TERMINAL_RESULT }; } }),
    /EXECUTOR_RUNTIME_IDENTITY_INVALID/);
    assert.equal(calls, 0);
    assert.equal(existsSync(join(f.manifestDir, `${ATTEMPT}.pending.json`)), true);
  } finally { f.dispose(); }
});
function skipUnlessWindows(t) {
  if (process.platform !== 'win32') {
    t.skip('Task Scheduler executor lifecycle is Windows-only');
    return true;
  }
  return false;
}

test('executor reads back the exact persisted terminal result before reporting persisted', async t => {
  if (skipUnlessWindows(t)) return;
  const f = fixture();
  try {
    const { run, calls } = persistTerminalResult(f, null);
    const outcome = await run;
    assert.equal(calls(), 1, 'the model execute callback runs exactly once');
    assert.equal(outcome.outcome, 'EXECUTOR_RESULT_PERSISTED_NOT_SEMANTIC_ACCEPTANCE');
    assert.equal(outcome.terminal_state, 'FINISHED');
    assert.equal(outcome.exit_code, 0);
    assert.equal(outcome.evidence_sha256, TERMINAL_RESULT.evidence_sha256);
    assert.equal(outcome.evidence_bytes, TERMINAL_RESULT.evidence_bytes);
    const persisted = JSON.parse(readFileSync(f.resultPath, 'utf8'));
    assert.equal(persisted.request_id, f.job.request_id);
    assert.equal(persisted.attempt_id, ATTEMPT);
    assert.equal(persisted.terminal.state, 'FINISHED');
    assert.equal(persisted.terminal.outcome, TERMINAL_RESULT.outcome);
    assert.equal(persisted.terminal.exit_code, TERMINAL_RESULT.exit_code);
    assert.equal(persisted.terminal.evidence_sha256, TERMINAL_RESULT.evidence_sha256);
    assert.equal(persisted.terminal.evidence_bytes, TERMINAL_RESULT.evidence_bytes);
    const persistedText = readFileSync(f.resultPath, 'utf8');
    assert.equal(readPersistedResult(f.resultPath, {
      expectedBytes: Buffer.byteLength(persistedText, 'utf8'),
    }).terminal.outcome, TERMINAL_RESULT.outcome);
  } finally { f.dispose(); }
});

test('executor rejects a mismatched readback without rerunning and preserves the written result', async t => {
  if (skipUnlessWindows(t)) return;
  const f = fixture();
  try {
    const { run, calls } = persistTerminalResult(f, (path, options) => readPersistedResult(path, {
      ...options,
      readBytes: resultPath => {
        const persisted = JSON.parse(readFileSync(resultPath, 'utf8'));
        persisted.terminal.outcome = 'X'.repeat(persisted.terminal.outcome.length);
        return Buffer.from(JSON.stringify(persisted, null, 2), 'utf8');
      },
    }));
    await assert.rejects(run, error => error.code === 'EXECUTOR_RESULT_READBACK_MISMATCH');
    assert.equal(calls(), 1, 'a readback mismatch must never rerun the model');
    assert.ok(existsSync(f.resultPath), 'the ambiguous result must never be deleted');
    const preserved = JSON.parse(readFileSync(f.resultPath, 'utf8'));
    assert.equal(preserved.terminal.outcome, TERMINAL_RESULT.outcome);
    assert.equal(preserved.terminal.state, 'FINISHED');
  } finally { f.dispose(); }
});

test('executor rejects a changed local-evidence field even when terminal fields still match', async t => {
  if (skipUnlessWindows(t)) return;
  const f = fixture();
  try {
    const { run, calls } = persistTerminalResult(f, path => {
      const persisted = JSON.parse(readFileSync(path, 'utf8'));
      persisted.local_evidence = { stdout_sha256: 'c'.repeat(64) };
      return persisted;
    });
    await assert.rejects(run, error => error.code === 'EXECUTOR_RESULT_READBACK_MISMATCH');
    assert.equal(calls(), 1, 'a tampered evidence readback must never rerun the model');
    assert.ok(existsSync(f.resultPath), 'the written result must remain available for reconciliation');
    const preserved = JSON.parse(readFileSync(f.resultPath, 'utf8'));
    assert.equal(preserved.local_evidence, null);
  } finally { f.dispose(); }
});

test('executor rejects a non-object readback with a fixed code without rerunning', async t => {
  if (skipUnlessWindows(t)) return;
  const f = fixture();
  try {
    const malformedPath = join(f.root, 'malformed-result.json');
    writeFileSync(malformedPath, 'null\n', { flag: 'wx' });
    assert.throws(() => readPersistedResult(malformedPath, {
      expectedBytes: Buffer.byteLength('null\n', 'utf8'),
    }),
      error => error.code === 'EXECUTOR_RESULT_READBACK_FAILED');
    const { run, calls } = persistTerminalResult(f, () => null);
    await assert.rejects(run, error => error.code === 'EXECUTOR_RESULT_READBACK_MISMATCH');
    assert.equal(calls(), 1, 'a malformed readback must never rerun the model');
    assert.ok(existsSync(f.resultPath), 'the written result remains available for reconciliation');
    const preserved = JSON.parse(readFileSync(f.resultPath, 'utf8'));
    assert.equal(preserved.terminal.outcome, TERMINAL_RESULT.outcome);
  } finally { f.dispose(); }
});

test('executor rejects missing, unreadable or size-mismatched readback and preserves the written result', async t => {
  if (skipUnlessWindows(t)) return;
  const cases = [
    ['missing', (path, options) => readPersistedResult(path, { ...options, statFile: () => {
      const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error;
    } })],
    ['unreadable', (path, options) => readPersistedResult(path, { ...options, readBytes: () => {
      const error = new Error('EIO'); error.code = 'EIO'; throw error;
    } })],
    ['size-mismatched', (path, options) => readPersistedResult(path, {
      ...options,
      statFile: () => ({ isFile: () => true, isSymbolicLink: () => false,
        size: options.expectedBytes + 1 }),
      readBytes: () => assert.fail('a mismatched file size must be rejected before reading'),
    })],
  ];
  for (const [label, readPersisted] of cases) {
    const f = fixture();
    try {
      const { run, calls } = persistTerminalResult(f, readPersisted);
      await assert.rejects(run, error => error.code === 'EXECUTOR_RESULT_READBACK_FAILED',
        `${label} readback must fail with the fixed sanitized code`);
      assert.equal(calls(), 1, `${label}: the model execute callback is never rerun`);
      assert.ok(existsSync(f.resultPath), `${label}: the written result is preserved`);
      const preserved = JSON.parse(readFileSync(f.resultPath, 'utf8'));
      assert.equal(preserved.terminal.outcome, TERMINAL_RESULT.outcome);
    } finally { f.dispose(); }
  }
});

test('executor readback accepts a valid record larger than the former fixed cap', async t => {
  if (skipUnlessWindows(t)) return;
  const f = fixture();
  try {
    const payload = 'x'.repeat(4 * 1024 * 1024 + 1);
    const serialized = JSON.stringify({ local_evidence: { payload } }, null, 2);
    const resultPath = join(f.root, 'large-result.json');
    writeFileSync(resultPath, serialized, { flag: 'wx' });
    const readback = readPersistedResult(resultPath, {
      expectedBytes: Buffer.byteLength(serialized, 'utf8'),
    });
    assert.equal(readback.local_evidence.payload.length, payload.length);
  } finally { f.dispose(); }
});

test('executor verifies the complete WAITING receipt including local evidence', async t => {
  if (skipUnlessWindows(t)) return;
  const f = fixture();
  const waiting = { outcome: 'OPENCODE_V2_AUTH_NOT_READY', exit_code: 48,
    evidence_sha256: null, evidence_bytes: 0, eligibility_state: 'WAITING',
    model_invoked: false, local_evidence: { reason: 'auth_wait' } };
  try {
    const { run, calls } = persistTerminalResult(f, (path, options) => readPersistedResult(path, {
      ...options,
      readBytes: resultPath => {
        const persisted = JSON.parse(readFileSync(resultPath, 'utf8'));
        persisted.local_evidence.reason = 'auth_fail';
        return Buffer.from(JSON.stringify(persisted, null, 2), 'utf8');
      },
    }), waiting);
    await assert.rejects(run, error => error.code === 'EXECUTOR_WAITING_RESULT_IDENTITY_MISMATCH');
    assert.equal(calls(), 1, 'a WAITING receipt mismatch must never rerun the model');
    const preserved = JSON.parse(readFileSync(f.resultPath, 'utf8'));
    assert.equal(preserved.terminal.state, 'WAITING');
    assert.equal(preserved.local_evidence.reason, 'auth_wait');
  } finally { f.dispose(); }
});

test('executor preserves schema-6 Antigravity WAITING identity and rejects tampered readback without changing result bytes', async t => {
  if (skipUnlessWindows(t)) return;
  const spec = 'Synthetic schema-6 Antigravity WAITING readback; no model invocation is permitted.';
  const f = fixture({ spec, makeJob: content => ({ ...modelJob(content),
    schema: 6, kind: 'antigravity_edit', request_id: 'PTYSD_W2_WAITING_READBACK_20261029',
    source_sha: 'd'.repeat(40), spec_path: 'native-bridge/tasks/w2-schema6-waiting-result-readback.md',
    model: 'gemini-3.8-flash-high', variant: 'high',
    edit_paths: ['native-bridge/tasks/w2-schema6-waiting-result-readback.md'],
    source_pr: 999999, goal_comment_id: 987654321, goal_body_sha256: 'c'.repeat(64) }) });
  try {
    f.config.enable_antigravity_model_runs = false;
    let executeCalls = 0;
    let originalPersistedBytes;
    const run = executePendingManifest({
      manifestDir: f.manifestDir, currentSid: () => EXECUTOR_SID, config: f.config,
      execute: async () => {
        executeCalls++;
        return { outcome: 'ANTIGRAVITY_MODEL_RUNS_NOT_ENABLED', exit_code: 48,
          eligibility_state: 'WAITING', model_invoked: false };
      },
      readPersisted: (path, options) => {
        originalPersistedBytes = Buffer.from(readFileSync(path));
        const persisted = readPersistedResult(path, options);
        persisted.terminal.goal_body_sha256 = 'e'.repeat(64);
        return persisted;
      },
    });
    await assert.rejects(run,
      error => error.code === 'EXECUTOR_WAITING_RESULT_IDENTITY_MISMATCH');
    assert.equal(executeCalls, 0, 'a disabled W2 lane must not call the execution callback');
    assert.ok(originalPersistedBytes, 'the exact pre-tamper persisted bytes were captured');
    const resultBytesAfterRejection = readFileSync(f.resultPath);
    assert.deepEqual(resultBytesAfterRejection, originalPersistedBytes,
      'tampered readback must not alter the original persisted result bytes');

    const saved = JSON.parse(resultBytesAfterRejection.toString('utf8'));
    const terminal = saved.terminal;
    assert.equal(saved.request_id, f.job.request_id);
    assert.equal(saved.attempt_id, ATTEMPT);
    assert.equal(terminal.request_id, f.job.request_id);
    assert.equal(terminal.attempt_id, ATTEMPT);
    assert.equal(terminal.kind, 'antigravity_edit');
    assert.equal(terminal.source_sha, f.job.source_sha);
    assert.equal(terminal.model, f.job.model);
    assert.equal(terminal.variant, f.job.variant);
    assert.equal(terminal.source_pr, f.job.source_pr);
    assert.equal(terminal.goal_comment_id, f.job.goal_comment_id);
    assert.equal(terminal.goal_body_sha256, f.job.goal_body_sha256);
    assert.equal(terminal.edit_paths_sha256,
      createHash('sha256').update(JSON.stringify(f.job.edit_paths)).digest('hex'));
    assert.equal(terminal.state, 'WAITING');
    assert.equal(terminal.outcome, 'ANTIGRAVITY_MODEL_RUNS_NOT_ENABLED');
    assert.equal(terminal.exit_code, 48);
    assert.equal(terminal.evidence_sha256, null);
    assert.equal(terminal.evidence_bytes, 0);
    assert.equal(terminal.eligibility_state, 'WAITING');
    assert.equal(terminal.model_invoked, false);
    assert.equal(terminal.task_acceptance, 'UNKNOWN');
    assert.equal(terminal.external_effects, 'UNKNOWN');
    assert.equal(parseReceipt(RECEIPT_MARKER + JSON.stringify(terminal))?.state, 'WAITING');
  } finally { f.dispose(); }
});
