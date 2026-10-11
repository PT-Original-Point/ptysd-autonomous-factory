import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateWorkerState } from './server.mjs';

test('source-only SUCCESS without terminal result yields COMPLETED and retains OBSERVED evidence', () => {
  const attempt = {
    intent: { task: 't1', model: 'p/m#v', session_id: 's1' },
    terminalInfo: { exit_code: 0 },
    eventsSummary: {
      nativeInitModel: 'p/m#v',
      nativeModelEvidence: 'OBSERVED_NATIVE_EXPORT',
      resultStatus: 'SUCCESS'
    },
    hasArtifact: true
  };
  const res = evaluateWorkerState({ attempt, workerRole: 'W2' });
  assert.equal(res.status, 'COMPLETED');
  assert.equal(res.modelEvidence, 'OBSERVED_NATIVE_EXPORT');
  assert.equal(res.actualModel, 'p/m#v');
});

test('failure precedence forces FAILED with Native Result FAILED blocker even with exit0, no terminal, or auth', () => {
  const conflictingExit0 = {
    intent: { task: 't2', model: 'p/m#v' },
    terminalInfo: { exit_code: 0, result: { status: 'SUCCESS' } },
    eventsSummary: { nativeExportError: 'binding mismatch', resultStatus: 'FAILED' }
  };
  const res1 = evaluateWorkerState({ attempt: conflictingExit0, workerRole: 'W2' });
  assert.equal(res1.status, 'FAILED');
  assert.match(res1.blocker, /Native Result FAILED/);

  const noTerminalInterrupted = {
    intent: { task: 't3', model: 'p/m#v' },
    terminalInfo: null,
    eventsSummary: { resultStatus: 'TIMED_OUT' }
  };
  const res2 = evaluateWorkerState({ attempt: noTerminalInterrupted, workerRole: 'W2' });
  assert.equal(res2.status, 'FAILED');
  assert.match(res2.blocker, /Native Result FAILED/);

  const authConflictFailed = {
    intent: { task: 't4', model: 'p/m#v' },
    terminalInfo: null,
    eventsSummary: { streamAuth403: true, resultStatus: 'FAILED' }
  };
  const res3 = evaluateWorkerState({ attempt: authConflictFailed, workerRole: 'W2' });
  assert.equal(res3.status, 'FAILED');
  assert.match(res3.blocker, /Native Result FAILED/);
});

test('streamed FreeTier vs raw 403 classifier distinct tool-route blockers', () => {
  const freeTier = {
    intent: { task: 't5', model: 'p/m#v' },
    eventsSummary: {
      streamAuth403: true,
      streamAuthError: { name: 'FreeTierError', message: 'Quota exhausted on free tier' }
    }
  };
  const res1 = evaluateWorkerState({ attempt: freeTier, workerRole: 'W2' });
  assert.equal(res1.status, 'BLOCKED');
  assert.equal(res1.blocker, '授權失敗 FreeTierError tool-route');
  assert.equal(res1.next, 'builtinBuild送審不重試');

  const raw403 = {
    intent: { task: 't6', model: 'p/m#v' },
    eventsSummary: {
      streamAuth403: true,
      streamAuthError: { status: 403, type: 'provider.auth' }
    }
  };
  const res2 = evaluateWorkerState({ attempt: raw403, workerRole: 'W2' });
  assert.equal(res2.status, 'BLOCKED');
  assert.equal(res2.blocker, '授權不明 AUTH_UNKNOWN tool-route');
  assert.equal(res2.next, 'builtinBuild送審不重試');
});
