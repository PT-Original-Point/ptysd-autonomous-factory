import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  OPERATOR_MARKER, encodeOperatorObservation, parseOperatorObservation,
  findOperatorComment, updateExistingOperatorComment, observationFreshness,
  collectWindowsObservation,
} from '../native-bridge/operator-observation.mjs';

const now = Date.parse('2026-10-13T10:00:00.000Z');
const observation = (overrides = {}) => ({
  schema: 1,
  project_id: 'CHATGPT_GLOBAL_SKILL_GOVERNANCE',
  repo: 'PT-Original-Point/ptysd-autonomous-factory',
  issue: 407,
  host_alias: 'win11-primary',
  snapshot_id: '0f412dbe-6b88-46f3-b9cc-e650cb8db41f',
  sequence: 1,
  observed_at: new Date(now).toISOString(),
  published_at: new Date(now + 1000).toISOString(),
  expires_at: new Date(now + 5 * 60 * 1000).toISOString(),
  source: { main_sha: 'a'.repeat(40), comment_id: 1,
    issue_comments_observed_at: new Date(now).toISOString() },
  windows: { status: 'FRESH', native_task: { enabled: false } },
  ...overrides,
});
const comment = (value, login = 'trusted-publisher', id = 1) => ({
  id, body: encodeOperatorObservation(value), user: { login }, updated_at:value.published_at,
});
const candidatePrJobComment = (candidatePr=434, sourceSha='a'.repeat(40), id=10) => {
  const job={schema:5,project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE',host:'DESKTOP-1B6PD2P',
    request_id:'PTYSD_PANEL_INTEGRATION_TEST',kind:'opencode_edit',source_sha:sourceSha,
    spec_path:'native-bridge/tasks/scoped-edit.md',spec_sha256:'c'.repeat(64),
    model:'opencode/spark',variant:'high',write_paths:['src/demo.mjs'],candidate_pr:candidatePr};
  return {id,body:'PTYSD_NATIVE_JOB_V1\n'+JSON.stringify(job),user:{login:'t14210184'}};
};

test('operator snapshot requires exact project identity, time bounds, and de-identified keys', () => {
  const body = encodeOperatorObservation(observation());
  assert.equal(parseOperatorObservation(body).issue, 407);
  assert.equal(parseOperatorObservation(body.replace('407', '408')), null);
  assert.throws(() => encodeOperatorObservation(observation({
    windows: { command_line: 'must never be published' },
  })), /INVALID_OPERATOR_OBSERVATION/);
  assert.throws(() => encodeOperatorObservation(observation({
    windows: { note: 'C:\\private\\workspace' },
  })), /INVALID_OPERATOR_OBSERVATION/);
  assert.throws(() => encodeOperatorObservation(observation({
    expires_at: new Date(now + 16 * 60 * 1000).toISOString(),
  })), /INVALID_OPERATOR_OBSERVATION/);
});

test('operator snapshot accepts the GitHub-supported body range beyond the old local ceiling', () => {
  const base = observation({
    windows: { status: 'FRESH', native_task: { enabled: false }, summary: '' },
  });
  const emptyBody = OPERATOR_MARKER + JSON.stringify(base);
  const padding = 'x'.repeat(65_536 - emptyBody.length);
  const maximumValue = {
    ...base,
    windows: { ...base.windows, summary: padding },
  };
  const maximumBody = OPERATOR_MARKER + JSON.stringify(maximumValue);
  assert.equal(maximumBody.length, 65_536);
  assert.equal(parseOperatorObservation(maximumBody)?.windows.summary.length, padding.length);

  const oversizedValue = {
    ...base,
    windows: { ...base.windows, summary: `${padding}x` },
  };
  const oversizedBody = OPERATOR_MARKER + JSON.stringify(oversizedValue);
  assert.equal(oversizedBody.length, 65_537);
  assert.equal(parseOperatorObservation(oversizedBody), null);
});

test('published_at must be at or after observation and strictly before expiry', () => {
  const parseWithPublishedAt = publishedAt => parseOperatorObservation(
    OPERATOR_MARKER + JSON.stringify(observation({ published_at: publishedAt })),
  );
  const observedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + 5 * 60 * 1000).toISOString();

  assert.equal(parseWithPublishedAt(new Date(now - 1).toISOString()), null,
    'publication before observation is invalid');
  assert.equal(parseWithPublishedAt(expiresAt), null,
    'publication at expiry is invalid');
  assert.equal(parseWithPublishedAt(new Date(now + 5 * 60 * 1000 + 1).toISOString()), null,
    'publication after expiry is invalid');
  assert.equal(parseWithPublishedAt(observedAt).published_at, observedAt,
    'publication equal to observation is valid');
});

test('one trusted observation comment is updated; missing, duplicate, or foreign author fails closed', () => {
  assert.equal(findOperatorComment([], 'trusted-publisher').status, 'NOT_SEEDED');
  assert.equal(findOperatorComment([comment(observation())], 'trusted-publisher').status, 'OK');
  assert.equal(findOperatorComment([comment(observation(), 'someone-else')], 'trusted-publisher').error,
    'OPERATOR_COMMENT_AUTHOR_MISMATCH');
  assert.equal(findOperatorComment([
    comment(observation(), 'trusted-publisher', 1),
    comment(observation({ snapshot_id: '11c95b35-bda3-4d54-9f91-431730ed5acd' }), 'trusted-publisher', 2),
  ], 'trusted-publisher').error, 'DUPLICATE_OPERATOR_COMMENTS');
});

test('publisher updates one pre-seeded comment with read-before-write and exact readback', async () => {
  const original = comment(observation());
  let stored = original;
  const writes = [];
  const updatedValue = observation({
    snapshot_id:'11c95b35-bda3-4d54-9f91-431730ed5acd',
    sequence:2,
    observed_at:new Date(now+60_000).toISOString(),
    published_at:new Date(now+60_000).toISOString(),
    expires_at:new Date(now+6*60_000).toISOString(),
  });
  const body = encodeOperatorObservation(updatedValue);
  const result = await updateExistingOperatorComment({
    comments:[original], expectedLogin:'trusted-publisher', body,
    readComment:async id => ({ ...stored, id }),
    patchComment:async (id, next) => { writes.push({ id, next }); stored={ ...stored,
      body:next, updated_at:updatedValue.published_at }; },
    readComments:async () => [stored],
  });
  assert.equal(result.status,'UPDATED');
  assert.equal(result.comment_id,1);
  assert.equal(result.readback_updated_at,updatedValue.published_at);
  assert.equal(writes.length,1);
  assert.equal(writes[0].id,1);
  assert.equal(stored.body,body);

  const missing = await updateExistingOperatorComment({
    comments:[], expectedLogin:'trusted-publisher', body,
    readComment:async()=>{ throw new Error('must not read'); },
    patchComment:async()=>{ throw new Error('must not create'); },
    readComments:async()=>[],
  });
  assert.equal(missing.status,'NOT_SEEDED');

  const changed = await updateExistingOperatorComment({
    comments:[original], expectedLogin:'trusted-publisher', body,
    readComment:async id=>({ id, body:'changed', user:{login:'trusted-publisher'} }),
    patchComment:async()=>{ throw new Error('must not overwrite changed comment'); },
    readComments:async()=>[original],
  });
  assert.equal(changed.status,'UNKNOWN');
  assert.equal(changed.error,'OPERATOR_COMMENT_CHANGED_BEFORE_UPDATE');
});

