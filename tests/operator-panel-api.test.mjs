import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { TextEncoder } from 'node:util';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../operator-panel/index.html', import.meta.url), 'utf8');
const v2QualificationWorkflow = readFileSync(
  new URL('../.github/workflows/v53r4-v2-cli-qualification.yml', import.meta.url), 'utf8');
const inlineScript = html.match(/<script>\s*([\s\S]*?)<\/script>/i)?.[1];
assert.ok(inlineScript, 'operator panel inline module exists');
const windowObject = { __PTYSD_TEST__: true };
const domElements = new Map();
function elementMock() {
  const children=[];
  return { textContent:'',className:'',hidden:false,href:'#',children,
    get firstChild() { return children[0] || null; },
    appendChild(child) { children.push(child); return child; },
    removeChild(child) { const index=children.indexOf(child); if (index >= 0) children.splice(index,1); return child; } };
}
const documentMock = { getElementById(id) {
  if (!domElements.has(id)) domElements.set(id, elementMock());
  return domElements.get(id);
}, createElement() { return elementMock(); } };
runInNewContext(inlineScript, { window: windowObject, document: documentMock, AbortController,
  crypto:webcrypto, TextEncoder,
  setTimeout, clearTimeout }, { filename: 'operator-panel/index.html' });
const panel = windowObject.PTYSDOperatorPanel;
assert.ok(panel?.createApiClient && panel?.createResourceStore);

