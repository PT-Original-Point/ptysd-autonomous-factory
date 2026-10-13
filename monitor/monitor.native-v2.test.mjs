import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboardState, createHttpServer } from './server.mjs';
import { fetchNativeIssueReceipts, deriveNativeV2Status, parseNativeJob, parseNativeReceipt } from './native-v2.mjs';

const main = 'a'.repeat(40), other = 'b'.repeat(40);
const project = 'CHATGPT_GLOBAL_SKILL_GOVERNANCE',host = 'DESKTOP-1B6PD2P';
const req = 'PTYSD_NATIVE_V2_LIVE_RECOVERY_20261013_A01',attempt = '9c8b6130-de76-4220-a7d6-a4bdabea1d18';
const job = {schema:1,project_id:project,host,request_id:req,kind:'native_preflight',
  source_sha:main,spec_path:null,spec_sha256:null};
const rec = (state,sha=main,id=attempt) => ({schema:1,project_id:project,host,
  request_id:req,attempt_id:id,state,kind:job.kind,source_sha:sha,
  outcome:state==='FINISHED'?'OPENCODE_V2_VERSION_CONFIRMED_NO_MODEL_AUTH':'DISPATCH_ACK_NOT_ACCEPTANCE',
  exit_code:state==='FINISHED'?0:null});
const body = (marker,obj) => marker+'\n'+JSON.stringify(obj);
const comment = (id,body,created_at='2026-10-13T07:00:00.000Z') => ({id,body,created_at,login:'t14210184'});
const task = comment(1,body('PTYSD_NATIVE_JOB_V1',job));
const start=comment(2,body('PTYSD_NATIVE_RECEIPT_V1',rec('STARTED')));
const finished=comment(3,body('PTYSD_NATIVE_RECEIPT_V1',rec('FINISHED')));
const now=Date.parse('2026-10-13T07:02:00.000Z');
const snapshot=(comments=[task,start,finished])=>({status:'OK',checked_at:new Date(now).toISOString(),comments});
const win={processes:[{name:'opencode.exe',pid:1234}],scheduled_tasks:[{name:'PTYSD-Native-OpenCode',state:'Ready',last_run:new Date(now-300000).toISOString()}]};
const fresh={processes:'FRESH',scheduled_tasks:'FRESH'};

