import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, chmodSync, readdirSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseJob, selectNext, parseReceipt, receipt, PROJECT, REPO, JOB_MARKER,
  RECEIPT_MARKER, checkModelAuthorization, findNativeCLI, terminalStateForResult,
  runWorker as executeWorker, main as runWorker, writeReceipt, ISSUE_TITLE } from '../native-bridge/worker.mjs';
import { OPERATOR_MARKER, encodeOperatorObservation, parseOperatorObservation }
  from '../native-bridge/operator-observation.mjs';

const commit = 'a'.repeat(40); const hash = 'b'.repeat(64);
const mkjob = (opts = {}) => ({ schema: 1, project_id: PROJECT, host: 'DESKTOP-1B6PD2P',
  request_id: 'PTYSD_NATIVE_PING_20261012', kind: 'ping', source_sha: commit,
  spec_path: null, spec_sha256: null, ...opts });
const encoded = o => JOB_MARKER + JSON.stringify(o);
const com = (id, body, login = 't14210184') => ({ id, body, user: { login } });
const h = x => createHash('sha256').update(x).digest('hex');
function seededOperatorObservation(commentId, sequence, mainSha, at = Date.now()) {
  const timestamp = new Date(at).toISOString();
  return {
    schema: 1, project_id: PROJECT, repo: REPO, issue: 407,
    host_alias: 'win11-primary', snapshot_id: randomUUID(), sequence,
    observed_at: timestamp, published_at: timestamp,
    expires_at: new Date(at + 5 * 60_000).toISOString(),
    source: { kind: 'WIN11_NATIVE_TASK_READBACK', comment_id: commentId,
      issue_comments_observed_at: timestamp, main_sha: mainSha },
    windows: { status: 'FRESH', native_task: { enabled: true, state: 'Ready' },
      opencode_process_count: 0, runner_service_count: 0, runner_service_running: false },
    native_worker: { state: 'POLL_EXECUTED_TASK_TRIGGER_UNVERIFIED',
      current_task: null, latest_task: null, files_modified: 'UNPROVEN',
      remote_commit: null, pull_request: null, ci: 'UNKNOWN', next_owner: 'NO_CURRENT_TASK' },
    opencode_v2: { process_observed_at: timestamp, process_count: 0,
      active_session_count: null, active_session_state: 'UNKNOWN_NO_PASSIVE_API',
      task_binding: 'UNPROVEN', code_changes: 'UNPROVEN',
      remote_commit: null, pull_request: null, ci: 'UNKNOWN' },
    github: { observed_at: timestamp, main_sha: mainSha, issue_comments_count: 2,
      runner_registration: { status: 'UNKNOWN', count: null, observed_at: timestamp },
      organization_runner_registration: 'UNKNOWN_ORG_SCOPE_NOT_AVAILABLE',
      runner_service_count: 0, runner_service_running: false },
    monitor_candidate: null, incident: null,
  };
}

