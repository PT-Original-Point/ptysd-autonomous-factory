import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../operator-panel/index.html', import.meta.url), 'utf8');
const inlineScript = html.match(/<script>\s*([\s\S]*?)<\/script>/i)?.[1];
assert.ok(inlineScript, 'operator panel inline module exists');
const windowObject = { __PTYSD_TEST__: true };
runInNewContext(inlineScript, { window: windowObject, document: {}, AbortController,
  setTimeout, clearTimeout }, { filename: 'operator-panel/index.html' });
const panel = windowObject.PTYSDOperatorPanel;
assert.ok(panel?.createApiClient && panel?.createResourceStore);

const baseTime = 1_800_000_000_000;
const head = 'a'.repeat(40);
const TEST_HOST = 'DESKTOP-1B6PD2P';
const urls = {
  issue: 'https://api.github.com/repos/PT-Original-Point/ptysd-autonomous-factory/issues/407/comments?per_page=100',
  pr: 'https://api.github.com/repos/PT-Original-Point/ptysd-autonomous-factory/pulls/434',
  main: 'https://api.github.com/repos/PT-Original-Point/ptysd-autonomous-factory/commits/main',
};

function response(status, body, values = {}) {
  const headers = Object.fromEntries(Object.entries(values).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return { status, ok: status >= 200 && status < 300,
    headers: { get(name) { return headers[String(name).toLowerCase()] ?? null; } },
    async json() { return body; } };
}

function quotaHeaders(now, remaining = 100) {
  return { 'X-RateLimit-Limit': 60, 'X-RateLimit-Remaining': remaining,
    'X-RateLimit-Reset': Math.floor((now + 60 * 60 * 1000) / 1000) };
}

function memoryStorage() {
  const values = new Map();
  return { getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); } };
}

function serialLocks() {
  const tails=new Map();
  return { request(name, _options, callback) {
    const previous=tails.get(name) || Promise.resolve();
    const current=previous.catch(() => undefined).then(callback);
    tails.set(name,current.catch(() => undefined));
    return current;
  } };
}

test('one page stays within the 21-request hourly polling budget', async () => {
  let now = baseTime;
  const calls = [];
  const client = panel.createApiClient(async url => {
    calls.push(url);
    const body = url === urls.issue ? [] : url === urls.pr ? { head: { sha: head } } :
      url === urls.main ? { sha: head } : { check_runs: [] };
    return response(200, body, quotaHeaders(now, 1000 - calls.length));
  }, { now: () => now });
  const store = panel.createResourceStore(client, () => now);
  for (let elapsed = 0; elapsed < 60 * 60 * 1000; elapsed += 5 * 60 * 1000) {
    now = baseTime + elapsed;
    await panel.runSyncCycle(store, client, urls);
  }
  assert.equal(calls.length, 21);
  assert.equal(calls.filter(url => url === urls.issue).length, 12);
  assert.equal(calls.filter(url => url === urls.pr).length, 4);
  assert.equal(calls.filter(url => url === urls.main).length, 1);
  assert.equal(calls.filter(url => url.includes(`/commits/${head}/check-runs`)).length, 4);
});

test('remaining zero pauses every source and repeated manual-style reads cannot bypass reset', async () => {
  let now = baseTime;
  const calls = [];
  const client = panel.createApiClient(async url => {
    calls.push(url);
    return response(200, [], quotaHeaders(now, 0));
  }, { now: () => now });
  const store = panel.createResourceStore(client, () => now);
  await panel.runSyncCycle(store, client, urls);
  assert.equal(calls.length, 1);
  assert.equal(client.getRateState().status, 'RATE_LIMITED');
  await Promise.all(Array.from({ length: 8 }, (_, index) =>
    client.requestJson(`${urls.pr}?manual=${index}`).catch(() => null)));
  assert.equal(calls.length, 1);
  assert.equal(client.isPaused(), true);
});

test('Retry-After takes precedence over an earlier primary reset header', async () => {
  let now = baseTime;
  let calls = 0;
  const client = panel.createApiClient(async () => {
    calls++;
    return response(403, { message: 'API rate limit exceeded' }, {
      ...quotaHeaders(now, 0), 'Retry-After': '3600' });
  }, { now: () => now });
  await assert.rejects(client.requestJson(urls.issue), { code: 'GITHUB_RATE_LIMIT_EXHAUSTED' });
  assert.equal(client.getRateState().pauseUntil, baseTime + 60 * 60 * 1000);
  now = baseTime + 30 * 60 * 1000;
  await assert.rejects(client.requestJson(urls.pr), { code: 'GITHUB_RATE_LIMIT_EXHAUSTED' });
  assert.equal(calls, 1);
});

