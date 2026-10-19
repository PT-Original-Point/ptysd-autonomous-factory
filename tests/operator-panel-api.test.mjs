import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../operator-panel/index.html', import.meta.url), 'utf8');
const inlineScript = html.match(/<script>\s*([\s\S]*?)<\/script>/i)?.[1];
assert.ok(inlineScript, 'operator panel inline module exists');
const windowObject = { __PTYSD_TEST__: true };
const domElements = new Map();
const documentMock = { getElementById(id) {
  if (!domElements.has(id)) domElements.set(id, {});
  return domElements.get(id);
} };
runInNewContext(inlineScript, { window: windowObject, document: documentMock, AbortController,
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

test('one page stays within the 21-request hourly polling budget', async () => {
  let now = baseTime;
  const calls = [];
  const client = panel.createApiClient(async url => {
    calls.push(url);
    const body = url === urls.issue ? observationComments(now) : url === urls.pr ? pullRequest(437, head) :
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

test('scheduled polling plus throttled manual sync stays within 37 reads per hour', async () => {
  let now = baseTime;
  const calls = [];
  const storage = memoryStorage();
  const locks = serialLocks();
  const client = panel.createApiClient(async (url, init) => {
    calls.push(url);
    if (url !== urls.issue && init?.headers?.['If-None-Match'])
      return response(304, null, { ...quotaHeaders(now, 60 - calls.length), ETag: `etag:${url}` });
    const body = url === urls.issue ? observationComments(now) : url === urls.pr ? pullRequest(437, head) :
      url === urls.main ? { sha: head } : { check_runs: [] };
    return response(200, body, { ...quotaHeaders(now, 60 - calls.length), ETag: `etag:${url}` });
  }, { now: () => now, storage, locks });
  const store = panel.createResourceStore(client, () => now);
  const manualMinutes = [];

  for (let minute = 0; minute < 60; minute++) {
    now = baseTime + minute * 60 * 1000;
    if (minute % 5 === 0) await panel.runSyncCycle(store, client, urls);
    if (await client.claimManualSyncWindow()) {
      manualMinutes.push(minute);
      await panel.runSyncCycle(store, client, urls, { force: true });
    }
  }

  assert.deepEqual(manualMinutes, [0, 15, 30, 45]);
  assert.equal(calls.length, 37,
    '21 scheduled reads plus at most four manual four-source revalidations');
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
  assert.equal(store.resources.checks.error, 'CANDIDATE_PR_IDENTITY_UNKNOWN');
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