function makeObservationWorkerFixture({ ambiguousReadback = false } = {}) {
  const root = mkdtempSync(join(homedir(), '.ptysd-worker-observation-'));
  const workspace = join(root, 'workspace');
  const stateDir = join(root, 'state');
  mkdirSync(workspace);
  mkdirSync(stateDir);
  const host = hostname().toUpperCase();
  const publisher = 'trusted-publisher';
  const observationId = 701;
  const job = mkjob({ host, request_id: 'PTYSD_NATIVE_OBSERVE_PING_20261014' });
  const store = {
    next: 703,
    comments: [
      com(observationId, encodeOperatorObservation(
        seededOperatorObservation(observationId, 17, commit, Date.now() - 60_000),
      ), publisher),
      com(702, encoded(job), 't14210184'),
    ],
    patches: 0,
    posts: 0,
    failReadback: ambiguousReadback,
    now: Date.now(),
  };
  const config = { repo: REPO, project_id: PROJECT, host, issue: 407,
    workspace, state_dir: stateDir, dispatchers: ['t14210184'] };
  const api = uri => {
    if (uri === 'user') return { login: publisher };
    if (uri === `repos/${REPO}/issues/407`)
      return { title: ISSUE_TITLE, state: 'open' };
    if (uri === `repos/${REPO}/git/ref/heads/main`)
      return { object: { sha: commit } };
    const match = uri.match(/\/issues\/comments\/(\d+)$/);
    if (match) return store.comments.find(c => c.id === Number(match[1]));
    throw new Error(`UNEXPECTED_MOCK_API_ROUTE:${uri}`);
  };
  const observationDependencies = {
    now: () => new Date(store.now),
    collectWindowsObservation: () => ({ status: 'FRESH', observed_at: new Date(store.now).toISOString(),
      tasks_total: 2, legacy_monitor_registered: false, listener_2667: false,
      opencode_process_count: 0, runner_service_count: 0, runner_service_running: false,
      native_task: { registered: true, enabled: true, state: 'Ready', last_run: null,
        last_result: '0x00000000', action_kind: 'WINDOWLESS_LAUNCHER',
        identity_class: 'INTERACTIVE_LIMITED', multiple_instances: 'IGNORENEW',
        trigger_interval_minutes: 5 } }),
    readRunnerRegistration: () => ({ total_count: 0 }),
    readComment: id => structuredClone(store.comments.find(c => c.id === id)),
    patchComment: (id, body) => {
      const comment = store.comments.find(c => c.id === id);
      if (!comment) throw new Error('MOCK_COMMENT_MISSING');
      comment.body = body;
      store.patches++;
    },
    readComments: () => {
      if (store.failReadback) {
        store.failReadback = false;
        throw new Error('MOCK_READBACK_UNAVAILABLE_AFTER_PATCH');
      }
      return structuredClone(store.comments);
    },
  };
  const receiptWrites = [];
  const logs = [];
  const run = () => runWorker({
    config, api, issueComments: () => store.comments,
    observationDependencies,
    writeReceipt: (_config, data, login) => {
      store.comments.push(com(store.next++, RECEIPT_MARKER + JSON.stringify(data), login));
      store.posts++;
      receiptWrites.push(data);
    },
    log: value => logs.push(value),
  });
  return { root, store, run, logs, receiptWrites, observationId,
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// These integration fixtures provide a POSIX shebang file named "gh".
// Windows PATH resolution can select the installed gh.exe instead, so keep
// those provider-facing scenarios in Linux CI and never contact live GitHub here.
const fakeShellIntegration = process.platform === 'win32' ? test.skip : test;

test('terminal state fails closed on capture/storage errors even when child exit is zero', () => {
  assert.equal(terminalStateForResult({ exit_code: 0, outcome: 'EVIDENCE_STORAGE_FAILED' }), 'BLOCKED');
  assert.equal(terminalStateForResult({ exit_code: 0, outcome: 'OUTPUT_CAPTURE_FAILED' }), 'BLOCKED');
  assert.equal(terminalStateForResult({ exit_code: 0, outcome: 'BRIDGE_PING_OK_NOT_OS_ACCEPTANCE' }), 'FINISHED');
  assert.equal(terminalStateForResult({ exit_code: 0, outcome: 'OPENCODE_V2_EXIT_0_UNTRUSTED' }), 'FINISHED');
  assert.equal(terminalStateForResult({ exit_code: 0 }), 'BLOCKED');
});

test('FINISHED is attempt lifecycle only and preserves an unverified semantic outcome', () => {
  const job = mkjob({ schema: 2, kind: 'opencode_plan', spec_path: 'native-bridge/tasks/review.md',
    spec_sha256: hash, model: 'opencode/spark', variant: 'high' });
  const result = { exit_code: 0, outcome: 'OPENCODE_V2_EXIT_0_UNTRUSTED',
    evidence_sha256: hash, evidence_bytes: 24 };
  const finalReceipt = receipt(job.request_id, '0'.repeat(8) + '-0000-4000-8000-000000000000',
    terminalStateForResult(result), job, result);
  assert.equal(finalReceipt.state, 'FINISHED');
  assert.equal(finalReceipt.outcome, 'OPENCODE_V2_EXIT_0_UNTRUSTED');
  assert.equal(Object.hasOwn(finalReceipt, 'accepted'), false);
});

test('Worker main publishes the seeded observation, verifies sequence readback, and preserves legal dispatch on ambiguity', async () => {
  const successful = makeObservationWorkerFixture();
  try {
    await successful.run();
    let observations = successful.store.comments.filter(c => c.body.startsWith(OPERATOR_MARKER));
    assert.equal(observations.length, 1);
    assert.equal(observations[0].id, successful.observationId);
    assert.equal(observations[0].user.login, 'trusted-publisher');
    let value = parseOperatorObservation(observations[0].body);
    assert.equal(value.sequence, 18);
    assert.ok(successful.logs.includes('OPERATOR_OBSERVATION_UPDATED'));
    assert.deepEqual(successful.receiptWrites.map(x => x.state), ['STARTED', 'FINISHED']);
    assert.equal(successful.store.patches, 1);

    successful.store.now += 60_000;
    await successful.run();
    observations = successful.store.comments.filter(c => c.body.startsWith(OPERATOR_MARKER));
    value = parseOperatorObservation(observations[0].body);
    assert.equal(observations.length, 1);
    assert.equal(observations[0].id, successful.observationId);
    assert.equal(value.sequence, 19);
    assert.equal(successful.receiptWrites.length, 2);
    assert.ok(successful.logs.includes('NO_DELTA_NO_LLM'));
  } finally { successful.cleanup(); }

  const ambiguous = makeObservationWorkerFixture({ ambiguousReadback: true });
  try {
    await ambiguous.run();
    const observations = ambiguous.store.comments.filter(c => c.body.startsWith(OPERATOR_MARKER));
    assert.equal(observations.length, 1);
    assert.equal(observations[0].id, ambiguous.observationId);
    assert.equal(ambiguous.store.patches, 1);
    assert.ok(ambiguous.logs.includes('OPERATOR_OBSERVATION_UPDATE_UNKNOWN'));
    assert.ok(!ambiguous.logs.includes('OPERATOR_OBSERVATION_UPDATED'));
    assert.deepEqual(ambiguous.receiptWrites.map(x => x.state), ['STARTED', 'FINISHED'],
      'an ambiguous status readback must not block an otherwise valid ping dispatch');

    ambiguous.store.now += 60_000;
    await ambiguous.run();
    const recovered = ambiguous.store.comments.filter(c => c.body.startsWith(OPERATOR_MARKER));
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].id, ambiguous.observationId);
    assert.equal(parseOperatorObservation(recovered[0].body).sequence, 19);
    assert.equal(ambiguous.receiptWrites.length, 2,
      'reconciliation must not replay the completed task or create duplicate receipts');
    assert.ok(ambiguous.logs.includes('OPERATOR_OBSERVATION_UPDATED'));
  } finally { ambiguous.cleanup(); }
});

