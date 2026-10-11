import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanPairedAttempts, evaluateWorkerState } from './server.mjs';

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('matching native export succeeded with valid artifact completes and observes model', () => {
  withTmpDir(dir => {
    const base = 'job-1';
    fs.writeFileSync(path.join(dir, `${base}.intent.json`), JSON.stringify({
      session_id: 'sess-100',
      model: 'provider-a/model-1#high',
      task: 'task-ok'
    }));
    fs.writeFileSync(path.join(dir, `${base}.export.json`), JSON.stringify({
      info: {
        id: 'sess-100',
        model: { providerID: 'provider-a', id: 'model-1', variant: 'high' },
        outcome: 'succeeded'
      }
    }));
    fs.writeFileSync(path.join(dir, `${base}.terminal.json`), JSON.stringify({ exit_code: 0 }));
    fs.writeFileSync(path.join(dir, `${base}.artifact.json`), JSON.stringify({
      files: [{ path: 'dist/out.js', content: 'console.log("ok");' }]
    }));

    const attempts = scanPairedAttempts(dir);
    assert.equal(attempts.length, 1);
    const att = attempts[0];
    assert.equal(att.eventsSummary.nativeInitModel, 'provider-a/model-1#high');
    assert.equal(att.eventsSummary.nativeModelEvidence, 'OBSERVED_NATIVE_EXPORT');
    assert.equal(att.eventsSummary.resultStatus, 'SUCCESS');
    assert.equal(att.hasArtifact, true);

    const evalRes = evaluateWorkerState({ attempt: att, workerRole: 'W2' });
    assert.equal(evalRes.status, 'COMPLETED');
    assert.equal(evalRes.actualModel, 'provider-a/model-1#high');
  });
});

test('wrong session or wrong model/variant rejected with binding mismatch and FAILED', () => {
  withTmpDir(dir => {
    const baseWrongSess = 'job-wrong-sess';
    fs.writeFileSync(path.join(dir, `${baseWrongSess}.intent.json`), JSON.stringify({
      session_id: 'sess-100',
      model: 'provider-a/model-1#high'
    }));
    fs.writeFileSync(path.join(dir, `${baseWrongSess}.export.json`), JSON.stringify({
      info: {
        id: 'sess-DIFFERENT',
        model: { providerID: 'provider-a', id: 'model-1', variant: 'high' },
        outcome: 'succeeded'
      }
    }));

    const baseWrongModel = 'job-wrong-model';
    fs.writeFileSync(path.join(dir, `${baseWrongModel}.intent.json`), JSON.stringify({
      session_id: 'sess-200',
      model: 'provider-a/model-1#high'
    }));
    fs.writeFileSync(path.join(dir, `${baseWrongModel}.export.json`), JSON.stringify({
      info: {
        id: 'sess-200',
        model: { providerID: 'provider-a', id: 'model-2', variant: 'high' },
        outcome: 'succeeded'
      }
    }));

    const baseWrongVar = 'job-wrong-var';
    fs.writeFileSync(path.join(dir, `${baseWrongVar}.intent.json`), JSON.stringify({
      session_id: 'sess-300',
      model: 'provider-a/model-1#high'
    }));
    fs.writeFileSync(path.join(dir, `${baseWrongVar}.export.json`), JSON.stringify({
      info: {
        id: 'sess-300',
        model: { providerID: 'provider-a', id: 'model-1', variant: 'low' },
        outcome: 'succeeded'
      }
    }));

    const attempts = scanPairedAttempts(dir);
    for (const att of attempts) {
      assert.equal(att.eventsSummary.resultStatus, 'FAILED');
      assert.equal(att.eventsSummary.nativeExportError, 'binding mismatch');
      assert.equal(att.eventsSummary.nativeInitModel, null);
      assert.equal(att.eventsSummary.nativeModelEvidence, null);
    }
  });
});

test('outcome failed despite exit 0 results in FAILED', () => {
  withTmpDir(dir => {
    const base = 'job-fail-outcome';
    fs.writeFileSync(path.join(dir, `${base}.intent.json`), JSON.stringify({
      session_id: 'sess-400',
      model: 'provider-a/model-1#high'
    }));
    fs.writeFileSync(path.join(dir, `${base}.export.json`), JSON.stringify({
      info: {
        id: 'sess-400',
        model: { providerID: 'provider-a', id: 'model-1', variant: 'high' },
        outcome: 'failed'
      }
    }));
    fs.writeFileSync(path.join(dir, `${base}.terminal.json`), JSON.stringify({ exit_code: 0 }));
    fs.writeFileSync(path.join(dir, `${base}.artifact.json`), JSON.stringify({
      files: [{ path: 'ok.txt', content: 'test' }]
    }));

    const attempts = scanPairedAttempts(dir);
    const att = attempts[0];
    assert.equal(att.eventsSummary.resultStatus, 'FAILED');
    const evalRes = evaluateWorkerState({ attempt: att, workerRole: 'W2' });
    assert.equal(evalRes.status, 'FAILED');
  });
});