test('publisher exposes GitHub updated_at as readback evidence and rejects missing metadata', async () => {
  const original = { ...comment(observation()), updated_at:new Date(now).toISOString() };
  const updatedValue = observation({
    snapshot_id:'11c95b35-bda3-4d54-9f91-431730ed5acd', sequence:2,
    observed_at:new Date(now+60_000).toISOString(),
    published_at:new Date(now+61_000).toISOString(),
    expires_at:new Date(now+6*60_000).toISOString(),
  });
  const body = encodeOperatorObservation(updatedValue);
  const updatedAt = new Date(now+62_000).toISOString();
  let stored = original;
  const options = {
    comments:[original], expectedLogin:'trusted-publisher', body,
    readComment:async id=>({...stored,id}),
    patchComment:async (_id,next)=>{stored={...stored,body:next,updated_at:updatedAt};},
    readComments:async()=>[stored],
  };
  const result = await updateExistingOperatorComment(options);
  assert.equal(result.status,'UPDATED');
  assert.equal(result.readback_updated_at,updatedAt);

  stored = original;
  options.patchComment = async (_id,next)=>{stored={...stored,body:next};delete stored.updated_at;};
  const unknown = await updateExistingOperatorComment(options);
  assert.equal(unknown.status,'UNKNOWN');
  assert.equal(unknown.error,'OPERATOR_COMMENT_READBACK_TIMESTAMP_UNKNOWN');

  stored = original;
  options.patchComment = async (_id,next)=>{stored={...stored,body:next,
    updated_at:original.updated_at};};
  const earlier = await updateExistingOperatorComment(options);
  assert.equal(earlier.status,'UNKNOWN');
  assert.equal(earlier.error,'OPERATOR_COMMENT_READBACK_TIMESTAMP_UNKNOWN');

  stored = original;
  options.patchComment = async (_id,next)=>{stored={...stored,body:next,
    updated_at:'2999-01-01T00:00:00.000Z'};};
  const future = await updateExistingOperatorComment(options);
  assert.equal(future.status,'UNKNOWN',
    'a future GitHub updated_at must not certify a publication the dashboard will reject');
  assert.equal(future.error,'OPERATOR_COMMENT_READBACK_TIMESTAMP_UNKNOWN');
});

test('expired observations degrade to STALE and future timestamps to UNKNOWN', () => {
  const valid = observation();
  assert.equal(observationFreshness(valid, now), 'FRESH');
  assert.equal(observationFreshness(valid, now + 6 * 60 * 1000), 'STALE');
  assert.equal(observationFreshness({
    ...valid, observed_at: new Date(now + 6 * 60 * 1000).toISOString(),
  }, now), 'UNKNOWN');
});

test('Windows collector is read-only, hides its PowerShell child, and publishes only allowlisted fields', () => {
  let invoked = false;
  const ignored = collectWindowsObservation({
    platformName: 'linux',
    execute: () => { invoked = true; },
  });
  assert.equal(ignored.status, 'UNKNOWN');
  assert.equal(invoked, false);

  const raw = {
    observed_at: new Date(now).toISOString(),
    tasks_total: 225,
    legacy_monitor_registered: false,
    listener_2667: false,
    opencode_process_count: 0,
    runner_service_count: 1,
    runner_service_running: 1,
    native_task: {
      registered: true, enabled: false, state: 'Disabled',
      last_run: new Date(now - 5 * 60 * 1000).toISOString(),
      last_result: '0x00000000', action_kind: 'WINDOWLESS_LAUNCHER',
      identity_class: 'INTERACTIVE_LIMITED', multiple_instances: 'IgnoreNew',
      trigger_interval_minutes: 5,
    },
  };
  const live = collectWindowsObservation({
    platformName: 'win32',
    execute: (file, args, options) => {
      invoked = true;
      assert.equal(file, 'powershell.exe');
      assert.ok(args.includes('-NonInteractive'));
      assert.equal(options.windowsHide, true);
      assert.equal(options.timeout, 7000);
      return JSON.stringify(raw);
    },
  });
  assert.equal(live.status, 'FRESH');
  assert.equal(live.tasks_total, 225);
  assert.equal(live.native_task.enabled, false);
  assert.equal(live.native_task.identity_class, 'INTERACTIVE_LIMITED');
  assert.equal(live.native_task.multiple_instances, 'IGNORENEW');
  assert.equal(live.native_task.action_kind, 'WINDOWLESS_LAUNCHER');
  assert.equal(live.opencode_process_count, 0);
  assert.equal(live.runner_service_running, 1);
  assert.equal(Object.hasOwn(live, 'command_line'), false);
  assert.match(readFileSync(new URL('../native-bridge/operator-observation.mjs', import.meta.url), 'utf8'),
    /wscript\.exe[\s\S]+HiddenWorker\\\.vbs/);
});