test('receipt write reconciles POST-success/readback-failure without posting a duplicate', () => {
  const job = mkjob();
  const attemptId = 'e416334f-404c-4e61-9b0e-f9283ee07013';
  const terminal = receipt(job.request_id, attemptId, 'FINISHED', job, {
    outcome: 'BRIDGE_PING_OK_NOT_OS_ACCEPTANCE', exit_code: 0,
  });
  const comments = [];
  let postCalls = 0;
  let failAfterPost = true;
  const dependencies = {
    readComments: () => {
      if (postCalls && failAfterPost) {
        failAfterPost = false;
        throw new Error('MOCK_REMOTE_READBACK_FAILED');
      }
      return structuredClone(comments);
    },
    postComment: body => {
      postCalls++;
      comments.push(com(1, body, 'worker'));
    },
  };
  assert.throws(() => writeReceipt({}, terminal, 'worker', dependencies),
    /RECEIPT_WRITE_AMBIGUOUS_NO_EXECUTION/);
  assert.equal(comments.length, 1);
  assert.equal(writeReceipt({}, terminal, 'worker', dependencies).status, 'ALREADY_PRESENT');
  assert.equal(postCalls, 1);
  assert.equal(comments.filter(c => parseReceipt(c.body)?.attempt_id === attemptId).length, 1);

  const conflicting = { ...terminal, outcome: 'DIFFERENT_ORIGINAL_CONTENT' };
  let conflictPosts = 0;
  assert.throws(() => writeReceipt({}, conflicting, 'worker', {
    readComments: () => comments,
    postComment: () => conflictPosts++,
  }), /RECEIPT_IDENTITY_CONFLICT/);
  assert.equal(conflictPosts, 0);
});