test('a 403 permission denial with remaining quota does not pause unrelated public reads', async () => {
  let now = baseTime;
  let calls = 0;
  const client = panel.createApiClient(async () => {
    calls++;
    if (calls === 1) return response(403, { message: 'Resource not accessible by integration' }, quotaHeaders(now, 20));
    return response(200, { ok: true }, quotaHeaders(now, 19));
  }, { now: () => now });
  await assert.rejects(client.requestJson(urls.issue), { code: 'GITHUB_PERMISSION_DENIED' });
  assert.equal(client.getRateState().status, 'READY');
  assert.deepEqual(await client.requestJson(urls.pr), { ok: true });
  assert.equal(calls, 2);
});

test('a successful cross-tab lock preserves the GitHub 403 permission error', async () => {
  let calls=0, lockCalls=0;
  const locks={request(_name,_options,callback) { lockCalls++; return Promise.resolve().then(callback); }};
  const client=panel.createApiClient(async () => {
    calls++;
    return response(403,{message:'Resource not accessible by integration'},quotaHeaders(baseTime,20));
  },{now:()=>baseTime,storage:memoryStorage(),locks});
  await assert.rejects(client.requestJson(urls.issue),{code:'GITHUB_PERMISSION_DENIED'});
  assert.equal(lockCalls,1);
  assert.equal(calls,1);
  assert.equal(client.getRateState().status,'READY');
  assert.equal(client.getRateState().coordination,'SHARED_LOCKED');
});

test('a 429 secondary limit applies bounded shared backoff across sources', async () => {
  let now = baseTime;
  let calls = 0;
  const client = panel.createApiClient(async () => {
    calls++;
    return response(429, { message: 'secondary rate limit; abuse detection' }, quotaHeaders(now, 25));
  }, { now: () => now });
  await assert.rejects(client.requestJson(urls.issue), { code: 'GITHUB_SECONDARY_RATE_LIMIT' });
  assert.equal(client.getRateState().pauseUntil, baseTime + 30 * 1000);
  await assert.rejects(client.requestJson(urls.main), { code: 'GITHUB_SECONDARY_RATE_LIMIT' });
  assert.equal(calls, 1);
});

test('a successful cross-tab lock preserves a shared 429 error and cooldown', async () => {
  let now=baseTime, calls=0, lockCalls=0;
  const locks={request(_name,_options,callback) { lockCalls++; return Promise.resolve().then(callback); }};
  const client=panel.createApiClient(async () => {
    calls++;
    return response(429,{message:'secondary rate limit'},quotaHeaders(now,25));
  },{now:()=>now,storage:memoryStorage(),locks});
  await assert.rejects(client.requestJson(urls.issue),{code:'GITHUB_SECONDARY_RATE_LIMIT'});
  assert.equal(client.getRateState().cause,'SECONDARY_LIMIT');
  assert.equal(client.getRateState().pauseUntil,baseTime+30*1000);
  now+=1;
  await assert.rejects(client.requestJson(urls.main),{code:'GITHUB_SECONDARY_RATE_LIMIT'});
  assert.equal(lockCalls,2,'both reads acquire the coordination lock before the shared cooldown is checked');
  assert.equal(calls,1);
});

test('a successful cross-tab lock preserves shared primary quota exhaustion', async () => {
  let calls=0, lockCalls=0;
  const locks={request(_name,_options,callback) { lockCalls++; return Promise.resolve().then(callback); }};
  const client=panel.createApiClient(async () => {
    calls++;
    return response(403,{message:'API rate limit exceeded'},quotaHeaders(baseTime,0));
  },{now:()=>baseTime,storage:memoryStorage(),locks});
  await assert.rejects(client.requestJson(urls.issue),{code:'GITHUB_RATE_LIMIT_EXHAUSTED'});
  assert.equal(client.getRateState().status,'RATE_LIMITED');
  assert.equal(client.getRateState().cause,'PRIMARY_LIMIT');
  await assert.rejects(client.requestJson(urls.pr),{code:'GITHUB_RATE_LIMIT_EXHAUSTED'});
  assert.equal(lockCalls,2);
  assert.equal(calls,1);
});