test('failed Windows collection exposes a bounded error code, not command output', () => {
  const result = collectWindowsObservation({
    platformName: 'win32',
    execute: () => { throw new Error('C:\\private\\path token=secret'); },
    now: () => new Date(now).toISOString(),
  });
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(result.error, 'WINDOWS_READBACK_FAILED');
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('single-page renderer classifies receipts, expiry, and missing status without inventing work', () => {
  const html = readFileSync(new URL('../operator-panel/index.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const window = { __PTYSD_TEST__: true };
  vm.runInNewContext(script, { window, document: {}, Date, Number, String, Array, JSON, RegExp });
  const api = window.PTYSDOperatorPanel;
  const valid = observation();
  const body = encodeOperatorObservation(valid);
  const verifiedComment = { id:1, body, user:{login:'wfvupu1212'},
    updated_at:new Date(now+2000).toISOString() };
  const verified = api.findSnapshot([verifiedComment], now);
  assert.equal(verified.status, 'FRESH');
  assert.equal(verified.readbackUpdatedAt, verifiedComment.updated_at,
    'the page must expose GitHub comment updated_at as publication readback evidence');
  assert.equal(api.findSnapshot([{id:1,body,user:{login:'wfvupu1212'}}],now).error,
    'OBSERVATION_GITHUB_UPDATED_AT_UNKNOWN');
  assert.equal(api.findSnapshot([{...verifiedComment,updated_at:new Date(now).toISOString()}],now).error,
    'OBSERVATION_GITHUB_UPDATED_AT_MISMATCH');
  assert.equal(api.findSnapshot([{ ...verifiedComment, id:2 }], now).error,
    'OBSERVATION_COMMENT_ID_MISMATCH');
  assert.equal(api.findSnapshot([{ body, user: { login: 't14210184' } }], now).status, 'UNKNOWN');
  assert.equal(api.findSnapshot([{ body }, { body }], now).error, 'DUPLICATE_OBSERVATIONS');
  assert.equal(api.findSnapshot([verifiedComment], now + 6 * 60 * 1000).status, 'STALE');

  const main = 'a'.repeat(40);
  const request = 'PTYSD_NATIVE_PRECHECK_20261013';
  const job = { schema:1, project_id:valid.project_id, host:'DESKTOP-1B6PD2P',
    request_id:request, kind:'native_preflight', source_sha:main,
    spec_path:null, spec_sha256:null };
  const comments = [
    { id:1, body:'PTYSD_NATIVE_JOB_V1\n'+JSON.stringify(job), user:{login:'t14210184'} },
    { id:2, body:'PTYSD_NATIVE_RECEIPT_V1\n'+JSON.stringify({
      schema:1, project_id:valid.project_id, host:'DESKTOP-1B6PD2P', request_id:request,
      attempt_id:'9c8b6130-de76-4220-a7d6-a4bdabea1d18', state:'STARTED',
      kind:job.kind, source_sha:main,
    }), user:{login:'t14210184'}, created_at:new Date(now).toISOString() },
  ];
  assert.equal(api.latestTask(comments, main).state, '已 STARTED；即時施工尚未證實');
  const startedTask = api.normalizeFormalTask(api.latestTask(comments, main));
  assert.equal(startedTask.state,'STARTED_UNVERIFIED');
  assert.equal(api.classifyW1({process_count:0},{current_task:null},'FRESH',now,startedTask).status,'PENDING');
  const finishedComments=[comments[0],{...comments[1],body:'PTYSD_NATIVE_RECEIPT_V1\n'+JSON.stringify({
    schema:1,project_id:valid.project_id,host:'DESKTOP-1B6PD2P',request_id:request,
    attempt_id:'9c8b6130-de76-4220-a7d6-a4bdabea1d18',state:'FINISHED',
    kind:job.kind,source_sha:main,
  })}];
  const finishedTask=api.normalizeFormalTask(api.latestTask(finishedComments,main));
  assert.equal(finishedTask.state,'HISTORICAL');
  assert.equal(api.classifyW1({process_count:0},{current_task:null},'FRESH',now,finishedTask).status,'UNKNOWN');
  assert.equal(api.latestTask([
    comments[0],
    { ...comments[1], user:{login:'wfvupu1212'} },
  ], main).state, '已 STARTED；即時施工尚未證實');
  assert.equal(api.latestTask(comments, 'b'.repeat(40)).state, '來源 SHA 已過期，未重派');
  assert.equal(api.latestTask([], main), null);
  assert.equal(api.summarizeChecks({ check_runs:[
    { head_sha:main, status:'completed', conclusion:'success' },
    { head_sha:main, status:'completed', conclusion:'skipped' },
    { head_sha:main, status:'pending', conclusion:null },
    { head_sha:'b'.repeat(40), status:'completed', conclusion:'failure' },
  ] }, main, 419).status, 'PENDING');
  assert.equal(api.summarizeChecks({ check_runs:[
    { head_sha:main, status:'completed', conclusion:'success' },
  ] }, main, 419).counts.success, 1);
  assert.equal(api.summarizeChecks({ check_runs:[] }, main, 419).status, 'UNKNOWN');
  assert.doesNotMatch(html, /38363923661/);
  assert.equal(api.latestTask([
    { ...comments[0], user:{login:'untrusted'} },
  ], main), null);
  const conflictingJob = { ...job, source_sha:'b'.repeat(40) };
  assert.match(api.latestTask([
    comments[0],
    { id:3, body:'PTYSD_NATIVE_JOB_V1\n'+JSON.stringify(conflictingJob),
      user:{login:'t14210184'} },
  ], main).state, /內容衝突/);
  assert.equal(api.fieldFreshness(new Date(now - 11*60*1000).toISOString(), 10*60*1000, now), 'STALE');
});

test('dashboard starts dark and worker states require role-bound recent evidence', () => {
  const html = readFileSync(new URL('../operator-panel/index.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  const window = { __PTYSD_TEST__: true };
  vm.runInNewContext(script, { window, document: {}, Date, Number, String, Array, JSON, RegExp });
  const api = window.PTYSDOperatorPanel;
  assert.match(html, /<meta name="color-scheme" content="dark">/);
  assert.match(html, /--page:#0b111b/);
  assert.match(html, /<h2 class="worker-name">OpenCode<\/h2>/);
  assert.match(html, /<h2 class="worker-name">Antigravity<\/h2>/);
  assert.match(html, /ChatGPT Web／Codex Zero Risk/);
  assert.match(html, /@media \(max-width:700px\)/);
  assert.doesNotMatch(script, /\.innerHTML\s*=/);
  assert.equal(api.constants.ISSUE_POLL_MS, 300000);
  assert.equal(api.constants.PR_POLL_MS, 900000);
  assert.equal(api.constants.CHECKS_POLL_MS, 900000);
  assert.equal(api.constants.MAIN_POLL_MS, 3600000);
  const freshResult={status:'FRESH',snapshot:{windows:{status:'FRESH',observed_at:new Date(now).toISOString()}}};
  assert.equal(api.freshnessOfSnapshot(freshResult,now,{fetchedAt:now,error:null}),'FRESH');
  assert.equal(api.freshnessOfSnapshot(freshResult,now,{fetchedAt:now,error:'GITHUB_HTTP_403'}),'UNKNOWN');
  assert.equal(api.freshnessOfSnapshot(freshResult,now,{fetchedAt:now-16*60_000,error:null}),'STALE');
  assert.equal(api.freshnessOfSnapshot({status:'STALE'},now,{fetchedAt:now,error:'GITHUB_HTTP_403'}),'STALE');

  const old = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const live = new Date(now - 30 * 1000).toISOString();
  assert.equal(api.classifyW1({ process_count:1, process_observed_at:live,
    historical_sessions_count:42, task_binding:'PROVEN', model_execution:'UNPROVEN' },
  {}, 'FRESH', now).status, 'UNKNOWN');
  assert.equal(api.classifyW1({ process_count:1, process_observed_at:live,
    historical_sessions_count:42, task_binding:'PROVEN', model_execution:'PROVEN',
    activity_observed_at:old, task_id:'W1_TASK_20261013' }, {}, 'FRESH', now).status, 'UNKNOWN');
  assert.equal(api.classifyW1({ process_count:1, process_observed_at:live,
    task_binding:'UNPROVEN', model_execution:'PROVEN',
    activity_observed_at:live, task_id:'OLD_W1_TASK_20261015' }, {}, 'FRESH', now).status, 'UNKNOWN',
  'a live process and copied historical activity must not become verified current work');
  assert.equal(api.classifyW1({ process_count:0, historical_sessions_count:42,
    historical_sessions_observed_at:old }, { latest_task:{kind:'native_v2_qualify',state:'FINISHED'} },
  'FRESH', now).status, 'UNKNOWN');
  assert.equal(api.classifyWorker(null, 'FRESH', now).status, 'UNKNOWN');
  assert.equal(api.classifyWorker({ worker_id:'W3', status:'PENDING', task_id:'W3_REQ_1' },
    'FRESH', now).status, 'UNKNOWN');
  assert.equal(api.classifyWorker({ worker_id:'W3', status:'PENDING', task_id:'W3_REQ_1',
    task_source:'Issue #407' }, 'FRESH', now).status, 'PENDING');
  const unsupportedRun = api.classifyWorker({ worker_id:'W3', status:'RUNNING_VERIFIED',
    task_id:'W3_REQ_1', attempt_id:'attempt-1', task_source:'Issue #407',
    evidence_ref:'comment-1', evidence_kind:'TUNNEL_CONNECTED', activity_observed_at:live },
  'FRESH', now);
  assert.equal(unsupportedRun.status, 'UNKNOWN');
  assert.equal(api.classifyWorker({ worker_id:'W3', status:'RUNNING_VERIFIED',
    task_id:'W3_REQ_1', attempt_id:'attempt-1', task_source:'Issue #407',
    evidence_ref:'comment-1', evidence_kind:'CODEX_ZERO_RISK_TOOL_CALL',
    activity_observed_at:old }, 'FRESH', now).status, 'UNKNOWN');
  assert.equal(api.classifyWorker({ worker_id:'W3', status:'RUNNING_VERIFIED',
    task_id:'W3_REQ_1', attempt_id:'attempt-1', task_source:'Issue #407',
    evidence_ref:'comment-1', evidence_kind:'CODEX_ZERO_RISK_TOOL_CALL',
    activity_observed_at:live }, 'FRESH', now).status, 'RUNNING_VERIFIED');
  assert.equal(api.classifyWorker({ worker_id:'W3', status:'RUNNING_VERIFIED',
    task_id:'W3_REQ_1', attempt_id:'attempt-1', task_source:'Issue #407',
    evidence_ref:'comment-1', evidence_kind:'CODEX_ZERO_RISK_TOOL_CALL',
    activity_observed_at:live }, 'STALE', now).status, 'STALE');
  assert.equal(api.classifyWorker({ worker_id:'W2', status:'IDLE',
    activity_observed_at:live, evidence_kind:'NO_ACTIVE_WORK' }, 'FRESH', now).status, 'UNKNOWN');
  assert.equal(api.workerRecord({workers:[{worker_id:'W1'}]},'W2'), null);
});

test('check-run states stay bound to exact SHA and skipped/cancelled are not passes', () => {
  const script = readFileSync(new URL('../operator-panel/index.html', import.meta.url), 'utf8')
    .match(/<script>([\s\S]*?)<\/script>/)[1];
  const window = { __PTYSD_TEST__: true };
  vm.runInNewContext(script, { window, document: {}, Date, Number, String, Array, JSON, RegExp });
  const api = window.PTYSDOperatorPanel;
  const sha = 'a'.repeat(40);
  const summarize = rows => api.summarizeChecks({check_runs:rows},sha,419);
  assert.equal(summarize([{head_sha:sha,status:'queued',conclusion:null}]).status,'QUEUED');
  assert.equal(summarize([{head_sha:sha,status:'pending',conclusion:null}]).status,'PENDING');
  assert.equal(summarize([{head_sha:sha,status:'in_progress',conclusion:null}]).status,'IN_PROGRESS');
  assert.equal(summarize([
    {head_sha:sha,status:'queued',conclusion:null},
    {head_sha:sha,status:'in_progress',conclusion:null},
  ]).status,'MIXED_ACTIVE');
  assert.equal(summarize([{head_sha:sha,status:'completed',conclusion:'failure'}]).status,'CI_FAILED');
  assert.equal(summarize([{head_sha:sha,status:'completed',conclusion:'cancelled'}]).status,'COMPLETED_WITH_NON_SUCCESS');
  assert.equal(summarize([{head_sha:sha,status:'completed',conclusion:'skipped'}]).status,'COMPLETED_WITH_SKIPS');
  assert.equal(summarize([{head_sha:sha,status:'completed',conclusion:'neutral'}]).status,'COMPLETED_WITH_SKIPS');
  assert.equal(summarize([{head_sha:sha,status:'completed',conclusion:'success'},
    {head_sha:'b'.repeat(40),status:'completed',conclusion:'failure'}]).counts.total,1);
  assert.equal(summarize([{head_sha:sha,status:'completed',conclusion:'success'}]).status,'CHECKS_SUCCESS');
});

test('GitHub API client reuses ETags, coalesces duplicate reads and classifies failures', async () => {
  const script = readFileSync(new URL('../operator-panel/index.html', import.meta.url), 'utf8')
    .match(/<script>([\s\S]*?)<\/script>/)[1];
  const window = { __PTYSD_TEST__: true };
  vm.runInNewContext(script, { window, document: {}, Date, Number, String, Array, JSON, RegExp });
  const makeResponse = (status, data, headers = {}) => ({
    status, ok:status >= 200 && status < 300,
    headers:{ get(name) { return headers[name.toLowerCase()] ?? null; } },
    json:async () => data,
  });
  const opts = { AbortControllerCtor:AbortController, setTimeoutFn:() => 1, clearTimeoutFn:() => {} };
  let calls = 0, release;
  const gate = new Promise(resolve => { release=resolve; });
  const payload = { value:'cached-body' };
  const client = window.PTYSDOperatorPanel.createApiClient(async (url, init) => {
    calls++;
    assert.equal(init.credentials,'omit');
    if (calls === 1) { await gate; return makeResponse(200,payload,{etag:'"etag-1"','x-ratelimit-remaining':'22'}); }
    assert.equal(init.headers['If-None-Match'],'"etag-1"');
    return makeResponse(304,null,{'x-ratelimit-remaining':'21'});
  },opts);
  const first = client.requestJson('https://api.github.com/example');
  const duplicate = client.requestJson('https://api.github.com/example');
  await Promise.resolve();
  assert.equal(calls,1);
  release();
  assert.deepEqual(await Promise.all([first,duplicate]),[payload,payload]);
  assert.equal(await client.requestJson('https://api.github.com/example'),payload);
  assert.equal(calls,2);
  assert.equal(client.getMeta('https://api.github.com/example').remaining,21);

  for (const [status,remaining,expected] of [
    [403,'0','GITHUB_RATE_LIMIT_EXHAUSTED'],[429,'4','GITHUB_SECONDARY_RATE_LIMIT'],
    [500,'9','GITHUB_HTTP_500'],
  ]) {
    const failing = window.PTYSDOperatorPanel.createApiClient(async () =>
      makeResponse(status,{}, {'x-ratelimit-remaining':remaining}),opts);
    await assert.rejects(failing.requestJson('https://api.github.com/failure-' + status),
      error => error.code === expected);
  }
  const timeout = window.PTYSDOperatorPanel.createApiClient(async () => {
    const error = new Error('aborted'); error.name='AbortError'; throw error;
  },opts);
  await assert.rejects(timeout.requestJson('https://api.github.com/timeout'),
    error => error.code === 'GITHUB_TIMEOUT');
  const cors = window.PTYSDOperatorPanel.createApiClient(async () => {
    throw new TypeError('Failed to fetch');
  },opts);
  await assert.rejects(cors.requestJson('https://api.github.com/cors'),
    error => error.code === 'GITHUB_CORS_OR_NETWORK_UNKNOWN');
});

test('checks resource keeps raw API data across polling, ETag, manual sync, and HEAD changes', async () => {
  const script = readFileSync(new URL('../operator-panel/index.html', import.meta.url), 'utf8')
    .match(/<script>([\s\S]*?)<\/script>/)[1];
  const window = { __PTYSD_TEST__: true };
  vm.runInNewContext(script, { window, document:{}, Date, Number, String, Array, JSON, RegExp });
  const api = window.PTYSDOperatorPanel;
  const makeResponse = (entry) => ({
    status:entry.status, ok:entry.status >= 200 && entry.status < 300,
    headers:{ get(name) { return entry.headers?.[name.toLowerCase()] ?? null; } },
    json:async () => entry.data,
  });
  const head1 = 'c'.repeat(40), head2 = 'd'.repeat(40);
  const original = { total_count:5, check_runs:[
    ...[1,2,3].map(n => ({ name:'success-' + n, head_sha:head1,
      status:'completed', conclusion:'success' })),
    { name:'waiting', head_sha:head1, status:'pending', conclusion:null },
    { name:'skipped', head_sha:head1, status:'completed', conclusion:'skipped' },
  ] };
  const changedHead = { total_count:1, check_runs:[
    { name:'new-head-check', head_sha:head2, status:'queued', conclusion:null },
    { name:'old-head-must-not-leak', head_sha:head1, status:'completed', conclusion:'failure' },
  ] };
  const responses = [
    { status:200, data:original, headers:{etag:'"checks-v1"'} },
    { status:304, data:null, headers:{} },
    { status:304, data:null, headers:{} },
    { status:200, data:changedHead, headers:{etag:'"checks-v2"'} },
  ];
  const calls = [];
  let clock=1_000;
  const client = api.createApiClient(async (url, init) => {
    calls.push({url,init});
    return makeResponse(responses.shift());
  }, { now:() => clock, AbortControllerCtor:AbortController,
    setTimeoutFn:() => 1, clearTimeoutFn:() => {} });
  const store = api.createResourceStore(client, () => clock);
  store.bindCandidatePr({number:434,request_id:'PTYSD_PANEL_TEST',source_sha:head1,error:null});
  const checkUrl1 = store.bindChecksHead(head1);
  assert.equal(await store.loadResource('checks',checkUrl1,api.constants.CHECKS_POLL_MS),original);
  assert.equal(store.resources.checks.data,original);
  assert.equal(Object.hasOwn(store.resources.checks.data,'payload'),false);
  assert.equal(Object.hasOwn(store.resources.checks.data,'headSha'),false);
  let summary = store.checksSummaryForHead(head1);
  assert.equal(summary.head_sha,head1);
  assert.equal(summary.counts.total,5);
  assert.equal(summary.counts.success,3);
  assert.equal(summary.counts.pending,1);
  assert.equal(summary.counts.skipped,1);

  clock += api.constants.ISSUE_POLL_MS;
  store.bindChecksHead(head1);
  assert.equal(await store.loadResource('checks',checkUrl1,api.constants.CHECKS_POLL_MS),original);
  assert.equal(calls.length,1,'the 5-minute dashboard poll reuses the 15-minute checks resource');
  assert.equal(store.checksSummaryForHead(head1).counts.pending,1);

  clock += api.constants.CHECKS_POLL_MS - api.constants.ISSUE_POLL_MS;
  assert.equal(await store.loadResource('checks',checkUrl1,api.constants.CHECKS_POLL_MS),original);
  assert.equal(calls.length,2,'the 15-minute refresh revalidates with GitHub');
  assert.equal(calls[1].init.headers['If-None-Match'],'"checks-v1"');
  assert.equal(store.resources.checks.data,original,'ETag 304 restores the raw cached API response');
  assert.equal(store.checksSummaryForHead(head1).counts.success,3);

  clock += 1;
  assert.equal(await store.loadResource('checks',checkUrl1,api.constants.CHECKS_POLL_MS,true),original);
  assert.equal(calls.length,2,'manual sync cannot bypass the shared resource TTL');
  clock += api.constants.CHECKS_POLL_MS;
  assert.equal(await store.loadResource('checks',checkUrl1,api.constants.CHECKS_POLL_MS,true),original);
  assert.equal(calls.length,3,'the next due sync performs one conditional read');
  assert.equal(calls[2].init.cache,'no-cache');
  assert.equal(calls[2].init.headers['If-None-Match'],'"checks-v1"');
  assert.equal(store.resources.checks.data,original);
  assert.equal(store.checksSummaryForHead(head1).counts.skipped,1);

  const checkUrl2 = store.bindChecksHead(head2);
  assert.notEqual(checkUrl2,checkUrl1);
  assert.equal(store.resources.checks.data,null,'a changed HEAD cannot reuse the previous HEAD body');
  assert.equal(store.checksSummaryForHead(head2),null);
  assert.equal(await store.loadResource('checks',checkUrl2,api.constants.CHECKS_POLL_MS),changedHead);
  summary = store.checksSummaryForHead(head2);
  assert.equal(summary.head_sha,head2);
  assert.equal(summary.counts.total,1);
  assert.equal(summary.counts.queued,1);
  assert.equal(summary.counts.failure,0,'a different HEAD failure is excluded');
  assert.equal(calls.length,4);
  assert.match(calls[3].url,new RegExp(head2));
  assert.equal(calls[3].init.headers['If-None-Match'],undefined);
});

test('checks API failures remain UNKNOWN with their precise HTTP, rate-limit, or CORS code', async () => {
  const script = readFileSync(new URL('../operator-panel/index.html', import.meta.url), 'utf8')
    .match(/<script>([\s\S]*?)<\/script>/)[1];
  const window = { __PTYSD_TEST__: true };
  vm.runInNewContext(script, { window, document:{}, Date, Number, String, Array, JSON, RegExp });
  const api = window.PTYSDOperatorPanel;
  const options = { AbortControllerCtor:AbortController, setTimeoutFn:() => 1, clearTimeoutFn:() => {} };
  const failures = [
    ['GITHUB_HTTP_503',async () => ({ status:503, ok:false,
      headers:{get:name => name.toLowerCase()==='x-ratelimit-remaining' ? '8' : null} })],
    ['GITHUB_RATE_LIMIT_EXHAUSTED',async () => ({ status:403, ok:false,
      headers:{get:name => name.toLowerCase()==='x-ratelimit-remaining' ? '0' : null} })],
    ['GITHUB_CORS_OR_NETWORK_UNKNOWN',async () => { throw new TypeError('Failed to fetch'); }],
  ];
  for (const [expected,fetchImpl] of failures) {
    const store = api.createResourceStore(api.createApiClient(fetchImpl,options));
    const head = 'e'.repeat(40), url = store.bindChecksHead(head);
    await store.loadResource('checks',url,api.constants.CHECKS_POLL_MS,true);
    assert.equal(store.resources.checks.error,expected);
    assert.equal(store.checksSummaryForHead(head),null);
  }
});

test('one simulated hour follows the 21-request schedule and serializes startup reads', async () => {
  const script = readFileSync(new URL('../operator-panel/index.html', import.meta.url), 'utf8')
    .match(/<script>([\s\S]*?)<\/script>/)[1];
  const window = { __PTYSD_TEST__: true };
  vm.runInNewContext(script, { window, document:{}, Date, Number, String, Array, JSON, RegExp });
  const api=window.PTYSDOperatorPanel;
  let time=1_000_000, remaining=60, active=0, maxActive=0;
  const requests=[];
  const head='a'.repeat(40);
  const client=api.createApiClient(async (url) => {
    active++; maxActive=Math.max(maxActive,active); requests.push(url); remaining--;
    await Promise.resolve();
    active--;
    const data=url.includes('/issues/407') ? [candidatePrJobComment(434,head)]
      : url.endsWith('/pulls/434') ? {number:434,head:{sha:head},base:{sha:'b'.repeat(40)}}
        : url.endsWith('/commits/main') ? {sha:'b'.repeat(40)}
          : {check_runs:[]};
    return {status:200,ok:true,headers:{get:name => {
      const values={
        etag:'"etag-'+requests.length+'"','x-ratelimit-limit':'60',
        'x-ratelimit-remaining':String(remaining),'x-ratelimit-reset':'9999999999',
      };
      return values[name.toLowerCase()] ?? null;
    }},json:async () => data};
  },{now:() => time,AbortControllerCtor:AbortController,setTimeoutFn:() => 1,clearTimeoutFn:() => {}});
  const store=api.createResourceStore(client,() => time);
  const urls={issue:'https://api.github.com/issues/407/comments?per_page=100',
    pr:'https://api.github.com/pulls/434',prFor:number=>`https://api.github.com/pulls/${number}`,
    main:'https://api.github.com/commits/main'};
  await Promise.all([api.runSyncCycle(store,client,urls),api.runSyncCycle(store,client,urls)]);
  assert.equal(requests.length,4,'overlapping same-page refreshes share each resource request');
  assert.equal(maxActive,1,'startup requests are serialized rather than burst in parallel');
  assert.match(requests[0],/issues\/407/);
  assert.match(requests[1],/commits\/main/);
  assert.match(requests[2],/pulls\/434/);
  assert.match(requests[3],/check-runs/);
  for (let minute=5; minute<60; minute+=5) {
    time=1_000_000+minute*60_000;
    await api.runSyncCycle(store,client,urls);
  }
  assert.equal(requests.length,21,'within [minute 0, minute 60), counts are 12+4+4+1');
  assert.equal(client.getRateState().remaining,39);
  const before=requests.length;
  await api.runSyncCycle(store,client,urls);
  assert.equal(requests.length,before,'manual or repeated sync cannot fetch resources before their TTL');
  assert.equal(api.adaptivePollInterval('pr',{getRateState:() => ({remaining:10})}),60*60*1000);
  assert.equal(api.adaptivePollInterval('main',{getRateState:() => ({remaining:10})}),2*60*60*1000);
});

test('shared primary cooldown blocks every source, honors Retry-After, then probes once', async () => {
  const script=readFileSync(new URL('../operator-panel/index.html',import.meta.url),'utf8')
    .match(/<script>([\s\S]*?)<\/script>/)[1];
  const window={__PTYSD_TEST__:true};
  vm.runInNewContext(script,{window,document:{},Date,Number,String,Array,JSON,RegExp});
  const api=window.PTYSDOperatorPanel;
  let time=1_000_000, calls=0;
  const responses=[
    {status:403,ok:false,headers:{get:name=>({ 'x-ratelimit-limit':'60','x-ratelimit-remaining':'0',
      'x-ratelimit-reset':'1005','retry-after':'10' }[name.toLowerCase()] ?? null)},json:async()=>({message:'API rate limit exceeded'})},
    {status:200,ok:true,headers:{get:name=>({ 'x-ratelimit-limit':'60','x-ratelimit-remaining':'50',
      'x-ratelimit-reset':'2000' }[name.toLowerCase()] ?? null)},json:async()=>[]},
  ];
  const client=api.createApiClient(async()=>{calls++;return responses.shift();},{
    now:()=>time,AbortControllerCtor:AbortController,setTimeoutFn:()=>1,clearTimeoutFn:()=>{}});
  const store=api.createResourceStore(client,()=>time);
  const urls={issue:'https://api.github.com/issues/407/comments?per_page=100',
    pr:'https://api.github.com/pulls/434',main:'https://api.github.com/commits/main'};
  await api.runSyncCycle(store,client,urls);
  assert.equal(calls,1,'remaining=0 stops the cycle before PR, main, or checks');
  assert.equal(store.resources.issue.error,'GITHUB_RATE_LIMIT_EXHAUSTED');
  assert.equal(client.getRateState().status,'RATE_LIMITED');
  assert.equal(client.getRateState().pauseUntil,1_010_000,'Retry-After takes precedence over the earlier reset');
  for (const key of ['issue','pr','main','checks']) {
    const url=key==='issue'?urls.issue:key==='pr'?urls.pr:key==='main'?urls.main:'https://api.github.com/commits/'+('a'.repeat(40))+'/check-runs?per_page=100';
    await store.loadResource(key,url,0,true);
  }
  assert.equal(calls,1,'manual, repeated sync, and every other source obey the shared pause');
  time=1_009_999;
  await api.runSyncCycle(store,client,urls);
  assert.equal(calls,1,'no retry occurs before Retry-After');
  time=1_010_000;
  const recovered=await api.runSyncCycle(store,client,urls);
  assert.equal(recovered.recoveryProbeCompleted,true);
  assert.equal(calls,2,'recovery begins with exactly one bounded request');
  assert.equal(client.getRateState().status,'READY');
  assert.equal(store.resources.pr.data,null,'recovery stops before polling other sources');
});

test('403 permission and unknown causes stay distinct; 429 uses bounded shared backoff', async () => {
  const script=readFileSync(new URL('../operator-panel/index.html',import.meta.url),'utf8')
    .match(/<script>([\s\S]*?)<\/script>/)[1];
  const window={__PTYSD_TEST__:true};
  vm.runInNewContext(script,{window,document:{},Date,Number,String,Array,JSON,RegExp});
  const api=window.PTYSDOperatorPanel;
  const options={now:()=>1_000_000,AbortControllerCtor:AbortController,setTimeoutFn:()=>1,clearTimeoutFn:()=>{}};
  const response=(status,remaining,message,extra={})=>({status,ok:false,
    headers:{get:name=>({
      'x-ratelimit-remaining':String(remaining),
      'x-ratelimit-limit':'60',
      ...extra,
    }[name.toLowerCase()] ?? null)},json:async()=>({message})});
  for (const [status,remaining,message,code] of [
    [403,7,'Resource not accessible by integration','GITHUB_PERMISSION_DENIED'],
    [403,7,'Unexpected denial','GITHUB_HTTP_403_REASON_UNKNOWN'],
  ]) {
    const client=api.createApiClient(async()=>response(status,remaining,message),options);
    await assert.rejects(client.requestJson('https://api.github.com/denied'),
      error=>error.code===code);
    assert.equal(client.getRateState().status,'READY','permission/unknown 403 with remaining quota is not primary exhaustion');
  }
  let time=1_000_000, calls=0;
  const client=api.createApiClient(async()=> {
    calls++;
    if (calls===1)
      return response(403,8,'You have exceeded a secondary rate limit',{ 'retry-after':'25','x-ratelimit-reset':'1010' });
    return response(429,8,'Too many requests',{ 'x-ratelimit-reset':'9999999999' });
  },{...options,now:()=>time});
  await assert.rejects(client.requestJson('https://api.github.com/secondary-403'),
    error=>error.code==='GITHUB_SECONDARY_RATE_LIMIT');
  assert.equal(client.getRateState().status,'RATE_LIMITED');
  assert.equal(client.getRateState().pauseUntil,1_025_000,'Retry-After wins over reset when later');
  time=1_025_000;
  await assert.rejects(client.requestJson('https://api.github.com/secondary-403'),
    error=>error.code==='GITHUB_SECONDARY_RATE_LIMIT');
  assert.equal(client.getRateState().pauseUntil,1_055_000,'secondary retry without Retry-After starts bounded backoff despite a distant primary reset');
  time=1_055_000;
  await assert.rejects(client.requestJson('https://api.github.com/secondary-403'),
    error=>error.code==='GITHUB_SECONDARY_RATE_LIMIT');
  assert.equal(client.getRateState().pauseUntil,1_115_000,'repeated secondary limit doubles its wait');
  assert.ok(client.getRateState().pauseUntil-time<=15*60_000);
});

test('X-Poll-Interval and network/5xx failures set bounded per-source retries', async () => {
  const script=readFileSync(new URL('../operator-panel/index.html',import.meta.url),'utf8')
    .match(/<script>([\s\S]*?)<\/script>/)[1];
  const window={__PTYSD_TEST__:true};
  vm.runInNewContext(script,{window,document:{},Date,Number,String,Array,JSON,RegExp});
  const api=window.PTYSDOperatorPanel;
  let time=1_000_000, pollCalls=0;
  const pollClient=api.createApiClient(async()=>{pollCalls++;return {
    status:200,ok:true,headers:{get:name=>name.toLowerCase()==='x-poll-interval'?'1200':
      name.toLowerCase()==='x-ratelimit-remaining'?'40':null},json:async()=>[],
  };},{now:()=>time,AbortControllerCtor:AbortController,setTimeoutFn:()=>1,clearTimeoutFn:()=>{}});
  const pollStore=api.createResourceStore(pollClient,()=>time);
  const issueUrl='https://api.github.com/issues/407/comments?per_page=100';
  await pollStore.loadResource('issue',issueUrl,api.constants.ISSUE_POLL_MS);
  assert.equal(pollClient.getMeta(issueUrl).pollIntervalMs,1_200_000);
  time+=10*60_000;
  await pollStore.loadResource('issue',issueUrl,api.constants.ISSUE_POLL_MS);
  assert.equal(pollCalls,1,'server X-Poll-Interval is applied as a minimum');
  time+=10*60_000;
  await pollStore.loadResource('issue',issueUrl,api.constants.ISSUE_POLL_MS);
  assert.equal(pollCalls,2);

  for (const kind of ['network','http-503']) {
    let current=2_000_000, calls=0;
    const failing=api.createApiClient(async()=>{
      calls++;
      if (kind==='network') throw new TypeError('Failed to fetch');
      return {status:503,ok:false,headers:{get:name=>name.toLowerCase()==='x-ratelimit-remaining'?'9':null},
        json:async()=>({message:'temporarily unavailable'})};
    },{now:()=>current,AbortControllerCtor:AbortController,setTimeoutFn:()=>1,clearTimeoutFn:()=>{}});
    const store=api.createResourceStore(failing,()=>current);
    await store.loadResource('issue',issueUrl,0);
    assert.equal(store.resources.issue.retryAt,current+30_000);
    await store.loadResource('issue',issueUrl,0);
    assert.equal(calls,1,'immediate network/5xx retries are suppressed');
    current+=30_000;
    await store.loadResource('issue',issueUrl,0);
    assert.equal(calls,2);
    assert.equal(store.resources.issue.retryAt,current+60_000,'repeated failures back off exponentially');
  }
});

test('separate tabs report tab-local quota when cross-tab coordination is unavailable', async () => {
  const script=readFileSync(new URL('../operator-panel/index.html',import.meta.url),'utf8')
    .match(/<script>([\s\S]*?)<\/script>/)[1];
  const window={__PTYSD_TEST__:true};
  vm.runInNewContext(script,{window,document:{},Date,Number,String,Array,JSON,RegExp});
  const api=window.PTYSDOperatorPanel;
  let calls=0;
  const clients=Array.from({length:3},()=>api.createApiClient(async()=>{calls++;return {
    status:200,ok:true,headers:{get:()=>null},json:async()=>({public:true}),
  };},{storage:null,channel:null,AbortControllerCtor:AbortController,setTimeoutFn:()=>1,clearTimeoutFn:()=>{}}));
  await Promise.all(clients.map(async(client,index)=>{
    const url='https://api.github.com/tab/'+index;
    await Promise.all([client.requestJson(url),client.requestJson(url)]);
    assert.equal(client.getRateState().coordination,'TAB_LOCAL_ONLY');
  }));
  assert.equal(calls,3,'same-tab duplicates merge; separate tabs are not falsely treated as one quota client');
  const empty=api.createResourceStore(clients[0],()=>1_000_000);
  assert.equal(api.sourceStatusLabel(empty.resources.issue,1_000_000,api.constants.ISSUE_POLL_MS),'UNKNOWN',
    'a reload with unavailable storage has no invented historical success');
});

test('browser renderer shows exact-head 3/1/1 checks and fails closed on API errors', async () => {
  const html = readFileSync(new URL('../operator-panel/index.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  const elements = new Map();
  class Element {
    constructor() { this.children=[]; this.textContent=''; this.className=''; this.disabled=false; this.listeners={}; }
    addEventListener(name, callback) { this.listeners[name]=callback; }
    appendChild(child) { this.children.push(child); }
    removeChild(child) { this.children.splice(this.children.indexOf(child),1); }
    get firstChild() { return this.children[0] || null; }
  }
  const document = {
    visibilityState:'visible',
    getElementById(id) { if (!elements.has(id)) elements.set(id,new Element()); return elements.get(id); },
    createElement() { return new Element(); },
    addEventListener() {},
  };
  let testNow=Date.now();
  class TestDate extends Date { static now() { return testNow; } }
  const observedAt = new Date(Date.now()-30_000).toISOString();
  const snapshot = observation({
    observed_at:observedAt,
    published_at:new Date(Date.now()-20_000).toISOString(),
    expires_at:new Date(Date.now()+5*60_000).toISOString(),
    source:{main_sha:'a'.repeat(40),comment_id:42},
    windows:{status:'FRESH',observed_at:observedAt,tasks_total:225,
      legacy_monitor_registered:false,listener_2667:false,
      native_task:{registered:true,enabled:true,state:'READY',action_kind:'WINDOWLESS_LAUNCHER',
        identity_class:'INTERACTIVE_LIMITED',multiple_instances:'IGNORENEW',
        trigger_interval_minutes:5,last_run:observedAt,last_result:'0x00000000'},
      runner_service_count:1,runner_service_running:1},
    native_worker:{current_task:null,latest_task:null},
    opencode_v2:{installed_version:'opencode v2.0.27',process_count:0,
      process_observed_at:observedAt,historical_sessions_count:42},
  });
  const comments=[{id:42,body:encodeOperatorObservation(snapshot),
    user:{login:'wfvupu1212'},created_at:observedAt,
    updated_at:new Date(Date.now()-10_000).toISOString()},candidatePrJobComment(434, 'a'.repeat(40),43)];
  const sha='a'.repeat(40);
  const pr={number:434,draft:true,merged:false,state:'open',head:{sha},base:{sha}};
  const payload=(url) => url.includes('/issues/407') ? comments
    : url.endsWith('/pulls/434') ? pr
    : url.endsWith('/commits/main') ? {sha}
    : {check_runs:[
      ...[1,2,3].map(n => ({name:'success-' + n,head_sha:sha,status:'completed',conclusion:'success'})),
      {name:'waiting',head_sha:sha,status:'pending',conclusion:null},
      {name:'skipped',head_sha:sha,status:'completed',conclusion:'skipped'},
    ]};
  let failChecks = false;
  const intervalCallbacks=[];
  let browserCalls=0;
  const window = {
    AbortController,
    setTimeout, clearTimeout, setInterval:fn => { intervalCallbacks.push(fn); return intervalCallbacks.length; },
    fetch:async url => { browserCalls++;
      return failChecks && url.includes('/check-runs')
      ? {status:503,ok:false,headers:{get:name => name.toLowerCase()==='x-ratelimit-remaining' ? '8' : null}}
      : ({status:200,ok:true,
      headers:{get:name => name.toLowerCase()==='etag' ? '"etag-live"' :
        name.toLowerCase()==='x-ratelimit-remaining' ? '50' : null},
      json:async () => payload(url)});
    },
  };
  vm.runInNewContext(script,{window,document,Date:TestDate,Number,String,Array,JSON,RegExp,AbortController});
  await new Promise(resolve => setTimeout(resolve,20));
  assert.match(elements.get('overall').className,/fresh/);
  assert.match(elements.get('metric-workers').textContent,/0／3/);
  assert.equal(elements.get('w1-badge').textContent,'狀態未確認');
  assert.equal(elements.get('w2-badge').textContent,'狀態未確認');
  assert.equal(elements.get('w3-badge').textContent,'狀態未確認');
  assert.equal(elements.get('runner-badge').textContent,'等待檢查結果');
  assert.match(elements.get('runner-checks').textContent,/成功 3／失敗 0／queued 0／pending 1/);
  assert.match(elements.get('runner-checks').textContent,/略過或 neutral 1/);
  assert.match(elements.get('pr-state').textContent,/Draft/);
  assert.match(elements.get('opencode-detail').textContent,/42/);
  assert.match(elements.get('rate-alert-title').textContent,/跨分頁鎖與公開快取未確認/);
  assert.equal(browserCalls,4,'startup reads the four sources once in dependency order');
  testNow += 5*60*1000;
  intervalCallbacks[0]();
  await new Promise(resolve => setTimeout(resolve,20));
  assert.equal(browserCalls,4,'without cross-tab quota coordination, automatic polling is disabled after startup');
  assert.match(elements.get('next-sync').textContent,/自動輪詢停用/);

  failChecks = true;
  testNow += 15*60*1000 + 1;
  await elements.get('refresh').listeners.click();
  assert.equal(elements.get('runner-badge').textContent,'CI 未確認');
  assert.equal(elements.get('checks-detail').textContent,'精確 HEAD 檢查未知：GITHUB_HTTP_503');
  assert.match(elements.get('overall-copy').textContent,/checks:GITHUB_HTTP_503/);
});

test('browser shows the shared rate-limit pause, recovery countdown, and historical/unknown state', async () => {
  const html=readFileSync(new URL('../operator-panel/index.html',import.meta.url),'utf8');
  const script=html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  const elements=new Map();
  class Element {
    constructor() { this.children=[]; this.textContent=''; this.className=''; this.disabled=false; this.listeners={}; this.hidden=false; }
    addEventListener(name,callback) { this.listeners[name]=callback; }
    appendChild(child) { this.children.push(child); }
    removeChild(child) { this.children.splice(this.children.indexOf(child),1); }
    get firstChild() { return this.children[0] || null; }
  }
  const document={visibilityState:'visible',getElementById(id) {
    if (!elements.has(id)) elements.set(id,new Element()); return elements.get(id);
  },createElement() { return new Element(); },addEventListener() {}};
  let calls=0, time=Date.now();
  class TestDate extends Date { static now() { return time; } }
  const timers=[];
  const window={__PTYSD_TEST__:false,AbortController,
    get localStorage() { throw new Error('file origin storage unavailable'); },
    setTimeout:(fn,ms) => { timers.push({fn,ms}); return timers.length; },clearTimeout:()=>{},setInterval:()=>1,
    fetch:async()=>{calls++;return {status:403,ok:false,headers:{get:name=>({
      'x-ratelimit-limit':'60','x-ratelimit-remaining':'0',
      'x-ratelimit-reset':String(Math.floor((time+120_000)/1000)),'retry-after':'120',
    }[name.toLowerCase()] ?? null)},json:async()=>({message:'API rate limit exceeded'})};}};
  vm.runInNewContext(script,{window,document,Date:TestDate,Number,String,Array,JSON,RegExp,AbortController});
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(calls,1,'the exhausted Issue response stops PR, main, and checks requests');
  assert.match(elements.get('rate-alert-title').textContent,/GitHub API 額度暫時耗盡/);
  assert.match(elements.get('rate-alert-detail').textContent,/剩餘額度：0／60/);
  assert.match(elements.get('rate-alert-detail').textContent,/00:02:00/);
  assert.match(elements.get('rate-alert-detail').textContent,/下一次允許讀取/);
  assert.match(elements.get('overall-title').textContent,/Win11 實際工作狀態目前未知/);
  assert.match(elements.get('rate-alert-detail').textContent,/跨分頁鎖與公開資料快取未同時確認/);
  await elements.get('refresh').listeners.click();
  await elements.get('refresh').listeners.click();
  assert.equal(calls,1,'manual sync cannot bypass the shared cooldown');
  assert.equal(timers.some(timer=>timer.ms>=119_000),false,
    'a file-origin browser without shared storage and Web Locks does not launch duplicate recovery probes');
  assert.equal(elements.get('w1-badge').textContent,'狀態未確認');
  assert.equal(elements.get('w2-badge').textContent,'狀態未確認');
  assert.equal(elements.get('w3-badge').textContent,'狀態未確認');
});
