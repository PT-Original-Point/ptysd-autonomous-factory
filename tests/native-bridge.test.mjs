import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, chmodSync, readdirSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseJob, selectNext, parseReceipt, receipt, PROJECT, REPO, JOB_MARKER,
  RECEIPT_MARKER, checkModelAuthorization, findNativeCLI,
  reconcileCodexExecutorResult } from '../native-bridge/worker.mjs';
import { executorResultPath } from '../native-bridge/codex-continuation.mjs';

const commit = 'a'.repeat(40); const hash = 'b'.repeat(64);
const mkjob = (opts = {}) => ({ schema: 1, project_id: PROJECT, host: 'DESKTOP-1B6PD2P',
  request_id: 'PTYSD_NATIVE_PING_20261012', kind: 'ping', source_sha: commit,
  spec_path: null, spec_sha256: null, ...opts });
const encoded = o => JOB_MARKER + JSON.stringify(o);
const com = (id, body, login = 't14210184') => ({ id, body, user: { login } });
const h = x => createHash('sha256').update(x).digest('hex');

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
  const codexJob = { ...mkjob(), schema: 3, kind: 'codex_plan', request_id: 'PTYSD_CODEX_TEST_20261015',
    spec_path: 'native-bridge/tasks/codex-review.md', spec_sha256: hash, model: 'gpt-6.1-sol',
    reasoning_effort: 'medium', write_paths: ['native-bridge/sample.mjs'] };
  assert.equal(parseJob(encoded(codexJob)).kind, 'codex_plan');
  const codexStart = receipt(codexJob.request_id, '00000000-0000-0000-0000-000000000001', 'STARTED', codexJob);
  assert.equal(parseReceipt(RECEIPT_MARKER + JSON.stringify(codexStart)).kind, 'codex_plan');
  assert.equal(selectNext([com(1, encoded(codexJob))], ['t14210184'], 'worker',
    codexJob.host, codexJob.source_sha).job.kind, 'codex_plan');
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
test('native CLI probe is bounded; no shell wrapper is treated as executable', () => {
  const empty=findNativeCLI({PATH:'/this/directory/does/not/exist'},false);
  assert.equal(empty.bin,null);
  assert.equal(empty.hasWrapper,false);
});
test('duplicate changed dispatch same request ID is blocked', () => {
  const a = encoded(mkjob()), b = encoded(mkjob({ source_sha: 'c'.repeat(40) }));
  assert.equal(selectNext([com(1,a),com(2,b)],['t14210184'],'worker','DESKTOP-1B6PD2P'),null);
});
test('worker integration: GitHub queued ping -> start + terminal with same-source readback; no delta zero LLM',
  { skip: process.platform === 'win32' }, () => {
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
    const env={...process.env, PATH:`${bin}${delimiter}${process.env.PATH}`,MOCK_GH_STATE:mock};
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
    assert.match(run.stdout,/FINISHED_PTYSD_NATIVE_PLAN/);
    const m2=JSON.parse(readFileSync(mock,'utf8'));
    const end=parseReceipt(m2.comments.at(-1).body);
    assert.equal(end.outcome,'OPENCODE_V2_EXIT_0_UNTRUSTED');
    assert.match(end.evidence_sha256,/^[a-f0-9]{64}$/);
    assert.equal(JSON.parse(readFileSync(join(work,'opencode.json'),'utf8')).default_agent, 'ptysd-readonly');
    assert.ok(!m2.comments.at(-1).body.includes('SAFE_V2_REVIEW_MOCK'));
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
test('no-LLM preflight yields a terminal receipt and local evidence hash',
  { skip: process.platform === 'win32' }, () => {
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
    const env={...process.env,PATH:`${bin}${delimiter}${process.env.PATH}`,MOCK_GH_STATE:mock};
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

test('V2 metadata task completes source-pinned GitHub receipts without model inference or credential leak',
  { skip: process.platform === 'win32' }, () => {
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
    const env={...process.env,PATH:bin+delimiter+process.env.PATH,MOCK_GH_STATE:mock,PROBE_CALLS:seen};
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

test('bad Codex result reconciliation stays UNKNOWN without replay and does not starve an independent ping', async () => {
  const home=mkdtempSync(join(homedir(),'.ptysd-codex-reconcile-test-'));
  try {
    const spool=join(home,'codex-spool');
    const resultDir=join(spool,'results');
    mkdirSync(resultDir,{recursive:true});
    const attempt='11111111-1111-4111-8111-111111111111';
    const codexJob={...mkjob({request_id:'PTYSD_CODEX_CORRUPT_RESULT_20261015'}),
      schema:3,kind:'codex_plan',spec_path:'native-bridge/tasks/review.md',spec_sha256:hash,
      model:'gpt-6.1-sol',reasoning_effort:'medium',write_paths:['README.md']};
    const started={...receipt(codexJob.request_id,attempt,'STARTED',codexJob),task_fingerprint:hash};
    const ping=mkjob({request_id:'PTYSD_NATIVE_INDEPENDENT_PING_20261015'});
    const comments=[com(1,encoded(codexJob)),
      com(2,RECEIPT_MARKER+JSON.stringify(started),'worker'),com(3,encoded(ping))];
    const config={codex_spool:spool,state_dir:join(home,'state')};
    const resultPath=executorResultPath(spool,codexJob.request_id,attempt);
    writeFileSync(resultPath,'{ truncated executor result');
    const blockedKinds=new Set();

    const corrupt=await reconcileCodexExecutorResult(started,config,'worker',blockedKinds);
    assert.deepEqual(corrupt,{status:'UNKNOWN_NO_REPLAY',reason:'RESULT_OR_RECEIPT_INVALID'});
    assert.ok(blockedKinds.has('codex_plan'));
    assert.equal(parseReceipt(comments[1].body).state,'STARTED');
    assert.equal(selectNext(comments,['t14210184'],'worker',codexJob.host,commit,
      [...blockedKinds]).job.request_id,ping.request_id);

    // A publish/readback error is also attempt-local: do not replay it or stop the ping lane.
    writeFileSync(resultPath,JSON.stringify({schema:1,kind:'codex_plan',
      request_id:codexJob.request_id,attempt_id:attempt,source_sha:codexJob.source_sha,
      exit_code:0,fingerprint:hash,session_id:null,diff_sha256:null,
      stdout_sha256:hash,stderr_sha256:hash,outcome:'CODEX_CLI_EXIT_0_UNVERIFIED',
      model_invoked:true,changed_paths:[],out_of_scope_paths:[],pr_url:null,tests:'NOT_RUN'}));
    let publicationCalls=0;
    const unknownWrite=await reconcileCodexExecutorResult(started,config,'worker',blockedKinds,{
      writeReceiptOnce:async()=>{publicationCalls++;throw new Error('CODEX_RECEIPT_READBACK_UNKNOWN_NO_REPLAY');}
    });
    assert.deepEqual(unknownWrite,{status:'UNKNOWN_NO_REPLAY',reason:'CODEX_RECEIPT_READBACK_UNKNOWN_NO_REPLAY'});
    assert.equal(publicationCalls,1);
    assert.equal(selectNext(comments,['t14210184'],'worker',codexJob.host,commit,
      [...blockedKinds]).job.request_id,ping.request_id);
    assert.equal(comments.filter(c=>parseReceipt(c.body)?.request_id===codexJob.request_id).length,1);
  } finally { rmSync(home,{recursive:true,force:true}); }
});