test('exact native receipt is displayed but never upgraded to coding acceptance',()=>{
  const d=deriveNativeV2Status({provider:snapshot(),windows:win,sectionFreshness:fresh,now});
  assert.equal(d.source,'FRESH');
  assert.equal(d.last_request,req);
  assert.match(d.last_receipt,/FINISHED/);
  assert.match(d.process,/未綁定到寫碼任務/);
  assert.match(d.scheduler,/不等於寫碼/);
  assert.match(d.coding,/尚未確認/);
});
test('same task but different SHA or attempt cannot close STARTED',()=>{
  for(const mismatch of [body('PTYSD_NATIVE_RECEIPT_V1',rec('FINISHED',other)),
    body('PTYSD_NATIVE_RECEIPT_V1',rec('FINISHED',main,'00000000-0000-0000-0000-000000000002'))]){
    const d=deriveNativeV2Status({provider:snapshot([task,start,comment(3,mismatch)]),now});
    assert.match(d.last_receipt,/STARTED/);
  }
});
test('foreign project/host and malformed task never enter native feed',()=>{
  assert.equal(parseNativeJob(body('PTYSD_NATIVE_JOB_V1',{...job,host:'FOREIGN'})),null);
  assert.equal(parseNativeReceipt(body('PTYSD_NATIVE_RECEIPT_V1',{...rec('FINISHED'),project_id:'FOREIGN'})),null);
  assert.equal(parseNativeReceipt(body('PTYSD_NATIVE_RECEIPT_V1',{...rec('FINISHED'),source_sha:'wrong'})),null);
});
test('old STARTED is ambiguous, not worker liveness or a reason for blind retry',()=>{
  const staleStart=comment(2,body('PTYSD_NATIVE_RECEIPT_V1',rec('STARTED')),'2026-10-13T06:00:00.000Z');
  const d=deriveNativeV2Status({provider:snapshot([task,staleStart]),now,windows:win,sectionFreshness:fresh});
  assert.match(d.last_receipt,/超過 20 分鐘/);
  assert.match(d.coding,/尚未確認/);
});
test('OS process and scheduler independently degrade to unknown when collector stale',()=>{
  const d=deriveNativeV2Status({provider:snapshot(),now,windows:win,sectionFreshness:{processes:'STALE',scheduled_tasks:'STALE'}});
  assert.match(d.process,/已過期/);assert.match(d.scheduler,/已過期/);
});
test('GitHub payload freshness is independent of fresh browser and OS heartbeat',()=>{
  const d=deriveNativeV2Status({provider:{...snapshot(),checked_at:new Date(now-600001).toISOString()},now,windows:win,sectionFreshness:fresh});
  assert.equal(d.source,'STALE'); assert.equal(d.last_request,null);
  assert.match(d.note,/不推測/);
});
test('GitHub API failure must not transform stale receipt into success',async()=>{
  const mock=async()=>({ok:false,status:403});
  const d=await fetchNativeIssueReceipts('PT-Original-Point/ptysd-autonomous-factory',mock);
  assert.equal(d.status,'UNKNOWN');assert.equal(d.error,'NATIVE_GITHUB_HTTP_403');
  assert.equal(d.comments.length,0);
});
test('GitHub issue mock reads existing receipts, never creates or posts work',async()=>{
  const seen=[];
  const mock=async(url,opts)=>{seen.push({url,opts});return{ok:true,status:200,
    json:async()=>[{id:1,body:task.body,created_at:task.created_at,user:{login:'t14210184'}}]};};
  const r=await fetchNativeIssueReceipts('PT-Original-Point/ptysd-autonomous-factory',mock);
  assert.equal(r.status,'OK');assert.equal(r.comments.length,1);
  assert.equal(seen.length,1);assert.ok(seen[0].url.includes('issues/407/comments'));
  assert.equal(seen[0].opts.method,undefined);
});
test('wrong repository aborts before network',async()=>{
  let calls=0;const r=await fetchNativeIssueReceipts('WRONG/REPO',()=>{calls++;});
  assert.equal(r.status,'UNKNOWN');assert.equal(calls,0);
});
test('GET state exposes native section without inventing a running coding worker',()=>{
  const state=buildDashboardState({now,config:{},nativeV2Data:snapshot(),windowsData:{
    status:'MONITORING',observed_at:new Date(now).toISOString(),data:{...win,
      collected_at:new Date(now).toISOString(),section_collected_at:{
        processes:new Date(now).toISOString(),scheduled_tasks:new Date(now).toISOString()}}}});
  assert.equal(state.nativeV2.source,'FRESH');
  assert.match(state.nativeV2.coding,/尚未確認/);
  assert.ok(Array.isArray(state.workers));
});
test('native dashboard renders at original read-only localhost, no write endpoint',async()=>{
  const app=createHttpServer({now,config:{},nativeV2Data:snapshot(),windowsData:{status:'UNKNOWN',data:null}});
  await new Promise(ok=>app.listen(0,'127.0.0.1',ok));
  try{
    const url='http://127.0.0.1:'+app.address().port;
    const response=await fetch(url+'/api/state');
    assert.equal(response.status,200);
    const data=await response.json();
    assert.equal(data.nativeV2.last_request,req);
    const bad=await fetch(url+'/api/state',{method:'POST'});
    assert.equal(bad.status,405);
  }finally{await new Promise(ok=>app.close(ok));}
});

test('untrusted Issue author cannot inject a newer native work item',()=>{
  const fake={...job,request_id:'PTYSD_NATIVE_FAKED_20261013'};
  const outsider={...comment(4,body('PTYSD_NATIVE_JOB_V1',fake)),login:'random-outsider'};
  const d=deriveNativeV2Status({provider:snapshot([task,start,finished,outsider]),now});
  assert.equal(d.last_request,req);
  assert.match(d.last_receipt,/FINISHED/);
});
test('untrusted Issue author cannot forge a FINISHED receipt for a real STARTED',()=>{
  const outsider={...finished,login:'random-outsider'};
  const d=deriveNativeV2Status({provider:snapshot([task,start,outsider]),now});
  assert.equal(d.last_request,req);
  assert.match(d.last_receipt,/STARTED/);
  assert.equal(d.last_outcome,null);
});
test('missing GitHub author does not establish native job or terminal identity',()=>{
  const anonymous=[task,start,finished].map(({login,...rest})=>rest);
  const d=deriveNativeV2Status({provider:snapshot(anonymous),now});
  assert.equal(d.last_request,null);
  assert.match(d.last_receipt,/尚無有效/);
});
test('untrusted STARTED cannot allow authorized terminal to masquerade as paired execution',()=>{
  const outsider={...start,login:'random-outsider'};
  const d=deriveNativeV2Status({provider:snapshot([task,outsider,finished]),now});
  assert.equal(d.last_request,req);
  assert.match(d.last_receipt,/還沒有匹配/);
  assert.equal(d.last_outcome,null);
});
