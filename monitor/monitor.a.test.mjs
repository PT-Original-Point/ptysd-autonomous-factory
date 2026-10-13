import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  readIncrementalRolloutLog,
  evaluateWorkerState,
  bootstrapRolloutBoundary
} from './server.mjs';

test('A1: Native Text (capital T) and public commentary/final_answer progress', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-a-text-'));
  const logFile = path.join(tmpDir, 'rollout.log');
  const lines = [
    JSON.stringify({ type: 'event_msg', timestamp: '2026-10-09T15:00:00Z', payload: { type: 'task_started' } }),
    JSON.stringify({ timestamp: '2026-10-09T15:00:01Z', payload: { item: { type: 'AgentMessage', phase: 'commentary', content: [{ type: 'Text', text: 'Analyzing repository structure' }] } } }),
    JSON.stringify({ timestamp: '2026-10-09T15:00:02Z', payload: { item: { type: 'Reasoning', text: 'internal scratchpad' } } }),
    JSON.stringify({ timestamp: '2026-10-09T15:00:03Z', payload: { item: { type: 'AgentMessage', phase: 'internal', content: [{ type: 'Text', text: 'hidden thoughts' }] } } }),
    JSON.stringify({ timestamp: '2026-10-09T15:00:04Z', payload: { item: { type: 'AgentMessage', phase: 'final_answer', content: [{ type: 'Text', text: 'Completed verification successfully' }] } } }),
    JSON.stringify({ timestamp: '2026-10-09T15:00:05Z', payload: { item: { type: 'AgentMessage', phase: 'commentary', content: [{ type: 'text', text: 'Backward compat lowercase text' }] } } })
  ];
  fs.writeFileSync(logFile, lines.join('\n') + '\n', 'utf8');

  const stateMap = new Map();
  const state = readIncrementalRolloutLog(logFile, stateMap);
  assert.strictEqual(state.status, 'RUNNING');
  assert.strictEqual(state.lastBoundary, 'task_started');
  assert.strictEqual(state.lastAgentMessage, 'Backward compat lowercase text');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('A1: Bounded streaming scan bootstraps last boundary when file > 2MiB and ignores tool strings', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-a-boot-'));
  const logFile = path.join(tmpDir, 'rollout.log');
  const fd = fs.openSync(logFile, 'w');

  const startEv = JSON.stringify({ type: 'event_msg', timestamp: '2026-10-09T15:01:33Z', payload: { type: 'task_started' } }) + '\n';
  fs.writeSync(fd, Buffer.from(startEv, 'utf8'));

  const toolEv = JSON.stringify({ timestamp: '2026-10-09T15:01:34Z', payload: { item: { type: 'CommandExecution', command: 'echo task_started' } } }) + '\n';
  fs.writeSync(fd, Buffer.from(toolEv, 'utf8'));

  const padChunk = JSON.stringify({ timestamp: '2026-10-09T15:02:00Z', payload: { item: { type: 'McpToolCall', status: 'executed' } } }) + '\n';
  const targetSize = 2.2 * 1024 * 1024;
  let currentSize = Buffer.byteLength(startEv) + Buffer.byteLength(toolEv);
  const padBuffer = Buffer.from(padChunk.repeat(20), 'utf8');
  while (currentSize < targetSize) {
    fs.writeSync(fd, padBuffer);
    currentSize += padBuffer.length;
  }
  fs.writeSync(fd, Buffer.from('{"broken_json: true\n', 'utf8'));
  fs.closeSync(fd);

  const stateMap = new Map();
  const state = readIncrementalRolloutLog(logFile, stateMap);
  assert.strictEqual(state.lastBoundary, 'task_started');
  assert.strictEqual(state.status, 'RUNNING');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('A2: evaluateWorkerState with FAILED uppercase, missing result, and native SUCCESS generation', () => {
  function makeAttemptState({ eventsSummary = {}, terminalInfo = null, hasArtifact = false } = {}) {
    return evaluateWorkerState({
      attempt: {
        intent: { taskId: 'task-w2-a', taskDesc: 'Repair worker A', model: 'native-model-1' },
        eventsSummary: { model: 'native-model-1', ...eventsSummary },
        terminalInfo,
        hasArtifact
      },
      workerRole: 'worker',
      policy: {},
      now: Date.now(),
      osProcesses: []
    });
  }

  const stFailed = makeAttemptState({
    eventsSummary: { resultStatus: 'FAILED' },
    terminalInfo: { exit_code: 0, result: { status: 'FAILED' } },
    hasArtifact: true
  });
  assert.strictEqual(stFailed.status, 'FAILED');
  assert.strictEqual(stFailed.modelEvidence, 'HISTORICAL');

  const stError = makeAttemptState({
    eventsSummary: { resultStatus: 'ERROR' },
    terminalInfo: { exit_code: 0, result: { status: 'ERROR' } },
    hasArtifact: true
  });
  assert.strictEqual(stError.status, 'FAILED');
  assert.strictEqual(stError.modelEvidence, 'HISTORICAL');

  const stCancelled = makeAttemptState({
    eventsSummary: { resultStatus: 'CANCELLED' },
    terminalInfo: { exit_code: 0, result: { status: 'CANCELLED' } },
    hasArtifact: true
  });
  assert.strictEqual(stCancelled.status, 'FAILED');
  assert.strictEqual(stCancelled.modelEvidence, 'HISTORICAL');

  const stLowerFailed = makeAttemptState({
    eventsSummary: { resultStatus: 'failed' },
    terminalInfo: { exit_code: 0, result: { status: 'failed' } },
    hasArtifact: true
  });
  assert.strictEqual(stLowerFailed.status, 'FAILED');
  assert.strictEqual(stLowerFailed.modelEvidence, 'HISTORICAL');

  const stMissing = makeAttemptState({
    eventsSummary: {},
    terminalInfo: { exit_code: 0 },
    hasArtifact: true
  });
  assert.strictEqual(stMissing.status, 'UNKNOWN');
  assert.strictEqual(stMissing.modelEvidence, 'HISTORICAL');

  const stNoArt = makeAttemptState({
    eventsSummary: { resultStatus: 'SUCCESS' },
    terminalInfo: { exit_code: 0, result: { status: 'SUCCESS' } },
    hasArtifact: false
  });
  assert.strictEqual(stNoArt.status, 'UNKNOWN');
  assert.strictEqual(stNoArt.modelEvidence, 'HISTORICAL');

  const stCompleted = makeAttemptState({
    eventsSummary: { resultStatus: 'SUCCESS' },
    terminalInfo: { exit_code: 0, result: { status: 'SUCCESS' } },
    hasArtifact: true
  });
  assert.strictEqual(stCompleted.status, 'COMPLETED');
  assert.strictEqual(stCompleted.modelEvidence, 'HISTORICAL');

  const stAuth = makeAttemptState({
    eventsSummary: {},
    terminalInfo: { exit_code: 1, error: { status: 403, type: 'provider.auth' } },
    hasArtifact: false
  });
  assert.strictEqual(stAuth.status, 'BLOCKED');
  assert.strictEqual(stAuth.modelEvidence, 'REQUESTED_ONLY');
});

test('A1: Bounded streaming scan cap returns null/UNKNOWN bootstrap when file size > maxScan', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-a-cap-'));
  const logFile = path.join(tmpDir, 'rollout.log');
  const ev1 = JSON.stringify({ type: 'event_msg', timestamp: '2026-10-09T15:00:00Z', payload: { type: 'task_started' } }) + '\n';
  const ev2 = JSON.stringify({ type: 'event_msg', timestamp: '2026-10-09T15:00:05Z', payload: { item: { type: 'McpToolCall', status: 'executed' } } }) + '\n';
  fs.writeFileSync(logFile, ev1 + ev2.repeat(50), 'utf8');
  const stat = fs.statSync(logFile);

  const smallMaxScan = 128;
  assert.ok(stat.size > smallMaxScan);
  const bootResult = bootstrapRolloutBoundary(logFile, smallMaxScan);
  assert.strictEqual(bootResult.lastBoundary, null);
  assert.strictEqual(bootResult.status, null);

  const fullResult = bootstrapRolloutBoundary(logFile, stat.size + 1024);
  assert.strictEqual(fullResult.lastBoundary, 'task_started');
  assert.strictEqual(fullResult.status, 'RUNNING');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
