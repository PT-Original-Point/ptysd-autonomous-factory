import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildDashboardState, deriveHomeOverview, fetchGitHubCanonical } from './server.mjs';

const project = 'CHATGPT_GLOBAL_SKILL_GOVERNANCE';
function syntheticReadback({ corrupt = false } = {}) {
  const checkpoint = { project_id: project, checkpoint_seq: 201, event: { type: 'TEST' } };
  const bytes = Buffer.from(JSON.stringify(checkpoint));
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const pointer = {
    project_id: project,
    checkpoint_seq: 201,
    checkpoint_path: 'governance/csg/checkpoints/000201.json',
    checkpoint_digest: 'sha256:' + (corrupt ? '0'.repeat(64) : hash)
  };
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const src = url.includes('/current.json?') ? Buffer.from(JSON.stringify(pointer)) : bytes;
    return { ok: true, json: async () => ({ encoding: 'base64', content: src.toString('base64'), size: src.length, sha: 'a'.repeat(40) }) };
  };
  return { fetchImpl, calls };
}

test('provider canonical pointer and checkpoint must match exact byte digest', async () => {
  const source = syntheticReadback();
  const good = await fetchGitHubCanonical('PT-Original-Point/ptysd-vnext42-governance-sandbox', 'v45/factory-control', source.fetchImpl);
  assert.equal(good.verified, true);
  assert.equal(good.pointer.checkpoint_seq, 201);
  assert.equal(source.calls.length, 2);
  const state = buildDashboardState({
    now: Date.parse(good.collected_at),
    canonicalData: good,
    config: {}
  });
  assert.equal(state.sources.canonical.freshness, 'FRESH');
  assert.equal(state.home.factoryOverview.canonical.control_readback, 'PROVIDER_CONFIRMED');
  assert.equal(state.home.factoryOverview.canonical.accepted, false);
});

test('tampered canonical checkpoint cannot become provider-confirmed', async () => {
  const source = syntheticReadback({ corrupt: true });
  const result = await fetchGitHubCanonical('PT-Original-Point/ptysd-vnext42-governance-sandbox', 'v45/factory-control', source.fetchImpl);
  assert.equal(result.verified, false);
  assert.match(result.error, /inconsistency/);
  const state = buildDashboardState({ canonicalData: result });
  assert.notEqual(state.sources.canonical.freshness, 'FRESH');
  assert.equal(state.home.factoryOverview.canonical.control_readback, 'UNKNOWN');
});

test('OS partial process failure is not zero or RUNNING despite fresh other sections', () => {
  const now = Date.parse('2026-10-11T04:00:00Z');
  const iso = new Date(now).toISOString();
  const state = buildDashboardState({
    now,
    config: { humanW1Paused: true },
    phaseAttempts: [{base: 'w2-one', intent: { task: 'R4 task', model: 'gemini-3.8-flash-high', at_utc: iso },
      processInfo: {pid: 1234, created_at:iso}, eventsSummary:{lastEventAt:iso,nativeInitModel:'gemini-3.8-flash-high'}}],
    windowsData: {status:'MONITORING',collected_at:iso,data: {
      collected_at:iso, processes:[{pid:1234,name:'agy.exe',created_at:iso}], errors:['processes: denied'],
      section_errors: {processes:'access denied',services:null,scheduled_tasks:null,vms:null},
      section_collected_at:{processes:null,services:iso,scheduled_tasks:iso,vms:iso}
    }}
  });
  assert.notEqual(state.sources.windows.freshness, 'FRESH');
  assert.notEqual(state.sources.windows.processes_freshness, 'FRESH');
  assert.equal(state.home.factoryOverview.activeWorkersCount,'未知');
  assert.notEqual(state.workers.find(w=>w.id==='worker-w2').status,'RUNNING');
});

test('duplicate cards for same observed PID are not duplicate workers', () => {
  const state = deriveHomeOverview({sources:{windows:{freshness:'FRESH'}},workers:[
    {id:'worker-w2',pid:100,status:'RUNNING',model_evidence:'OBSERVED_NATIVE_INIT'},
    {id:'worker-w2-one',pid:100,status:'RUNNING',model_evidence:'OBSERVED_NATIVE_INIT'},
    {id:'worker-w1',pid:101,status:'RUNNING',model_evidence:'OBSERVED_NATIVE_INIT'}
  ]});
  assert.equal(state.factoryOverview.activeWorkersCount,2);
  assert.equal(state.genuinelyActive.length,2);
});

test('no readback and historical CI never imply canonical acceptance', () => {
  const s=deriveHomeOverview({tasks:[{worker:'GitHub Actions',status:'COMPLETED',tests:'SUCCESS',head:'b'.repeat(40)}],config:{candidateSha:'a'.repeat(40)}, sources:{github:{freshness:'STALE'}}});
  assert.equal(s.factoryOverview.canonical.control_readback,'UNKNOWN');
  assert.equal(s.factoryOverview.canonical.accepted,false);
  assert.notEqual(s.factoryOverview.ciQualification.status,'CI_PASSED_NON_CANONICAL');
});