test('strict exact job contract rejects injection, cross-project, unknown keys and paths', () => {
  assert.deepEqual(parseJob(encoded(mkjob())), mkjob());
  assert.equal(parseJob(encoded(mkjob({ project_id: 'HANYAO' }))), null);
  assert.equal(selectNext([com(1,encoded(mkjob({ host:'OTHER-PC' })))],['t14210184'],'worker','DESKTOP-1B6PD2P'),null);
  assert.equal(parseJob(encoded(mkjob({ kind: 'shell' }))), null);
  assert.equal(parseJob(encoded({ ...mkjob(), command: 'Remove-Item C:\\' })), null);
  assert.equal(parseJob(encoded(mkjob({ kind: 'opencode_plan', spec_path: '../secrets', spec_sha256: hash }))), null);
  assert.equal(parseJob(encoded(mkjob({ kind: 'opencode_plan', spec_path: 'native-bridge/tasks/review.md', spec_sha256: hash }))),null);
  const modelJob = { ...mkjob(), schema: 2, kind: 'opencode_plan', spec_path:'native-bridge/tasks/review.md',
    spec_sha256: hash, model:'opencode/spark', variant:'high' };
  assert.equal(parseJob(encoded(modelJob)).kind, 'opencode_plan');
  assert.equal(parseJob(encoded({...modelJob, model:'https://wrong'})),null);
  assert.equal(parseJob(encoded({...modelJob, variant:'unverified'})).variant,'unverified');
  assert.equal(checkModelAuthorization({...modelJob, variant:'unverified'}, {allowed_models:{'opencode/spark':['high']}}),false);
  assert.equal(parseJob(encoded({...modelJob, shell:'pwsh'})),null);
  assert.equal(parseJob(encoded(mkjob({kind:'native_preflight'}))).kind,'native_preflight');
  assert.equal(parseJob(encoded(mkjob({kind:'native_v2_qualify'}))).kind,'native_v2_qualify');
  assert.equal(parseJob(encoded(mkjob({kind:'native_v2_qualify',spec_path:'tasks/other.md'}))),null);
  assert.ok(checkModelAuthorization(modelJob,{ allowed_models:{ 'opencode/spark':['high'] } }));
  assert.ok(!checkModelAuthorization(modelJob, {allowed_models:{}}));
  assert.equal(parseJob('garbage'), null);
});
test('only allowlisted sender and host are eligible, completed/started jobs never rerun', () => {
  const a = encoded(mkjob());
  const state = [com(1,a,'outsider'), com(2,a)];
  assert.equal(selectNext(state, ['t14210184'], 'worker', 'DESKTOP-1B6PD2P').id, 2);
  assert.equal(selectNext(state, ['t14210184'], 'worker', 'OTHER-HOST'), null);
  const start = receipt(mkjob().request_id,'00000000-0000-0000-0000-000000000000','STARTED',mkjob());
  assert.ok(parseReceipt(RECEIPT_MARKER + JSON.stringify(start)));
  state.push(com(3,RECEIPT_MARKER+JSON.stringify(start),'worker'));
  assert.equal(selectNext(state,['t14210184'],'worker','DESKTOP-1B6PD2P'),null);
});
test('stale unsigned job does not starve newer exact-main job', () => {
  const first=mkjob({request_id:'PTYSD_NATIVE_OLD_20261012',source_sha:'a'.repeat(40)});
  const second=mkjob({request_id:'PTYSD_NATIVE_NEW_20261012',source_sha:'c'.repeat(40)});
  const s=[com(1,encoded(first)),com(2,encoded(second))];
  assert.equal(selectNext(s,['t14210184'],'worker','DESKTOP-1B6PD2P','c'.repeat(40)).id,2);
});
test('corrupt per-attempt result is isolated and does not starve an independent ping', async () => {
  const home=mkdtempSync(join(homedir(),'.ptysd-native-reconcile-'));
  try {
    const workspace=join(home,'workspace'),stateDir=join(home,'state');
    mkdirSync(workspace); mkdirSync(stateDir);
    const attemptId='11111111-1111-4111-8111-111111111111';
    const requestId='PTYSD_NATIVE_CORRUPT_PLAN_20261015';
    const plan={...mkjob({host:hostname().toUpperCase(),request_id:requestId,kind:'opencode_plan',
      spec_path:'native-bridge/tasks/readonly-host-inventory.md',spec_sha256:hash}),
      schema:2,model:'opencode/spark',variant:'high'};
    const ping=mkjob({host:hostname().toUpperCase(),request_id:'PTYSD_NATIVE_INDEPENDENT_PING_20261015'});
    const start=receipt(requestId,attemptId,'STARTED',plan);
    const terminal=receipt(requestId,attemptId,'BLOCKED',plan,
      {outcome:'EVIDENCE_STORAGE_FAILED',exit_code:1,evidence_sha256:null,evidence_bytes:0});
    const cases=[false,true];
    for (const hasTerminal of cases) {
      const comments=[com(1,encoded(plan)),com(2,RECEIPT_MARKER+JSON.stringify(start),'worker')];
      if (hasTerminal) comments.push(com(3,RECEIPT_MARKER+JSON.stringify(terminal),'worker'));
      comments.push(com(4,encoded(ping)));
      const resultPath=join(stateDir,`result-${requestId}-${attemptId}.json`);
      writeFileSync(resultPath,'{"truncated":', 'utf8');
      const logs=[]; let nextId=comments.length+1;
      const executor={task_name:'\\PTYSD\\OpenCodeExecutor',user_sid:'S-1-5-21-100-200-300-1001',
        publisher_sid:'S-1-5-21-100-200-300-1002',node_bin:'C:\\Node\\node.exe',
        script_path:'C:\\PTYSD\\executor.mjs',config_path:'C:\\PTYSD\\executor.json',
        manifest_dir:'C:\\PTYSD\\manifests',results_dir:'C:\\PTYSD\\results',
        working_directory:'C:\\PTYSD'};
      const result=await executeWorker({repo:REPO,project_id:PROJECT,host:hostname().toUpperCase(),issue:101,
        workspace,state_dir:stateDir,dispatchers:['t14210184'],executor,
        enable_v2_model_runs:true,allowed_models:{'opencode/spark':['high']}},{
        apiRead(endpoint) {
          if (endpoint==='user') return {login:'worker'};
          if (endpoint.endsWith('/issues/101')) return {title:'[PTYSD-NATIVE] OpenCode dispatch and receipts',state:'open'};
          if (endpoint.includes('/git/ref/heads/main')) return {object:{sha:commit}};
          const match=endpoint.match(/\/issues\/comments\/(\d+)$/);
          if (match) return comments.find(item=>item.id===Number(match[1]));
          throw new Error(`UNEXPECTED_TEST_API_${endpoint}`);
        },
        commentsRead:()=>comments,
        writeReceipt(_config,data,login) { comments.push(com(nextId++,RECEIPT_MARKER+JSON.stringify(data),login)); },
        executorResultsDir:()=>stateDir,
        executorResultPath:()=>resultPath,
        runPlan:()=>{ throw new Error('TEST_MUST_NOT_START_A_MODEL'); },
        log:value=>logs.push(value),
      });
      assert.equal(result.state,'FINISHED');
      assert.equal(result.request_id,ping.request_id);
      assert.ok(logs.some(value=>/NO_REPLAY/.test(value)),logs.join(' | '));
      assert.equal(comments.filter(item=>parseReceipt(item.body)?.request_id===requestId &&
        parseReceipt(item.body)?.state!=='STARTED').length,hasTerminal?1:0);
      assert.equal(parseReceipt(comments.at(-1).body)?.request_id,ping.request_id);
      rmSync(resultPath,{force:true});
    }
  } finally { rmSync(home,{recursive:true,force:true}); }
});
test('native CLI probe is bounded; no shell wrapper is treated as executable', () => {
  const empty=findNativeCLI({PATH:'/this/directory/does/not/exist'},false);
  assert.equal(empty.bin,null);
  assert.equal(empty.hasWrapper,false);
});
test('duplicate changed dispatch same request ID is blocked', () => {
  const a = encoded(mkjob()), b = encoded(mkjob({ source_sha: 'c'.repeat(40) }));
  assert.equal(selectNext([com(1,a),com(2,b)],['t14210184'],'worker','DESKTOP-1B6PD2P'),null);
});
fakeShellIntegration('worker integration: GitHub queued ping -> start + terminal with same-source readback; no delta zero LLM', () => {
  // The only mocked surfaces are gh and opencode binaries. No GitHub or Windows host is contacted.
  const home = mkdtempSync(join(homedir(), '.ptysd-native-test-'));
  try {
    const bin = join(home,'bin'), work=join(home,'workspace'), state=join(home,'state');
    mkdirSync(bin); mkdirSync(work); mkdirSync(state);
    const fakeGh = join(bin,'gh');
    const mock = join(home,'mock.json');
    const job=mkjob({ host: hostname().toUpperCase() });
    writeFileSync(mock,JSON.stringify({ main:commit, user:'win11-worker', issue:101,
      comments:[com(1, encoded(job))], next:2, spec:''}));
    writeFileSync(fakeGh, `#!/usr/bin/env node\nconst fs=require('fs');const a=process.argv.slice(2);const p=process.env.MOCK_GH_STATE;const x=JSON.parse(fs.readFileSync(p,'utf8'));if(a[0]==='api'){if(a[1]==='user')console.log(JSON.stringify({login:x.user}));else if(a[1].includes('/git/ref/heads/main'))console.log(JSON.stringify({object:{sha:x.main}}));else if(a[1].includes('/issues/comments/')){console.log(JSON.stringify(x.comments.find(c=>c.id===Number(a[1].split('/').pop()))));}else if(a[1].includes('/issues/101/comments'))console.log(JSON.stringify([x.comments]));else if(a[1].endsWith('/issues/101'))console.log(JSON.stringify({title:'[PTYSD-NATIVE] OpenCode dispatch and receipts',state:'open'}));else if(a[1].includes('/contents/'))console.log(JSON.stringify({encoding:'base64',content:Buffer.from(x.spec).toString('base64')}));else process.exit(20);}else if(a[0]==='issue'&&a[1]==='comment'){const fn=a[a.indexOf('--body-file')+1];x.comments.push({id:x.next++,body:fs.readFileSync(fn,'utf8'),user:{login:x.user}});fs.writeFileSync(p,JSON.stringify(x));console.log('posted');}else process.exit(21);\n`);
    chmodSync(fakeGh,0o755);
    writeFileSync(join(bin,'opencode'),'#!/bin/sh\necho UNEXPECTED_OPEN_CODE >&2\nexit 88\n');
    chmodSync(join(bin,'opencode'),0o755);
    const config=join(home,'config.json');
    writeFileSync(config,JSON.stringify({ repo:REPO,project_id:PROJECT,host:hostname().toUpperCase(),issue:101,workspace:work,state_dir:state,dispatchers:['t14210184'],allowed_models:{'opencode/spark':['high']}, enable_v2_model_runs:true }));
    const env={...process.env, PATH:`${bin}:${process.env.PATH}`,MOCK_GH_STATE:mock};
    const path=resolve('native-bridge/worker.mjs');
    const first=spawnSync(process.execPath,[path,'--config',config],{cwd:resolve('.'),env,encoding:'utf8',timeout:15000});
    assert.equal(first.status,0,first.stderr);
    assert.match(first.stdout,/FINISHED_PTYSD_NATIVE_PING/);
    const m=JSON.parse(readFileSync(mock,'utf8'));
    assert.equal(m.comments.length,3);
    assert.equal(parseReceipt(m.comments[1].body).state,'STARTED');
    assert.equal(parseReceipt(m.comments[2].body).state,'FINISHED');
    assert.equal(parseReceipt(m.comments[2].body).outcome,'BRIDGE_PING_OK_NOT_OS_ACCEPTANCE');
    const second=spawnSync(process.execPath,[path,'--config',config],{cwd:resolve('.'),env,encoding:'utf8',timeout:15000});
    assert.equal(second.status,0,second.stderr);
    assert.match(second.stdout,/NO_DELTA_NO_LLM/);
    assert.equal(JSON.parse(readFileSync(mock,'utf8')).comments.length,3);
    // Push trusted immutable pinned plan; fake opencode rejects mutation and posts only digest.
    const plan='review README only';
    m.spec=plan;
    const planJob={...mkjob({ host:hostname().toUpperCase(),request_id:'PTYSD_NATIVE_PLAN_20261012',
      kind:'opencode_plan',spec_path:'native-bridge/tasks/readonly-host-inventory.md',spec_sha256:h(plan)}),schema:2,model:'opencode/spark',variant:'high'};
    m.comments.push(com(m.next++,encoded(planJob))); writeFileSync(mock,JSON.stringify(m));
    writeFileSync(join(bin,'opencode'),`#!/usr/bin/env node\nconst fs=require('fs');const a=process.argv.slice(2);\nif(a.length===1&&a[0]==='--version'){console.log('opencode v2.0.27');process.exit(0)}\nconst c=JSON.parse(fs.readFileSync(require('path').join(process.cwd(),'opencode.json'),'utf8'));\nif(a[0]!=='run'||a.includes('--pure')||a.includes('--variant')||!a.includes('ptysd-readonly')||!a.includes('--model')||a[a.indexOf('--model')+1]!=='opencode/spark#high'||!c.permissions?.some(x=>x.action==='shell'&&x.effect==='deny')||!c.agents?.['ptysd-readonly'])process.exit(43);\nconsole.log('SAFE_V2_REVIEW_MOCK');\n`);
        chmodSync(join(bin,'opencode'),0o755);
    const run=spawnSync(process.execPath,[path,'--config',config],{cwd:resolve('.'),env,encoding:'utf8',timeout:15000});
    assert.equal(run.status,0,run.stderr);
    assert.match(run.stdout,/EXECUTOR_NOT_CONFIGURED_NO_MODEL_DISPATCH/);
    const m2=JSON.parse(readFileSync(mock,'utf8'));
    assert.equal(m2.comments.length,m.comments.length,'no receipt is emitted without a ready separate Executor');
    assert.equal(readdirSync(work).includes('opencode.json'),false,'the dispatcher must not start inline model work');
    // A crashed model attempt is ambiguous, but independent native probes continue.
    const orphan={...planJob,request_id:'PTYSD_NATIVE_ORPHAN_20261013'};
    const orphanStart=receipt(orphan.request_id,'00000000-0000-0000-0000-000000000001','STARTED',orphan);
    m2.comments.push(com(m2.next++,encoded(orphan)));
    m2.comments.push(com(m2.next++,RECEIPT_MARKER+JSON.stringify(orphanStart),'win11-worker'));
    m2.comments.push(com(m2.next++,encoded(mkjob({host:hostname().toUpperCase(),
      request_id:'PTYSD_NATIVE_INDEPENDENT_20261013'}))));
    writeFileSync(mock,JSON.stringify(m2));
    const independent=spawnSync(process.execPath,[path,'--config',config],{cwd:resolve('.'),
      env,encoding:'utf8',timeout:15000});
    assert.equal(independent.status,0,independent.stderr);
    assert.match(independent.stdout,/AMBIGUOUS_STARTED_PTYSD_NATIVE_ORPHAN_20261013/);
    assert.match(independent.stdout,/FINISHED_PTYSD_NATIVE_INDEPENDENT_20261013/);
    const after=JSON.parse(readFileSync(mock,'utf8'));
    assert.equal(parseReceipt(after.comments.at(-1).body).state,'FINISHED');
    assert.equal(after.comments.filter(x=>x.body.startsWith(RECEIPT_MARKER) &&
      parseReceipt(x.body)?.request_id===orphan.request_id).length,1);
  } finally { rmSync(home,{recursive:true,force:true}); }
});