const baseTime = 1_800_000_000_000;
const head = 'a'.repeat(40);
const repository = 'PT-Original-Point/ptysd-autonomous-factory';
const apiRoot = `https://api.github.com/repos/${repository}`;
const urls = {
  issue: `${apiRoot}/issues/407/comments?per_page=100`,
  pr: `${apiRoot}/pulls/437`,
  main: `${apiRoot}/commits/main`,
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

function observationComments(now, { prNumber = 437, sourceSha = head, latestTask = true } = {}) {
  const observedAt = new Date(now).toISOString();
  const commentId = 407007;
  const snapshot = {
    schema: 1, project_id: 'CHATGPT_GLOBAL_SKILL_GOVERNANCE', repo: repository,
    issue: 407, host_alias: 'win11-primary', snapshot_id: '11111111-1111-4111-8111-111111111111',
    sequence: 3, observed_at: observedAt,
    expires_at: new Date(now + 10 * 60 * 1000).toISOString(),
    source: { comment_id: commentId },
    native_worker: { latest_task: latestTask ? {
      request_id: 'PTYSD_OPERATOR_PANEL_TEST_20261016', kind: 'opencode_edit',
      source_pr: prNumber, source_sha: sourceSha, state: 'QUEUED_NOT_STARTED',
    } : null },
  };
  return [{ id: commentId, user: { login: 'wfvupu1212' }, updated_at: observedAt,
    body: 'PTYSD_OPERATOR_OBSERVATION_V1\n' + JSON.stringify(snapshot) }];
}

function pullRequest(number, sha, { state = 'open', baseRepo = repository, headRepo = repository } = {}) {
  return { number, state, base: { ref: 'main', repo: { id: 1352411536, full_name: baseRepo } },
    head: { sha, repo: { id: 1352411536, full_name: headRepo } } };
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

test('polling the latest W2 comment page stays within the hourly request budget', async () => {
  let now = baseTime;
  const calls = [];
  const budgetUrls = { ...urls, goal:apiRoot + '/issues/310/comments?per_page=100&sort=created&direction=desc' };
  const latestIssueUrl = budgetUrls.issue + '&page=2';
  const latestGoalUrl = budgetUrls.goal + '&page=2';
  const issueFillers = Array.from({length:99},(_,index) => ({id:6_100_000_000+index,
    user:{login:'t14210184'},body:'older Issue #407 comment '+index}));
  const firstGoalPage = Array.from({length:100},(_,index) => ({id:6_000_000_000+index,
    user:{login:'t14210184'},body:'historical comment '+index}));
  const latestIssueLink = `<${latestIssueUrl}>; rel="next", <${latestIssueUrl}>; rel="last"`;
  const lastGoalLink = `<${latestGoalUrl}>; rel="next", <${latestGoalUrl}>; rel="last"`;
  const client = panel.createApiClient(async url => {
    calls.push(url);
    const body = url === budgetUrls.issue ? [...observationComments(now),...issueFillers] :
      url === latestIssueUrl ? [] : url === budgetUrls.goal ? firstGoalPage : url === latestGoalUrl ? [] :
      url === budgetUrls.pr ? pullRequest(437, head) :
        url === budgetUrls.main ? { sha: head } : { check_runs: [] };
    return response(200, body, {...quotaHeaders(now, 1000 - calls.length),
      ...(url===budgetUrls.issue ? {Link:latestIssueLink} : {}),
      ...(url===budgetUrls.goal ? {Link:lastGoalLink} : {})});
  }, { now: () => now });
  const store = panel.createResourceStore(client, () => now);
  for (let elapsed = 0; elapsed < 60 * 60 * 1000; elapsed += 5 * 60 * 1000) {
    now = baseTime + elapsed;
    await panel.runSyncCycle(store, client, budgetUrls);
  }
  assert.equal(calls.length, 30);
  assert.equal(calls.filter(url => url === budgetUrls.issue).length, 12);
  assert.equal(calls.filter(url => url === latestIssueUrl).length, 4);
  assert.equal(calls.filter(url => url === budgetUrls.goal).length, 1);
  assert.equal(calls.filter(url => url === latestGoalUrl).length, 4);
  assert.equal(calls.filter(url => url === budgetUrls.pr).length, 4);
  assert.equal(calls.filter(url => url === budgetUrls.main).length, 1);
  assert.equal(calls.filter(url => url.includes(`/commits/${head}/check-runs`)).length, 4);
});

test('manual sync coordination copy matches the configured fifteen-minute throttle', () => {
  assert.equal(panel.constants.MANUAL_SYNC_MIN_MS, 15 * 60 * 1000);
  const emptyResource = { data:null, fetchedAt:0, error:null };
  panel.renderRateStatus({ status:'READY', coordination:'TAB_LOCAL_ONLY', remaining:null,
    lastError:null, lastSuccessAt:null, resetAt:null, pauseUntil:null, indefinite:false },
    { issue:emptyResource, pr:emptyResource, checks:emptyResource, main:emptyResource }, baseTime);
  const detail=domElements.get('rate-alert-detail').textContent;
  const next=domElements.get('next-sync').textContent;
  assert.match(detail, /仍遵守 GitHub 共用冷卻及 15 分鐘最小間隔/);
  assert.match(next, /手動同步會以 ETag 重新驗證，最短間隔 15 分鐘/);
  assert.doesNotMatch(detail + next, /最短間隔 60 秒/);
});

test('scheduled polling plus throttled manual sync stays within the 60-read public API budget', async () => {
  let now = baseTime;
  const calls = [];
  const budgetUrls = { ...urls, goal:apiRoot + '/issues/310/comments?per_page=100&sort=created&direction=desc' };
  const latestIssueUrl = budgetUrls.issue + '&page=2';
  const latestGoalUrl = budgetUrls.goal + '&page=2';
  const issueFillers = Array.from({length:99},(_,index) => ({id:6_100_000_000+index,
    user:{login:'t14210184'},body:'older Issue #407 comment '+index}));
  const firstGoalPage = Array.from({length:100},(_,index) => ({id:6_000_000_000+index,
    user:{login:'t14210184'},body:'historical comment '+index}));
  const latestIssueLink = `<${latestIssueUrl}>; rel="next", <${latestIssueUrl}>; rel="last"`;
  const lastGoalLink = `<${latestGoalUrl}>; rel="next", <${latestGoalUrl}>; rel="last"`;
  const storage = memoryStorage();
  const locks = serialLocks();
  const client = panel.createApiClient(async (url, init) => {
    calls.push(url);
    if (url !== budgetUrls.issue && init?.headers?.['If-None-Match'])
      return response(304, null, { ...quotaHeaders(now, 60 - calls.length), ETag: `etag:${url}` });
    const body = url === budgetUrls.issue ? [...observationComments(now),...issueFillers] :
      url === latestIssueUrl ? [] : url === budgetUrls.goal ? firstGoalPage : url === latestGoalUrl ? [] :
      url === budgetUrls.pr ? pullRequest(437, head) :
        url === budgetUrls.main ? { sha: head } : { check_runs: [] };
    return response(200, body, { ...quotaHeaders(now, 60 - calls.length), ETag: `etag:${url}`,
      ...(url===budgetUrls.issue ? {Link:latestIssueLink} : {}),
      ...(url===budgetUrls.goal ? {Link:lastGoalLink} : {}) });
  }, { now: () => now, storage, locks });
  const store = panel.createResourceStore(client, () => now);
  const manualMinutes = [];

  for (let minute = 0; minute < 60; minute++) {
    now = baseTime + minute * 60 * 1000;
    if (minute % 5 === 0) await panel.runSyncCycle(store, client, budgetUrls);
    if (await client.claimManualSyncWindow()) {
      manualMinutes.push(minute);
      await panel.runSyncCycle(store, client, budgetUrls, { force: true });
    }
  }

  assert.deepEqual(manualMinutes, [0, 15, 30, 45]);
  assert.ok(calls.length <= 60,
    'scheduled and throttled manual reads stay below the public unauthenticated primary limit');
});

test('schema-6 jobs verify their exact Human Goal comment through the existing comment API', async () => {
  const humanGoal = { id:6188322050, user:{login:'t14210184'},
    issue_url:apiRoot + '/issues/310',
    body:'<!-- PTYSD_V53R4_DELETE_FIRST_AUTONOMY_GOAL_20261015 -->\nPinned Human authority.' };
  const identity = await panel.hashHumanGoalComment(humanGoal);
  const job = {
    schema:6, project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE', host:'DESKTOP-1B6PD2P',
    request_id:'W2_PANEL_GOAL_FALLBACK_20261027_A1B2C3D4', kind:'antigravity_edit',
    source_sha:'b'.repeat(40), spec_path:'native-bridge/tasks/w2-r7-panel-evidence.md',
    spec_sha256:'c'.repeat(64), model:'gemini-3.8-flash-high', variant:'high',
    edit_paths:['operator-panel/index.html'], source_pr:579,
    goal_comment_id:humanGoal.id, goal_body_sha256:identity.body_sha256,
  };
  const goalUrl=apiRoot + '/issues/310/comments?per_page=100&sort=created&direction=desc';
  const exactGoalUrl=apiRoot + '/issues/comments/' + humanGoal.id;
  const calls=[];
  const client=panel.createApiClient(async url => {
    calls.push(url);
    if (url===urls.issue) return response(200,observationComments(baseTime,{latestTask:false}),quotaHeaders(baseTime));
    if (url===goalUrl) return response(200,[{id:6439900001,user:{login:'t14210184'},
      body:'PTYSD_NATIVE_JOB_V1\n'+JSON.stringify(job)}],quotaHeaders(baseTime));
    if (url===exactGoalUrl) return response(200,humanGoal,quotaHeaders(baseTime));
    if (url===urls.main) return response(200,{sha:head},quotaHeaders(baseTime));
    throw new Error('unexpected API URL: ' + url);
  },{now:()=>baseTime});
  const store=panel.createResourceStore(client,()=>baseTime);
  await panel.runSyncCycle(store,client,{...urls,goal:goalUrl});
  assert.ok(calls.includes(exactGoalUrl),'the panel fetches the job-pinned Human comment by ID');
  assert.equal(store.resources.goal.identity.id,humanGoal.id);
  assert.equal(store.resources.goal.identity.body_sha256,identity.body_sha256);
});

test('the newest schema-6 job is discovered on GitHub Issue #310 last page', async () => {
  const humanGoal = { id:6188322050, user:{login:'t14210184'},
    issue_url:apiRoot + '/issues/310',
    body:'<!-- PTYSD_V53R4_DELETE_FIRST_AUTONOMY_GOAL_20261015 -->\nPinned Human authority.' };
  const identity=await panel.hashHumanGoalComment(humanGoal);
  const job={schema:6,project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE',host:'DESKTOP-1B6PD2P',
    request_id:'W2_PANEL_LAST_PAGE_20261027_A1B2C3D4',kind:'antigravity_edit',source_sha:'b'.repeat(40),
    spec_path:'native-bridge/tasks/w2-r7-panel-evidence.md',spec_sha256:'c'.repeat(64),
    model:'gemini-3.8-flash-high',variant:'high',edit_paths:['operator-panel/index.html'],
    source_pr:579,goal_comment_id:humanGoal.id,goal_body_sha256:identity.body_sha256};
  const goalUrl=apiRoot+'/issues/310/comments?per_page=100&sort=created&direction=desc';
  const lastUrl=goalUrl+'&page=2';
  const firstPage=Array.from({length:100},(_,index)=>({id:5_800_000_000+index,
    user:{login:'t14210184'},body:'older comment '+index}));
  firstPage[47]=humanGoal;
  const latestPage=[{id:6440507307,user:{login:'t14210184'},
    body:'PTYSD_NATIVE_JOB_V1\n'+JSON.stringify(job)}];
  const calls=[];
  const client=panel.createApiClient(async url=>{
    calls.push(url);
    if(url===urls.issue) return response(200,observationComments(baseTime,{latestTask:false}),quotaHeaders(baseTime));
    if(url===goalUrl) return response(200,firstPage,{...quotaHeaders(baseTime),
      Link:`<${lastUrl}>; rel="next", <${lastUrl}>; rel="last"`});
    if(url===lastUrl) return response(200,latestPage,{...quotaHeaders(baseTime),
      Link:`<${goalUrl}&page=1>; rel="prev", <${goalUrl}&page=1>; rel="first"`});
    if(url===urls.main) return response(200,{sha:head},quotaHeaders(baseTime));
    throw new Error('unexpected API URL: '+url);
  },{now:()=>baseTime});
  const store=panel.createResourceStore(client,()=>baseTime);
  await panel.runSyncCycle(store,client,{...urls,goal:goalUrl});
  assert.ok(calls.includes(lastUrl));
  assert.equal(store.resources.goal.latestComplete,true);
  const evidence=panel.w2EvidenceData(store.resources.goal.latestComments,[],head,
    store.resources.goal.identity,store.resources.goal.latestComplete);
  assert.equal(evidence.native.job.request_id,job.request_id);
  assert.equal(evidence.native.jobCommentId,6440507307);
  assert.equal(evidence.native.goalReferenceVerified,true);
});

test('the W2 receipt is recovered from Issue #407 last page and remains bound to its job', async () => {
  const humanGoal={id:6188322050,user:{login:'t14210184'},issue_url:apiRoot+'/issues/310',
    body:'<!-- PTYSD_V53R4_DELETE_FIRST_AUTONOMY_GOAL_20261015 -->\nPinned Human authority.'};
  const identity=await panel.hashHumanGoalComment(humanGoal);
  const requestId='W2_PANEL_ISSUE_PAGINATION_20261027_A1B2C3D4';
  const sourceSha='b'.repeat(40);
  const job={schema:6,project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE',host:'DESKTOP-1B6PD2P',
    request_id:requestId,kind:'antigravity_edit',source_sha:sourceSha,
    spec_path:'native-bridge/tasks/w2-r7-panel-evidence.md',spec_sha256:'c'.repeat(64),
    model:'gemini-3.8-flash-high',variant:'high',edit_paths:['operator-panel/index.html'],
    source_pr:579,goal_comment_id:humanGoal.id,goal_body_sha256:identity.body_sha256};
  const attemptId='9ca84030-61c9-4b74-bc2c-1872bca46050';
  const receipt={schema:1,project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE',host:'DESKTOP-1B6PD2P',
    request_id:requestId,attempt_id:attemptId,state:'BLOCKED',kind:'antigravity_edit',
    source_sha:sourceSha,source_pr:579,session_id:'gemini-native-session-579',
    task_acceptance:'UNKNOWN',external_effects:'UNKNOWN'};
  const issueUrl=apiRoot+'/issues/407/comments?per_page=100';
  const issueLastUrl=issueUrl+'&page=2';
  const goalUrl=apiRoot+'/issues/310/comments?per_page=100&sort=created&direction=desc';
  const issuePage=Array.from({length:100},(_,index)=>({id:6_100_000_000+index,
    user:{login:'t14210184'},body:'older Issue #407 comment '+index}));
  issuePage[0]=observationComments(baseTime,{latestTask:false})[0];
  const issueLast=[{id:6440844675,user:{login:'t14210184'},
    body:'PTYSD_NATIVE_RECEIPT_V1\n'+JSON.stringify(receipt)}];
  const calls=[];
  const client=panel.createApiClient(async url=>{
    calls.push(url);
    if(url===issueUrl) return response(200,issuePage,{...quotaHeaders(baseTime),
      Link:`<${issueLastUrl}>; rel="next", <${issueLastUrl}>; rel="last"`});
    if(url===issueLastUrl) return response(200,issueLast,{...quotaHeaders(baseTime),
      Link:`<${issueUrl}&page=1>; rel="prev", <${issueUrl}&page=1>; rel="first"`});
    if(url===goalUrl) return response(200,[{id:6440507307,user:{login:'t14210184'},
      body:'PTYSD_NATIVE_JOB_V1\n'+JSON.stringify(job)}],quotaHeaders(baseTime));
    if(url===apiRoot+'/issues/comments/'+humanGoal.id) return response(200,humanGoal,quotaHeaders(baseTime));
    if(url===urls.main) return response(200,{sha:head},quotaHeaders(baseTime));
    throw new Error('unexpected API URL: '+url);
  },{now:()=>baseTime});
  const store=panel.createResourceStore(client,()=>baseTime);
  await panel.runSyncCycle(store,client,{...urls,issue:issueUrl,goal:goalUrl});
  assert.ok(calls.includes(issueLastUrl));
  assert.equal(store.resources.issue.latestComplete,true);
  const evidence=panel.w2EvidenceData(store.resources.goal.latestComments,
    store.resources.issue.latestComments,head,store.resources.goal.identity,
    store.resources.goal.latestComplete,store.resources.issue.latestComplete);
  assert.equal(evidence.native.job.request_id,requestId);
  assert.equal(evidence.native.receipt.attempt_id,attemptId);
  assert.equal(evidence.native.receipt.session_id,receipt.session_id);
  assert.equal(evidence.native.receipt.state,'BLOCKED');
  assert.equal(evidence.native.receipt.external_effects,'UNKNOWN');
});

test('manual sync revalidates fresh resources with ETags but cannot bypass a shared rate pause', async () => {
  let now = baseTime;
  let blockIssue = false;
  const calls = [];
  const client = panel.createApiClient(async (url, init) => {
    calls.push({ url, headers: init?.headers || {} });
    if (blockIssue && url === urls.issue) {
      blockIssue = false;
      return response(403, { message: 'API rate limit exceeded' }, quotaHeaders(now, 0));
    }
    if (init?.headers?.['If-None-Match'])
      return response(304, null, { ...quotaHeaders(now, 40), ETag: `etag:${url}` });
    const body = url === urls.issue ? observationComments(now) : url === urls.pr ? pullRequest(437, head) :
      url === urls.main ? { sha: head } : { check_runs: [] };
    return response(200, body, { ...quotaHeaders(now, 50), ETag: `etag:${url}` });
  }, { now: () => now });
  const store = panel.createResourceStore(client, () => now);

  await panel.runSyncCycle(store, client, urls);
  assert.equal(calls.length, 4);
  now += 1000;
  await panel.runSyncCycle(store, client, urls);
  assert.equal(calls.length, 4, 'ordinary polling honors each resource TTL');

  await panel.runSyncCycle(store, client, urls, { force: true });
  assert.equal(calls.length, 8, 'manual sync revalidates all four sources despite fresh cached data');
  assert.ok(calls.slice(4).every(call => call.headers['If-None-Match']),
    'manual revalidation uses the cached ETag instead of discarding the conditional cache');

  blockIssue = true;
  now += 1000;
  await panel.runSyncCycle(store, client, urls, { force: true });
  assert.equal(calls.length, 9, 'the first source exhausts the shared quota and stops later sources');
  assert.equal(client.getRateState().status, 'RATE_LIMITED');
  await panel.runSyncCycle(store, client, urls, { force: true });
  assert.equal(calls.length, 9, 'another manual sync cannot bypass the shared cooldown');
});

test('manual sync minimum interval is shared across tabs and respects the shared rate pause', async () => {
  let now = baseTime;
  assert.equal(panel.constants.MANUAL_SYNC_MIN_MS, 15 * 60 * 1000,
    'one page can issue at most four manual cycles (16 source reads) per hour');
  const storage = memoryStorage();
  const locks = serialLocks();
  let exhausted = false;
  const createClient = () => panel.createApiClient(async () => {
    if (exhausted) return response(403, { message: 'API rate limit exceeded' }, quotaHeaders(now, 0));
    return response(200, { ok: true }, quotaHeaders(now, 20));
  }, { now: () => now, storage, locks });
  const firstTab = createClient();
  const secondTab = createClient();

  assert.equal(await firstTab.claimManualSyncWindow(), true);
  assert.equal(await secondTab.claimManualSyncWindow(), false,
    'another tab cannot claim a second manual sync inside the shared interval');
  now += panel.constants.MANUAL_SYNC_MIN_MS;
  assert.equal(await secondTab.claimManualSyncWindow(), true,
    'a manual sync is allowed when the common minimum interval has elapsed');

  exhausted = true;
  await assert.rejects(firstTab.requestJson(urls.issue), { code: 'GITHUB_RATE_LIMIT_EXHAUSTED' });
  assert.equal(await secondTab.claimManualSyncWindow(), false,
    'the shared rate pause blocks a manual sync even when its minimum interval elapsed');
});

test('PR and checks reads require a fresh exact task pin and use its PR number', async () => {
  let now = baseTime;
  const calls = [];
  const client = panel.createApiClient(async url => {
    calls.push(url);
    if (url === urls.issue) return response(200, observationComments(now), quotaHeaders(now));
    if (url === urls.pr) return response(200, pullRequest(437, head), quotaHeaders(now));
    if (url === urls.main) return response(200, { sha: head }, quotaHeaders(now));
    if (url === `${apiRoot}/commits/${head}/check-runs?per_page=100`)
      return response(200, { check_runs: [{ head_sha: head, name: 'hosted', status: 'completed', conclusion: 'success' }] }, quotaHeaders(now));
    throw new Error(`UNEXPECTED_URL:${url}`);
  }, { now: () => now });
  const store = panel.createResourceStore(client, () => now);
  const cycle = await panel.runSyncCycle(store, client, { issue: urls.issue, main: urls.main });
  assert.equal(cycle.prPin.number, 437);
  assert.deepEqual(calls, [urls.issue, urls.pr, urls.main,
    `${apiRoot}/commits/${head}/check-runs?per_page=100`]);
  assert.equal(store.checksSummaryForHead(head, 437).pr_number, 437);

  const missingPin = panel.candidatePrPin(panel.findSnapshot(
    observationComments(now, { latestTask: false }), now));
  assert.equal(missingPin, null);
  const stalePin = panel.candidatePrPin(panel.findSnapshot(
    observationComments(now - 11 * 60 * 1000), now));
  assert.equal(stalePin, null, 'an expired Win11 snapshot cannot select a PR or refresh its CI');
});

test('missing or stale observation pins never fall back to a hard-coded PR or checks URL', async () => {
  for (const commentsForCase of [
    observationComments(baseTime, { latestTask: false }),
    observationComments(baseTime - 11 * 60 * 1000),
  ]) {
    let now = baseTime;
    const calls = [];
    const client = panel.createApiClient(async url => {
      calls.push(url);
      if (url === urls.issue) return response(200, commentsForCase, quotaHeaders(now));
      if (url === urls.main) return response(200, { sha: head }, quotaHeaders(now));
      throw new Error(`UNEXPECTED_UNPINNED_READ:${url}`);
    }, { now: () => now });
    const store = panel.createResourceStore(client, () => now);
    const result = await panel.runSyncCycle(store, client, { issue: urls.issue, main: urls.main });
    assert.equal(result.prPin, null);
    assert.equal(calls.some(url => url.includes('/pulls/') || url.includes('/check-runs')), false);
    assert.equal(store.resources.checks.error, 'TASK_PR_PIN_UNKNOWN');
  }
});

test('PR identity mismatch never requests checks for an unpinned or foreign candidate', async () => {
  let now = baseTime;
  const calls = [];
  const client = panel.createApiClient(async url => {
    calls.push(url);
    if (url === urls.issue) return response(200, observationComments(now), quotaHeaders(now));
    if (url === urls.pr) return response(200,
      pullRequest(437, head, { headRepo: 'someone-else/fork' }), quotaHeaders(now));
    if (url === urls.main) return response(200, { sha: head }, quotaHeaders(now));
    throw new Error(`UNEXPECTED_URL:${url}`);
  }, { now: () => now });
  const store = panel.createResourceStore(client, () => now);
  const cycle = await panel.runSyncCycle(store, client, { issue: urls.issue, main: urls.main });
  assert.equal(cycle.pullIdentityMatches, false);
  assert.ok(calls.includes(urls.pr));
  assert.equal(calls.some(url => url.includes('/check-runs')), false);
  assert.equal(store.resources.checks.error, 'REPO_OR_PROJECT_IDENTITY_MISMATCH');
});

test('closed unmerged task PR is historical lifecycle, not candidate identity failure', async () => {
  let now=baseTime;
  const calls=[];
  const closed={...pullRequest(437,head,{state:'closed'}),merged:false,merged_at:null};
  const client=panel.createApiClient(async url => {
    calls.push(url);
    if (url === urls.issue) return response(200,observationComments(now),quotaHeaders(now));
    if (url === urls.pr) return response(200,closed,quotaHeaders(now));
    if (url === urls.main) return response(200,{sha:head},quotaHeaders(now));
    throw new Error(`UNEXPECTED_CLOSED_PR_READ:${url}`);
  },{now:() => now});
  const store=panel.createResourceStore(client,() => now);
  const cycle=await panel.runSyncCycle(store,client,{issue:urls.issue,main:urls.main});
  assert.equal(cycle.pullIdentityMatches,true);
  assert.equal(cycle.pullLifecycle.lifecycle,'CLOSED_UNMERGED');
  assert.equal(cycle.pullLifecycle.source_sha_matches,true);
  assert.equal(cycle.pullLifecycle.checks_allowed,false);
  assert.equal(store.resources.checks.error,null,
    'a closed historical PR has no applicable checks; this is not a GitHub API error');
  assert.equal(calls.some(url => url.includes('/check-runs')),false);
  const direct=panel.candidatePullLifecycle(closed,{number:437,source_sha:head});
  assert.equal(direct.status,'CLOSED_UNMERGED');
  assert.equal(direct.identity_matches,true);
});

test('task SHA drift is reported separately and never reads current PR checks for the old task', async () => {
  let now=baseTime;
  const staleTaskSha='c'.repeat(40);
  const calls=[];
  const client=panel.createApiClient(async url => {
    calls.push(url);
    if (url === urls.issue) return response(200,
      observationComments(now,{sourceSha:staleTaskSha}),quotaHeaders(now));
    if (url === urls.pr) return response(200,pullRequest(437,head),quotaHeaders(now));
    if (url === urls.main) return response(200,{sha:head},quotaHeaders(now));
    throw new Error(`UNEXPECTED_SHA_DRIFT_READ:${url}`);
  },{now:() => now});
  const store=panel.createResourceStore(client,() => now);
  const cycle=await panel.runSyncCycle(store,client,{issue:urls.issue,main:urls.main});
  assert.equal(cycle.pullLifecycle.lifecycle,'OPEN_REVIEWABLE');
  assert.equal(cycle.pullLifecycle.status,'SOURCE_SHA_DRIFT');
  assert.equal(cycle.pullLifecycle.source_sha_matches,false);
  assert.equal(cycle.pullLifecycle.checks_allowed,false);
  assert.equal(store.resources.checks.error,null);
  assert.equal(calls.some(url => url.includes('/check-runs')),false);
});

test('formal W1/W2 cards fetch their exact schema-6 job, source PR, and SHA-bound checks once', async () => {
  let now=baseTime;
  const w1Request='W1_PANEL_FETCH_20261024';
  const w2Request='W2_PANEL_FETCH_20261024';
  const w2Sha='b'.repeat(40);
  const w1CommentId=6356591863;
  const w2CommentId=6342391654;
  const common={schema:6,project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE',host:'DESKTOP-1B6PD2P',
    goal_comment_id:6188322050,goal_body_sha256:'c'.repeat(64),
    spec_path:'native-bridge/tasks/panel-fetch-test.md',spec_sha256:'d'.repeat(64),
    edit_paths:['tests/operator-panel-api.test.mjs']};
  const w1Job={...common,request_id:w1Request,kind:'opencode_edit',source_sha:head,
    model:'opencode/deepseek-v4.1-flash-free',variant:null,source_pr:437};
  const w2Job={...common,request_id:w2Request,kind:'antigravity_edit',source_sha:w2Sha,
    model:'gemini-3.8-flash-high',variant:'high',source_pr:461};
  const w1JobUrl=`${apiRoot}/issues/comments/${w1CommentId}`;
  const w2JobUrl=`${apiRoot}/issues/comments/${w2CommentId}`;
  const w2PrUrl=`${apiRoot}/pulls/461`;
  const w2ChecksUrl=`${apiRoot}/commits/${w2Sha}/check-runs?per_page=100`;
  const calls=[];
  const snapshot={schema:1,project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE',repo:repository,
    issue:407,host_alias:'win11-primary',snapshot_id:'11111111-1111-4111-8111-111111111111',
    sequence:3,observed_at:new Date(now).toISOString(),expires_at:new Date(now+10*60_000).toISOString(),
    source:{comment_id:407007},
    native_worker:{latest_task:{request_id:w1Request,kind:'opencode_edit',source_pr:437,
      source_sha:head,state:'QUEUED_NOT_STARTED',job_comment_id:w1CommentId}},
    workers:[{worker_id:'W2',status:'BLOCKED',task_id:w2Request,task_kind:'antigravity_edit',
      task_source_sha:w2Sha,source_pr:461,task_comment_id:w2CommentId,task_state:'BLOCKED'}]};
  const issue=[{id:407007,user:{login:'wfvupu1212'},updated_at:new Date(now).toISOString(),
    body:'PTYSD_OPERATOR_OBSERVATION_V1\n'+JSON.stringify(snapshot)}];
  const jobComment=(id,job) => ({id,user:{login:'t14210184'},created_at:new Date(now-1000).toISOString(),
    body:'PTYSD_NATIVE_JOB_V1\n'+JSON.stringify(job)});
  const client=panel.createApiClient(async url => {
    calls.push(url);
    if (url === urls.issue) return response(200,issue,quotaHeaders(now));
    if (url === urls.pr) return response(200,pullRequest(437,head),quotaHeaders(now));
    if (url === urls.main) return response(200,{sha:head},quotaHeaders(now));
    if (url === `${apiRoot}/commits/${head}/check-runs?per_page=100` || url === w2ChecksUrl)
      return response(200,{check_runs:[]},quotaHeaders(now));
    if (url === w1JobUrl) return response(200,jobComment(w1CommentId,w1Job),quotaHeaders(now));
    if (url === w2JobUrl) return response(200,jobComment(w2CommentId,w2Job),quotaHeaders(now));
    if (url === w2PrUrl) return response(200,pullRequest(461,w2Sha),quotaHeaders(now));
    throw new Error(`UNEXPECTED_FORMAL_DISPATCH_READ:${url}`);
  },{now:() => now});
  const store=panel.createResourceStore(client,() => now);
  await panel.runSyncCycle(store,client,{issue:urls.issue,main:urls.main});
  assert.equal(store.resources.dispatches.W1.data.id,w1CommentId);
  assert.equal(store.resources.dispatches.W2.data.id,w2CommentId);
  assert.equal(store.resources.dispatchPulls.W2.data.number,461);
  assert.equal(store.resources.dispatchChecks.W2.url,w2ChecksUrl);
  assert.equal(calls.filter(url => url === w1JobUrl).length,1);
  assert.equal(calls.filter(url => url === w2JobUrl).length,1);
  assert.equal(calls.filter(url => url === w2PrUrl).length,1);
  assert.equal(calls.filter(url => url === w2ChecksUrl).length,1);
  assert.equal(panel.validSchema6DispatchComment(store.resources.dispatches.W1.data,
    {comment_id:w1CommentId,request_id:w1Request,source_sha:head,kind:'opencode_edit',source_pr:437}).model,
    w1Job.model);
});

test('renderer separates closed W1 source history from live worker status and shows three dispatch cards', () => {
  domElements.clear();
  const now=baseTime;
  const observedAt=new Date(now-30_000).toISOString();
  const expiresAt=new Date(now+90_000).toISOString();
  const w1Sha='221e0c0e4524e07bc06a2aae431fdd34d121b73d';
  const mainSha='0a54bab4cef150f0c43cd27d96c09697e422db78';
  const requestId='W1_PANEL_CLOSED_PR_20261024';
  const attemptId='3f9246cd-f968-4290-9c76-0514bb7775b5';
  const jobCommentId=6356591863;
  const task={worker_id:'W1',status:'UNKNOWN',task_id:requestId,task_kind:'opencode_edit',
    task_source_sha:w1Sha,source_pr:505,task_comment_id:jobCommentId,
    task_state:'FINISHED_NOT_ACCEPTANCE',attempt_id:attemptId,code_changes:'DIFF_CAPTURED_UNVERIFIED',
    changed_files_count:2,diff_sha256:'d'.repeat(64),next_owner:'Codex'};
  const snapshot={schema:1,project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE',
    repo:repository,issue:407,host_alias:'win11-primary',
    snapshot_id:'11111111-1111-4111-8111-111111111111',sequence:511,
    observed_at:observedAt,expires_at:expiresAt,
    source:{comment_id:6144415195,main_sha:mainSha},
    runtime_deployment:{status:'MANIFEST_MATCHED',observed_at:observedAt,source_main_sha:mainSha,
      deployment_pr:592,deployment_pr_head:'c'.repeat(40),bundle_sha256:'d'.repeat(64)},
    windows:{status:'FRESH',observed_at:observedAt,native_task:{registered:true,enabled:true,
      state:'READY',identity_class:'INTERACTIVE_LIMITED',multiple_instances:'IgnoreNew',
      start_when_available:true},
      executor_tasks:{
        opencode:{registered:true,enabled:true,state:'READY',last_run:observedAt,last_result:'0X00000000'},
        antigravity:{registered:true,enabled:false,state:'DISABLED',last_run:observedAt,last_result:'0X00000000'},
        codex:{registered:true,enabled:true,state:'RUNNING',last_run:observedAt,last_result:'0X00000000'},
      }},
    native_worker:{latest_task:{request_id:requestId,kind:'opencode_edit',source_pr:505,
      source_sha:w1Sha,state:'FINISHED_NOT_ACCEPTANCE'}},
    workers:[task,{worker_id:'W2',status:'BLOCKED',task_id:'W2_PANEL_TEST',
      blocker_code:'ANTIGRAVITY_EDIT_TOOL_EXECUTION_FAILED_DIFF_PRESERVED',
      model_execution_switch:'DISABLED'},
      {worker_id:'W3',status:'UNKNOWN'}],
    opencode_v2:{process_count:0,installed_version:'2.0.32'}};
  const observationComment={id:6144415195,user:{login:'wfvupu1212'},
    updated_at:new Date(now-20_000).toISOString(),
    body:'PTYSD_OPERATOR_OBSERVATION_V1\n'+JSON.stringify(snapshot)};
  const receipt={schema:1,project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE',host:'DESKTOP-1B6PD2P',
    request_id:requestId,source_sha:w1Sha,kind:'opencode_edit',attempt_id:attemptId,state:'FINISHED',
    outcome:'V2_EDIT_DIFF_CAPTURED_UNVERIFIED',model_invoked:true,tool_execution_count:2};
  const receiptComment={id:6357000001,user:{login:'t14210184'},
    created_at:new Date(now-10_000).toISOString(),
    body:'PTYSD_NATIVE_RECEIPT_V1\n'+JSON.stringify(receipt)};
  const job={schema:6,project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE',host:'DESKTOP-1B6PD2P',
    request_id:requestId,kind:'opencode_edit',source_sha:w1Sha,
    spec_path:'native-bridge/tasks/panel-test.md',spec_sha256:'a'.repeat(64),
    model:'opencode/deepseek-v4.1-flash-free',variant:null,
    edit_paths:['tests/operator-panel-api.test.mjs'],source_pr:505,
    goal_comment_id:6188322050,goal_body_sha256:'b'.repeat(64)};
  const jobComment={id:jobCommentId,user:{login:'t14210184'},
    created_at:new Date(now-15_000).toISOString(),
    body:'PTYSD_NATIVE_JOB_V1\n'+JSON.stringify(job)};
  const closedPr={number:505,state:'closed',draft:false,merged:false,merged_at:null,
    base:{ref:'main',sha:'2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2',
      repo:{id:1352411536,full_name:repository}},
    head:{sha:w1Sha,repo:{id:1352411536,full_name:repository}}};
  const resources={
    issue:{data:[observationComment,receiptComment],fetchedAt:now,error:null,url:urls.issue},
    pr:{data:closedPr,fetchedAt:now,error:null,url:`${apiRoot}/pulls/505`},
    main:{data:{sha:mainSha},fetchedAt:now,error:null,url:urls.main},
    checks:{data:null,fetchedAt:0,error:'CLOSED_UNMERGED',url:''},
    dispatches:{W1:{data:jobComment,fetchedAt:now,error:null}},
    dispatchPulls:{},dispatchChecks:{},
  };
  const lifecycle=panel.candidatePullLifecycle(closedPr,{number:505,source_sha:w1Sha});
  assert.equal(lifecycle.lifecycle,'CLOSED_UNMERGED');
  assert.equal(lifecycle.identity_matches,true);
  panel.render(null,resources,null,now,{status:'READY',coordination:'SHARED_LOCKED',remaining:40,
    lastError:null,lastSuccessAt:now,resetAt:null,pauseUntil:null,indefinite:false});
  panel.render(null,resources,null,now,{status:'RATE_LIMITED',coordination:'SHARED_LOCKED',remaining:0,
    lastError:'GITHUB_RATE_LIMIT_EXHAUSTED',lastSuccessAt:now,resetAt:now+60_000,
    pauseUntil:now+60_000,indefinite:false});
  assert.equal(domElements.get('github-state').className,'badge bad',
    'a global GitHub rate pause must not color the cached Issue badge as healthy');
  assert.match(domElements.get('github-state').textContent,/額度耗盡/);
  assert.equal(domElements.get('overall').className,'panel overview unknown',
    'the overview must not keep a healthy color while its own copy says live status is unknown');
  panel.render(null,resources,null,now,{status:'COOLDOWN',coordination:'SHARED_LOCKED',remaining:10,
    lastError:'GITHUB_API_COOLDOWN',lastSuccessAt:now,resetAt:now+30_000,
    pauseUntil:now+30_000,indefinite:false});
  assert.equal(domElements.get('github-state').className,'badge warn');
  assert.match(domElements.get('github-state').textContent,/冷卻中/);
  assert.match(domElements.get('pr-state').textContent,/已關閉未合併/);
  assert.match(domElements.get('native-executor-tasks').textContent,/W1 OpenCode：READY（啟用）/);
  assert.match(domElements.get('native-executor-tasks').textContent,/W2 Antigravity：DISABLED（停用）/);
  assert.match(domElements.get('native-executor-tasks').textContent,/Codex 主控：RUNNING（啟用）/);
  assert.doesNotMatch(domElements.get('native-executor-tasks').textContent,/W3 Codex/);
  assert.match(domElements.get('native-executor-tasks').textContent,/不代表模型工作/);
  assert.match(domElements.get('native-identity').textContent,/互動登入後補跑已啟用；首次登入前不保證/);
  snapshot.windows.native_task.start_when_available=false;
  observationComment.body='PTYSD_OPERATOR_OBSERVATION_V1\n'+JSON.stringify(snapshot);
  panel.render(null,resources,null,now,{status:'READY',coordination:'SHARED_LOCKED',remaining:40,
    lastError:null,lastSuccessAt:now,resetAt:null,pauseUntil:null,indefinite:false});
  assert.match(domElements.get('native-identity').textContent,/互動登入後補跑未啟用/);
  delete snapshot.windows.native_task.start_when_available;
  observationComment.body='PTYSD_OPERATOR_OBSERVATION_V1\n'+JSON.stringify(snapshot);
  panel.render(null,resources,null,now,{status:'READY',coordination:'SHARED_LOCKED',remaining:40,
    lastError:null,lastSuccessAt:now,resetAt:null,pauseUntil:null,indefinite:false});
  assert.match(domElements.get('native-identity').textContent,/互動登入後補跑設定未知/);
  assert.match(domElements.get('pr-state').textContent,/歷史來源/);
  assert.match(domElements.get('pr-state').textContent,/PR #505/);
  assert.doesNotMatch(domElements.get('pr-state').textContent,/CANDIDATE_PR_IDENTITY_UNKNOWN/);
  assert.match(domElements.get('pr-deployment').textContent,/不屬於可部署來源/);
  assert.match(domElements.get('runtime-source').textContent,/Issue #407 Win11 runtime 觀測中的部署 PR #592/);
  assert.match(domElements.get('runtime-source').textContent,/與目前任務來源 PR 分開/);
  assert.match(domElements.get('checks-detail').textContent,/CLOSED_UNMERGED/);
  assert.match(domElements.get('metric-ci').textContent,/歷史 PR 已關閉/);
  assert.equal(domElements.get('w1-dispatch-state').textContent.includes('UNKNOWN'),true);
  assert.match(domElements.get('w1-dispatch-task').textContent,/W1_PANEL_CLOSED_PR_20261024/);
  assert.match(domElements.get('w1-dispatch-attempt').textContent,/3f9246cd-f968-4290-9c76-0514bb7775b5/);
  assert.match(domElements.get('w1-dispatch-progress').textContent,/FINISHED_NOT_ACCEPTANCE/);
  assert.match(domElements.get('w1-dispatch-delivery').textContent,/DIFF_CAPTURED_UNVERIFIED/);
  assert.match(domElements.get('w1-dispatch-time').textContent,/最後已讀回派工／收據/);
  assert.match(domElements.get('w2-dispatch-state').textContent,/BLOCKED／派工留言 ID 未確認/);
  assert.match(domElements.get('w2-model-switch').textContent,/模型執行開關：停用.*不派發新的模型工作/);
  assert.match(domElements.get('w2-dispatch-progress').textContent,/ANTIGRAVITY_EDIT_TOOL_EXECUTION_FAILED_DIFF_PRESERVED/);
  assert.match(domElements.get('w3-dispatch-progress').textContent,/沒有 Zero Risk request_id/);
  assert.match(domElements.get('codex-executor').textContent,/UNKNOWN/);
  assert.match(domElements.get('codex-evidence').textContent,/UNKNOWN/);
  assert.match(domElements.get('codex-task').textContent,/UNKNOWN.*Executor/);
  assert.match(domElements.get('codex-harvest').textContent,/W1 Codex source acceptance 待確認/);
});

test('an empty formal schema-6 queue is not presented as no READY Codex Goal work', () => {
  assert.match(html,/正式派工／Codex GOAL 續工/);
  const empty={data:null,fetchedAt:baseTime,error:null,url:''};
  const resources={
    issue:{data:[],fetchedAt:baseTime,error:null,url:urls.issue},
    pr:empty,main:{data:{sha:head},fetchedAt:baseTime,error:null,url:urls.main},checks:empty,
    dispatches:{W1:{data:null,fetchedAt:baseTime,error:null},
      W2:{data:null,fetchedAt:baseTime,error:null},W3:{data:null,fetchedAt:baseTime,error:null}},
    dispatchPulls:{},dispatchChecks:{},
  };
  panel.render(null,resources,null,baseTime,{status:'READY',coordination:'SHARED_LOCKED',
    remaining:40,lastError:null,lastSuccessAt:baseTime,resetAt:null,pauseUntil:null,indefinite:false});
  const next=domElements.get('codex-next').textContent;
  assert.match(next,/schema-6/i);
  assert.match(next,/Codex.*GOAL|GOAL.*Codex/);
  assert.match(next,/不代表|不能推導/);
  assert.doesNotMatch(next,/下一個 READY：UNKNOWN/);
});

test('recent events join #310 schema-6 dispatches to exact #407 request, source, kind, and attempt receipts', () => {
  const w1Request='W1_EDITFILE_TELEMETRY_20261023_9C8247675F914DCBBC708DD2AB90A6C2';
  const w1Sha='221e0c0e4524e07bc06a2aae431fdd34d121b73d';
  const w1Attempt='3f9246cd-f968-4290-9c76-0514bb7775b5';
  const w2Request='W2S_5AA1ADD410B24E28ADAB8E4B7E528920_20261022_154481FF';
  const w2Sha='918f60e0023b7194874e6ea640cb98023760697c';
  const w2Attempt='24331e45-62db-4f55-ad40-87776a799c5d';
  const job=(request_id,kind,source_sha,source_pr,model,variant=null) => ({
    schema:6,project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE',host:'DESKTOP-1B6PD2P',
    request_id,kind,source_sha,source_pr,goal_comment_id:6188322050,
    goal_body_sha256:'a'.repeat(64),spec_path:'native-bridge/tasks/panel-event-test.md',
    spec_sha256:'b'.repeat(64),edit_paths:['tests/operator-panel-api.test.mjs'],model,variant,
  });
  const dispatch=(id,value,at) => ({id,user:{login:'t14210184'},created_at:at,
    body:'PTYSD_NATIVE_JOB_V1\n'+JSON.stringify(value)});
  const receipt=(id,value,at) => ({id,user:{login:'t14210184'},created_at:at,
    body:'PTYSD_NATIVE_RECEIPT_V1\n'+JSON.stringify({schema:1,
      project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE',host:'DESKTOP-1B6PD2P',...value})});
  const snapshot={sequence:526,observed_at:'2026-10-24T05:42:33.371Z',
    expires_at:'2026-10-24T05:52:33.371Z',workers:[
      {worker_id:'W1',task_id:w1Request,task_kind:'opencode_edit',task_source_sha:w1Sha,
        source_pr:505,task_comment_id:6356591863,attempt_id:w1Attempt,task_state:'FINISHED_NOT_ACCEPTANCE'},
      {worker_id:'W2',task_id:w2Request,task_kind:'antigravity_edit',task_source_sha:w2Sha,
        source_pr:461,task_comment_id:6342391654,attempt_id:w2Attempt,task_state:'BLOCKED'},
    ]};
  const w1Job=dispatch(6356591863,job(w1Request,'opencode_edit',w1Sha,505,
    'opencode/deepseek-v4.1-flash-free'),'2026-10-23T03:21:45Z');
  const w2Job=dispatch(6342391654,job(w2Request,'antigravity_edit',w2Sha,461,
    'gemini-3.8-flash-high','high'),'2026-10-22T13:49:13Z');
  const w2EarlierReceipts=Array.from({length:13},(_,index) => receipt(6344000000+index,
    {request_id:w2Request,source_sha:w2Sha,kind:'antigravity_edit',attempt_id:w2Attempt,
      state:index===12?'BLOCKED':'WAITING'},
    new Date(Date.parse('2026-10-22T14:54:35Z')+index*1000).toISOString()));
  const comments=[
    {id:6000000000,user:{login:'t14210184'},created_at:'2026-10-13T00:00:00Z',
      body:'PTYSD_NATIVE_JOB_V1\n'+JSON.stringify({schema:1,project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE',
        host:'DESKTOP-1B6PD2P',request_id:'OLD_2013_EVENT',kind:'native_preflight',
        source_sha:'c'.repeat(40),spec_path:null,spec_sha256:null})},
    receipt(6356722286,{request_id:w1Request,source_sha:w1Sha,kind:'opencode_edit',
      attempt_id:w1Attempt,state:'STARTED'},'2026-10-23T03:32:45Z'),
    receipt(6356778997,{request_id:w1Request,source_sha:w1Sha,kind:'opencode_edit',
      attempt_id:w1Attempt,state:'FINISHED',outcome:'V2_EDIT_DIFF_CAPTURED_UNVERIFIED'},'2026-10-23T03:37:33Z'),
    receipt(6356999999,{request_id:w1Request,source_sha:w1Sha,kind:'opencode_edit',
      attempt_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',state:'BLOCKED'},'2026-10-24T04:00:00Z'),
    ...w2EarlierReceipts,
    receipt(6344079399,{request_id:w2Request,source_sha:w2Sha,kind:'antigravity_edit',
      attempt_id:w2Attempt,state:'BLOCKED'},'2026-10-22T15:07:35Z'),
  ];
  const crowdedChecks={pr_number:525,checks:Array.from({length:9},(_,index)=>({
    name:'check-'+index,status:'completed',conclusion:'success',
    completed_at:new Date(Date.parse('2026-10-24T05:53:00Z')+index*1000).toISOString(),
  }))};
  const events=panel.classifyRecentEvents(comments,snapshot,crowdedChecks,
    {W1:{data:w1Job},W2:{data:w2Job}},Date.parse('2026-10-24T14:00:00+08:00'));
  assert.equal(events.length,8);
  assert.ok(events.some(event => event.at==='2026-10-23T03:37:33Z' &&
    /W1.*FINISHED.*不代表/.test(event.label)), 'W1 terminal receipt is paired to its #310 dispatch');
  assert.ok(events.some(event => event.at==='2026-10-22T15:07:35Z' &&
    /W2.*BLOCKED/.test(event.label)), 'W2 blocked receipt is paired to its #310 dispatch');
  assert.ok(events.some(event => event.at===snapshot.observed_at && /526.*STALE/.test(event.label)),
    'latest Win11 observation is present but explicitly historical after expiry');
  assert.equal(events.some(event => /OLD_2013_EVENT/.test(event.label)),false,
    'an Issue #407 legacy job cannot crowd out the #310 dispatch timeline');
  assert.equal(events.some(event => /aaaaaaaa-aaaa/.test(event.label)),false,
    'a receipt from a different attempt cannot be attributed to the current task');
});

test('dispatch cards separate W1 execution, reconciliation, result PR/CI, and acceptance while preserving W2 ambiguity', () => {
  const w1Request='W1_EDITFILE_TELEMETRY_20261023_9C8247675F914DCBBC708DD2AB90A6C2';
  const w1Sha='221e0c0e4524e07bc06a2aae431fdd34d121b73d';
  const w1Attempt='3f9246cd-f968-4290-9c76-0514bb7775b5';
  const w2Request='W2S_5AA1ADD410B24E28ADAB8E4B7E528920_20261022_154481FF';
  const w2Sha='918f60e0023b7194874e6ea640cb98023760697c';
  const w2Attempt='24331e45-62db-4f55-ad40-87776a799c5d';
  const job=(request_id,kind,source_sha,source_pr,model,variant=null) => ({
    schema:6,project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE',host:'DESKTOP-1B6PD2P',
    request_id,kind,source_sha,source_pr,goal_comment_id:6188322050,
    goal_body_sha256:'a'.repeat(64),spec_path:'native-bridge/tasks/panel-event-test.md',
    spec_sha256:'b'.repeat(64),edit_paths:['tests/operator-panel-api.test.mjs'],model,variant,
  });
  const dispatch=(id,value,at) => ({id,user:{login:'t14210184'},created_at:at,
    body:'PTYSD_NATIVE_JOB_V1\n'+JSON.stringify(value)});
  const receipt=(id,value,at) => ({id,user:{login:'t14210184'},created_at:at,
    body:'PTYSD_NATIVE_RECEIPT_V1\n'+JSON.stringify({schema:1,
      project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE',host:'DESKTOP-1B6PD2P',...value})});
  const snapshot={sequence:526,observed_at:'2026-10-24T05:42:33.371Z',
    expires_at:'2026-10-24T05:52:33.371Z',workers:[
      {worker_id:'W1',status:'UNKNOWN',task_id:w1Request,task_kind:'opencode_edit',task_source_sha:w1Sha,
        source_pr:505,task_comment_id:6356591863,attempt_id:w1Attempt,task_state:'FINISHED_NOT_ACCEPTANCE',
        code_changes:'DIFF_CAPTURED_UNVERIFIED',changed_files_count:2,diff_sha256:'2d40660d98eb983dc343c7b1a6612a868a948a288545bb51a4abb7af14e9e968'},
      {worker_id:'W2',status:'BLOCKED',task_id:w2Request,task_kind:'antigravity_edit',task_source_sha:w2Sha,
        source_pr:461,task_comment_id:6342391654,attempt_id:w2Attempt,task_state:'BLOCKED',
        blocker_code:'ANTIGRAVITY_EDIT_TOOL_EXECUTION_FAILED_NO_DIFF'},
      {worker_id:'W3',status:'UNKNOWN'},
    ]};
  const w1Job=dispatch(6356591863,job(w1Request,'opencode_edit',w1Sha,505,
    'opencode/deepseek-v4.1-flash-free'),'2026-10-23T03:21:45Z');
  const w2Job=dispatch(6342391654,job(w2Request,'antigravity_edit',w2Sha,461,
    'gemini-3.8-flash-high','high'),'2026-10-22T13:49:13Z');
  const w1Terminal=receipt(6356778997,{request_id:w1Request,source_sha:w1Sha,kind:'opencode_edit',
    attempt_id:w1Attempt,state:'FINISHED',outcome:'V2_EDIT_DIFF_CAPTURED_UNVERIFIED',
    model_invoked:true,tool_execution_count:11,diff_sha256:'2d40660d98eb983dc343c7b1a6612a868a948a288545bb51a4abb7af14e9e968',
    diff_bytes:12151,changed_files_count:2},'2026-10-23T03:37:33Z');
  const w2Terminal=receipt(6344079399,{request_id:w2Request,source_sha:w2Sha,kind:'antigravity_edit',
    attempt_id:w2Attempt,state:'BLOCKED',outcome:'ANTIGRAVITY_EDIT_TOOL_EXECUTION_FAILED_NO_DIFF',
    diff_bytes:0,changed_files_count:0,external_effects:'UNKNOWN',model_invoked:true,
    tool_execution_count:31,file_change_tool_completed_count:2},'2026-10-22T15:07:35Z');
  const reconciliation={id:6367399586,user:{login:'wfvupu1212'},created_at:'2026-10-23T14:36:17Z',
    body:[
      'PTYSD_V53R4_R2_EVIDENCE_RECONCILIATION_V1','observed_at=2026-10-23T14:35:26Z',
      'W1_EDITFILE_TELEMETRY',`request_id=${w1Request}`,`attempt_id=${w1Attempt}`,'source_pr=505',
      `source_head=${w1Sha}`,'original_terminal_state=FINISHED_NOT_ACCEPTANCE',
      `diff_sha256=2d40660d98eb983dc343c7b1a6612a868a948a288545bb51a4abb7af14e9e968`,
      'diff_reconciliation=PASS','codex_review=PASS_FOR_SCOPED_TELEMETRY_CHANGE',
      'integration=PR_507_MERGED','integration_commit=928e9d129d299761063ac4b5e11d125b368d6a9f',
      'pr_507_checks=check-native-only:PASS;csg-trusted-verifier-hosted:PASS;v2-native-windows:PASS;bounded-driver-acceptance:SKIPPED;csg-trusted-verifier:CANCELLED',
      'W2_ARTIFACT_RECOVERY',`request_id=${w2Request}`,`attempt_id=${w2Attempt}`,
      'original_task_source_pr=461',`original_task_source_sha=${w2Sha}`,
      'last_original_receipt=6344079399','receipt_vs_stream=terminal_receipt_reported_ZERO_DIFF; raw stream and Win11 original worktree show three scoped files changed',
      'classification=PARTIAL_OR_AMBIGUOUS','external_effects=UNKNOWN','replay=PROHIBITED',
      'native-bridge/antigravity-quota.mjs_sha256=3756936b35d742430419ca5a1c152642a9c31ee4fbce724eb83ee3c34d8f5014',
      'tests/antigravity-quota.test.mjs_sha256=6b13ad53f12967610e2dc7ad7fbfe3b9c80be81a2e9f8be8e77ce2319ad1a88c',
      'package.json_sha256=bb0b28885e6150008d5e520f397965542840608fdc619271c31170171493c7b2',
    ].join('\n')};
  const comments=[w1Terminal,w2Terminal,reconciliation];
  const resources={dispatches:{W1:{data:w1Job},W2:{data:w2Job}},dispatchPulls:{},dispatchChecks:{}};
  const now=Date.parse('2026-10-24T13:47:35+08:00');
  const w1=panel.dispatchCardData('W1',snapshot,comments,resources,{status:'STALE'},now,
    {lifecycle:'CLOSED_UNMERGED',status:'CLOSED_UNMERGED',checks_allowed:false});
  const w2=panel.dispatchCardData('W2',snapshot,comments,resources,{status:'STALE'},now,
    {lifecycle:'OPEN_DRAFT',status:'OPEN_DRAFT',checks_allowed:false});
  assert.equal(w1.shortStatus,'已完成執行');
  assert.equal(w1.workerTerminal,'FINISHED_NOT_ACCEPTANCE');
  assert.equal(w1.diffReconciliation,'PASS');
  assert.equal(w1.resultPr.number,507);
  assert.equal(w1.resultPr.head,'928e9d129d299761063ac4b5e11d125b368d6a9f');
  assert.match(w1.resultPr.checks,/bounded-driver-acceptance:SKIPPED/);
  assert.match(w1.formalAcceptance,/UNKNOWN/);
  for (const invalidIntegrationCommit of [null,'not-a-git-sha']) {
    const bodyLines=reconciliation.body.split('\n').filter(line => !line.startsWith('integration_commit='));
    if (invalidIntegrationCommit !== null) bodyLines.push('integration_commit=' + invalidIntegrationCommit);
    const malformedReconciliation={...reconciliation,id:6367399587,body:bodyLines.join('\n')};
    const withoutTrustedResultHead=panel.dispatchCardData('W1',snapshot,
      [w1Terminal,w2Terminal,malformedReconciliation],resources,{status:'STALE'},now,
      {lifecycle:'CLOSED_UNMERGED',status:'CLOSED_UNMERGED',checks_allowed:false});
    assert.equal(withoutTrustedResultHead.resultPr,null,
      'missing or invalid integration_commit must not fabricate a result PR head');
    assert.match(withoutTrustedResultHead.resultDetails,/回收核對未確認/);
  }
  assert.equal(w2.shortStatus,'受阻');
  assert.equal(w2.hasBoundReceipt,true,
    'a W2 terminal receipt is exposed only after the exact request/source/attempt binding matches');
  assert.equal(w2.receiptState,'BLOCKED');
  assert.equal(w2.receiptAttemptId,w2Attempt);
  assert.equal(w2.externalEffectClass,'PARTIAL_OR_AMBIGUOUS');
  assert.equal(w2.externalEffects,'UNKNOWN');
  assert.equal(w2.recoveredFileHashes.length,3);
  assert.match(w2.summaryProgress,/回收證據待核對/);
  assert.doesNotMatch(w2.summaryProgress,/沒有修改|零修改/);
  assert.equal(w2.noReplay,true);
});

test('W1 source acceptance is shown separately without upgrading the original Worker terminal', () => {
  const requestId='W1_OPENCODE_FREE_LIMIT_EVIDENCE_20261028_AF6FA547';
  const attemptId='4483bca1-b4c8-4297-8dd3-d4aa604a3801';
  const sourceSha='3bdc5f62dcfed11374ed5d02cc88e2f7ab9901dd';
  const workerDiff='9598ef67cd26cdd3d0ca029f3f2c3207a836098257429381f15ae7f6f0a378a8';
  const sourcePrMerge='9f3007f96b61cf9a8b99bf08921ecdaccc15b1da';
  const resultHead='76cc0f39ca2c463d730dee734c02bbaecac76403';
  const resultMerge='cf01f6d05d71e00ac4058d5aff40f522ef318dd2';
  const jobCommentId=6463422047;
  const receiptId=6463850724;
  const reconciliationId=6474981919;
  const acceptanceId=6475955674;
  const identityId=6477442274;
  const job={schema:6,project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE',host:'DESKTOP-1B6PD2P',
    request_id:requestId,kind:'opencode_edit',source_sha:sourceSha,
    spec_path:'native-bridge/tasks/w1-opencode-free-limit-evidence.md',spec_sha256:'a'.repeat(64),
    model:'opencode/deepseek-v4.1-flash-free',variant:null,
    edit_paths:['native-bridge/opencode-v2.mjs','tests/opencode-v2.test.mjs'],source_pr:589,
    goal_comment_id:6188322050,goal_body_sha256:'b'.repeat(64)};
  const jobComment={id:jobCommentId,user:{login:'t14210184'},created_at:'2026-10-28T08:02:00Z',
    body:'PTYSD_NATIVE_JOB_V1\n'+JSON.stringify(job)};
  const task={worker_id:'W1',task_id:requestId,task_kind:'opencode_edit',task_source_sha:sourceSha,
    source_pr:589,task_comment_id:jobCommentId,attempt_id:attemptId,
    task_state:'FINISHED_NOT_ACCEPTANCE',code_changes:'DIFF_CAPTURED_UNVERIFIED',
    changed_files_count:2,diff_sha256:workerDiff,task_acceptance:'UNKNOWN',
    external_effects:'UNKNOWN'};
  const snapshot={workers:[task],native_worker:{latest_task:{request_id:requestId,
    kind:'opencode_edit',source_pr:589,source_sha:sourceSha,state:'FINISHED_NOT_ACCEPTANCE'}}};
  const receipt={schema:1,project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE',host:'DESKTOP-1B6PD2P',
    request_id:requestId,attempt_id:attemptId,state:'FINISHED',kind:'opencode_edit',source_sha:sourceSha,
    outcome:'V2_EDIT_DIFF_CAPTURED_UNVERIFIED',model_invoked:true,tool_execution_count:10,
    model:'opencode/deepseek-v4.1-flash-free',
    session_id:'ses_e7e7bee1dffeg50Z7gp73YsNXR',diff_sha256:workerDiff,diff_bytes:13291,
    changed_files_count:2,external_effects:'UNKNOWN'};
  const comment=(id,login,body,created_at) => ({id,user:{login},body,created_at});
  const terminal=comment(receiptId,'t14210184',
    'PTYSD_NATIVE_RECEIPT_V1\n'+JSON.stringify(receipt),'2026-10-28T08:36:00Z');
  const reconciliation=comment(reconciliationId,'wfvupu1212',[
    'PTYSD_V53R4_R2_EVIDENCE_RECONCILIATION_V1','observed_at=2026-10-28T16:44:02Z',
    'W1_EDITFILE_TELEMETRY',`request_id=${requestId}`,`attempt_id=${attemptId}`,
    'source_pr=589',`source_head=${sourceSha}`,`worker_diff_sha256=${workerDiff}`,
    'diff_reconciliation=PASS_SCOPED_PATHS_AND_RESULT_PR;WORKER_PATCH_BYTE_IDENTITY_NOT_REVERIFIED',
    'codex_review=PASS_FOR_BOUNDED_NESTED_PROVIDER_ERROR_CLASSIFICATION',
    'original_terminal_state=FINISHED_NOT_ACCEPTANCE','integration=PR_590_MERGED',
    `integration_commit=${resultMerge}`,
    'pr_590_checks=check-native-only:PASS;csg-trusted-verifier-hosted:PASS;v2-native-windows:PASS;bounded-driver-acceptance:SKIPPED;csg-trusted-verifier:CANCELLED_NOT_COUNTED',
  ].join('\n'),'2026-10-28T16:44:02Z');
  const acceptance=comment(acceptanceId,'t14210184',[
    'PTYSD_V53R4_R6_W1_SOURCE_ACCEPTANCE_AFTER_MERGE_V1',
    'record_type=ADDITIVE_CODEX_SOURCE_ACCEPTANCE_NOT_ORIGINAL_WORKER_OR_LIVE_ACCEPTANCE',
    'repo=PT-Original-Point/ptysd-autonomous-factory',
    'human_goal_comment_id=6188322050',
    'current_main=37e662614821e181fa8a9c00d49b6818ef5b8329',
    'W1_LINEAGE',`request_id=${requestId}`,`task_comment_id=${jobCommentId}`,
    `attempt_id=${attemptId}`,'model=opencode/deepseek-v4.1-flash-free',
    'session_id=ses_e7e7bee1dffeg50Z7gp73YsNXR',`worker_diff_sha256=${workerDiff}`,
    `source_spec_pr=589; head=${sourceSha}; merge_commit=${sourcePrMerge}`,
    `result_pr=590; head=${resultHead}; merge_commit=${resultMerge}`,
    'current_main_contains_both_merges=TRUE','current_main_blobs_match_pr590_merge=TRUE',
    'EXACT_HEAD_VALIDATION','check-native-only=SUCCESS','csg-trusted-verifier-hosted=SUCCESS',
    'v2-native-windows=SUCCESS','csg-trusted-verifier=CANCELLED_NOT_COUNTED_AS_PASS',
    'bounded-driver-acceptance=SKIPPED','focused_test=45_passed;0_failed;0_skipped',
    'git_diff_check=PASS','semantic_review=PASS_FOR_BOUNDED_NESTED_PROVIDER_ERROR_CLASSIFICATION_AND_SANITIZATION',
    'source_acceptance=PASS_FOR_PR590_REVIEWED_SOURCE_AND_MERGED_INTEGRATION',
    'live_acceptance=NOT_CLAIMED','worker_model_external_effects=UNKNOWN_AS_ORIGINAL_TERMINAL_RECORDED',
  ].join('\n'),'2026-10-29T01:27:56Z');
  const patchIdentity=comment(identityId,'t14210184',[
    'PTYSD_V53R4_R6_W1_SOURCE_PATCH_BYTE_IDENTITY_RECONCILIATION_V1',
    'record_type=ADDITIVE_CODEX_SOURCE_RECONCILIATION_NOT_ORIGINAL_WORKER_TERMINAL_OR_LIVE_ACCEPTANCE',
    'W1_LINEAGE',`request_id=${requestId}`,`task_comment_id=${jobCommentId}`,
    `attempt_id=${attemptId}`,`worker_diff_sha256=${workerDiff}`,
    'worker_diff_bytes=13291',
    'worker_diff_byte_identity=CONFIRMED_AGAINST_PR590_GIT_DIFF',
    `source_pr=589; source_head=${sourceSha}`,
    `result_pr=590; result_head=${resultHead}`,
    `merge_commit=${resultMerge}`,
    `pr590_git_diff_bytes=13291`,`pr590_git_diff_sha256=${workerDiff}`,
    'byte_identical=true','current_main_contains_merge=true','current_blobs_match_merge=true',
    'EXACT_HEAD_CHECKS','check-native-only=SUCCESS',
    'csg-trusted-verifier-hosted=SUCCESS','v2-native-windows=SUCCESS',
    'csg-trusted-verifier=CANCELLED_NOT_COUNTED_AS_PASS','bounded-driver-acceptance=SKIPPED',
    'BOUNDARIES','source_acceptance=SUPPORTED_FOR_EXACT_WORKER_DIFF_AND_MERGED_PR590_SOURCE',
    'original_worker_terminal=FINISHED_NOT_ACCEPTANCE;unchanged',
    'original_worker_task_acceptance=UNKNOWN;external_effects=UNKNOWN',
    'live_acceptance=NOT_CLAIMED',
  ].join('\n'),'2026-10-29T02:37:44Z');
  const comments=[terminal,reconciliation,acceptance,patchIdentity];
  const data=panel.dispatchCardData('W1',snapshot,comments,
    {dispatches:{W1:{data:jobComment}}},{status:'UNKNOWN'},Date.parse('2026-10-29T03:00:00Z'),
    {lifecycle:'MERGED',status:'MERGED',checks_allowed:false});

  assert.ok(data.codexSourceAcceptance,'the current W1 request and attempt have matching Codex source-acceptance and byte-identity readbacks');
  assert.equal(data.codexSourceAcceptance.status,'ACCEPTED');
  assert.equal(data.codexSourceAcceptance.resultPr,590);
  assert.equal(data.codexSourceAcceptance.resultHead,resultHead);
  assert.equal(data.codexSourceAcceptance.mergeCommit,resultMerge);
  assert.equal(data.formalAcceptance,'UNKNOWN',
    'Codex source acceptance must not upgrade the original Worker task_acceptance');
  assert.equal(data.workerTerminal,'FINISHED_NOT_ACCEPTANCE');
  assert.equal(data.externalEffects,'UNKNOWN');
  assert.match(data.codexSourceAcceptance.label,/PR #590.*SOURCE_ACCEPTED/);
  const worker=panel.workerCardData('W1',task,{status:'UNKNOWN',delivery:'UNKNOWN'},snapshot,null,
    data.codexSourceAcceptance);
  assert.match(worker.changes,/Codex.*PR #590/);
  assert.match(worker.sourceAcceptance,/Codex source accepted/i);
  assert.match(worker.sourceAcceptance,/Worker task_acceptance=UNKNOWN/);
  assert.match(worker.sourceAcceptance,/external_effects=UNKNOWN/);
  assert.match(worker.delivery,/PR #590 SOURCE_ACCEPTED/);
  assert.match(panel.w1SourceHarvestLabel(data),/Codex source accepted via PR #590/);
  assert.match(panel.w1SourceHarvestLabel(data),/Worker task_acceptance=UNKNOWN/);
  assert.match(panel.w1SourceHarvestLabel(data),/external_effects=UNKNOWN/);
  assert.equal(panel.validJob(job),true,
    'the shared schema-6 validator accepts the official OpenCode/W1 contract');
  const goalIdentity={id:job.goal_comment_id,author:'t14210184',body_sha256:job.goal_body_sha256};
  const githubTask=panel.schema6TaskSource([jobComment],'W1',goalIdentity,true);
  assert.equal(githubTask.task_comment_id,jobCommentId,
    'a complete, identity-matched Issue #310 readback can supply the formal W1 task when the OS snapshot omits it');
  assert.equal(panel.schema6TaskSource([jobComment],'W1',goalIdentity,false),null,
    'an incomplete Issue #310 pagination read cannot supply a formal task');
  assert.equal(panel.schema6TaskSource([jobComment],'W1',
    {...goalIdentity,body_sha256:'c'.repeat(64)},true),null,
    'a mismatched Human GOAL identity cannot supply a formal task');
  const recoveredFromGoal=panel.dispatchCardData('W1',{workers:[],native_worker:{}},comments,{},
    {status:'UNKNOWN'},Date.parse('2026-10-29T03:00:00Z'),
    {lifecycle:'MERGED',status:'MERGED',checks_allowed:false},[jobComment],goalIdentity,true);
  assert.equal(recoveredFromGoal.codexSourceAcceptance.status,'ACCEPTED',
    'source acceptance stays visible when the current Win11 snapshot no longer carries the completed W1 task');
  assert.match(recoveredFromGoal.formalAcceptance,/^UNKNOWN/);
  assert.equal(recoveredFromGoal.workerTerminal,'FINISHED_NOT_ACCEPTANCE');
  assert.equal(recoveredFromGoal.externalEffects,'UNKNOWN');
  const sourceOnlyWorker=panel.workerCardData('W1',null,{status:'UNKNOWN',delivery:'UNKNOWN'},
    {},null,recoveredFromGoal.codexSourceAcceptance);
  assert.match(sourceOnlyWorker.task,/W1_OPENCODE_FREE_LIMIT_EVIDENCE/);
  assert.match(sourceOnlyWorker.changes,/Codex 已核對.*接受 PR #590/);
  assert.match(sourceOnlyWorker.sourceAcceptance,/Worker task_acceptance=UNKNOWN/);
  assert.match(sourceOnlyWorker.sourceAcceptance,/external_effects=UNKNOWN/);
  assert.match(sourceOnlyWorker.sourceAcceptance,/live_acceptance=NOT_CLAIMED/);
  assert.match(sourceOnlyWorker.delivery,/PR #590 SOURCE_ACCEPTED/);
  panel.renderDispatchCard('W1',data);
  assert.match(domElements.get('w1-dispatch-codex-source-acceptance').textContent,/SOURCE_ACCEPTED/);
  assert.match(domElements.get('w1-dispatch-acceptance').textContent,/UNKNOWN/);

  const futurePrComments=comments.map(comment=>({...comment,body:comment.body
    .replaceAll('PR_590','PR_612').replaceAll('pr_590','pr_612')
    .replaceAll('PR590','PR612').replaceAll('pr590','pr612')
    .replaceAll('result_pr=590','result_pr=612')}));
  const futurePrData=panel.dispatchCardData('W1',snapshot,futurePrComments,
    {dispatches:{W1:{data:jobComment}}},{status:'UNKNOWN'},Date.parse('2026-10-29T03:00:00Z'),
    {lifecycle:'MERGED',status:'MERGED',checks_allowed:false});
  assert.equal(futurePrData.codexSourceAcceptance.status,'ACCEPTED',
    'the legacy readback format binds dynamically to another result PR number');
  assert.equal(futurePrData.codexSourceAcceptance.resultPr,612);
  assert.equal(futurePrData.formalAcceptance,'UNKNOWN');
  assert.equal(futurePrData.workerTerminal,'FINISHED_NOT_ACCEPTANCE');
  assert.equal(futurePrData.externalEffects,'UNKNOWN');
  const rejectedCases=[
    comments.map(c=>c.id===acceptanceId ? {...c,body:c.body.replace(attemptId,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')} : c),
    comments.map(c=>c.id===identityId ? {...c,user:{login:'untrusted-user'}} : c),
    comments.map(c=>c.id===identityId ? {...c,body:c.body.replace('byte_identical=true','byte_identical=false')} : c),
    comments.map(c=>c.id===identityId ? {...c,body:c.body.replace('v2-native-windows=SUCCESS','v2-native-windows=FAILURE')} : c),
    comments.map(c=>c.id===acceptanceId ? {...c,body:c.body.replace('focused_test=45_passed;0_failed;0_skipped','focused_test=45_passed;1_failed;0_skipped')} : c),
    comments.map(c=>c.id===acceptanceId ? {...c,body:c.body.replace('source_spec_pr=589; head='+sourceSha,'source_spec_pr=589; head='+'e'.repeat(40))} : c),
    comments.map(c=>c.id===acceptanceId ? {...c,body:c.body.replace('result_pr=590; head='+resultHead,'result_pr=590; head='+'c'.repeat(40))} : c),
    comments.map(c=>c.id===acceptanceId ? {...c,body:c.body.replace('source_acceptance=PASS_FOR_PR590_REVIEWED_SOURCE_AND_MERGED_INTEGRATION','source_acceptance=PASS_FOR_PR591_REVIEWED_SOURCE_AND_MERGED_INTEGRATION')} : c),
    comments.map(c=>c.id===identityId ? {...c,body:c.body.replace('worker_diff_sha256='+workerDiff,'worker_diff_sha256='+'d'.repeat(64))} : c),
  ];
  for (const invalidComments of rejectedCases) {
    const rejected=panel.dispatchCardData('W1',snapshot,invalidComments,
      {dispatches:{W1:{data:jobComment}}},{status:'UNKNOWN'},Date.parse('2026-10-29T03:00:00Z'),
      {lifecycle:'MERGED',status:'MERGED',checks_allowed:false});
    assert.equal(rejected.codexSourceAcceptance,null,
      'mismatched or incomplete source evidence is not shown as accepted');
    assert.equal(rejected.workerTerminal,'FINISHED_NOT_ACCEPTANCE');
    assert.equal(rejected.externalEffects,'UNKNOWN');
  }
});

test('W1 current additive reconciliation renders the exact merged result without upgrading Worker acceptance', () => {
  const requestId='W1_SCHEMA6_GOAL_ROUTE_ISOLATION_20261029_4E8C3F80D2A44F859644D1EAA79E592B';
  const attemptId='66843969-4669-4b80-8a3b-ae16d640fc74';
  const sourceSha='f396f33915cc4a264deaa780260ca8a857562a04';
  const workerDiff='87e91957261f2548a5c768beee48ada5e7af227affeda9a4e562746e67c35d80';
  const resultHead='bd809b9b4df42176632e5510443fc20c8cf21cc6';
  const resultMerge='3f3ff87a263a6b770bbe57e55e49ed126dfd1ffc';
  const jobCommentId=6485401935;
  const receiptId=6485617466;
  const reconciliationId=6485843644;
  const job={schema:6,project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE',host:'DESKTOP-1B6PD2P',
    request_id:requestId,kind:'opencode_edit',source_sha:sourceSha,
    spec_path:'native-bridge/tasks/w1-schema6-codex-claim-independence.md',
    spec_sha256:'3eb5db201e77460d2b70a69b9a72cd2042f4b1311c46100284e82fcdfea97e29',
    model:'opencode/deepseek-v4.1-flash-free',variant:null,
    edit_paths:['tests/native-bridge.test.mjs'],source_pr:605,
    goal_comment_id:6188322050,
    goal_body_sha256:'2f1829da0e1f5105a384be03904b2289c57c05e8a44215c4824fb6b8631d8f7b'};
  const jobComment={id:jobCommentId,user:{login:'t14210184'},created_at:'2026-10-29T01:30:32Z',
    body:'PTYSD_NATIVE_JOB_V1\n'+JSON.stringify(job)};
  const receipt={schema:1,project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE',host:'DESKTOP-1B6PD2P',
    request_id:requestId,attempt_id:attemptId,state:'FINISHED',kind:'opencode_edit',source_sha:sourceSha,
    outcome:'V2_EDIT_DIFF_CAPTURED_UNVERIFIED',model_invoked:true,tool_execution_count:48,
    model:'opencode/deepseek-v4.1-flash-free',session_id:'ses_e7aacddf2ffe8A1pX0K75fOSc2',
    diff_sha256:workerDiff,diff_bytes:3399,changed_files_count:1,external_effects:'UNKNOWN'};
  const terminal={id:receiptId,user:{login:'t14210184'},created_at:'2026-10-29T01:47:34Z',
    body:'PTYSD_NATIVE_RECEIPT_V1\n'+JSON.stringify(receipt)};
  const reconciliation={id:reconciliationId,user:{login:'t14210184'},created_at:'2026-10-29T02:14:04Z',
    body:[
      'PTYSD_V53R4_R2_EVIDENCE_RECONCILIATION_V1',
      'record_type=ADDITIVE_CODEX_SOURCE_AND_DIFF_RECONCILIATION_NOT_NATIVE_WORKER_RECEIPT',
      'repo=PT-Original-Point/ptysd-autonomous-factory',
      'project_id=CHATGPT_GLOBAL_SKILL_GOVERNANCE',
      'human_goal_comment_id=6188322050',
      'W1_EDITFILE_TELEMETRY',`request_id=${requestId}`,`task_comment_id=${jobCommentId}`,
      `attempt_id=${attemptId}`,'source_pr=605',`source_head=${sourceSha}`,
      'model=opencode/deepseek-v4.1-flash-free','session_id=ses_e7aacddf2ffe8A1pX0K75fOSc2',
      `worker_diff_sha256=${workerDiff}`,'diff_sha256='+workerDiff,'diff_bytes=3399',
      'changed_files=tests/native-bridge.test.mjs','changed_files_count=1',
      'diff_reconciliation=PASS_WORKER_PATCH_MATCHES_MERGED_PR_AFTER_NORMALIZING_STANDARD_GIT_INDEX_ABBREVIATION',
      'codex_review=PASS_SCHEMA4_GUARD_RETAINED_AND_SCHEMA6_OPENCode_ROUTE_REMAINS_ELIGIBLE',
      'source_acceptance=ACCEPTED_FOR_EXACT_WORKER_DIFF_AND_MERGED_PR_606',
      'original_terminal_state=FINISHED_NOT_ACCEPTANCE','integration=PR_606_MERGED',
      `integration_commit=${resultMerge}`,`pr_606_head=${resultHead}`,
      'pr_606_checks=check-native-only=SUCCESS;csg-trusted-verifier-hosted=SUCCESS;v2-native-windows=SUCCESS;csg-trusted-verifier=PENDING_NOT_COUNTED_AS_PASS;bounded-driver-acceptance=SKIPPED',
      `current_main_after_merge=${resultMerge}`,
      'merged_file_blob=tests/native-bridge.test.mjs:6a022df74791c8b8765fcbe4d6fb6bceb94bb268',
      'focused_test=node --test tests/native-bridge.test.mjs;75_total;72_passed;0_failed;3_skipped',
      'git_diff_check=PASS','worker_task_acceptance=UNKNOWN;external_effects=UNKNOWN',
      'live_acceptance=NOT_CLAIMED',
    ].join('\n')};
  const task={worker_id:'W1',task_id:requestId,task_kind:'opencode_edit',task_source_sha:sourceSha,
    source_pr:605,task_comment_id:jobCommentId,attempt_id:attemptId,
    task_state:'FINISHED_NOT_ACCEPTANCE',code_changes:'DIFF_CAPTURED_UNVERIFIED',
    changed_files_count:1,diff_sha256:workerDiff,task_acceptance:'UNKNOWN',external_effects:'UNKNOWN'};
  const snapshot={workers:[task],native_worker:{latest_task:{request_id:requestId,
    kind:'opencode_edit',source_pr:605,source_sha:sourceSha,state:'FINISHED_NOT_ACCEPTANCE'}}};
  const comments=[terminal,reconciliation];
  const resources={dispatches:{W1:{data:jobComment}}};
  const now=Date.parse('2026-10-30T00:00:00Z');
  const data=panel.dispatchCardData('W1',snapshot,comments,resources,{status:'UNKNOWN'},now,
    {lifecycle:'MERGED',status:'MERGED'},[],null,false);

  assert.ok(data.codexSourceAcceptance,
    'the current exact #407 reconciliation is recognized as Codex source acceptance');
  assert.equal(data.codexSourceAcceptance.status,'ACCEPTED');
  assert.equal(data.codexSourceAcceptance.acceptanceCommentId,reconciliationId);
  assert.equal(data.codexSourceAcceptance.patchIdentityCommentId,null,
    'the current additive reconciliation has no separate byte-identity comment');
  assert.equal(data.codexSourceAcceptance.resultPr,606);
  assert.equal(data.codexSourceAcceptance.resultHead,resultHead);
  assert.equal(data.codexSourceAcceptance.mergeCommit,resultMerge);
  assert.equal(data.workerTerminal,'FINISHED_NOT_ACCEPTANCE');
  assert.equal(data.formalAcceptance,'UNKNOWN');
  assert.equal(data.externalEffects,'UNKNOWN');
  assert.equal(data.codexSourceAcceptance.liveAcceptance,'NOT_CLAIMED');
  panel.renderDispatchCard('W1',data);
  assert.match(domElements.get('w1-dispatch-codex-source-acceptance').textContent,/PR #606 SOURCE_ACCEPTED/);
  assert.match(domElements.get('w1-dispatch-codex-source-acceptance').textContent,/PENDING_NOT_COUNTED_AS_PASS/);
  assert.match(domElements.get('w1-dispatch-acceptance').textContent,/UNKNOWN/);

  const rejectedBodies=[
    reconciliation.body.replace('v2-native-windows=SUCCESS','v2-native-windows=FAILURE'),
    reconciliation.body.replace('0_failed;3_skipped','1_failed;2_skipped'),
    reconciliation.body.replace(requestId,requestId+'_MISMATCH'),
    reconciliation.body.replace('repo=PT-Original-Point/ptysd-autonomous-factory','repo=other/project'),
    reconciliation.body.replace('human_goal_comment_id=6188322050','human_goal_comment_id=6188322051'),
    reconciliation.body.replace('worker_task_acceptance=UNKNOWN;external_effects=UNKNOWN',
      'worker_task_acceptance=ACCEPTED;external_effects=UNKNOWN'),
    reconciliation.body.replace('changed_files=tests/native-bridge.test.mjs',
      'changed_files=native-bridge/worker.mjs'),
    reconciliation.body.replace('6a022df74791c8b8765fcbe4d6fb6bceb94bb268','not-a-blob'),
  ];
  for (const body of rejectedBodies) {
    const rejected=panel.dispatchCardData('W1',snapshot,comments.map(comment =>
      comment.id === reconciliationId ? {...comment,body} : comment),resources,
      {status:'UNKNOWN'},now,{lifecycle:'MERGED',status:'MERGED'},[],null,false);
    assert.equal(rejected.codexSourceAcceptance,null,
      'a failed trusted check, failed test, mismatched request, upgraded Worker claim, or invalid main blob is rejected');
    assert.equal(rejected.workerTerminal,'FINISHED_NOT_ACCEPTANCE');
    assert.equal(rejected.formalAcceptance,'UNKNOWN');
    assert.equal(rejected.externalEffects,'UNKNOWN');
  }
  const mismatchedGoalJob={...job,goal_comment_id:6188322051};
  const mismatchedGoalResources={dispatches:{W1:{data:{...jobComment,
    body:'PTYSD_NATIVE_JOB_V1\n'+JSON.stringify(mismatchedGoalJob)}}}};
  const mismatchedGoal=panel.dispatchCardData('W1',snapshot,comments,mismatchedGoalResources,
    {status:'UNKNOWN'},now,{lifecycle:'MERGED',status:'MERGED'},[],null,false);
  assert.equal(mismatchedGoal.codexSourceAcceptance,null,
    'the reconciliation GOAL identity must match the dispatched task identity');
  assert.equal(mismatchedGoal.formalAcceptance,'UNKNOWN');
});

test('W1 additive source acceptance rejects independent identity, source, diff, check, path, and blob mutations', () => {
  const requestId='W1_ADDITIVE_NEGATIVE_COVERAGE_20261029_7B3F2C9A';
  const attemptId='4d7c1e29-8b3a-4f61-9c25-1a6e0b7d2f84';
  const sourceSha='2c5e8a1f9b3d4e6c7a0f5b2d8e1a3c6f9d4b7e2a';
  const workerDiff='9a3f6c1e4d7b2a5f8c0e3d6b9a2f5c8e1d4b7a0f3c6e9d2b5a8f1c4e7d0b3a6f';
  const diffBytes=4821;
  const sourcePr=703;
  const resultPr=742;
  const resultHead='5e0b3d8a1c6f4e9b2d7a0c5f8e3b6d1a4c9f2e7b';
  const resultMerge='7d2a5f8e1b4c9d6a3f0e7b2c5a8d1f4e6b9c0a3d';
  const blobSha='3a6c9f2e5b8d1a4c7f0e3b6d9a2c5f8e1b4d7a0c';
  const jobCommentId=6512345001;
  const receiptId=6512345002;
  const reconciliationId=6512345003;
  const sessionId='ses_5d8c2f1a9b7e3d6c4a0f8e2b6d9c1a5f';
  const model='opencode/deepseek-v4.1-flash-free';
  const changedFile='tests/operator-panel-api.test.mjs';
  const jobCreatedAt='2026-11-01T08:00:00Z';
  const receiptCreatedAt='2026-11-01T08:30:00Z';
  const reconciliationCreatedAt='2026-11-01T09:00:00Z';
  const now=Date.parse('2026-11-01T12:00:00Z');

  const buildFixture=(resultNumber, changedFilePath=changedFile,
    v2Status='v2-native-windows=NOT_APPLICABLE_PATH_FILTERED') => {
    const job={schema:6,project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE',host:'DESKTOP-1B6PD2P',
      request_id:requestId,kind:'opencode_edit',source_sha:sourceSha,
      spec_path:'native-bridge/tasks/w1-additive-negative-coverage.md',
      spec_sha256:'d'.repeat(64),model,variant:null,edit_paths:[changedFilePath],
      source_pr:sourcePr,goal_comment_id:6188322050,goal_body_sha256:'c'.repeat(64)};
    const jobComment={id:jobCommentId,user:{login:'t14210184'},created_at:jobCreatedAt,
      body:'PTYSD_NATIVE_JOB_V1\n'+JSON.stringify(job)};
    const receipt={schema:1,project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE',host:'DESKTOP-1B6PD2P',
      request_id:requestId,attempt_id:attemptId,state:'FINISHED',kind:'opencode_edit',
      source_sha:sourceSha,outcome:'V2_EDIT_DIFF_CAPTURED_UNVERIFIED',model_invoked:true,
      tool_execution_count:7,model,session_id:sessionId,diff_sha256:workerDiff,diff_bytes:diffBytes,
      changed_files_count:1,external_effects:'UNKNOWN'};
    const terminal={id:receiptId,user:{login:'t14210184'},created_at:receiptCreatedAt,
      body:'PTYSD_NATIVE_RECEIPT_V1\n'+JSON.stringify(receipt)};
    const checks=`pr_${resultNumber}_checks=check-native-only=SUCCESS;` +
      `csg-trusted-verifier-hosted=SUCCESS;${v2Status};` +
      'csg-trusted-verifier=PENDING_NOT_COUNTED_AS_PASS;bounded-driver-acceptance=SKIPPED';
    const body=[
      'PTYSD_V53R4_R2_EVIDENCE_RECONCILIATION_V1',
      'record_type=ADDITIVE_CODEX_SOURCE_AND_DIFF_RECONCILIATION_NOT_NATIVE_WORKER_RECEIPT',
      `repo=${repository}`,
      'project_id=CHATGPT_GLOBAL_SKILL_GOVERNANCE',
      'human_goal_comment_id=6188322050',
      'W1_EDITFILE_TELEMETRY',
      `request_id=${requestId}`,
      `task_comment_id=${jobCommentId}`,
      `attempt_id=${attemptId}`,
      `source_pr=${sourcePr}`,
      `source_head=${sourceSha}`,
      `model=${model}`,
      `session_id=${sessionId}`,
      `worker_diff_sha256=${workerDiff}`,
      `diff_sha256=${workerDiff}`,
      `diff_bytes=${diffBytes}`,
      `changed_files=${changedFilePath}`,
      'changed_files_count=1',
      'diff_reconciliation=PASS_ADDITIVE_NEGATIVE_COVERAGE',
      'codex_review=PASS_ADDITIVE_NEGATIVE_COVERAGE',
      `source_acceptance=ACCEPTED_FOR_EXACT_WORKER_DIFF_AND_MERGED_PR_${resultNumber}`,
      'original_terminal_state=FINISHED_NOT_ACCEPTANCE',
      `integration=PR_${resultNumber}_MERGED`,
      `integration_commit=${resultMerge}`,
      `pr_${resultNumber}_head=${resultHead}`,
      checks,
      `current_main_after_merge=${resultMerge}`,
      `merged_file_blob=${changedFilePath}:${blobSha}`,
      'focused_test=node --test tests/operator-panel-api.test.mjs;7_total;5_passed;0_failed;2_skipped',
      'git_diff_check=PASS',
      'worker_task_acceptance=UNKNOWN;external_effects=UNKNOWN',
      'live_acceptance=NOT_CLAIMED',
    ].join('\n');
    const reconciliation={id:reconciliationId,user:{login:'t14210184'},
      created_at:reconciliationCreatedAt,body};
    const task={worker_id:'W1',task_id:requestId,task_kind:'opencode_edit',
      task_source_sha:sourceSha,source_pr:sourcePr,task_comment_id:jobCommentId,
      attempt_id:attemptId,task_state:'FINISHED_NOT_ACCEPTANCE',
      code_changes:'DIFF_CAPTURED_UNVERIFIED',changed_files_count:1,diff_sha256:workerDiff,
      task_acceptance:'UNKNOWN',external_effects:'UNKNOWN'};
    const snapshot={workers:[task],native_worker:{latest_task:{request_id:requestId,
      kind:'opencode_edit',source_pr:sourcePr,source_sha:sourceSha,state:'FINISHED_NOT_ACCEPTANCE'}}};
    return {comments:[terminal,reconciliation],jobComment,snapshot,
      resources:{dispatches:{W1:{data:jobComment}}},body,checks};
  };

  const cardFor=(fixture,comments=fixture.comments,resources=fixture.resources) =>
    panel.dispatchCardData('W1',fixture.snapshot,comments,resources,{status:'UNKNOWN'},now,
      {lifecycle:'MERGED',status:'MERGED'},[],null,false);
  const replaceLine=(body,key,value) => body.split('\n').map(line =>
    line.startsWith(key + '=') ? key + '=' + value : line).join('\n');
  const removeLine=(body,key) => body.split('\n').filter(line =>
    !line.startsWith(key + '=')).join('\n');

  const fixture=buildFixture(resultPr);
  const data=cardFor(fixture);
  assert.ok(data.codexSourceAcceptance,
    'the additive reconciliation is recognized only with the complete exact binding');
  assert.equal(data.codexSourceAcceptance.status,'ACCEPTED');
  assert.equal(data.codexSourceAcceptance.resultPr,resultPr);
  assert.equal(data.codexSourceAcceptance.resultHead,resultHead);
  assert.equal(data.codexSourceAcceptance.mergeCommit,resultMerge);
  assert.equal(data.codexSourceAcceptance.sourcePr,sourcePr);
  assert.equal(data.codexSourceAcceptance.sourceSha,sourceSha);
  assert.equal(data.codexSourceAcceptance.requestId,requestId);
  assert.equal(data.codexSourceAcceptance.attemptId,attemptId);
  assert.equal(data.codexSourceAcceptance.workerDiffSha256,workerDiff);
  assert.match(data.codexSourceAcceptance.checks,/check-native-only=SUCCESS/);
  assert.match(data.codexSourceAcceptance.checks,/csg-trusted-verifier-hosted=SUCCESS/);
  assert.match(data.codexSourceAcceptance.checks,/v2-native-windows=NOT_APPLICABLE_PATH_FILTERED/);
  assert.match(data.codexSourceAcceptance.focusedTest,/5_passed;0_failed;2_skipped/);
  assert.equal(data.reconciliation.codexReview,'PASS_ADDITIVE_NEGATIVE_COVERAGE');
  assert.equal(data.resultPr.number,resultPr);
  assert.equal(data.workerTerminal,'FINISHED_NOT_ACCEPTANCE');
  assert.equal(data.formalAcceptance,'UNKNOWN');
  assert.equal(data.externalEffects,'UNKNOWN');
  assert.equal(data.codexSourceAcceptance.liveAcceptance,'NOT_CLAIMED');
  panel.renderDispatchCard('W1',data);
  assert.match(domElements.get('w1-dispatch-codex-source-acceptance').textContent,
    new RegExp(`PR #${resultPr} SOURCE_ACCEPTED`));
  assert.match(domElements.get('w1-dispatch-result').textContent,
    new RegExp(`結果 PR #${resultPr}`));
  assert.equal(domElements.get('w1-dispatch-result-link').href,
    `https://github.com/${repository}/pull/${resultPr}`);
  assert.match(domElements.get('w1-dispatch-acceptance').textContent,/UNKNOWN/);

  const nativePathFixture=buildFixture(resultPr + 31,'native-bridge/v2-readiness.mjs',
    'v2-native-windows=SUCCESS');
  assert.ok(panel.validSchema6DispatchComment(nativePathFixture.jobComment),
    'native workflow scope is a valid schema-6 task path');
  const nativePathData=cardFor(nativePathFixture);
  assert.ok(nativePathData.codexSourceAcceptance,
    'a change covered by the V2 workflow requires its successful exact-head check');
  assert.equal(nativePathData.codexSourceAcceptance.status,'ACCEPTED');
  assert.match(nativePathData.codexSourceAcceptance.checks,/v2-native-windows=SUCCESS/);
  const nativePathWithoutCheck=buildFixture(resultPr + 32,'native-bridge/v2-readiness.mjs',
    'v2-native-windows=NOT_APPLICABLE_PATH_FILTERED');
  assert.equal(cardFor(nativePathWithoutCheck).codexSourceAcceptance,null,
    'a V2 workflow path cannot be exempted as path-filtered');
  const filteredPathWithoutMarker=buildFixture(resultPr + 33,changedFile,'');
  assert.equal(cardFor(filteredPathWithoutMarker).codexSourceAcceptance,null,
    'an excluded path still requires an explicit non-applicable marker');
  const filteredPathWithContradictoryChecks=buildFixture(resultPr + 34,changedFile,
    'v2-native-windows=NOT_APPLICABLE_PATH_FILTERED;v2-native-windows=SUCCESS');
  assert.equal(cardFor(filteredPathWithContradictoryChecks).codexSourceAcceptance,null,
    'conflicting V2 status markers are rejected');

  const panelFilterBlock=html.match(/const V2_NATIVE_WORKFLOW_PATH_FILTERS = \[([\s\S]*?)\];/);
  assert.ok(panelFilterBlock,'panel declares the V2 workflow filter contract');
  const panelFilters=[...panelFilterBlock[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  const workflowFilters=[...v2QualificationWorkflow.matchAll(/^\s{6}- '([^']+)'$/gm)]
    .map(match => match[1]);
  assert.deepEqual(panelFilters,workflowFilters,
    'the panel applicability rules stay aligned with the actual workflow path filters');

  const otherFixture=buildFixture(resultPr + 29);
  const otherData=cardFor(otherFixture);
  assert.equal(otherData.codexSourceAcceptance.resultPr,resultPr + 29,
    'the additive acceptance follows the fixture result PR instead of a fixed PR number');
  assert.match(otherData.codexSourceAcceptance.label,
    new RegExp(`PR #${resultPr + 29} SOURCE_ACCEPTED`));

  const otherDiff='f'.repeat(64);
  const mutations=[
    ['request identity', body => replaceLine(body,'request_id',requestId + '_MISMATCH')],
    ['task comment identity', body => replaceLine(body,'task_comment_id',String(jobCommentId + 1))],
    ['attempt identity', body => replaceLine(body,'attempt_id','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')],
    ['project identity', body => replaceLine(body,'project_id','CHATGPT_GLOBAL_SKILL_GOVERNANCE_ALT')],
    ['GOAL identity', body => replaceLine(body,'human_goal_comment_id','6188322051')],
    ['repository identity', body => replaceLine(body,'repo','other/project')],
    ['source SHA', body => replaceLine(body,'source_head','e'.repeat(40))],
    ['source PR', body => replaceLine(body,'source_pr',String(sourcePr + 1))],
    ['worker diff SHA', body => replaceLine(
      replaceLine(body,'worker_diff_sha256',otherDiff),'diff_sha256',otherDiff)],
    ['worker diff byte count', body => replaceLine(body,'diff_bytes',String(diffBytes + 1))],
    ['forged source acceptance', body => replaceLine(body,'source_acceptance',
      `ACCEPTED_FOR_EXACT_WORKER_DIFF_AND_MERGED_PR_${resultPr + 1}`)],
    ['integration versus result PR metadata', body => replaceLine(body,'integration',
      `PR_${resultPr + 1}_MERGED`)],
    ['failed required trusted check', body =>
      body.replace('csg-trusted-verifier-hosted=SUCCESS','csg-trusted-verifier-hosted=FAILURE')],
    ['missing required trusted check', body => body.replace(fixture.checks,
      `pr_${resultPr}_checks=check-native-only=SUCCESS;v2-native-windows=NOT_APPLICABLE_PATH_FILTERED;` +
      'csg-trusted-verifier=PENDING_NOT_COUNTED_AS_PASS;bounded-driver-acceptance=SKIPPED')],
    ['failed focused test summary', body => replaceLine(body,'focused_test',
      'node --test tests/operator-panel-api.test.mjs;7_total;5_passed;1_failed;1_skipped')],
    ['missing focused test summary', body => removeLine(body,'focused_test')],
    ['failed Codex review', body => replaceLine(body,'codex_review','FAIL_ADDITIVE_NEGATIVE_COVERAGE')],
    ['changed path outside pinned edit paths', body =>
      replaceLine(body,'changed_files','native-bridge/worker.mjs')],
    ['invalid merged blob identity', body =>
      replaceLine(body,'merged_file_blob',`${changedFile}:not-a-blob`)],
    ['missing merged blob identity', body => removeLine(body,'merged_file_blob')],
  ];
  for (const [label,mutate] of mutations) {
    const mutatedBody=mutate(fixture.body);
    assert.notEqual(mutatedBody,fixture.body,`${label} must change the valid additive fixture`);
    const rejected=cardFor(fixture,fixture.comments.map(comment =>
      comment.id === reconciliationId ? {...comment,body:mutatedBody} : comment));
    assert.equal(rejected.codexSourceAcceptance,null,
      `${label} must not be recognized as Codex source acceptance`);
    assert.equal(rejected.workerTerminal,'FINISHED_NOT_ACCEPTANCE',
      `${label} must preserve the original Worker terminal`);
    assert.equal(rejected.formalAcceptance,'UNKNOWN',
      `${label} must preserve Worker task_acceptance=UNKNOWN`);
    assert.equal(rejected.externalEffects,'UNKNOWN',
      `${label} must preserve external_effects=UNKNOWN`);
  }
});

test('dispatch layout uses two readable desktop columns, collapsible technical detail, and a compact W3 empty state', () => {
  assert.match(html, /\.dispatch-grid\s*\{[^}]*repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(html, /\.worker-title-line\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(html, /\.worker-live \.badge\s*\{[^}]*white-space:\s*normal/);
  assert.match(html, /\.worker-live \.badge\s*\{[^}]*overflow-wrap:\s*break-word/);
  assert.match(html, /<details class="dispatch-technical"/);
  assert.match(html, /id="w3-empty"/);
  assert.match(html, /id="w1-task-badge"/);
  assert.match(html, /id="w2-task-badge"/);
  assert.match(html, /id="w3-task-badge"/);
  assert.match(html, /@media\s*\(max-width:\s*700px\)/);
});

test('W3 Agent/request identifiers do not stand in for handoff, MCP execution, completion, or Codex receipt', () => {
  const agentId='01a16cdd-bbf7-71c0-af1e-0ba1e568790e';
  const snapshot={workers:[{worker_id:'W3',status:'UNKNOWN',task_id:agentId,
    task_comment_id:6368000001,attempt_id:'11111111-1111-4111-8111-111111111111'}]};
  const card=panel.dispatchCardData('W3',snapshot,[],{dispatches:{}},{status:'UNKNOWN'},baseTime);
  assert.equal(card.hasTask,true);
  assert.match(card.task,/候選留言 #6368000001（未驗證）/);
  assert.match(card.w3Stages.formal,/UNKNOWN/);
  assert.match(card.w3Stages.handoff,/UNKNOWN/);
  assert.match(card.w3Stages.toolCalls,/UNKNOWN/);
  assert.match(card.w3Stages.completion,/UNKNOWN/);
  assert.match(card.w3Stages.codexReceipt,/UNKNOWN/);
  assert.match(card.summaryProgress,/五階段獨立待驗證/);
  assert.doesNotMatch(card.summaryProgress,/已完成|已傳送|工具執行成功/);
});

test('W3 self-reported tool activity and launcher traces do not prove Zero Risk execution or delivery', () => {
  const now=baseTime;
  const record={worker_id:'W3',status:'RUNNING_VERIFIED',task_id:'W3_PANEL_CANDIDATE',
    attempt_id:'11111111-1111-4111-8111-111111111111',task_source:'issue-407',
    evidence_ref:'self-reported-tool-call',evidence_kind:'ZERO_RISK_TOOL_CALL',
    activity_observed_at:new Date(now).toISOString(),
    verified_steps:['launcher_1','launcher_2','launcher_3','launcher_4','launcher_5'],
    code_changes:'PROVEN',commit_sha:'a'.repeat(40),pr_number:527,delivery_status:'ACCEPTED'};
  assert.equal(panel.classifyWorker(record,'FRESH',now).status,'RUNNING_VERIFIED',
    'generic classification alone would promote the source-only claim');
  const classified=panel.classifyW3(record,'FRESH',now);
  assert.equal(classified.status,'UNKNOWN');
  const card=panel.workerCardData('W3',record,classified,{workers:[record]});
  for (const field of ['session','activity','progress','changes','delivery','source'])
    assert.match(card[field],/UNKNOWN/);
  assert.doesNotMatch(card.progress,/launcher_1|launcher_5/);
  assert.doesNotMatch(card.delivery,/Commit a{40}|交付階段 ACCEPTED/);
  assert.equal(panel.classifyW3(record,'STALE',now).status,'STALE');
});

test('future timestamps never masquerade as current observations or dispatch events', () => {
  const now=Date.parse('2026-10-24T14:00:00Z');
  const snapshot={sequence:1,observed_at:new Date(now+1000).toISOString(),
    expires_at:new Date(now+11*60_000).toISOString()};
  assert.equal(panel.fieldFreshness(snapshot.observed_at,10*60_000,now),'UNKNOWN');
  assert.equal(panel.classifyRecentEvents([] ,snapshot,null,{},now).some(
    event=>event.eventType==='observation'),false);
  const invalidExpiration={...snapshot,observed_at:new Date(now-1000).toISOString(),
    expires_at:new Date(now-2000).toISOString()};
  assert.equal(panel.classifyRecentEvents([],invalidExpiration,null,{},now).some(
    event=>event.eventType==='observation'),false);
  const published=observationComments(now);
  const futurePublisher={...published[0],updated_at:new Date(now+1001).toISOString()};
  assert.equal(panel.findSnapshot([futurePublisher],now).status,'UNKNOWN',
    'GitHub metadata beyond a one-second clock skew cannot attest freshness');
  const body=JSON.parse(published[0].body.split('\n').slice(1).join('\n'));
  body.observed_at=new Date(now+1000).toISOString();
  const futureSample={...published[0],body:'PTYSD_OPERATOR_OBSERVATION_V1\n'+JSON.stringify(body)};
  assert.equal(panel.findSnapshot([futureSample],now).status,'UNKNOWN',
    'future observed_at is untrusted even when GitHub metadata is current');
});

test('future and foreign attempt receipts cannot override a valid matching dispatch', () => {
  const now=Date.parse('2026-10-24T14:00:00Z');
  const request_id='W1_PANEL_STRICT_MATCH_20261024';
  const source_sha='a'.repeat(40);
  const attempt_id='11111111-1111-4111-8111-111111111111';
  const job={request_id,source_sha,kind:'opencode_edit',source_pr:505};
  const item=(id,overrides,created_at)=>({id,created_at,user:{login:'t14210184'},
    body:'PTYSD_NATIVE_RECEIPT_V1\n'+JSON.stringify({
      schema:1,project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE',host:'DESKTOP-1B6PD2P',
      request_id,source_sha,kind:job.kind,attempt_id,state:'FINISHED',...overrides})});
  const valid=item(12,{},new Date(now-1000).toISOString());
  const comments=[valid,
    item(13,{source_sha:'b'.repeat(40)},new Date(now-100).toISOString()),
    item(14,{kind:'antigravity_edit'},new Date(now-100).toISOString()),
    item(15,{attempt_id:'22222222-2222-4222-8222-222222222222'},
      new Date(now-100).toISOString()),
    item(16,{},new Date(now+1000).toISOString())];
  const receipts=panel.dispatchReceipt(comments,job,attempt_id,10,now);
  assert.equal(receipts.items.length,1);
  assert.equal(receipts.latest.id,12);
});

test('changing the task PR pin invalidates PR and checks data from the previous pin', async () => {
  let now = baseTime;
  let selected = { prNumber: 437, sourceSha: head };
  const calls = [];
  const client = panel.createApiClient(async url => {
    calls.push(url);
    if (url === urls.issue) return response(200,
      observationComments(now, selected), quotaHeaders(now));
    if (url === `${apiRoot}/pulls/437`) return response(200, pullRequest(437, head), quotaHeaders(now));
    if (url === `${apiRoot}/pulls/438`) return response(200, pullRequest(438, 'b'.repeat(40)), quotaHeaders(now));
    if (url.includes('/check-runs')) return response(200, { check_runs: [] }, quotaHeaders(now));
    if (url === urls.main) return response(200, { sha: head }, quotaHeaders(now));
    throw new Error(`UNEXPECTED_URL:${url}`);
  }, { now: () => now });
  const store = panel.createResourceStore(client, () => now);
  await panel.runSyncCycle(store, client, { issue: urls.issue, main: urls.main });
  assert.equal(store.resources.pr.data.number, 437);
  assert.equal(store.resources.checks.url, `${apiRoot}/commits/${head}/check-runs?per_page=100`);

  now += 5 * 60 * 1000;
  selected = { prNumber: 438, sourceSha: 'b'.repeat(40) };
  const cycle = await panel.runSyncCycle(store, client, { issue: urls.issue, main: urls.main });
  assert.equal(cycle.prPin.number, 438);
  assert.equal(store.resources.pr.data.number, 438);
  assert.equal(store.resources.checks.url,
    `${apiRoot}/commits/${'b'.repeat(40)}/check-runs?per_page=100`);
  assert.equal(store.checksSummaryForHead(head, 437), null);
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
    const body=url === urls.issue ? observationComments(now) : url === urls.pr ? pullRequest(437,head) :
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
  for (const store of stores) assert.equal(store.resources.issue.data.length,1);

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
  store.bindPullRequest({ number: 437 });
  const firstUrl = store.bindChecksHead(head);
  await store.loadResource('checks', firstUrl, 0);
  assert.ok(store.checksSummaryForHead(head, 437));
  const nextHead = 'b'.repeat(40);
  const nextUrl = store.bindChecksHead(nextHead);
  assert.notEqual(nextUrl, firstUrl);
  assert.equal(store.checksSummaryForHead(head), null);
  assert.equal(store.resources.checks.data, null);
});

test('a late PR response cannot overwrite the resource after its task pin changes', async () => {
  let resolveOld;
  const client = {
    getMeta: () => null,
    getRateState: () => ({}),
    isPaused: () => false,
    requestJson(url) {
      if (url === `${apiRoot}/pulls/437`)
        return new Promise(resolve => { resolveOld = resolve; });
      if (url === `${apiRoot}/pulls/438`)
        return Promise.resolve(pullRequest(438, 'b'.repeat(40)));
      throw new Error(`UNEXPECTED_URL:${url}`);
    },
  };
  const store = panel.createResourceStore(client, () => baseTime);
  const oldUrl = store.bindPullRequest({ number: 437 });
  const oldRead = store.loadResource('pr', oldUrl, 0);
  assert.equal(typeof resolveOld, 'function');

  const newUrl = store.bindPullRequest({ number: 438 });
  await store.loadResource('pr', newUrl, 0);
  resolveOld(pullRequest(437, head));
  await oldRead;

  assert.equal(store.resources.pr.url, newUrl);
  assert.equal(store.resources.pr.data.number, 438);
  assert.equal(store.resources.pr.inFlight, null);
});

test('a rejected fetch surfaces GITHUB_CORS_OR_NETWORK_UNKNOWN without faking data or pausing', async () => {
  let now = baseTime;
  let calls = 0;
  const client = panel.createApiClient(async () => {
    calls++;
    throw new TypeError('Failed to fetch');
  }, { now: () => now });
  const store = panel.createResourceStore(client, () => now);

  await assert.rejects(client.requestJson(urls.issue), { code: 'GITHUB_CORS_OR_NETWORK_UNKNOWN' });
  assert.equal(calls, 1);
  assert.equal(client.getRateState().lastSuccessAt, null, 'a rejected fetch never refreshes lastSuccessAt');
  assert.equal(client.isPaused(), false, 'a network failure is not a primary-quota pause');
  assert.equal(client.getRateState().status, 'READY');
  assert.equal(client.getRateState().cause, null);

  assert.equal(await store.loadResource('main', urls.main, 0), null);
  assert.equal(store.resources.main.error, 'GITHUB_CORS_OR_NETWORK_UNKNOWN');
  assert.equal(store.resources.main.data, null, 'no current data is fabricated');
  assert.equal(store.resources.main.fetchedAt, 0, 'fetchedAt is not refreshed');
  assert.equal(calls, 2);

  const retryAt = store.resources.main.retryAt;
  assert.ok(retryAt > now && retryAt <= now + 5 * 60 * 1000, 'the resource backoff is bounded');
  assert.equal(await store.loadResource('main', urls.main, 0), null);
  assert.equal(calls, 2, 'the failed resource is not retried immediately');
  assert.equal(store.resources.main.retryAt, retryAt);
});

test('an HTTP 503 with remaining quota fails locally, lets unrelated reads proceed, and backs off per resource', async () => {
  let now = baseTime;
  const calls = [];
  const client = panel.createApiClient(async url => {
    calls.push(url);
    if (url === urls.issue)
      return response(503, { message: 'Service Unavailable' },
        { 'X-RateLimit-Limit': 60, 'X-RateLimit-Remaining': 42 });
    return response(200, { sha: head }, { 'X-RateLimit-Limit': 60, 'X-RateLimit-Remaining': 41 });
  }, { now: () => now });
  const store = panel.createResourceStore(client, () => now);

  assert.equal(await store.loadResource('issue', urls.issue, 0), null);
  assert.equal(store.resources.issue.error, 'GITHUB_HTTP_503');
  assert.equal(store.resources.issue.data, null, 'no current data is fabricated');
  assert.equal(store.resources.issue.fetchedAt, 0, 'fetchedAt is not refreshed');
  assert.equal(calls.length, 1);
  assert.equal(client.getRateState().lastSuccessAt, null, 'a 503 never refreshes lastSuccessAt');
  assert.equal(client.isPaused(), false, 'nonzero remaining is not a primary-quota pause');
  assert.equal(client.getRateState().status, 'READY');
  assert.equal(client.getRateState().cause, null);

  assert.deepEqual(await client.requestJson(urls.main), { sha: head },
    'an unrelated public read is not blocked by the failed resource');
  assert.equal(calls.length, 2);
  assert.equal(client.getRateState().lastSuccessAt, now);

  const firstRetryAt = store.resources.issue.retryAt;
  assert.equal(firstRetryAt - now, 30 * 1000, 'the failing resource starts inside its bounded local backoff');
  assert.equal(await store.loadResource('issue', urls.issue, 0), null);
  assert.equal(calls.length, 2, 'the failed resource is not retried inside its retry window');

  const backoffs = [];
  let cursor = firstRetryAt;
  while (backoffs.length < 6) {
    now = cursor;
    await store.loadResource('issue', urls.issue, 0);
    const next = store.resources.issue.retryAt;
    backoffs.push(next - now);
    cursor = next;
  }
  assert.ok(backoffs.every(ms => ms > 0 && ms <= 5 * 60 * 1000), 'per-resource backoff stays within five minutes');
  assert.ok(backoffs.every((ms, index) => index === 0 || ms >= backoffs[index - 1]), 'backoff never shrinks');
  assert.equal(Math.max(...backoffs), 5 * 60 * 1000, 'per-resource backoff caps at five minutes');
});

test('W2 panel evidence separates native schema-6 task, direct CLI, and the historical blocked attempt', async () => {
  // Exact identity read back from the pinned GitHub Human GOAL comment #6188322050.
  const goalIdentity = { id:6188322050, author:'t14210184',
    body_sha256:'2f1829da0e1f5105a384be03904b2289c57c05e8a44215c4824fb6b8631d8f7b' };
  const goalBodySha = goalIdentity.body_sha256;
  const oldRequest = 'W2S_5AA1ADD410B24E28ADAB8E4B7E528920_20261022_154481FF';
  const oldAttempt = '24331e45-62db-4f55-ad40-87776a799c5d';
  const oldSha = '918f60e0023b7194874e6ea640cb98023760697c';
  const currentRequest = 'W2_PANEL_DELIVERY_LINEAGE_20261028_F25880F4BCA4BDFD51122F761A0F1308';
  const currentSha = 'f1f485e348c41bb0f8d9da696efdb37ad9026d7c';
  const specHash = '716ffbad70e5cbba5459e9e956724cd032cff64667910b139ab01f24cdcec0ed';
  const job = (requestId, sourceSha, sourcePr, specPath, editPaths) => ({
    schema:6, project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE', host:'DESKTOP-1B6PD2P',
    request_id:requestId, kind:'antigravity_edit', source_sha:sourceSha,
    spec_path:specPath, spec_sha256:specHash, model:'gemini-3.8-flash-high', variant:'high',
    edit_paths:editPaths, source_pr:sourcePr, goal_comment_id:6188322050,
    goal_body_sha256:goalBodySha,
  });
  const comment = (id, login, body, createdAt) => ({ id, user:{login}, body, created_at:createdAt });
  const oldJob = job(oldRequest,oldSha,461,'native-bridge/tasks/w2-r7-target-multiplicity.md',
    ['native-bridge/antigravity-quota.mjs','tests/antigravity-quota.test.mjs','package.json']);
  const currentJob = job(currentRequest,currentSha,586,'native-bridge/tasks/w2-panel-current-delivery-lineage.md',
    ['operator-panel/index.html']);
  const directCliBody = [
    'record_type=ADDITIVE_CONTROLLER_READBACK_NOT_NATIVE_WORKER_RECEIPT',
    'native_worker_job=NOT_CREATED',
    'native_worker_attempt=NOT_CREATED',
    '### Actual model session',
    '- Model=gemini-3.8-flash-high; session_id=be190416-e85f-4f68-b33a-5d05f54d7072; status=SUCCESS; one turn; duration=959.607 seconds.',
    '- Gemini changed only tests/v2-readiness.test.mjs: +132/-1; diff SHA-256=ae294af7292c35e949bc6a83bb16d2f38779720aa347c1721968ce9f9eb5eae4.',
    '- Focused tests: 52 total, 51 passed, 0 failed, 1 skipped. Full suite: 401 total, 396 passed, 0 failed, 5 skipped.',
    '- PR #575 was closed as superseded after its follow-up commit failed DIRECT_PARENT_MISMATCH.',
    '- Replacement PR #576 is OPEN, non-draft, head=a4b4b5a00f003f446847be3ab521cbf278e02c78, base=7810399813554df0aaf64dbf2c60466ae0305ff1.',
    '- The session was not a native Worker attempt; external_effects remains UNKNOWN.',
  ].join('\n');
  const oldReceipt = {
    schema:1, project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE', host:'DESKTOP-1B6PD2P',
    request_id:oldRequest, attempt_id:oldAttempt, state:'BLOCKED', kind:'antigravity_edit',
    source_sha:oldSha, source_pr:461, outcome:'ANTIGRAVITY_EDIT_TOOL_EXECUTION_FAILED_NO_DIFF',
    session_id:'1bd39163-9221-4973-9268-fc73584e1d36', task_acceptance:'UNKNOWN',
    external_effects:'UNKNOWN',
  };
  const currentReceipt = {
    schema:1, project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE', host:'DESKTOP-1B6PD2P',
    request_id:currentRequest, attempt_id:'e20221e7-1ac2-49d0-a27a-91312a079a48',
    state:'FINISHED', kind:'antigravity_edit', source_sha:currentSha, source_pr:586,
    outcome:'ANTIGRAVITY_EDIT_DIFF_CAPTURED_UNVERIFIED_FILE_TOOL_FAILURES_RETAINED',
    session_id:'7dd5d8cc-2388-459c-9779-aac594eade70',
    diff_sha256:'423d51612e6eb7596d19afc08411b05d5ffe4666e9c9027b44357ffdcaa647ae', diff_bytes:6381,
    task_acceptance:'UNKNOWN', external_effects:'UNKNOWN',
  };
  const currentAcceptance = {
    schema:1, project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE',
    record_type:'ADDITIVE_CONTROLLER_READBACK_NOT_NATIVE_WORKER_RECEIPT',
    request_id:currentRequest, attempt_id:currentReceipt.attempt_id,
    source_sha:currentSha, source_pr:586, codex_source_acceptance:'ACCEPTED',
    exact_head_ci:'SUCCESS', tests:{
      focused:{total:29,passed:29,failed:0,skipped:0},
      full:{total:412,passed:367,failed:0,skipped:45},
      operator_panel:{total:29,passed:29,failed:0,skipped:0},
    },
    external_effects:'UNKNOWN',
  };
  const directDeliveryReadback = {
    schema:1, project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE',
    record_type:'ADDITIVE_CONTROLLER_READBACK_NOT_NATIVE_WORKER_RECEIPT',
    direct_cli_comment_id:6438594849,
    direct_cli_session_id:'be190416-e85f-4f68-b33a-5d05f54d7072',
    model:'gemini-3.8-flash-high',
    direct_cli_diff_sha256:'ae294af7292c35e949bc6a83bb16d2f38779720aa347c1721968ce9f9eb5eae4',
    original_pr:576, original_head_sha:'a4b4b5a00f003f446847be3ab521cbf278e02c78',
    original_pr_state:'CLOSED_UNMERGED', recovery_pr:577,
    recovery_head_sha:'e1669889f8a9111cfb0af9f6eddeecb95a757141',
    recovery_pr_state:'CLOSED_UNMERGED', combined_delivery_pr:578,
    combined_head_sha:'da11c4bdddad19f30b8477c24c69e2ada0b7e163',
    base_sha:'7810399813554df0aaf64dbf2c60466ae0305ff1',
    sole_parent_sha:'7810399813554df0aaf64dbf2c60466ae0305ff1',
    merge_commit_sha:'737fa98390549c12bda2e42466311b42c2198ef6',
    main_after_merge:'1268cdbf5cc56bb7ac3b7fe7fdb9d74adb039e49',
    main_contains_merge:true,
    exact_head_ci:{'csg-trusted-verifier-hosted':'SUCCESS','check-native-only':'SUCCESS',
      'v2-native-windows':'SUCCESS','bounded-driver-acceptance':'SKIPPED',
      'csg-trusted-verifier':'CANCELLED_NOT_COUNTED'},
    provenance:'DIRECT_CLI_NOT_NATIVE_WORKER',
    native_worker_job:'NOT_CREATED', native_worker_attempt:'NOT_CREATED',
    external_effects:'UNKNOWN',
  };
  const laterW1Job = {
    schema:6, project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE', host:'DESKTOP-1B6PD2P',
    request_id:'W1_OPENCODE_FREE_LIMIT_EVIDENCE_20261028_AF6FA547', kind:'opencode_edit',
    source_sha:'3bdc5f62dcfed11374ed5d02cc88e2f7ab9901dd',
    spec_path:'native-bridge/tasks/w1-opencode-free-limit-evidence.md',
    spec_sha256:'4d3230faf5f9c6fe406884d7774665e72d3474ad7eb9a92dc8a3aeb201fe2545',
    model:'opencode/deepseek-v4.1-flash-free', variant:null,
    edit_paths:['native-bridge/opencode-v2.mjs','tests/opencode-v2.test.mjs'],
    source_pr:589, goal_comment_id:6188322050, goal_body_sha256:goalBodySha,
  };
  const goalComments = [
    comment(6342391654,'t14210184','PTYSD_NATIVE_JOB_V1\n'+JSON.stringify(oldJob),'2026-10-22T13:49:13Z'),
    comment(6450252993,'t14210184','PTYSD_NATIVE_JOB_V1\n'+JSON.stringify(currentJob),'2026-10-28T01:44:00Z'),
    comment(6463422047,'t14210184','PTYSD_NATIVE_JOB_V1\n'+JSON.stringify(laterW1Job),'2026-10-28T08:02:00Z'),
  ];
  const issueComments = [
    comment(6344079399,'t14210184','PTYSD_NATIVE_RECEIPT_V1\n'+JSON.stringify(oldReceipt),'2026-10-22T15:07:35Z'),
    comment(6367399586,'t14210184',`original_unknown_attempt=${oldAttempt}\nw1_classification=MODEL_SESSION_AND_SCOPED_DIFF_CONFIRMED;PATCH_INTEGRATED_AND_CODEX_TESTED_VIA_PR_507\nclassification=PARTIAL_OR_AMBIGUOUS\nexternal_effects=UNKNOWN`,'2026-10-23T14:36:17Z'),
    comment(6438594849,'t14210184',directCliBody,'2026-10-27T09:45:07Z'),
    comment(6462176020,'t14210184','PTYSD_NATIVE_RECEIPT_V1\n'+JSON.stringify(currentReceipt),'2026-10-28T01:49:00Z'),
    comment(6433468416,'t14210184',`original_unknown_attempt=${oldAttempt}\nclassification=PARTIAL_OR_AMBIGUOUS\nexternal_effects=UNKNOWN`,'2026-10-27T04:05:21Z'),
    comment(6462408686,'t14210184','### W2 R7 schema-6 source acceptance\nPTYSD_V53R4_W2_PANEL_ACCEPTANCE_V1\n'+JSON.stringify(currentAcceptance),'2026-10-28T01:52:00Z'),
    comment(6449891925,'t14210184','### W2 direct CLI delivery lineage readback\nPTYSD_W2_DIRECT_CLI_DELIVERY_V1\n'+JSON.stringify(directDeliveryReadback),'2026-10-28T01:58:00Z'),
  ];
  assert.equal(panel.validJob(currentJob),true,'the panel recognizes the exact schema-6 W2 job contract');
  assert.equal(panel.validJob(laterW1Job),true,'the panel recognizes the exact schema-6 W1 job contract');
  assert.equal(panel.validJob({...currentJob,edit_paths:['../package.json']}),false,
    'the panel rejects an out-of-repository edit path');
  const evidence = panel.w2EvidenceData(goalComments,issueComments,head,goalIdentity);
  assert.equal(evidence.native.job.request_id,currentRequest);
  assert.equal(evidence.native.jobCommentId,6450252993);
  assert.equal(evidence.native.goalReferenceVerified,true);
  assert.equal(evidence.native.job.source_pr,586);
  assert.equal(evidence.native.receipt.attempt_id,currentReceipt.attempt_id);
  assert.equal(evidence.native.receipt.session_id,currentReceipt.session_id);
  assert.equal(evidence.native.receipt.state,'FINISHED');
  assert.equal(evidence.native.receipt.task_acceptance,'UNKNOWN');
  assert.equal(evidence.native.codexAcceptance.codex_source_acceptance,'ACCEPTED');
  assert.equal(evidence.native.receipt.external_effects,'UNKNOWN');
  const workerSummary=panel.workerMetricSummary(
    {W1:{status:'UNKNOWN'},W2:{status:'UNKNOWN'},W3:{status:'UNKNOWN'}},
    {W1:{hasBoundReceipt:true,codexSourceAcceptance:{status:'ACCEPTED'}},
      W2:{hasBoundReceipt:true}},
    {native:{receipt:{attempt_id:'00000000-0000-4000-8000-000000000001'},
      codexAcceptance:{codex_source_acceptance:'ACCEPTED'}}},true,true);
  assert.equal(workerSummary,'目前施工 0／3；W1/W2 精確收據 2／2；Codex 來源接受 2／2',
    'current activity, bound Worker receipts, and Codex source acceptance are separate facts');
  assert.match(panel.workerMetricSummary(
    {W1:{status:'UNKNOWN'},W2:{status:'UNKNOWN'},W3:{status:'UNKNOWN'}},
    {W1:{hasBoundReceipt:true},W2:{hasBoundReceipt:true}},
    {native:{receipt:null,receiptResolution:'SNAPSHOT_REQUEST_MISMATCH'}},true,true),
    /W1\/W2 精確收據 1／2/,
    'the W2 total comes from its exact latest-job binding, not a stale per-worker snapshot');
  assert.doesNotMatch(workerSummary,/近期施工證據/,
    'a zero active count must not erase recent terminal Worker receipts');
  assert.match(panel.workerMetricSummary({}, {}, {}, false, false),
    /目前施工 UNKNOWN；W1\/W2 原生收據 UNKNOWN；Codex 來源接受 UNKNOWN/,
    'stale OS or incomplete GitHub reads never become zero counts');
  const acceptedEvidence = panel.w2EvidenceData(goalComments,issueComments,head,goalIdentity);
  assert.equal(acceptedEvidence.native.codexAcceptance.codex_source_acceptance,'ACCEPTED');
  assert.equal(acceptedEvidence.native.receipt.state,'FINISHED',
    'a separate Codex source acceptance never upgrades the Worker lifecycle receipt');
  assert.equal(acceptedEvidence.native.receipt.external_effects,'UNKNOWN');
  panel.renderW2Evidence(acceptedEvidence);
  assert.match(domElements.get('w2-native-acceptance').textContent,/Codex source_acceptance=ACCEPTED/);
  assert.match(domElements.get('w2-native-acceptance').textContent,/CI=SUCCESS/);
  assert.match(domElements.get('w2-native-acceptance').textContent,/測試 367\/412 · 失敗 0 · 略過 45/);
  assert.match(domElements.get('w2-native-acceptance').textContent,/Worker task_acceptance=UNKNOWN/);
  assert.match(domElements.get('w2-native-acceptance').textContent,/external_effects=UNKNOWN/);

  const otherAttemptReceipt={...currentReceipt,
    attempt_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    session_id:'00000000-0000-4000-8000-000000000001'};
  const twoAttemptComments=[...issueComments,comment(6462176021,'t14210184',
    'PTYSD_NATIVE_RECEIPT_V1\n'+JSON.stringify(otherAttemptReceipt),'2026-10-28T06:18:00Z')];
  const unboundAttempts=panel.w2EvidenceData(goalComments,twoAttemptComments,head,goalIdentity);
  assert.equal(unboundAttempts.native.receiptResolution,'MULTIPLE_ATTEMPTS_UNBOUND',
    'the W2 summary must not silently treat the latest comment as the uniquely recovered attempt');
  assert.equal(unboundAttempts.native.receipt,null,
    'multiple W2 attempts require an exact attempt binding before showing a Session or terminal');
  assert.equal(unboundAttempts.native.codexAcceptance,null,
    'a source acceptance tied to one attempt is not attached to an ambiguous attempt set');
  panel.renderW2Evidence(unboundAttempts);
  assert.match(domElements.get('w2-native-attempt').textContent,/多個 attempt.*未自動挑選/);
  assert.match(domElements.get('w2-native-session').textContent,/Session UNKNOWN/);
  assert.match(domElements.get('w2-native-acceptance').textContent,/source acceptance 保留 UNKNOWN/);
  const boundAttempt=panel.w2EvidenceData(goalComments,twoAttemptComments,head,goalIdentity,
    true,true,{requestId:currentRequest,attemptId:currentReceipt.attempt_id});
  assert.equal(boundAttempt.native.receipt.attempt_id,currentReceipt.attempt_id,
    'an exact request/attempt binding recovers only that W2 receipt');
  assert.equal(boundAttempt.native.receipt.session_id,currentReceipt.session_id);
  assert.equal(boundAttempt.native.codexAcceptance.codex_source_acceptance,'ACCEPTED');
  const missingExpectedAttempt=panel.w2EvidenceData(goalComments,twoAttemptComments,head,goalIdentity,
    true,true,{requestId:currentRequest,attemptId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'});
  assert.equal(missingExpectedAttempt.native.receiptResolution,'EXPECTED_ATTEMPT_NOT_FOUND');
  assert.equal(missingExpectedAttempt.native.receipt,null,
    'a missing expected attempt must not fall back to another attempt');
  assert.equal(missingExpectedAttempt.native.codexAcceptance,null);
  panel.renderW2Evidence(missingExpectedAttempt);
  assert.match(domElements.get('w2-native-attempt').textContent,/指定 attempt.*不改配其他 attempt/);
  assert.equal(evidence.directCli.provenance,'DIRECT_CLI_NOT_NATIVE_WORKER');
  assert.equal(evidence.directCli.session_id,'be190416-e85f-4f68-b33a-5d05f54d7072');
  assert.equal(evidence.directCli.pull_request,576);
  assert.equal(evidence.directCli.changed_file,'tests/v2-readiness.test.mjs');
  assert.match(evidence.directCli.tests,/52 total, 51 passed, 0 failed, 1 skipped/);
  assert.match(evidence.directCli.tests,/Full: 401 total, 396 passed, 0 failed, 5 skipped/);
  assert.equal(evidence.directCli.provenance,'DIRECT_CLI_NOT_NATIVE_WORKER');
  assert.equal(evidence.directCli.deliveryReadback?.combined_delivery_pr,578);
  assert.equal(evidence.directCli.deliveryReadback?.original_pr_state,'CLOSED_UNMERGED');
  assert.equal(evidence.directCli.deliveryReadback?.main_after_merge,'1268cdbf5cc56bb7ac3b7fe7fdb9d74adb039e49');
  assert.match(domElements.get('w2-direct-delivery').textContent,/PR #576.*CLOSED_UNMERGED/);
  assert.match(domElements.get('w2-direct-delivery').textContent,/PR #578.*MERGED/);
  assert.match(domElements.get('w2-direct-delivery').textContent,/737fa98390549c12bda2e42466311b42c2198ef6/);
  const mismatchedLineage = panel.w2EvidenceData(goalComments,issueComments.map(c =>
    c.id === 6449891925 ? {...c,body:'PTYSD_W2_DIRECT_CLI_DELIVERY_V1\n'+JSON.stringify({
      ...directDeliveryReadback,direct_cli_session_id:'different-session'})} : c),head,goalIdentity);
  assert.equal(mismatchedLineage.directCli.deliveryReadback,null,
    'a lineage record for a different direct-CLI session is ignored');
  panel.renderW2Evidence(mismatchedLineage);
  const arbitraryPrefix = panel.w2EvidenceData(goalComments,issueComments.map(c =>
    c.id === 6449891925 ? {...c,body:'untrusted note\n'+c.body.slice(c.body.indexOf('PTYSD_W2_DIRECT_CLI_DELIVERY_V1'))} : c),head,goalIdentity);
  assert.equal(arbitraryPrefix.directCli.deliveryReadback,null,
    'arbitrary prose before the marked direct-CLI lineage is ignored');
  assert.match(domElements.get('w2-direct-delivery').textContent,/UNKNOWN/);
  assert.equal(evidence.historical.attempt_id,oldAttempt);
  assert.equal(evidence.historical.state,'BLOCKED');
  assert.equal(evidence.historical.classification,'PARTIAL_OR_AMBIGUOUS');
  assert.equal(evidence.historical.external_effects,'UNKNOWN');
  const mismatchedGoal = panel.w2EvidenceData(goalComments,issueComments,head,
    { ...goalIdentity, body_sha256:'f'.repeat(64) });
  assert.equal(mismatchedGoal.native.goalReferenceVerified,false);
  panel.renderW2Evidence(evidence);
  assert.ok(domElements.get('w2-native-task').textContent.includes(currentRequest));
  assert.ok(domElements.get('w2-native-task').textContent.includes(currentSha));
  assert.match(domElements.get('w2-native-task').textContent,/GOAL 已核對/);
  assert.ok(domElements.get('w2-native-session').textContent.includes(currentReceipt.session_id));
  assert.ok(domElements.get('w2-native-attempt').textContent.includes('FINISHED'));
  assert.match(domElements.get('w2-native-acceptance').textContent,/task_acceptance=UNKNOWN/);
  assert.match(domElements.get('w2-native-acceptance').textContent,/Codex source_acceptance=ACCEPTED/);
  assert.match(domElements.get('w2-direct-cli').textContent,/非原生 Worker/);
  assert.match(domElements.get('w2-historical').textContent,/歷史/);
  for (const id of ['w2-native-task','w2-native-attempt','w2-native-session',
    'w2-native-acceptance','w2-direct-cli','w2-direct-delivery','w2-direct-diff','w2-direct-tests','w2-historical','w2-model-eligibility','w2-last-result'])
    assert.match(html,new RegExp(`id=["']${id}["']`),`panel contains ${id}`);
});

test('W2 source acceptance binds the exact blocked attempt, diff, result PR, and trusted checks', async () => {
  const requestId='W2_RUNTIME_REFRESH_NONMUTATION_20261029_8EE5D1135A9644F5A29D92A96F218293';
  const sourceSha='450a2f51253a4bb868d68c8c573fe2f380237974';
  const attemptId='3123a5e1-5d97-4dec-a008-a2d99c6e7e74';
  const diffSha='429c668023ca14a016023e9265d256af6f7cbe85cef18bd3b9b4b219952cbc9b';
  const goalBodySha='2f1829da0e1f5105a384be03904b2289c57c05e8a44215c4824fb6b8631d8f7b';
  const job={
    schema:6, project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE', host:'DESKTOP-1B6PD2P',
    request_id:requestId, kind:'antigravity_edit', source_sha:sourceSha,
    spec_path:'native-bridge/tasks/w2-runtime-refresh-nonmutation-contract.md',
    spec_sha256:'9ec18d8b4f8d7a84788d65233210bf51dd95a12a27da9ca361cec6609f20ae85',
    model:'gemini-3.8-flash-high', variant:'high',
    edit_paths:['tests/native-worker-opencode-cli-audit.test.mjs'],
    source_pr:625, goal_comment_id:6188322050, goal_body_sha256:goalBodySha,
  };
  const receipt={
    schema:1, project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE', host:'DESKTOP-1B6PD2P',
    request_id:requestId, attempt_id:attemptId, state:'BLOCKED', kind:'antigravity_edit',
    source_sha:sourceSha, source_pr:625,
    outcome:'ANTIGRAVITY_EDIT_TOOL_EXECUTION_FAILED_DIFF_PRESERVED',
    session_id:'24caad69-3bce-4692-94cb-60505bf37446',
    diff_sha256:diffSha, diff_bytes:9362,
    task_acceptance:'UNKNOWN', external_effects:'UNKNOWN',
  };
  const goalComments=[{id:6492466486,user:{login:'t14210184'},
    body:'PTYSD_NATIVE_JOB_V1\n'+JSON.stringify(job)}];
  const sourceBody=[
    'PTYSD_V53R4_W2_SOURCE_ACCEPTANCE_V1',
    'record_type=CODEX_SOURCE_ACCEPTANCE_WITH_WORKER_BLOCKED_TERMINAL',
    'repo=PT-Original-Point/ptysd-autonomous-factory',
    'project_id=CHATGPT_GLOBAL_SKILL_GOVERNANCE',
    'human_goal_comment_id=6188322050',
    '',
    'WORKER_EXECUTION',
    'request_id='+requestId,
    'worker_attempt_id='+attemptId,
    'worker_terminal_comment_id=6493900836',
    'worker_state=BLOCKED',
    'worker_outcome=ANTIGRAVITY_EDIT_TOOL_EXECUTION_FAILED_DIFF_PRESERVED',
    'gemini_session_id=24caad69-3bce-4692-94cb-60505bf37446',
    'model=gemini-3.8-flash-high',
    'diff_sha256='+diffSha,
    'diff_bytes=9362',
    'external_effects=UNKNOWN',
    '',
    'CODEX_SOURCE_REVIEW',
    'source_pr=625',
    'source_head='+sourceSha,
    'result_pr=629',
    'result_head=453ab048718632b1cf94ba885858b3eb272b1a84',
    'result_merge_commit=962181b54734ae3aff55a1948d21c4d734eeb7cc',
    'main_readback=962181b54734ae3aff55a1948d21c4d734eeb7cc',
    'changed_path=tests/native-worker-opencode-cli-audit.test.mjs',
    'source_test=node --test tests/native-worker-opencode-cli-audit.test.mjs:3_pass;0_fail',
    'git_diff_check=PASS',
    'exact_head_checks=check-native-only:SUCCESS;csg-trusted-verifier-hosted:SUCCESS',
    'legacy_check=csg-trusted-verifier:PENDING_ZERO_STEPS (old factory-bounded self-hosted workflow);bounded-driver-acceptance:SKIPPED',
    'source_acceptance=CODEX_ACCEPTED_AFTER_TEST_AND_EXACT_HEAD_HOSTED_VERIFIER',
    'worker_task_acceptance=UNKNOWN;external_effects=UNKNOWN',
  ].join('\n');
  const sourceComment={id:6494098118,user:{login:'t14210184'},body:sourceBody};
  const resultPull={
    number:629,state:'closed',merged:true,merged_at:'2026-10-29T10:21:22Z',
    merge_commit_sha:'962181b54734ae3aff55a1948d21c4d734eeb7cc',
    base:{ref:'main',repo:{id:1352411536,full_name:'PT-Original-Point/ptysd-autonomous-factory'}},
    head:{sha:'453ab048718632b1cf94ba885858b3eb272b1a84',
      repo:{id:1352411536,full_name:'PT-Original-Point/ptysd-autonomous-factory'}},
  };
  const trustedActionsApp={id:15368,slug:'github-actions',name:'GitHub Actions'};
  const resultChecks={check_runs:[
    {id:901,name:'check-native-only',head_sha:'453ab048718632b1cf94ba885858b3eb272b1a84',
      status:'completed',conclusion:'success',app:trustedActionsApp},
    {id:902,name:'csg-trusted-verifier-hosted',head_sha:'453ab048718632b1cf94ba885858b3eb272b1a84',
      status:'completed',conclusion:'success',app:trustedActionsApp},
  ]};
  const issueComments=[
    {id:6493900836,user:{login:'t14210184'},
      body:'PTYSD_NATIVE_RECEIPT_V1\n'+JSON.stringify(receipt)},
    sourceComment,
  ];
  const goalIdentity={id:6188322050,author:'t14210184',body_sha256:goalBodySha};
  const evidence=panel.w2EvidenceData(goalComments,issueComments,
    '962181b54734ae3aff55a1948d21c4d734eeb7cc',goalIdentity,true,true,
    {requestId,attemptId},resultPull,resultChecks);
  assert.equal(evidence.native.receiptCommentId,6493900836);
  assert.equal(evidence.native.receipt.state,'BLOCKED');
  assert.equal(evidence.native.receipt.session_id,receipt.session_id);
  assert.equal(evidence.native.receipt.task_acceptance,'UNKNOWN');
  assert.equal(evidence.native.receipt.external_effects,'UNKNOWN');
  assert.equal(evidence.native.codexAcceptance.codex_source_acceptance,'ACCEPTED');
  assert.equal(evidence.native.codexAcceptance.sourceAcceptance.diff_sha256,diffSha);
  assert.equal(evidence.native.codexAcceptance.sourceAcceptance.result_pr,629);
  assert.equal(evidence.native.codexAcceptance.sourceAcceptance.result_head,
    '453ab048718632b1cf94ba885858b3eb272b1a84');
  assert.equal(evidence.native.codexAcceptance.sourceAcceptance.merge_commit,
    '962181b54734ae3aff55a1948d21c4d734eeb7cc');
  panel.renderW2Evidence(evidence);
  assert.match(domElements.get('w2-native-attempt').textContent,/BLOCKED/);
  assert.match(domElements.get('w2-native-acceptance').textContent,/Worker task_acceptance=UNKNOWN/);
  assert.match(domElements.get('w2-native-acceptance').textContent,/結果 PR #629 MERGED/);
  assert.match(domElements.get('w2-native-acceptance').textContent,/check-native-only:SUCCESS/);
  assert.match(domElements.get('w2-native-acceptance').textContent,/csg-trusted-verifier-hosted:SUCCESS/);
  assert.match(domElements.get('w2-native-acceptance').textContent,/PENDING_ZERO_STEPS/);
  assert.match(domElements.get('w2-native-acceptance').textContent,/3_pass;0_fail/);
  assert.match(domElements.get('w2-native-acceptance').textContent,/external_effects=UNKNOWN/);

  const rejected=body => panel.w2EvidenceData(goalComments,[
    issueComments[0],{...sourceComment,body}], '962181b54734ae3aff55a1948d21c4d734eeb7cc',
    goalIdentity,true,true,{requestId,attemptId},resultPull,resultChecks).native.codexAcceptance;
  const badRecords=[
    sourceBody.replace('request_id='+requestId,'request_id=W2_OTHER_REQUEST_20261029'),
    sourceBody.replace('worker_attempt_id='+attemptId,
      'worker_attempt_id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    sourceBody.replace('source_head='+sourceSha,'source_head='+'f'.repeat(40)),
    sourceBody.replace('diff_sha256='+diffSha,'diff_sha256='+'f'.repeat(64)),
    sourceBody.replace('result_pr=629','result_pr=PR #629'),
    sourceBody.replace('result_head=453ab048718632b1cf94ba885858b3eb272b1a84',
      'result_head='+'f'.repeat(40)),
    sourceBody.replace('csg-trusted-verifier-hosted:SUCCESS',
      'csg-trusted-verifier-hosted:FAILURE'),
    sourceBody.replace('source_acceptance=CODEX_ACCEPTED_AFTER_TEST_AND_EXACT_HEAD_HOSTED_VERIFIER',
      'source_acceptance=ACCEPTED'),
    sourceBody.replace('worker_task_acceptance=UNKNOWN;external_effects=UNKNOWN',
      'worker_task_acceptance=ACCEPTED;external_effects=UNKNOWN'),
    sourceBody.replace('worker_terminal_comment_id=6493900836',
      'worker_terminal_comment_id=6493900837'),
  ];
  for (const body of badRecords)
    assert.equal(rejected(body),null,'mismatched identity, diff, result PR, CI, or acceptance is rejected');
  const wrongAuthor=panel.w2EvidenceData(goalComments,[
    issueComments[0],{...sourceComment,user:{login:'untrusted-user'}}],
    '962181b54734ae3aff55a1948d21c4d734eeb7cc',goalIdentity,true,true,
    {requestId,attemptId});
  assert.equal(wrongAuthor.native.codexAcceptance,null,
    'a non-dispatcher cannot supply Codex source acceptance');
  const wrongPrReadback=panel.w2EvidenceData(goalComments,issueComments,
    '962181b54734ae3aff55a1948d21c4d734eeb7cc',goalIdentity,true,true,
    {requestId,attemptId},{...resultPull,head:{...resultPull.head,sha:'f'.repeat(40)}},resultChecks);
  assert.equal(wrongPrReadback.native.codexAcceptance,null,
    'the result PR API head must match the accepted result head');
  const wrongMergeReadback=panel.w2EvidenceData(goalComments,issueComments,
    '962181b54734ae3aff55a1948d21c4d734eeb7cc',goalIdentity,true,true,
    {requestId,attemptId},{...resultPull,merge_commit_sha:'f'.repeat(40)},resultChecks);
  assert.equal(wrongMergeReadback.native.codexAcceptance,null,
    'the result PR API merge commit must match its source acceptance readback');
  const failedTrustedCheck=panel.w2EvidenceData(goalComments,issueComments,
    '962181b54734ae3aff55a1948d21c4d734eeb7cc',goalIdentity,true,true,
    {requestId,attemptId},resultPull,{check_runs:resultChecks.check_runs.map(run =>
      run.name === 'csg-trusted-verifier-hosted' ? {...run,conclusion:'failure'} : run)});
  assert.equal(failedTrustedCheck.native.codexAcceptance,null,
    'a failed live trusted exact-head check prevents source acceptance');
  const wrongCheckHead=panel.w2EvidenceData(goalComments,issueComments,
    '962181b54734ae3aff55a1948d21c4d734eeb7cc',goalIdentity,true,true,
    {requestId,attemptId},resultPull,{check_runs:resultChecks.check_runs.map(run =>
      ({...run,head_sha:'f'.repeat(40)}))});
  assert.equal(wrongCheckHead.native.codexAcceptance,null,
    'checks from any other SHA are not reused');

  const humanGoal={id:6188322050,user:{login:'t14210184'},issue_url:apiRoot+'/issues/310',
    body:'<!-- PTYSD_V53R4_DELETE_FIRST_AUTONOMY_GOAL_20261015 -->\nBounded Human construction authority.'};
  const verifiedGoal=await panel.hashHumanGoalComment(humanGoal);
  const cycleJob={...job,goal_body_sha256:verifiedGoal.body_sha256};
  const goalUrl=apiRoot+'/issues/310/comments?per_page=100&sort=created&direction=desc';
  const cycleGoalComments=[
    humanGoal,
    {id:6492466486,user:{login:'t14210184'},
      body:'PTYSD_NATIVE_JOB_V1\n'+JSON.stringify(cycleJob)},
  ];
  const cycleIssueComments=[
    ...observationComments(baseTime,{latestTask:false}),
    issueComments[0],sourceComment,
  ];
  const calls=[];
  const resultChecksUrl=apiRoot+'/commits/453ab048718632b1cf94ba885858b3eb272b1a84/check-runs?per_page=100';
  const client=panel.createApiClient(async url=>{
    calls.push(url);
    if (url===urls.issue) return response(200,cycleIssueComments,quotaHeaders(baseTime));
    if (url===goalUrl) return response(200,cycleGoalComments,quotaHeaders(baseTime));
    if (url===urls.main) return response(200,{sha:'962181b54734ae3aff55a1948d21c4d734eeb7cc'},quotaHeaders(baseTime));
    if (url===apiRoot+'/pulls/629') return response(200,resultPull,quotaHeaders(baseTime));
    if (url===resultChecksUrl) return response(200,resultChecks,quotaHeaders(baseTime));
    throw new Error('unexpected API URL: '+url);
  },{now:()=>baseTime});
  const store=panel.createResourceStore(client,()=>baseTime);
  await panel.runSyncCycle(store,client,{...urls,goal:goalUrl});
  assert.ok(calls.includes(apiRoot+'/pulls/629'),
    'the existing GitHub API client reads the exact result PR named by the bound acceptance');
  assert.equal(store.resources.w2ResultPr.url,apiRoot+'/pulls/629');
  assert.equal(store.resources.w2ResultPr.data.number,629);
  assert.ok(calls.includes(resultChecksUrl),
    'the panel independently reads check runs for the result PR exact HEAD');
  assert.equal(store.resources.w2ResultChecks.url,resultChecksUrl);
  const cycleEvidence=panel.w2EvidenceData(cycleGoalComments,cycleIssueComments,
    '962181b54734ae3aff55a1948d21c4d734eeb7cc',verifiedGoal,true,true,
    {requestId,attemptId},store.resources.w2ResultPr.data,store.resources.w2ResultChecks.data);
  assert.equal(cycleEvidence.native.codexAcceptance.sourceAcceptance.result_pr,629);
});

test('W2 additive FINISHED acceptance supports the canonical fields and reads an open result PR exact HEAD', async () => {
  const requestId='W2_PANEL_QUEUE_TERMINAL_ELIGIBILITY_20261030_A4BAE486B75D4B6BAEB87B6F74652754';
  const sourceSha='cf1d8c636dba20bbd368f234342654a8db954814';
  const attemptId='f0766d35-15b9-4f2b-b0f4-2c63ba643ed8';
  const sessionId='68eedbf7-4342-4ce1-b0fe-21cde61f2802';
  const diffSha='7c1d7fa00be818d23f7cda72fb4d079f844cc1311144fb13fc8c20eb335d3030';
  const goalBodySha='2f1829da0e1f5105a384be03904b2289c57c05e8a44215c4824fb6b8631d8f7b';
  const resultHead='c'.repeat(40);
  const resultBaseSha='b'.repeat(40);
  const resultPrNumber=645;
  const editPaths=['operator-panel/index.html','tests/operator-panel-api.test.mjs'];
  const job={
    schema:6, project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE', host:'DESKTOP-1B6PD2P',
    request_id:requestId, kind:'antigravity_edit', source_sha:sourceSha,
    spec_path:'native-bridge/tasks/w2-panel-current-queue-terminal-eligibility.md',
    spec_sha256:'ef47124e43ecd5eccdd587d1a6f2fc2078412c6c87fb244c8c3706d565875850',
    model:'gemini-3.8-flash-high', variant:'high', edit_paths:editPaths, source_pr:644,
    goal_comment_id:6188322050, goal_body_sha256:goalBodySha,
  };
  const receipt={
    schema:1, project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE', host:'DESKTOP-1B6PD2P',
    request_id:requestId, attempt_id:attemptId, state:'FINISHED', kind:'antigravity_edit',
    source_sha:sourceSha, source_pr:644,
    outcome:'ANTIGRAVITY_EDIT_DIFF_CAPTURED_UNVERIFIED_FILE_TOOL_FAILURES_RETAINED',
    session_id:sessionId, diff_sha256:diffSha, diff_bytes:30841,
    task_acceptance:'UNKNOWN', external_effects:'UNKNOWN',
  };
  const goalComments=[
    {id:6188322050,user:{login:'t14210184'},issue_url:apiRoot+'/issues/310',
      body:'Human authorized bounded pre-Production construction.'},
    {id:6505121134,user:{login:'t14210184'},body:'PTYSD_NATIVE_JOB_V1\n'+JSON.stringify(job)},
  ];
  const sourceBody=[
    'PTYSD_V53R4_W2_SOURCE_ACCEPTANCE_V1',
    'record_type=ADDITIVE_CODEX_SOURCE_ACCEPTANCE_NOT_MERGE_OR_RUNTIME_ACCEPTANCE',
    'repo=PT-Original-Point/ptysd-autonomous-factory',
    'project_id=CHATGPT_GLOBAL_SKILL_GOVERNANCE',
    'human_goal_comment_id=6188322050',
    'goal_body_sha256='+goalBodySha,
    'prestate_latest_issue407_comment=6505800965',
    'request_id='+requestId,
    'attempt_id='+attemptId,
    'terminal_receipt_comment_id=6505800965',
    'worker_state=FINISHED',
    'worker_outcome='+receipt.outcome,
    'model=gemini-3.8-flash-high;variant=high;cli_version=1.4.10',
    'session_id='+sessionId,
    'worker_diff_sha256='+diffSha,
    'worker_diff_bytes=30841',
    'worker_task_acceptance=UNKNOWN',
    'external_effects=UNKNOWN',
    'task_source_pr=644',
    'task_source_head='+sourceSha,
    'result_pr='+resultPrNumber,
    'result_head='+resultHead,
    'result_base_sha='+resultBaseSha,
    'changed_paths='+editPaths.join(','),
    'git_diff_check=PASS',
    "focused_test=node --test --test-name-pattern='W2 panel acceptance parser' tests/operator-panel-api.test.mjs:1_pass;0_fail",
    'exact_head_ci=SUCCESS_REQUIRED_TRUSTED_CHECKS',
    'checks=check-native-only:SUCCESS(run_40904904767);csg-trusted-verifier-hosted:SUCCESS(run_40904904738);v2-native-windows:SUCCESS(run_40904904801)',
    'legacy_check=csg-trusted-verifier:PENDING_NOT_COUNTED_AS_PASS',
    'codex_source_acceptance=ACCEPTED_FOR_PR_HEAD_ONLY',
    'merge=NOT_PERFORMED',
    'runtime_deployment=NOT_PERFORMED',
  ].join('\n');
  const sourceComment={id:6506000001,user:{login:'t14210184'},body:sourceBody};
  const resultPull={
    number:resultPrNumber,state:'open',merged:false,merged_at:null,merge_commit_sha:null,
    base:{ref:'main',sha:resultBaseSha,
      repo:{id:1352411536,full_name:'PT-Original-Point/ptysd-autonomous-factory'}},
    head:{sha:resultHead,
      repo:{id:1352411536,full_name:'PT-Original-Point/ptysd-autonomous-factory'}},
  };
  const trustedActionsApp={id:15368,slug:'github-actions',name:'GitHub Actions'};
  const resultChecks={check_runs:[
    {id:40904904767,name:'check-native-only',head_sha:resultHead,status:'completed',conclusion:'success',app:trustedActionsApp},
    {id:40904904738,name:'csg-trusted-verifier-hosted',head_sha:resultHead,status:'completed',conclusion:'success',app:trustedActionsApp},
  ]};
  const issueComments=[
    {id:6505800965,user:{login:'t14210184'},body:'PTYSD_NATIVE_RECEIPT_V1\n'+JSON.stringify(receipt)},
    sourceComment,
  ];
  const goalIdentity={id:6188322050,author:'t14210184',body_sha256:goalBodySha};
  const evidence=panel.w2EvidenceData(goalComments,issueComments,head,goalIdentity,true,true,
    {requestId,attemptId},resultPull,resultChecks);
  assert.equal(evidence.native.receipt.state,'FINISHED');
  assert.equal(evidence.native.receipt.session_id,sessionId);
  assert.equal(evidence.native.receipt.task_acceptance,'UNKNOWN');
  assert.equal(evidence.native.receipt.external_effects,'UNKNOWN');
  assert.equal(evidence.native.codexAcceptance.codex_source_acceptance,'ACCEPTED');
  assert.equal(evidence.native.codexAcceptance.sourceAcceptance.result_pr,resultPrNumber);
  assert.equal(evidence.native.codexAcceptance.sourceAcceptance.result_head,resultHead);
  assert.equal(evidence.native.codexAcceptance.sourceAcceptance.result_pr_state,'OPEN_HEAD_ONLY');
  panel.renderW2Evidence(evidence);
  assert.match(domElements.get('w2-native-acceptance').textContent,/結果 PR #645 OPEN_HEAD_ONLY/);
  assert.match(domElements.get('w2-native-acceptance').textContent,/Worker task_acceptance=UNKNOWN/);
  assert.match(domElements.get('w2-native-acceptance').textContent,/external_effects=UNKNOWN/);

  const mergedAfterHead=panel.w2EvidenceData(goalComments,issueComments,'e'.repeat(40),goalIdentity,true,true,
    {requestId,attemptId},{...resultPull,state:'closed',merged:true,merged_at:'2026-10-30T03:30:00Z',
      merge_commit_sha:'d'.repeat(40)},resultChecks);
  assert.equal(mergedAfterHead.native.codexAcceptance.sourceAcceptance.result_pr_state,
    'MERGED_AFTER_HEAD_ACCEPTANCE');
  assert.equal(mergedAfterHead.native.codexAcceptance.sourceAcceptance.merge_commit,'d'.repeat(40));
  assert.equal(mergedAfterHead.native.codexAcceptance.sourceAcceptance.main_readback,null,
    'a PR merge commit is not presented as a current main ref readback');

  const wrongCheckApp=panel.w2EvidenceData(goalComments,issueComments,head,goalIdentity,true,true,
    {requestId,attemptId},resultPull,{check_runs:resultChecks.check_runs.map(run=>
      run.name==='csg-trusted-verifier-hosted'
        ? {...run,app:{id:999999,slug:'untrusted-app',name:'Untrusted App'}} : run)});
  assert.equal(wrongCheckApp.native.codexAcceptance,null,
    'a same-named successful check from a different GitHub App cannot satisfy trusted CI');

  const rejected=body=>panel.w2EvidenceData(goalComments,[issueComments[0],
    {...sourceComment,body}],head,goalIdentity,true,true,{requestId,attemptId},resultPull,resultChecks)
    .native.codexAcceptance;
  const badRecords=[
    sourceBody.replace('request_id='+requestId,'request_id=W2_OTHER_REQUEST_20261030'),
    sourceBody.replace('attempt_id='+attemptId,'attempt_id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    sourceBody.replace('task_source_head='+sourceSha,'task_source_head='+'f'.repeat(40)),
    sourceBody.replace('worker_diff_sha256='+diffSha,'worker_diff_sha256='+'f'.repeat(64)),
    sourceBody.replace('result_pr=645','result_pr=PR #645'),
    sourceBody.replace('result_head='+resultHead,'result_head='+'f'.repeat(40)),
    sourceBody.replace('checks=check-native-only:SUCCESS','checks=check-native-only:FAILURE'),
    sourceBody.replace('codex_source_acceptance=ACCEPTED_FOR_PR_HEAD_ONLY','codex_source_acceptance=ACCEPTED'),
    sourceBody.replace('worker_task_acceptance=UNKNOWN','worker_task_acceptance=ACCEPTED'),
    sourceBody.replace('terminal_receipt_comment_id=6505800965','terminal_receipt_comment_id=6505800966'),
    sourceBody.replace('changed_paths='+editPaths.join(','),'changed_paths=outside/scope.mjs'),
    sourceBody.replace('0_fail','1_fail'),
  ];
  for(const body of badRecords)
    assert.equal(rejected(body),null,'wrong request, attempt, SHA, diff, PR, checks, acceptance, receipt, scope or tests are rejected');
  assert.equal(panel.w2EvidenceData(goalComments,[issueComments[0],
    {...sourceComment,user:{login:'untrusted-user'}}],head,goalIdentity,true,true,
    {requestId,attemptId},resultPull,resultChecks).native.codexAcceptance,null,
  'only a dispatcher-authored source acceptance is eligible');
  assert.equal(panel.w2EvidenceData(goalComments,issueComments,head,goalIdentity,true,true,
    {requestId,attemptId},{...resultPull,head:{...resultPull.head,sha:'f'.repeat(40)}},resultChecks)
    .native.codexAcceptance,null,'the live result PR HEAD must match the accepted HEAD');
  assert.equal(panel.w2EvidenceData(goalComments,issueComments,head,goalIdentity,true,true,
    {requestId,attemptId},resultPull,{check_runs:resultChecks.check_runs.map(run=>
      ({...run,head_sha:'f'.repeat(40)}))}).native.codexAcceptance,null,
  'checks from a different HEAD cannot satisfy acceptance');

  const humanGoal={id:6188322050,user:{login:'t14210184'},issue_url:apiRoot+'/issues/310',
    body:'<!-- PTYSD_V53R4_DELETE_FIRST_AUTONOMY_GOAL_20261015 -->\nBounded Human construction authority.'};
  const verifiedGoal=await panel.hashHumanGoalComment(humanGoal);
  const cycleJob={...job,goal_body_sha256:verifiedGoal.body_sha256};
  const cycleSourceComment={...sourceComment,
    body:sourceBody.replace('goal_body_sha256='+goalBodySha,
      'goal_body_sha256='+verifiedGoal.body_sha256)};
  const goalUrl=apiRoot+'/issues/310/comments?per_page=100&sort=created&direction=desc';
  const cycleGoalComments=[humanGoal,{id:6505121134,user:{login:'t14210184'},
    body:'PTYSD_NATIVE_JOB_V1\n'+JSON.stringify(cycleJob)}];
  const cycleIssueComments=[...observationComments(baseTime,{latestTask:false}),issueComments[0],cycleSourceComment];
  const calls=[];
  const resultChecksUrl=apiRoot+'/commits/'+resultHead+'/check-runs?per_page=100';
  const client=panel.createApiClient(async url=>{
    calls.push(url);
    if(url===urls.issue)return response(200,cycleIssueComments,quotaHeaders(baseTime));
    if(url===goalUrl)return response(200,cycleGoalComments,quotaHeaders(baseTime));
    if(url===urls.main)return response(200,{sha:head},quotaHeaders(baseTime));
    if(url===apiRoot+'/pulls/'+resultPrNumber)return response(200,resultPull,quotaHeaders(baseTime));
    if(url===resultChecksUrl)return response(200,resultChecks,quotaHeaders(baseTime));
    throw new Error('unexpected API URL: '+url);
  },{now:()=>baseTime});
  const store=panel.createResourceStore(client,()=>baseTime);
  await panel.runSyncCycle(store,client,{...urls,goal:goalUrl});
  assert.ok(calls.includes(apiRoot+'/pulls/'+resultPrNumber),
    'the panel reads the result PR identified by the exact source acceptance');
  assert.ok(calls.includes(resultChecksUrl),
    'the panel reads trusted check-runs at an open result PR exact HEAD');
  assert.equal(store.resources.w2ResultChecks.url,resultChecksUrl);
});

test('a direct Antigravity CLI session alone never appears as a schema-6 native W2 task', () => {
  const comment = { id:6438594849, user:{login:'t14210184'}, created_at:'2026-10-27T09:45:07Z',
    body:['record_type=ADDITIVE_CONTROLLER_READBACK_NOT_NATIVE_WORKER_RECEIPT',
      'native_worker_job=NOT_CREATED','native_worker_attempt=NOT_CREATED',
      'Model=gemini-3.8-flash-high; session_id=be190416-e85f-4f68-b33a-5d05f54d7072; status=SUCCESS;',
      'PR #576; external_effects remains UNKNOWN.'].join('\n') };
  const evidence=panel.w2EvidenceData([], [comment], head);
  assert.equal(evidence.native.job,null);
  assert.equal(evidence.native.receipt,null);
  assert.equal(evidence.directCli.session_id,'be190416-e85f-4f68-b33a-5d05f54d7072');
  assert.equal(evidence.directCli.provenance,'DIRECT_CLI_NOT_NATIVE_WORKER');
});

test('mobile overview keeps its GitHub state badge within the card', () => {
  const start = html.indexOf('@media (max-width:700px)');
  const end = html.indexOf('@media (max-width:440px)', start);
  assert.ok(start >= 0 && end > start, 'mobile layout rules are present');
  const mobileCss = html.slice(start, end);
  assert.match(mobileCss, /\.overview-head\s*\{[^}]*flex-direction:\s*column/);
  assert.match(mobileCss, /\.overview-copy\s*\{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(mobileCss,
    /\.overview-head\s*>\s*\.badge\s*\{[^}]*max-width:\s*100%[^}]*white-space:\s*normal[^}]*overflow-wrap:\s*anywhere/);
});

test('mobile section heading stacks its supporting text for readable width', () => {
  const start = html.indexOf('@media (max-width:700px)');
  const end = html.indexOf('@media (max-width:440px)', start);
  assert.ok(start >= 0 && end > start, 'mobile layout rules are present');
  const mobileCss = html.slice(start, end);
  assert.match(mobileCss, /\.section\s*\{[^}]*flex-direction:\s*column[^}]*align-items:\s*flex-start/);
  assert.match(mobileCss, /\.section\s+h2\s*,\s*\.section\s+p\s*\{[^}]*margin:\s*0/);
});

test('operator panel documentation binds live PR data to task evidence, not a fixed historical PR', () => {
  const readme = readFileSync(new URL('../operator-panel/README.md', import.meta.url), 'utf8')
    .replace(/\s+/g, ' ');
  assert.doesNotMatch(readme, /live PR #419 metadata/i);
  assert.doesNotMatch(readme, /normal one-page budget is about 21 requests per hour/i);
  assert.match(readme, /task PR number is not hard-coded/i);
  assert.match(readme, /one-time W2 direct CLI lineage.*historical PR identities/i);
  assert.match(readme, /task source PRs.*fresh Issue #407 native Worker observation.*Issue #310 schema-6 dispatch/i);
  assert.match(readme, /runtime deployment PR.*observation provenance.*displayed separately from.*task source PR/i);
  assert.match(readme, /Issue #407 and #310.*every 5 minutes/);
  assert.match(readme, /pagination and separate per-worker source PR reads add requests/i);
  assert.match(readme, /W2.*native.*direct CLI.*separate/i);
});

test('W2 regression: new queued request alongside previous terminal result, request without receipt, and terminal acceptance preservation', () => {
  const goalBodySha = '2f1829da0e1f5105a384be03904b2289c57c05e8a44215c4824fb6b8631d8f7b';
  const goalIdentity = { id:6188322050, author:'t14210184', body_sha256:goalBodySha };
  const oldJob = {
    schema:6, project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE', host:'DESKTOP-1B6PD2P',
    request_id:'W2_OLD_REQUEST_20261028_A1B2C3D4', kind:'antigravity_edit',
    source_sha:'a'.repeat(40), spec_path:'native-bridge/tasks/w2-r7-panel-evidence.md',
    spec_sha256:'c'.repeat(64), model:'gemini-3.8-flash-high', variant:'high',
    edit_paths:['operator-panel/index.html'], source_pr:579,
    goal_comment_id:6188322050, goal_body_sha256:goalBodySha,
  };
  const oldReceipt = {
    schema:1, project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE', host:'DESKTOP-1B6PD2P',
    request_id:'W2_OLD_REQUEST_20261028_A1B2C3D4', attempt_id:'11111111-1111-4111-8111-111111111111',
    state:'FINISHED', outcome:'COMPLETED', kind:'antigravity_edit',
    source_sha:'a'.repeat(40), source_pr:579, session_id:'22222222-2222-4222-8222-222222222222',
    task_acceptance:'UNKNOWN', external_effects:'UNKNOWN',
  };
  const newJob = {
    schema:6, project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE', host:'DESKTOP-1B6PD2P',
    request_id:'W2_NEW_REQUEST_20261029_B2C3D4E5', kind:'antigravity_edit',
    source_sha:'b'.repeat(40), spec_path:'native-bridge/tasks/w2-r7-panel-evidence.md',
    spec_sha256:'c'.repeat(64), model:'gemini-3.8-flash-high', variant:'high',
    edit_paths:['operator-panel/index.html'], source_pr:580,
    goal_comment_id:6188322050, goal_body_sha256:goalBodySha,
  };

  const goalComments = [
    { id:6490000001, user:{login:'t14210184'}, body:'PTYSD_NATIVE_JOB_V1\n'+JSON.stringify(oldJob) },
    { id:6490000010, user:{login:'t14210184'}, body:'PTYSD_NATIVE_JOB_V1\n'+JSON.stringify(newJob) },
  ];
  const issueComments = [
    { id:6490000002, user:{login:'t14210184'}, body:'PTYSD_NATIVE_RECEIPT_V1\n'+JSON.stringify(oldReceipt) },
  ];

  const evidence = panel.w2EvidenceData(goalComments, issueComments, 'b'.repeat(40), goalIdentity, true, true);
  assert.equal(evidence.native.job.request_id, 'W2_NEW_REQUEST_20261029_B2C3D4E5');
  assert.equal(evidence.native.receipt, null);
  assert.equal(evidence.native.receiptResolution, 'NO_MATCHING_RECEIPT');
  assert.ok(evidence.native.lastTerminal?.receipt);
  assert.equal(evidence.native.lastTerminal.receipt.job.request_id, 'W2_OLD_REQUEST_20261028_A1B2C3D4');
  assert.equal(evidence.native.lastTerminal.receipt.attempt_id, '11111111-1111-4111-8111-111111111111');
  assert.equal(evidence.native.lastTerminal.receipt.task_acceptance, 'UNKNOWN');
  assert.equal(evidence.native.lastTerminal.receipt.external_effects, 'UNKNOWN');

  panel.renderW2Evidence(evidence);
  assert.ok(domElements.get('w2-native-task').textContent.includes('W2_NEW_REQUEST_20261029_B2C3D4E5'));
  assert.match(domElements.get('w2-native-attempt').textContent, /已觀測到正式請求；尚未觀測到 Worker 收據（request observed; Worker receipt not observed）/);
  assert.match(domElements.get('w2-native-session').textContent, /最新請求尚未讀回工作階段（Session UNKNOWN）/);
  assert.match(domElements.get('w2-native-acceptance').textContent, /最新請求尚未讀回 Worker 收據；Worker 終態與驗收 UNKNOWN/);
  assert.match(domElements.get('w2-last-result').textContent, /最近終態收據：W2_OLD_REQUEST_20261028_A1B2C3D4 · 批次 11111111-1111-4111-8111-111111111111 · FINISHED（生命週期結束；非驗收） · COMPLETED · Worker task_acceptance=UNKNOWN · external_effects=UNKNOWN/);

  const finishedLatest = panel.w2EvidenceData([goalComments[0]], issueComments, 'a'.repeat(40), goalIdentity, true, true);
  assert.equal(finishedLatest.native.receipt.state, 'FINISHED');
  assert.equal(finishedLatest.native.receipt.task_acceptance, 'UNKNOWN');
  assert.equal(finishedLatest.native.receipt.external_effects, 'UNKNOWN');
  panel.renderW2Evidence(finishedLatest);
  assert.match(domElements.get('w2-native-attempt').textContent, /批次 11111111-1111-4111-8111-111111111111 · FINISHED（生命週期結束；非驗收）/);
  assert.match(domElements.get('w2-native-acceptance').textContent, /Worker task_acceptance=UNKNOWN · external_effects=UNKNOWN/);
  assert.match(domElements.get('w2-last-result').textContent, /最近終態收據：W2_OLD_REQUEST_20261028_A1B2C3D4/);
});

test('W2 regression: fresh explicit idle evidence vs absent idle evidence and empty queue claims', () => {
  const now = baseTime;
  const freshIdle = {
    worker_id:'W2', status:'IDLE', activity_observed_at:new Date(now).toISOString(),
    evidence_ref:'snap-w2-idle-1', evidence_kind:'NO_ACTIVE_WORK',
  };
  const verifiedIdle = panel.classifyWorker(freshIdle, 'FRESH', now);
  assert.equal(verifiedIdle.status, 'IDLE');
  assert.match(verifiedIdle.reason, /新鮮來源同時證實沒有待處理任務及活動程序/);

  const freshIdleAlt = { ...freshIdle, evidence_kind:'NO_PENDING_TASKS_AND_NO_ACTIVE_PROCESS' };
  assert.equal(panel.classifyWorker(freshIdleAlt, 'FRESH', now).status, 'IDLE');

  const unsupportedKind = { ...freshIdle, evidence_kind:'IDLE_ASSUMED_NO_TASK_ROW' };
  assert.equal(panel.classifyWorker(unsupportedKind, 'FRESH', now).status, 'UNKNOWN');

  const missingRef = { ...freshIdle, evidence_ref:null };
  assert.equal(panel.classifyWorker(missingRef, 'FRESH', now).status, 'UNKNOWN');

  assert.equal(panel.classifyWorker(null, 'FRESH', now).status, 'UNKNOWN');
  assert.equal(panel.classifyWorker(freshIdle, 'STALE', now).status, 'STALE');
  assert.equal(panel.classifyWorker(freshIdle, 'UNKNOWN', now).status, 'UNKNOWN');

  const emptyGoalEvidence = panel.w2EvidenceData([], [], head, null, true, true);
  panel.renderW2Evidence(emptyGoalEvidence);
  assert.equal(domElements.get('w2-native-task').textContent, '未觀測到正式 schema-6 W2 請求（不代表原生佇列為空或無 READY Goal 工作）');
  assert.equal(domElements.get('w2-native-attempt').textContent, '尚無相符原生收據批次');
  assert.equal(domElements.get('w2-last-result').textContent, '尚無已確認的終態收據');
});

test('W2 regression: model eligibility is separated from execution switch with WAITING as waiting state', () => {
  const job = {
    request_id:'W2_ELIGIBILITY_TEST_20261029', source_sha:'c'.repeat(40), source_pr:601,
  };
  const enabledRecord = {
    worker_id:'W2', task_id:job.request_id, task_source_sha:job.source_sha, source_pr:job.source_pr,
    model_execution_switch:'ENABLED', model_eligibility:'WAITING',
  };
  const disabledRecord = { ...enabledRecord, model_execution_switch:'DISABLED' };

  assert.equal(panel.modelExecutionSwitchLabel('W2', enabledRecord), '模型執行開關：啟用；不代表本次已派工或模型資格可用');
  assert.equal(panel.modelExecutionSwitchLabel('W2', disabledRecord), '模型執行開關：停用；目前不派發新的模型工作');

  const enabledWaiting = panel.w2ModelEligibility(enabledRecord, 'FRESH', job, true);
  assert.equal(enabledWaiting, 'WAITING');
  assert.equal(panel.w2ModelEligibilityLabel(enabledWaiting), '模型執行資格：WAITING；等待狀態，非資格核准');

  const disabledWaiting = panel.w2ModelEligibility(disabledRecord, 'FRESH', job, true);
  assert.equal(disabledWaiting, 'WAITING');
  assert.equal(panel.w2ModelEligibilityLabel(disabledWaiting), '模型執行資格：WAITING；等待狀態，非資格核准');

  assert.equal(panel.w2ModelEligibilityLabel('READY'), '模型執行資格：READY；Win11 觀測明示資格就緒');
  assert.equal(panel.w2ModelEligibilityLabel('ELIGIBLE'), '模型執行資格：ELIGIBLE；Win11 觀測明示符合資格');
  assert.equal(panel.w2ModelEligibilityLabel('INELIGIBLE'), '模型執行資格：INELIGIBLE；目前不具備執行資格');

  assert.equal(panel.w2ModelEligibility({ ...enabledRecord, model_eligibility:null }, 'FRESH', job, true), 'UNKNOWN');
  assert.equal(panel.w2ModelEligibility({ ...enabledRecord, model_eligibility:'UNKNOWN' }, 'FRESH', job, true), 'UNKNOWN');
  assert.equal(panel.w2ModelEligibility({ ...enabledRecord, model_eligibility:'AUTO_READY' }, 'FRESH', job, true), 'UNKNOWN');
  assert.equal(panel.w2ModelEligibility(enabledRecord, 'STALE', job, true), 'UNKNOWN');
  assert.equal(panel.w2ModelEligibility(enabledRecord, 'UNKNOWN', job, true), 'UNKNOWN');
  assert.equal(panel.w2ModelEligibilityLabel('UNKNOWN'), '模型執行資格：UNKNOWN');

  const switchOnly = { model_execution_switch:'ENABLED' };
  assert.equal(panel.w2ModelEligibility(switchOnly, 'FRESH', job, true), 'UNKNOWN');
});

test('W2 regression: incomplete sources, identity mismatches, unbound multiple attempts, and cross-lane preservation', () => {
  const goalBodySha = '2f1829da0e1f5105a384be03904b2289c57c05e8a44215c4824fb6b8631d8f7b';
  const goalIdentity = { id:6188322050, author:'t14210184', body_sha256:goalBodySha };
  const job = {
    schema:6, project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE', host:'DESKTOP-1B6PD2P',
    request_id:'W2_IDENTITY_TEST_20261029', kind:'antigravity_edit', source_sha:'d'.repeat(40),
    spec_path:'native-bridge/tasks/w2-r7-panel-evidence.md', spec_sha256:'c'.repeat(64),
    model:'gemini-3.8-flash-high', variant:'high', edit_paths:['operator-panel/index.html'],
    source_pr:602, goal_comment_id:6188322050, goal_body_sha256:goalBodySha,
  };
  const goalComments = [{ id:6490000020, user:{login:'t14210184'}, body:'PTYSD_NATIVE_JOB_V1\n'+JSON.stringify(job) }];

  const wrongGoalIdentity = panel.w2EvidenceData(goalComments, [], 'd'.repeat(40),
    { ...goalIdentity, body_sha256:'f'.repeat(64) }, true, true);
  assert.equal(wrongGoalIdentity.native.goalReferenceVerified, false);
  assert.equal(wrongGoalIdentity.native.receiptResolution, 'GOAL_REFERENCE_UNVERIFIED');
  assert.equal(wrongGoalIdentity.native.lastTerminal.status, 'GOAL_REFERENCE_UNVERIFIED');
  panel.renderW2Evidence(wrongGoalIdentity);
  assert.match(domElements.get('w2-native-task').textContent, /GOAL 未核對；任務身分 UNKNOWN/);
  assert.match(domElements.get('w2-native-attempt').textContent, /attempt 狀態 UNKNOWN/);
  assert.match(domElements.get('w2-native-session').textContent, /Session UNKNOWN/);
  assert.match(domElements.get('w2-native-acceptance').textContent, /Worker 終態與 Codex source acceptance UNKNOWN/);
  assert.match(domElements.get('w2-last-result').textContent, /UNKNOWN：Human GOAL 身分／雜湊未核對/);

  const incompleteGoal = panel.w2EvidenceData(goalComments, [], 'd'.repeat(40), goalIdentity, false, true);
  assert.equal(incompleteGoal.native.sourceComplete, false);
  assert.equal(incompleteGoal.native.receiptResolution, 'GOAL_SOURCE_INCOMPLETE');
  panel.renderW2Evidence(incompleteGoal);
  assert.match(domElements.get('w2-native-task').textContent, /Issue #310 最新評論分頁未核對；schema-6 派工狀態未知/);
  assert.match(domElements.get('w2-last-result').textContent, /UNKNOWN：來源資料未完整讀回/);

  const incompleteIssue = panel.w2EvidenceData(goalComments, [], 'd'.repeat(40), goalIdentity, true, false);
  assert.equal(incompleteIssue.native.issueSourceComplete, false);
  assert.equal(incompleteIssue.native.receiptResolution, 'ISSUE_SOURCE_INCOMPLETE');
  panel.renderW2Evidence(incompleteIssue);
  assert.match(domElements.get('w2-native-attempt').textContent, /Issue #407 最新／相符收據分頁未核對；attempt 狀態未知/);
  assert.match(domElements.get('w2-last-result').textContent, /UNKNOWN：來源資料未完整讀回/);

  const wrongRequestReceipt = {
    schema:1, project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE', host:'DESKTOP-1B6PD2P',
    request_id:'W2_OTHER_REQUEST_20261029', attempt_id:'33333333-3333-4333-8333-333333333333',
    state:'FINISHED', kind:'antigravity_edit', source_sha:'d'.repeat(40), source_pr:602,
  };
  const wrongSourceReceipt = { ...wrongRequestReceipt, request_id:job.request_id, source_sha:'e'.repeat(40) };
  const wrongPrReceipt = { ...wrongRequestReceipt, request_id:job.request_id, source_pr:999 };
  const mismatchEvidence = panel.w2EvidenceData(goalComments, [
    { id:6490000021, user:{login:'t14210184'}, body:'PTYSD_NATIVE_RECEIPT_V1\n'+JSON.stringify(wrongRequestReceipt) },
    { id:6490000022, user:{login:'t14210184'}, body:'PTYSD_NATIVE_RECEIPT_V1\n'+JSON.stringify(wrongSourceReceipt) },
    { id:6490000023, user:{login:'t14210184'}, body:'PTYSD_NATIVE_RECEIPT_V1\n'+JSON.stringify(wrongPrReceipt) },
  ], 'd'.repeat(40), goalIdentity, true, true);
  assert.equal(mismatchEvidence.native.receipt, null);
  assert.equal(mismatchEvidence.native.receiptResolution, 'NO_MATCHING_RECEIPT');

  const wrongRecord = {
    worker_id:'W2', task_id:'W2_OTHER_REQUEST', task_source_sha:job.source_sha, source_pr:job.source_pr,
    model_eligibility:'READY',
  };
  assert.equal(panel.w2ModelEligibility(wrongRecord, 'FRESH', job, true), 'UNKNOWN');
  const malformedSourcePr = {
    worker_id:'W2', task_id:job.request_id, task_source_sha:job.source_sha,
    source_pr:String(job.source_pr), model_eligibility:'READY',
  };
  assert.equal(panel.w2ModelEligibility(malformedSourcePr, 'FRESH', job, true), 'UNKNOWN');

  const receiptAttempt1 = {
    schema:1, project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE', host:'DESKTOP-1B6PD2P',
    request_id:job.request_id, attempt_id:'44444444-4444-4444-8444-444444444444',
    state:'FINISHED', kind:'antigravity_edit', source_sha:job.source_sha, source_pr:job.source_pr,
  };
  const receiptAttempt2 = { ...receiptAttempt1, attempt_id:'55555555-5555-4555-8555-555555555555' };
  const unboundEvidence = panel.w2EvidenceData(goalComments, [
    { id:6490000031, user:{login:'t14210184'}, body:'PTYSD_NATIVE_RECEIPT_V1\n'+JSON.stringify(receiptAttempt1) },
    { id:6490000032, user:{login:'t14210184'}, body:'PTYSD_NATIVE_RECEIPT_V1\n'+JSON.stringify(receiptAttempt2) },
  ], 'd'.repeat(40), goalIdentity, true, true);
  assert.equal(unboundEvidence.native.receiptResolution, 'MULTIPLE_ATTEMPTS_UNBOUND');
  assert.equal(unboundEvidence.native.receipt, null);
  panel.renderW2Evidence(unboundEvidence);
  assert.match(domElements.get('w2-native-attempt').textContent, /同一 request 有多個 attempt；尚無精確 attempt 綁定，未自動挑選/);
  assert.match(domElements.get('w2-native-session').textContent, /多個 attempt 未唯一綁定；Session UNKNOWN/);
  assert.match(domElements.get('w2-native-acceptance').textContent, /多個 attempt 未唯一綁定；Worker 終態與 Codex source acceptance 保留 UNKNOWN/);
  assert.match(domElements.get('w2-last-result').textContent, /UNKNOWN：同一 request 有多個 attempt 未安全綁定/);

  const w1Record = { worker_id:'W1', configured:false, model_execution_switch:'DISABLED' };
  const w1Card = panel.workerCardData('W1', w1Record, { status:'UNCONFIGURED', reason:'未配置' }, {});
  assert.equal(w1Card.prefix, 'w1');
  assert.equal(panel.modelExecutionSwitchLabel('W1', w1Record), '模型執行開關：停用；目前不派發新的模型工作');

  const w3Record = { worker_id:'W3', status:'PENDING', task_id:'W3_TASK', task_source:'https://github.com' };
  const w3Card = panel.workerCardData('W3', w3Record, { status:'PENDING', reason:'等候' }, {});
  assert.equal(w3Card.prefix, 'w3');
  assert.equal(panel.modelExecutionSwitchLabel('W3', w3Record), null);

  assert.equal(unboundEvidence.directCli, null);
  assert.equal(unboundEvidence.historical, null);

});