test('ETag 304 uses only the cached response for the same URL', async () => {
  const calls = [];
  const client = panel.createApiClient(async (url, init) => {
    calls.push({ url, headers: init.headers });
    if (calls.length === 1) return response(200, { marker: 'original' }, {
      ...quotaHeaders(baseTime, 55), ETag: '"issue-v1"' });
    return response(304, null, quotaHeaders(baseTime, 54));
  }, { now: () => baseTime });
  const first = await client.requestJson(urls.issue);
  const second = await client.requestJson(urls.issue);
  assert.deepEqual(first, { marker: 'original' });
  assert.deepEqual(second, first);
  assert.equal(calls[1].headers['If-None-Match'], '"issue-v1"');
});

test('large public responses are shared when storage accepts them', async () => {
  const writes = new Map();
  const storage = { getItem(key) { return writes.get(key) ?? null; },
    setItem(key, value) { writes.set(key, String(value)); }, removeItem(key) { writes.delete(key); } };
  const body = { marker: 'large-public-response', payload: 'x'.repeat(760_000) };
  const client = panel.createApiClient(async () => response(200, body, quotaHeaders(baseTime, 59)),
    { now: () => baseTime, storage });

  assert.deepEqual(await client.requestJson(urls.issue), body);
  const cacheKey = [...writes.keys()].find(key => key.includes(encodeURIComponent(urls.issue)));
  assert.ok(cacheKey, 'a browser storage implementation that accepts the public cache must receive it');
  const cached = JSON.parse(writes.get(cacheKey));
  assert.equal(cached.url, urls.issue);
  assert.deepEqual(cached.data, body);
});

test('ETag 304 remaining zero shares the pause across tabs; inaccessible storage is labeled local-only', async () => {
  let issueCalls = 0;
  let siblingCalls = 0;
  const storage = memoryStorage();
  const firstTab = panel.createApiClient(async () => {
    issueCalls++;
    if (issueCalls === 1) return response(200, { marker: 'cached-source' }, {
      ...quotaHeaders(baseTime, 1), ETag: '"same-source"' });
    return response(304, null, { ...quotaHeaders(baseTime, 0), ETag: '"same-source"' });
  }, { now: () => baseTime, storage });
  const secondTab = panel.createApiClient(async () => {
    siblingCalls++;
    return response(200, { shouldNotBeRead: true }, quotaHeaders(baseTime, 59));
  }, { now: () => baseTime, storage });

  assert.deepEqual(await firstTab.requestJson(urls.issue), { marker: 'cached-source' });
  assert.deepEqual(await firstTab.requestJson(urls.issue), { marker: 'cached-source' });
  assert.equal(firstTab.getRateState().status, 'RATE_LIMITED');
  await assert.rejects(secondTab.requestJson(urls.pr), { code: 'GITHUB_RATE_LIMIT_EXHAUSTED' });
  assert.equal(issueCalls, 2);
  assert.equal(siblingCalls, 0, 'the sibling tab must honor the shared 304 quota headers');

  const unavailableStorage = { getItem() { throw new Error('storage unavailable'); },
    setItem() { throw new Error('storage unavailable'); }, removeItem() { throw new Error('storage unavailable'); } };
  const isolatedTab = panel.createApiClient(async () => response(200, { ok: true }, quotaHeaders(baseTime, 59)),
    { now: () => baseTime, storage: unavailableStorage });
  assert.deepEqual(await isolatedTab.requestJson(urls.main), { ok: true });
  assert.equal(isolatedTab.getRateState().coordination, 'TAB_LOCAL_ONLY');
});