// No real GitHub host, Windows service or model API is invoked in these tests.
fakeShellIntegration('no-LLM preflight yields a terminal receipt and local evidence hash', () => {
  const home=mkdtempSync(join(homedir(), '.ptysd-preflight-test-'));
  try {
    const bin=join(home,'bin'), work=join(home,'work'), state=join(home,'state');
    mkdirSync(bin); mkdirSync(work); mkdirSync(state);
    const mock=join(home,'mock.json');
    const job=mkjob({kind:'native_preflight',host:hostname().toUpperCase(),request_id:'PTYSD_NATIVE_PROBE_20261012'});
    writeFileSync(mock,JSON.stringify({main:commit,user:'win11-worker',issue:101,comments:[com(1,encoded(job))],next:2,spec:''}));
    const fakeGh=join(bin,'gh');
    writeFileSync(fakeGh, `#!/usr/bin/env node
const fs=require('fs');const a=process.argv.slice(2);const p=process.env.MOCK_GH_STATE;const x=JSON.parse(fs.readFileSync(p,'utf8'));if(a[0]==='api'){if(a[1]==='user')console.log(JSON.stringify({login:x.user}));else if(a[1].includes('/git/ref/heads/main'))console.log(JSON.stringify({object:{sha:x.main}}));else if(a[1].includes('/issues/comments/'))console.log(JSON.stringify(x.comments.find(c=>c.id===Number(a[1].split('/').pop()))));else if(a[1].includes('/issues/101/comments'))console.log(JSON.stringify([x.comments]));else if(a[1].endsWith('/issues/101'))console.log(JSON.stringify({title:'[PTYSD-NATIVE] OpenCode dispatch and receipts',state:'open'}));else process.exit(20);}else if(a[0]==='issue'&&a[1]==='comment'){x.comments.push({id:x.next++,body:fs.readFileSync(a[a.indexOf('--body-file')+1],'utf8'),user:{login:x.user}});fs.writeFileSync(p,JSON.stringify(x));}else process.exit(21);
`);
    chmodSync(fakeGh,0o755);
    const config=join(home,'config.json');
    writeFileSync(config,JSON.stringify({repo:REPO,project_id:PROJECT,host:hostname().toUpperCase(),issue:101,workspace:work,state_dir:state,dispatchers:['t14210184']}));
    const runner=resolve('native-bridge/worker.mjs');
    const env={...process.env,PATH:`${bin}:${process.env.PATH}`,MOCK_GH_STATE:mock};
    const res=spawnSync(process.execPath,[runner,'--config',config],{cwd:resolve('.'),env,encoding:'utf8',timeout:15000});
    assert.equal(res.status,0,res.stderr);
    assert.match(res.stdout,/FINISHED_PTYSD_NATIVE_PROBE_20261012/);
    const c=JSON.parse(readFileSync(mock,'utf8')).comments;
    assert.equal(c.length,3);
    const receipt=parseReceipt(c[2].body);
    assert.equal(receipt.state,'FINISHED');
    assert.equal(receipt.kind,'native_preflight');
    assert.match(receipt.evidence_sha256,/^[a-f0-9]{64}$/);
    assert.equal(c[2].body.includes(home),false);
    assert.equal(c[2].body.includes('secret'),false);
  } finally {rmSync(home,{recursive:true,force:true});}
});

