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
const urls = {
  issue: 'https://api.github.com/repos/PT-Original-Point/ptysd-autonomous-factory/issues/407/comments?per_page=100',
  pr: 'https://api.github.com/repos/PT-Original-Point/ptysd-autonomous-factory/pulls/419',
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