test('three tabs serialize startup reads and reuse same-URL public cache until the resource TTL expires', async () => {
  let now=baseTime;
  const calls=[];
  const active=new Map();
  let activeTotal=0, maxConcurrent=0;
  const storage=memoryStorage();
  const locks=serialLocks();
  const clients=Array.from({length:3},()=>panel.createApiClient(async url => {
    calls.push(url);
    activeTotal++;
    maxConcurrent=Math.max(maxConcurrent,activeTotal);
    const inProgress=(active.get(url) || 0)+1;
    active.set(url,inProgress);
    await new Promise(resolve => setTimeout(resolve,0));
    activeTotal--;
    active.set(url,inProgress-1);
    const count=calls.filter(item => item === url).length;
    const body=url === urls.issue ? [] : url === urls.pr ? {head:{sha:head}} :
      url === urls.main ? {sha:head} : {check_runs:[]};
    if (url === urls.issue && count > 1)
      return response(304,null,{...quotaHeaders(now,55),ETag:'"issue-shared"'});
    return response(200,body,{...quotaHeaders(now,59-calls.length),ETag:'"shared"'});
  },{now:()=>now,storage,locks}));
  const stores=clients.map(client=>panel.createResourceStore(client,()=>now));

  await Promise.all(stores.map((store,index)=>panel.runSyncCycle(store,clients[index],urls)));
  assert.equal(calls.length,4,'all tabs share one fresh response per GitHub URL');
  assert.equal(maxConcurrent,1,'a shared Web Lock prevents overlapping network requests across tabs');
  assert.ok(clients.every(client=>client.getRateState().coordination === 'SHARED_LOCKED'));
  for (const store of stores) assert.equal(store.resources.issue.data.length,0);

  now+=5*60*1000+1;
  await Promise.all(stores.map((store,index)=>panel.runSyncCycle(store,clients[index],urls)));
  assert.equal(calls.length,5,'only the expired Issue resource is revalidated');
  assert.equal(calls.filter(url=>url===urls.issue).length,2);
  assert.ok(clients.every(client=>client.getRateState().status === 'READY'),
    'the fresh shared ETag response prevents the other tabs from issuing duplicate validation reads');
  assert.equal(maxConcurrent,1);
});

test('failed cross-tab lock blocks the network request and degrades coordination visibly', async () => {
  let calls=0;
  const client=panel.createApiClient(async()=>{calls++;return response(200,{},quotaHeaders(baseTime));},{
    now:()=>baseTime,storage:memoryStorage(),locks:{request:async()=>{throw new Error('lock unavailable');}},
  });
  await assert.rejects(client.requestJson(urls.issue),{code:'GITHUB_CROSS_TAB_LOCK_UNAVAILABLE'});
  assert.equal(calls,0,'a failed shared lock must not silently fall back to an uncoordinated request');
  assert.equal(client.getRateState().coordination,'BEST_EFFORT_STORAGE_ONLY');
});

test('a HEAD change clears the old checks binding and summary', async () => {
  const client = panel.createApiClient(async () => response(200, { check_runs: [] }, quotaHeaders(baseTime, 40)),
    { now: () => baseTime });
  const store = panel.createResourceStore(client, () => baseTime);
  const firstUrl = store.bindChecksHead(head);
  await store.loadResource('checks', firstUrl, 0);
  assert.ok(store.checksSummaryForHead(head));
  const nextHead = 'b'.repeat(40);
  const nextUrl = store.bindChecksHead(nextHead);
  assert.notEqual(nextUrl, firstUrl);
  assert.equal(store.checksSummaryForHead(head), null);
  assert.equal(store.resources.checks.data, null);
});

test('schema-4 scoped OpenCode edit is visible as a queued task without implying execution', () => {
  const editJob = { schema:4, project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE',
    host:TEST_HOST, request_id:'PTYSD_NATIVE_EDIT_ROUTE_20261015',
    kind:'opencode_edit', source_sha:head,
    spec_path:'native-bridge/tasks/scoped-edit.md', spec_sha256:'b'.repeat(64),
    model:'opencode/spark', variant:'high', write_paths:['operator-panel/index.html'] };
  assert.equal(panel.validJob(editJob), true);
  const task = panel.latestTask([{ id:41, body:'PTYSD_NATIVE_JOB_V1\n'+JSON.stringify(editJob),
    user:{ login:'t14210184' } }], head);
  assert.equal(task.job.kind, 'opencode_edit');
  assert.equal(task.state, '已接單／尚無 STARTED 收據');
  assert.equal(panel.normalizeFormalTask(task).state, 'QUEUED_NOT_STARTED');
  const manyPaths={...editJob,write_paths:Array.from({length:17},(_,index)=>`src/reviewed-file-${index}.mjs`)};
  assert.equal(panel.validJob(manyPaths),true,
    'the dashboard must not reject exact path scopes accepted by the source policy');
  const longPath=`src/${'x'.repeat(181)}.mjs`;
  assert.ok(longPath.length>180);
  assert.equal(panel.validJob({...editJob,write_paths:[longPath]}),true,
    'the dashboard must not retain a fixed path-character ceiling');
  assert.equal(panel.validJob({...editJob,write_paths:['src/工廠 狀態面板.mjs']}),true,
    'the dashboard must accept an exact Unicode path with spaces');

  for (const invalid of [
    { ...editJob, write_paths:['../outside.txt'] },
    { ...editJob, write_paths:['.github/workflows/release.yml'] },
    { ...editJob, write_paths:['native-bridge/csg-trusted-pr-verifier.mjs'] },
    { ...editJob, write_paths:['src/secret-config.json'] },
    { ...editJob, write_paths:['src/file.js','SRC/FILE.JS'] },
    { ...editJob, write_paths:['src/file?.js'] },
    { ...editJob, write_paths:['src/[a].js'] },
    { ...editJob, write_paths:['src/{a}.js'] },
    { ...editJob, write_paths:['src/NUL.txt'] },
    { ...editJob, write_paths:['src/trailing.'] },
    { ...editJob, write_paths:['src/trailing '] },
    { ...editJob, model:'not-a-provider-model' },
    { ...editJob, model:'opencode/../secret' },
    { ...editJob, variant:'HIGH' },
    { ...editJob, variant:'x'.repeat(41) },
    { ...editJob, extra:'not in the schema' },
  ]) assert.equal(panel.validJob(invalid), false);
  assert.equal(panel.validJob({ ...editJob, write_paths:['native-bridge/worker.mjs'] }), true,
    'the panel must permit exact ordinary native-bridge source scopes');
  assert.equal(panel.validJob({ ...editJob,
    write_paths:['native-bridge/codex-executor-install-state.psm1'] }), true,
  'the panel must not retain a deny rule for the removed installer-state module');
});