fakeShellIntegration('V2 metadata task completes source-pinned GitHub receipts without model inference or credential leak', () => {
  const home=mkdtempSync(join(homedir(), '.ptysd-v2-meta-test-'));
  try {
    const bin=join(home,'bin'), work=join(home,'work'), state=join(home,'state');
    mkdirSync(bin);mkdirSync(work);mkdirSync(state);
    const mock=join(home,'mock.json'), seen=join(home,'calls.txt');
    const job=mkjob({kind:'native_v2_qualify',host:hostname().toUpperCase(),
      request_id:'PTYSD_NATIVE_V2_META_20261013'});
    writeFileSync(mock,JSON.stringify({main:commit,user:'worker',issue:101,
      comments:[com(1,encoded(job))],next:2,spec:''}));
    const ghScript = [
      '#!/usr/bin/env node',
      'const fs=require("fs"),a=process.argv.slice(2),p=process.env.MOCK_GH_STATE,x=JSON.parse(fs.readFileSync(p,"utf8"));',
      'if(a[0]==="api"){if(a[1]==="user")console.log(JSON.stringify({login:x.user}));',
      'else if(a[1].includes("/git/ref/heads/main"))console.log(JSON.stringify({object:{sha:x.main}}));',
      'else if(a[1].includes("/issues/comments/"))console.log(JSON.stringify(x.comments.find(c=>c.id===Number(a[1].split("/").pop()))));',
      'else if(a[1].includes("/issues/101/comments"))console.log(JSON.stringify([x.comments]));',
      'else if(a[1].endsWith("/issues/101"))console.log(JSON.stringify({title:"[PTYSD-NATIVE] OpenCode dispatch and receipts",state:"open"}));',
      'else process.exit(20);}else if(a[0]==="issue"&&a[1]==="comment"){x.comments.push({id:x.next++,body:fs.readFileSync(a[a.indexOf("--body-file")+1],"utf8"),user:{login:x.user}});fs.writeFileSync(p,JSON.stringify(x));}else process.exit(21);'
    ].join('\n')+'\n';
    writeFileSync(join(bin,'gh'),ghScript);chmodSync(join(bin,'gh'),0o755);
    const opencodeScript=[
      '#!/usr/bin/env node',
      'const fs=require("fs"),a=process.argv.slice(2);fs.appendFileSync(process.env.PROBE_CALLS,a.join(" ")+"\\n");',
      'if(a.length===1&&a[0]==="--version")console.log("opencode v2.0.27");',
      'else if(a[0]==="auth"&&a[1]==="list")console.log(JSON.stringify([{provider:"opencode",token:"PRIVATE_TOKEN_CANARY"}]));',
      'else if(a[0]==="models")console.log("opencode/spark-free");',
      'else process.exit(89);'
    ].join('\n')+'\n';
    writeFileSync(join(bin,'opencode'),opencodeScript);chmodSync(join(bin,'opencode'),0o755);
    const config=join(home,'config.json'),runner=resolve('native-bridge/worker.mjs');
    writeFileSync(config,JSON.stringify({repo:REPO,project_id:PROJECT,
      host:hostname().toUpperCase(),issue:101,workspace:work,state_dir:state,
      dispatchers:['t14210184']}));
    const env={...process.env,PATH:bin+':'+process.env.PATH,MOCK_GH_STATE:mock,PROBE_CALLS:seen};
    const first=spawnSync(process.execPath,[runner,'--config',config],{cwd:resolve('.'),
      env,encoding:'utf8',timeout:15000});
    assert.equal(first.status,0,first.stderr);
    assert.match(first.stdout,/FINISHED_PTYSD_NATIVE_V2_META_20261013/);
    const c=JSON.parse(readFileSync(mock,'utf8')).comments;
    assert.equal(c.length,3);
    const end=parseReceipt(c.at(-1).body);
    assert.equal(end.state,'FINISHED');
    assert.equal(end.outcome,'V2_ZERO_TOKEN_METADATA_ONLY_NOT_MODEL_ACCEPTANCE');
    assert.match(end.evidence_sha256,/^[a-f0-9]{64}$/);
    assert.ok(!c.at(-1).body.includes('PRIVATE_TOKEN_CANARY'));
    const e=readdirSync(state).find(x=>x.startsWith('native-evidence-'));
    assert.ok(e);
    const facts=JSON.parse(readFileSync(join(state,e),'utf8'));
    assert.equal(facts.auth_metadata.saved_account_count,1);
    assert.equal(facts.model_catalog.catalog_count,1);
    assert.equal(facts.inference_executed,false);
    assert.ok(!JSON.stringify(facts).includes('PRIVATE_TOKEN_CANARY'));
    const calls=readFileSync(seen,'utf8').trim().split('\n');
    assert.deepEqual(calls,['--version','auth list --format json','models']);
    const second=spawnSync(process.execPath,[runner,'--config',config],{cwd:resolve('.'),
      env,encoding:'utf8',timeout:15000});
    assert.equal(second.status,0,second.stderr);
    assert.match(second.stdout,/NO_DELTA_NO_LLM/);
    assert.equal(readFileSync(seen,'utf8').trim().split('\n').length,3);
  }finally{rmSync(home,{recursive:true,force:true});}
});

test('receipt identity rejects foreign project and wrong source cannot mask current job', () => {
  const job=mkjob(), start=receipt(job.request_id,'00000000-0000-0000-0000-000000000002','STARTED',job);
  assert.equal(parseReceipt(RECEIPT_MARKER+JSON.stringify({...start,project_id:'OTHER'})),null);
  assert.equal(parseReceipt(RECEIPT_MARKER+JSON.stringify({...start,source_sha:'x'.repeat(40)})),null);
  const other={...start,source_sha:'c'.repeat(40)};
  const state=[com(1,encoded(job)),com(2,RECEIPT_MARKER+JSON.stringify(other),'worker')];
  assert.equal(selectNext(state,['t14210184'],'worker',job.host,job.source_sha)?.id,1);
});