test('missing empty or malformed artifact in OpenCode yields hasArtifact false and UNKNOWN status', () => {
  withTmpDir(dir => {
    const createAttempt = (base, artContent) => {
      fs.writeFileSync(path.join(dir, `${base}.intent.json`), JSON.stringify({
        session_id: `sess-${base}`,
        model: 'provider-a/model-1#high'
      }));
      fs.writeFileSync(path.join(dir, `${base}.export.json`), JSON.stringify({
        info: {
          id: `sess-${base}`,
          model: { providerID: 'provider-a', id: 'model-1', variant: 'high' },
          outcome: 'succeeded'
        }
      }));
      fs.writeFileSync(path.join(dir, `${base}.terminal.json`), JSON.stringify({ exit_code: 0 }));
      if (artContent !== null) {
        fs.writeFileSync(path.join(dir, `${base}.artifact.json`), artContent);
      }
    };

    createAttempt('missing', null);
    createAttempt('empty-files', JSON.stringify({ files: [] }));
    createAttempt('malformed-json', '{ invalid');
    createAttempt('empty-content', JSON.stringify({ files: [{ path: 'x.js', content: '' }] }));

    const attempts = scanPairedAttempts(dir);
    for (const att of attempts) {
      assert.equal(att.hasArtifact, false);
      const evalRes = evaluateWorkerState({ attempt: att, workerRole: 'W2' });
      assert.equal(evalRes.status, 'UNKNOWN');
    }
  });
});

test('cache provenance: good then wrong model', () => {
  withTmpDir(dir => {
    const cache = new Map(), b = 'j1', p = path.join(dir, `${b}.intent.json`), ep = path.join(dir, `${b}.export.json`);
    fs.writeFileSync(p, JSON.stringify({ session_id: 's1', model: 'p/m#h' }));
    fs.writeFileSync(ep, JSON.stringify({ info: { id: 's1', model: { providerID: 'p', id: 'm', variant: 'h' }, outcome: 'succeeded' } }));
    assert.equal(scanPairedAttempts(dir, cache)[0].eventsSummary.resultStatus, 'SUCCESS');
    fs.writeFileSync(ep, JSON.stringify({ info: { id: 's1', model: { providerID: 'p', id: 'm2', variant: 'h' }, outcome: 'succeeded' } }));
    const a2 = scanPairedAttempts(dir, cache)[0];
    assert.equal(a2.eventsSummary.nativeInitModel, null);
    assert.equal(a2.eventsSummary.resultStatus, 'FAILED');
  });
});

test('cache provenance: good then wrong session', () => {
  withTmpDir(dir => {
    const cache = new Map(), b = 'j2', p = path.join(dir, `${b}.intent.json`), ep = path.join(dir, `${b}.export.json`);
    fs.writeFileSync(p, JSON.stringify({ session_id: 's1', model: 'p/m#h' }));
    fs.writeFileSync(ep, JSON.stringify({ info: { id: 's1', model: { providerID: 'p', id: 'm', variant: 'h' }, outcome: 'succeeded' } }));
    assert.equal(scanPairedAttempts(dir, cache)[0].eventsSummary.resultStatus, 'SUCCESS');
    fs.writeFileSync(ep, JSON.stringify({ info: { id: 's2', model: { providerID: 'p', id: 'm', variant: 'h' }, outcome: 'succeeded' } }));
    const a2 = scanPairedAttempts(dir, cache)[0];
    assert.equal(a2.eventsSummary.nativeInitModel, null);
    assert.equal(a2.eventsSummary.resultStatus, 'FAILED');
  });
});

test('cache provenance: good then malformed export', () => {
  withTmpDir(dir => {
    const cache = new Map(), b = 'j3', p = path.join(dir, `${b}.intent.json`), ep = path.join(dir, `${b}.export.json`);
    fs.writeFileSync(p, JSON.stringify({ session_id: 's1', model: 'p/m#h' }));
    fs.writeFileSync(ep, JSON.stringify({ info: { id: 's1', model: { providerID: 'p', id: 'm', variant: 'h' }, outcome: 'succeeded' } }));
    assert.equal(scanPairedAttempts(dir, cache)[0].eventsSummary.resultStatus, 'SUCCESS');
    fs.writeFileSync(ep, '{ malformed');
    const a2 = scanPairedAttempts(dir, cache)[0];
    assert.equal(a2.eventsSummary.nativeInitModel, null);
    assert.equal(a2.eventsSummary.resultStatus, 'FAILED');
  });
});

test('cache provenance: good then removed export', () => {
  withTmpDir(dir => {
    const cache = new Map(), b = 'j4', p = path.join(dir, `${b}.intent.json`), ep = path.join(dir, `${b}.export.json`);
    fs.writeFileSync(p, JSON.stringify({ session_id: 's1', model: 'p/m#h' }));
    fs.writeFileSync(ep, JSON.stringify({ info: { id: 's1', model: { providerID: 'p', id: 'm', variant: 'h' }, outcome: 'succeeded' } }));
    assert.equal(scanPairedAttempts(dir, cache)[0].eventsSummary.resultStatus, 'SUCCESS');
    fs.unlinkSync(ep);
    const a2 = scanPairedAttempts(dir, cache)[0];
    assert.equal(a2.eventsSummary.nativeInitModel, null);
    assert.notEqual(a2.eventsSummary.nativeModelEvidence, 'OBSERVED_NATIVE_EXPORT');
    assert.notEqual(a2.eventsSummary.resultStatus, 'SUCCESS');
  });
});