test('legacy read-only OpenCode plans remain historical and never appear as queued W1 work', () => {
  const legacyPlan={schema:2,project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE',
    host:TEST_HOST,request_id:'PTYSD_NATIVE_PLAN_RETIRED_20261016',
    kind:'opencode_plan',source_sha:head,spec_path:'native-bridge/tasks/readonly-host-inventory.md',
    spec_sha256:'c'.repeat(64),model:'opencode/spark',variant:'high'};
  const comments=[{id:51,body:'PTYSD_NATIVE_JOB_V1\n'+JSON.stringify(legacyPlan),
    user:{login:'t14210184'}}];
  const selected=panel.latestTask(comments,head);
  assert.equal(panel.validJob(legacyPlan),true,'legacy records stay readable for history');
  assert.equal(selected.state,'LEGACY_READONLY_NOT_DISPATCHED');
  const formal=panel.normalizeFormalTask(selected);
  assert.equal(formal.state,'LEGACY_READONLY_NOT_DISPATCHED');
  assert.equal(panel.classifyW1({},null,'FRESH',baseTime,formal).status,'UNKNOWN');
  const card=panel.workerCardData('W1',null,{status:'UNKNOWN'}, {},formal);
  assert.match(card.task,/歷史唯讀規劃；不會派工/);
  const historicalReceipt={schema:1,project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE',
    host:TEST_HOST,request_id:legacyPlan.request_id,
    attempt_id:'9c8b6130-de76-4220-a7d6-a4bdabea1d18',state:'FINISHED',kind:'opencode_plan',
    source_sha:head,candidate_pr:null,goal_ref:null};
  const withReceipt=panel.latestTask([...comments,{id:52,
    body:'PTYSD_NATIVE_RECEIPT_V1\n'+JSON.stringify(historicalReceipt),user:{login:'wfvupu1212'}}],head);
  assert.equal(withReceipt.state,'LEGACY_READONLY_NOT_DISPATCHED');
  assert.equal(withReceipt.receipt_state,'FINISHED','retain the historical receipt without treating it as a new task state');
  assert.equal(withReceipt.attempt_id,historicalReceipt.attempt_id);
});

test('candidate PR edit jobs remain visible only when the exact open PR head and base match', () => {
  assert.equal(panel.constants.MONITORED_PR_NUMBER, 434,
    'the panel follows the current integrated Draft candidate, not the closed #419');
  const candidateHead='b'.repeat(40);
  const goalRef={issue:310,comment_id:6188322050,
    marker:'PTYSD_V53R4_DELETE_FIRST_AUTONOMY_GOAL_20261015',body_sha256:'d'.repeat(64)};
  const job={schema:6,project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE',host:TEST_HOST,
    request_id:'PTYSD_NATIVE_CANDIDATE_PANEL_20261016',kind:'opencode_edit',source_sha:candidateHead,
    spec_path:'native-bridge/tasks/scoped-edit.md',spec_sha256:'c'.repeat(64),
    model:'opencode/spark',variant:'high',write_paths:['native-bridge/worker.mjs'],candidate_pr:434,goal_ref:goalRef};
  assert.equal(panel.validJob(job),true,'schema-6 candidate jobs from the native Worker are readable');
  assert.equal(panel.validJob({...job,goal_ref:{...goalRef,issue:311}}),false);
  assert.equal(panel.validJob({...job,goal_ref:{...goalRef,marker:'OTHER_GOAL'}}),false);
  const repo={id:1352411536,full_name:'PT-Original-Point/ptysd-autonomous-factory'};
  const pin={number:434,state:'open',base:{ref:'main',sha:head,repo},head:{sha:candidateHead,repo}};
  const comments=[{id:41,body:'PTYSD_NATIVE_JOB_V1\n'+JSON.stringify(job),user:{login:'t14210184'}}];
  const selected=panel.latestTask(comments,head,pin);
  assert.equal(selected.state,'已接單／尚無 STARTED 收據');
  assert.equal(panel.normalizeFormalTask(selected).state,'QUEUED_NOT_STARTED');
  for(const invalidPin of [null,{...pin,head:{...pin.head,sha:'d'.repeat(40)}},
    {...pin,base:{...pin.base,sha:'e'.repeat(40)}},{...pin,state:'closed'},
    {...pin,number:435},
    {...pin,base:{...pin.base,repo:{id:7,full_name:'fork/ptysd-autonomous-factory'}}},
    {...pin,head:{...pin.head,repo:{id:7,full_name:'fork/ptysd-autonomous-factory'}}}]) {
    const unverified=panel.latestTask(comments,head,invalidPin);
    assert.equal(unverified.state,'候選 PR HEAD/base 未核對，來源未確認');
    assert.equal(panel.normalizeFormalTask(unverified).state,'CANDIDATE_PIN_UNVERIFIED');
  }
  const matchingReceipt={schema:1,project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE',
    host:TEST_HOST,request_id:job.request_id,attempt_id:'9c8b6130-de76-4220-a7d6-a4bdabea1d18',
    state:'FINISHED',kind:'opencode_edit',source_sha:candidateHead,candidate_pr:434,goal_ref:goalRef};
  const matchingTask=panel.latestTask([...comments,{id:42,user:{login:'wfvupu1212'},
    body:'PTYSD_NATIVE_RECEIPT_V1\n'+JSON.stringify(matchingReceipt)}],head,pin);
  assert.equal(matchingTask.state,'收到 FINISHED；不代表寫碼驗收');
  assert.equal(matchingTask.attempt_id,matchingReceipt.attempt_id);
  const wrongGoalReceipt={...matchingReceipt,goal_ref:{...goalRef,body_sha256:'e'.repeat(64)}};
  const wrongGoalTask=panel.latestTask([...comments,{id:42,user:{login:'wfvupu1212'},
    body:'PTYSD_NATIVE_RECEIPT_V1\n'+JSON.stringify(wrongGoalReceipt)}],head,pin);
  assert.equal(wrongGoalTask.state,'已接單／尚無 STARTED 收據');
  assert.equal(wrongGoalTask.attempt_id,null,
    'a receipt for another Human GOAL body cannot be attached to this task');
  const withoutPin=panel.latestTask([...comments,{id:42,user:{login:'wfvupu1212'},
    body:'PTYSD_NATIVE_RECEIPT_V1\n'+JSON.stringify(matchingReceipt)}],head,null);
  assert.equal(withoutPin.state,'候選 PR HEAD/base 未核對，來源未確認');
  assert.equal(withoutPin.attempt_id,null,
    'receipt history is not attached to a candidate task until the live PR pin is verified');
  const mismatchedReceipt={schema:1,project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE',
    host:TEST_HOST,request_id:job.request_id,attempt_id:'9c8b6130-de76-4220-a7d6-a4bdabea1d18',
    state:'FINISHED',kind:'opencode_edit',source_sha:candidateHead,candidate_pr:435,goal_ref:goalRef};
  const withForeignReceipt=[...comments,{id:42,user:{login:'wfvupu1212'},
    body:'PTYSD_NATIVE_RECEIPT_V1\n'+JSON.stringify(mismatchedReceipt)}];
  const stillQueued=panel.latestTask(withForeignReceipt,head,pin);
  assert.equal(stillQueued.state,'已接單／尚無 STARTED 收據',
    'a receipt for another PR cannot finish this candidate attempt');
  assert.equal(stillQueued.attempt_id,null);
});
