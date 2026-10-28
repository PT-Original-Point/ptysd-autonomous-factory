import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import './native-worker-install-bundle.test.mjs';
import {
  OPERATOR_MARKER, encodeOperatorObservation, parseOperatorObservation,
  OPERATOR_COMMENT_ID, findOperatorComment, updateExistingOperatorComment, observationFreshness,
  collectWindowsObservation, collectRuntimeDeployment,
} from '../native-bridge/operator-observation.mjs';
import {
  JOB_MARKER, RECEIPT_MARKER, PROJECT, REPO,
  publishOperatorObservation, receipt as workerReceipt,
} from '../native-bridge/worker.mjs';

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
  expires_at: new Date(now + 5 * 60 * 1000).toISOString(),
  source: { main_sha: 'a'.repeat(40), comment_id: 1,
    issue_comments_observed_at: new Date(now).toISOString() },
  windows: { status: 'FRESH', native_task: { enabled: false } },
  ...overrides,
});
const comment = (value, login = 'trusted-publisher', id = 1) => ({
  id, body: encodeOperatorObservation(value), user: { login }, updated_at: value.observed_at,
});

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
  assert.throws(() => encodeOperatorObservation(observation({ publisher_login: 'bad login' })),
    /INVALID_OPERATOR_OBSERVATION/);
  assert.throws(() => encodeOperatorObservation(observation({ comment_author_login: 'bad/login' })),
    /INVALID_OPERATOR_OBSERVATION/);
});

test('operator snapshot rejects malformed source main SHA but keeps legacy snapshots without it readable', () => {
  for (const main_sha of ['not-a-git-sha', 'g'.repeat(40), 'a'.repeat(39)]) {
    const malformed = observation({ source: { ...observation().source, main_sha } });
    assert.equal(parseOperatorObservation(OPERATOR_MARKER + JSON.stringify(malformed)), null);
  }
  assert.equal(parseOperatorObservation(OPERATOR_MARKER + JSON.stringify(
    observation({ source: 'malformed' }))), null);

  const priorRuntimeFiles = ['worker.mjs', 'opencode-v2.mjs', 'v2-readiness.mjs',
    'codex-continuation.mjs', 'operator-observation.mjs', 'captured-process.mjs',
    'safe-error-code.mjs', 'windows-executor.mjs'];
  const priorRuntime = observation({ runtime_deployment: {
    status: 'MANIFEST_MATCHED', observed_at: new Date(now).toISOString(),
    source_main_sha: 'a'.repeat(40), deployment_pr: 462, deployment_pr_head: 'b'.repeat(40),
    bundle_sha256: 'c'.repeat(64),
    component_sha256: Object.fromEntries(priorRuntimeFiles.map(name => [name, 'd'.repeat(64)])),
  } });
  const migratedRuntime = parseOperatorObservation(OPERATOR_MARKER + JSON.stringify(priorRuntime));
  assert.equal(migratedRuntime.runtime_deployment.status, 'UNKNOWN',
    'a prior manifest without the newly required quota module cannot attest the new runtime');
  assert.equal(migratedRuntime.runtime_deployment.reason_code, 'RUNTIME_FILES_UNAVAILABLE');
  assert.equal(migratedRuntime.runtime_deployment.component_sha256['antigravity-quota.mjs'], null);

  const legacySource = { ...observation().source };
  delete legacySource.main_sha;
  const legacy = observation({ source: legacySource });
  assert.equal(parseOperatorObservation(OPERATOR_MARKER + JSON.stringify(legacy))?.source.main_sha,
    undefined);
});

test('operator snapshot accepts the GitHub-supported body range beyond the old local ceiling', () => {
  const base = observation({
    windows: { status: 'FRESH', native_task: { enabled: false }, summary: '' },
  });
  const emptyBody = OPERATOR_MARKER + JSON.stringify(base);
  const padding = 'x'.repeat(65_536 - emptyBody.length);
  const maximumValue = { ...base, windows: { ...base.windows, summary: padding } };
  const maximumBody = OPERATOR_MARKER + JSON.stringify(maximumValue);
  assert.equal(maximumBody.length, 65_536);
  assert.equal(parseOperatorObservation(maximumBody)?.windows.summary.length, padding.length);

  const oversizedValue = { ...base, windows: { ...base.windows, summary: `${padding}x` } };
  const oversizedBody = OPERATOR_MARKER + JSON.stringify(oversizedValue);
  assert.equal(oversizedBody.length, 65_537);
  assert.equal(parseOperatorObservation(oversizedBody), null);
});

test('snapshot does not duplicate GitHub publication time; legacy published_at remains readable', () => {
  const current = observation();
  assert.equal(parseOperatorObservation(encodeOperatorObservation(current)).published_at, undefined);
  const legacy = { ...current, published_at: current.observed_at };
  assert.equal(parseOperatorObservation(OPERATOR_MARKER + JSON.stringify(legacy)).published_at,
    current.observed_at);
});

test('runtime source identity is published only when a deployment manifest matches every installed module', () => {
  const root=mkdtempSync(join(tmpdir(),'pty-runtime-fingerprint-'));
  const runtimeDir=join(root,'runtime');
  const backup=join(runtimeDir,'backups','worker-deploy-accepted-fixture');
  const installer=readFileSync(new URL('../native-bridge/install.ps1',import.meta.url),'utf8');
  const runtimeBundle=installer.match(/\$runtimeFiles\s*=\s*@\(([\s\S]*?)\)/i);
  assert.ok(runtimeBundle,'installer declares the deployed Worker runtime bundle');
  const files=[...runtimeBundle[1].matchAll(/['"]([^'"]+\.mjs)['"]/g)].map(match=>match[1]);
  const digest=value=>createHash('sha256').update(value).digest('hex');
  try {
    mkdirSync(backup,{recursive:true});
    const staged=files.map(file=>{
      const bytes=Buffer.from('verified runtime component ' + file);
      writeFileSync(join(runtimeDir,file),bytes);
      return {file,stage_sha256:digest(bytes)};
    });
    const manifest={schema:1,source_main_sha:'a'.repeat(40),accepted_pr:462,
      accepted_pr_head:'b'.repeat(40),files:staged};
    writeFileSync(join(backup,'manifest.json'),JSON.stringify(manifest));
    const verified=collectRuntimeDeployment({runtimeDir,now:()=>new Date(now).toISOString()});
    assert.equal(verified.status,'MANIFEST_MATCHED');
    assert.deepEqual(Object.keys(verified.component_sha256).sort(),[...files].sort(),
      'runtime fingerprint covers every module copied by the production installer');
    assert.equal(verified.source_main_sha,'a'.repeat(40));
    assert.equal(verified.deployment_pr,462);
    assert.equal(verified.component_sha256['worker.mjs'],staged[0].stage_sha256);
    assert.equal(parseOperatorObservation(encodeOperatorObservation(observation({
      runtime_deployment:verified,
    }))).runtime_deployment.status,'MANIFEST_MATCHED');
    assert.equal(JSON.stringify(verified).includes(root),false,'public fingerprint must not expose local paths');

    const duplicateFiles={...manifest,files:[...staged,staged[0]]};
    writeFileSync(join(backup,'manifest.json'),JSON.stringify(duplicateFiles));
    const duplicateEntry=collectRuntimeDeployment({runtimeDir,now:()=>new Date(now).toISOString()});
    assert.equal(duplicateEntry.status,'UNKNOWN','duplicate module entries must fail closed');
    assert.equal(duplicateEntry.reason_code,'DEPLOYMENT_MANIFEST_NOT_MATCHED');
    writeFileSync(join(backup,'manifest.json'),JSON.stringify(manifest));

    const conflictingBackup=join(runtimeDir,'backups','worker-deploy-accepted-conflicting');
    mkdirSync(conflictingBackup,{recursive:true});
    writeFileSync(join(conflictingBackup,'manifest.json'),JSON.stringify({...manifest,
      accepted_pr:463,accepted_pr_head:'c'.repeat(40)}));
    const ambiguous=collectRuntimeDeployment({runtimeDir,now:()=>new Date(now).toISOString()});
    assert.equal(ambiguous.status,'UNKNOWN','different matching deployment identities are ambiguous');
    assert.equal(ambiguous.reason_code,'DEPLOYMENT_MANIFEST_AMBIGUOUS');
    rmSync(conflictingBackup,{recursive:true,force:true});

    writeFileSync(join(runtimeDir,'opencode-v2.mjs'),'dependency changed after deployment');
    const dependencyMismatch=collectRuntimeDeployment({runtimeDir,now:()=>new Date(now).toISOString()});
    assert.equal(dependencyMismatch.status,'UNKNOWN',
      'a changed non-entry runtime dependency must invalidate deployment identity');
    assert.equal(dependencyMismatch.reason_code,'DEPLOYMENT_MANIFEST_NOT_MATCHED');
    writeFileSync(join(runtimeDir,'opencode-v2.mjs'),Buffer.from('verified runtime component opencode-v2.mjs'));

    writeFileSync(join(runtimeDir,'worker.mjs'),'changed after deployment');
    const mismatch=collectRuntimeDeployment({runtimeDir,now:()=>new Date(now).toISOString()});
    assert.equal(mismatch.status,'UNKNOWN');
    assert.equal(mismatch.reason_code,'DEPLOYMENT_MANIFEST_NOT_MATCHED');
    assert.equal(mismatch.source_main_sha,undefined,'a stale manifest must not claim the deployed commit');
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});

test('one trusted observation comment is updated; missing, duplicate, or foreign author fails closed', () => {
  assert.equal(findOperatorComment([], 'trusted-publisher').status, 'NOT_SEEDED');
  assert.equal(findOperatorComment([comment(observation())], 'trusted-publisher').status, 'OK');
  assert.equal(findOperatorComment([comment(observation({ source: {
    ...observation().source, comment_id: 2,
  } }))], 'trusted-publisher').error, 'OPERATOR_COMMENT_ID_MISMATCH');
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
    expires_at:new Date(now+6*60_000).toISOString(),
  });
  const body = encodeOperatorObservation(updatedValue);
  const confirmedAt = new Date(now + 61_000).toISOString();
  const result = await updateExistingOperatorComment({
    comments:[original], expectedLogin:'trusted-publisher', body,
    readComment:async id => ({ ...stored, id }),
    patchComment:async (id, next) => {
      writes.push({ id, next }); stored={ ...stored, body:next, updated_at:confirmedAt };
    },
    readComments:async () => [stored],
    now:() => now + 61_000,
  });
  assert.equal(result.status,'UPDATED');
  assert.equal(result.comment_id,1);
  assert.equal(writes.length,1);
  assert.equal(writes[0].id,1);
  assert.equal(stored.body,body);
  assert.equal(result.github_updated_at,confirmedAt,
    'publication time comes from the exact GitHub comment readback');
  assert.equal(result.observation.snapshot_id,updatedValue.snapshot_id);
  assert.equal(result.observation.sequence,updatedValue.sequence);

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

test('publisher rejects a higher sequence whose observed_at does not advance', async () => {
  const original = comment(observation());
  const value = observation({ sequence:2,
    snapshot_id:'11c95b35-bda3-4d54-9f91-431730ed5acd' });
  const stored = original;
  let patchCount = 0;
  const result = await updateExistingOperatorComment({
    comments:[original], expectedLogin:'trusted-publisher', body:encodeOperatorObservation(value),
    readComment:async id => ({ ...stored, id }),
    patchComment:async () => { patchCount += 1; },
    readComments:async () => [stored],
    now:() => now + 10_000,
  });
  assert.equal(result.status,'UNKNOWN');
  assert.equal(result.error,'OPERATOR_OBSERVED_AT_NOT_MONOTONIC');
  assert.equal(patchCount,0,'reject before performing the external write');
});

test('publisher rejects a confirmed update whose GitHub updated_at did not advance', async () => {
  const original = comment(observation());
  const value = observation({ sequence:2,
    snapshot_id:'11c95b35-bda3-4d54-9f91-431730ed5acd',
    observed_at:new Date(now + 1000).toISOString() });
  let stored = original;
  const result = await updateExistingOperatorComment({
    comments:[original], expectedLogin:'trusted-publisher', body:encodeOperatorObservation(value),
    readComment:async id => ({ ...stored, id }),
    patchComment:async (_id, body) => { stored={ ...stored, body }; },
    readComments:async () => [stored],
    now:() => now + 10_000,
  });
  assert.equal(result.status,'UNKNOWN');
  assert.equal(result.error,'OPERATOR_COMMENT_UPDATE_TIME_NOT_MONOTONIC');
});

test('publisher does not report success when GitHub readback omits updated_at', async () => {
  const original = comment(observation());
  const value = observation({ sequence:2, snapshot_id:'11c95b35-bda3-4d54-9f91-431730ed5acd',
    observed_at:new Date(now + 1000).toISOString() });
  let stored = original;
  const result = await updateExistingOperatorComment({
    comments:[original], expectedLogin:'trusted-publisher', body:encodeOperatorObservation(value),
    readComment:async id => ({ ...stored, id }),
    patchComment:async (_id, body) => { stored={ ...stored, body, updated_at:undefined }; },
    readComments:async () => [stored],
    now:() => now + 10_000,
  });
  assert.equal(result.status,'UNKNOWN');
  assert.equal(result.error,'OPERATOR_COMMENT_UPDATED_AT_UNKNOWN');
});

test('publisher rejects a GitHub updated_at outside the snapshot TTL', async () => {
  const original = comment(observation());
  const value = observation({ sequence:2, snapshot_id:'11c95b35-bda3-4d54-9f91-431730ed5acd',
    observed_at:new Date(now + 1000).toISOString() });
  let stored = original;
  const result = await updateExistingOperatorComment({
    comments:[original], expectedLogin:'trusted-publisher', body:encodeOperatorObservation(value),
    readComment:async id => ({ ...stored, id }),
    patchComment:async (_id, body) => { stored={ ...stored, body, updated_at:value.expires_at }; },
    readComments:async () => [stored],
    now:() => now + 10_000,
  });
  assert.equal(result.status,'UNKNOWN');
  assert.equal(result.error,'OPERATOR_COMMENT_UPDATE_TIME_INVALID');
});

test('expired observations degrade to STALE and future timestamps to UNKNOWN', () => {
  const valid = observation();
  assert.equal(observationFreshness(valid, now), 'FRESH');
  assert.equal(observationFreshness(valid, now + 6 * 60 * 1000), 'STALE');
  assert.equal(observationFreshness({
    ...valid, observed_at: new Date(now + 6 * 60 * 1000).toISOString(),
  }, now), 'UNKNOWN');
});

test('Windows collector reads only named PTYSD tasks and publishes only allowlisted fields', () => {
  let invoked = false;
  const ignored = collectWindowsObservation({
    platformName: 'linux',
    execute: () => { invoked = true; },
  });
  assert.equal(ignored.status, 'UNKNOWN');
  assert.equal(invoked, false);

  const raw = {
    observed_at: new Date(now).toISOString(),
    legacy_monitor_registered: false,
    listener_2667: false,
    opencode_process_count: 0,
    runner_service_count: 1,
    runner_service_running: 1,
    executor_tasks: {
      opencode: { registered: true, enabled: true, state: 'Ready',
        last_run: new Date(now - 5 * 60 * 1000).toISOString(), last_result: '0x00000000' },
      antigravity: { registered: true, enabled: false, state: 'Disabled',
        last_run: null, last_result: null },
      codex: { registered: true, enabled: true, state: 'Ready',
        last_run: new Date(now - 10 * 60 * 1000).toISOString(), last_result: '0x00000000' },
    },
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
      assert.equal(options.timeout, 30_000);
      return JSON.stringify(raw);
    },
  });
  assert.equal(live.status, 'FRESH');
  assert.equal(Object.hasOwn(live, 'tasks_total'), false);
  assert.equal(live.native_task.enabled, false);
  assert.equal(live.native_task.identity_class, 'INTERACTIVE_LIMITED');
  assert.equal(live.native_task.multiple_instances, 'IGNORENEW');
  assert.equal(live.native_task.action_kind, 'WINDOWLESS_LAUNCHER');
  assert.equal(live.opencode_process_count, 0);
  assert.equal(live.runner_service_running, 1);
  assert.deepEqual(live.executor_tasks, {
    opencode: { registered: true, enabled: true, state: 'READY',
      last_run: new Date(now - 5 * 60 * 1000).toISOString(), last_result: '0X00000000' },
    antigravity: { registered: true, enabled: false, state: 'DISABLED',
      last_run: null, last_result: null },
    codex: { registered: true, enabled: true, state: 'READY',
      last_run: new Date(now - 10 * 60 * 1000).toISOString(), last_result: '0X00000000' },
  });
  assert.equal(Object.hasOwn(live, 'command_line'), false);
  assert.equal(Object.hasOwn(live, 'active_sessions'), false);
  const collectorSource = readFileSync(new URL('../native-bridge/operator-observation.mjs', import.meta.url), 'utf8');
  assert.match(collectorSource, /Get-ExactTask 'PTYSD-Native-OpenCode'/);
  assert.match(collectorSource, /Get-ExactTask 'PTYSD-Factory-Monitor'/);
  assert.match(collectorSource, /PTYSD-OpenCode-Executor/);
  assert.match(collectorSource, /PTYSD-Antigravity-Executor/);
  assert.match(collectorSource, /PTYSD-Codex-Executor/);
  assert.doesNotMatch(collectorSource, /\$all\s*=\s*@\(Get-ScheduledTask/);
  assert.match(collectorSource, /wscript\.exe[\s\S]+HiddenWorker\\\.vbs/);
  assert.match(collectorSource, /Name='opencode2\.exe' OR Name='opencode-cli\.exe' OR Name='opencode\.exe'/,
    'process inventory must include the installed OpenCode V2 CLI executable name');

  const legacy = collectWindowsObservation({
    platformName: 'win32',
    execute: () => JSON.stringify({ ...raw, tasks_total: 225,
      active_sessions: 'NOT_SAFELY_QUERIED' }),
  });
  assert.equal(legacy.status, 'FRESH', 'historical extra fields remain safely ignorable');
  assert.equal(Object.hasOwn(legacy, 'tasks_total'), false);
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
  const updatedAt = new Date(Date.parse(valid.observed_at) + 1000).toISOString();
  assert.equal(api.findSnapshot([{ id:1, body, updated_at:updatedAt,
    user: { login: 'wfvupu1212' } }], now).status, 'FRESH');
  const malformedSourceBody = OPERATOR_MARKER + JSON.stringify({ ...valid,
    source: { ...valid.source, main_sha: 'g'.repeat(40) } });
  assert.equal(api.findSnapshot([{ id:1, body:malformedSourceBody, updated_at:updatedAt,
    user: { login: 'wfvupu1212' } }], now).error, 'AUTHOR_OR_SCHEMA_MISMATCH');
  assert.equal(api.findSnapshot([{ id:2, body, updated_at:updatedAt,
    user: { login: 'wfvupu1212' } }], now).error,
    'OBSERVATION_COMMENT_ID_MISMATCH');
  assert.equal(api.findSnapshot([{ body, user: { login: 't14210184' } }], now).status, 'UNKNOWN');
  assert.equal(api.findSnapshot([{ body }, { body }], now).error, 'DUPLICATE_OBSERVATIONS');
  assert.equal(api.findSnapshot([{ id:1, body, updated_at:updatedAt,
    user: { login: 'wfvupu1212' } }], now + 6 * 60 * 1000).status, 'STALE');
  assert.equal(api.findSnapshot([{ id:1, body, user: { login: 'wfvupu1212' } }], now).error,
    'GITHUB_UPDATED_AT_UNKNOWN');

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
  const waitingJob = { schema:2,project_id:valid.project_id,host:'DESKTOP-1B6PD2P',
    request_id:'PTYSD_OPENCODE_WAITING_UI_20261018',kind:'opencode_plan',source_sha:main,
    spec_path:'native-bridge/tasks/waiting-ui.md',spec_sha256:'b'.repeat(64),
    model:'opencode/spark',variant:'high' };
  const waitingAttempt = '9c8b6130-de76-4220-a7d6-a4bdabea1d18';
  const waitingComments = [
    { id:10, body:'PTYSD_NATIVE_JOB_V1\n'+JSON.stringify(waitingJob), user:{login:'t14210184'} },
    { id:11, body:'PTYSD_NATIVE_RECEIPT_V1\n'+JSON.stringify({
      schema:1,project_id:valid.project_id,host:'DESKTOP-1B6PD2P',request_id:waitingJob.request_id,
      attempt_id:waitingAttempt,state:'STARTED',kind:waitingJob.kind,source_sha:main,
    }), user:{login:'t14210184'}, created_at:new Date(now).toISOString() },
    { id:12, body:'PTYSD_NATIVE_RECEIPT_V1\n'+JSON.stringify({
      schema:1,project_id:valid.project_id,host:'DESKTOP-1B6PD2P',request_id:waitingJob.request_id,
      attempt_id:waitingAttempt,state:'WAITING',kind:waitingJob.kind,source_sha:main,
      outcome:'OPENCODE_V2_AUTH_NOT_READY',eligibility_state:'WAITING',
      exit_code:48,model_invoked:false,
    }), user:{login:'t14210184'}, created_at:new Date(now+1).toISOString() },
  ];
  const waitingTask = api.latestTask(waitingComments, main);
  assert.equal(waitingTask.state,'執行資格待確認；條件恢復後可重評估');
  assert.equal(api.normalizeFormalTask(waitingTask).state,'WAITING_ELIGIBILITY');
  assert.equal(api.classifyW1({process_count:0},{current_task:null},'FRESH',now,
    api.normalizeFormalTask(waitingTask)).status,'PENDING');
  assert.match(api.classifyW1({process_count:0},{current_task:null},'FRESH',now,
    api.normalizeFormalTask(waitingTask)).reason,/執行資格待確認/);
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
  ] }, main, 437).status, 'PENDING');
  assert.equal(api.summarizeChecks({ check_runs:[
    { head_sha:main, status:'completed', conclusion:'success' },
  ] }, main, 437).counts.success, 1);
  assert.equal(api.summarizeChecks({ check_runs:[] }, main, 437).status, 'UNKNOWN');
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
  assert.match(api.workerChangeLabel('W1', { code_changes:'DIFF_CAPTURED_UNVERIFIED',
    changed_files_count:2 }, {}), /收據記錄 2 個檔案.*尚未由 Codex 驗證或接受/);
  assert.match(api.workerChangeLabel('W2', { code_changes:'DIFF_CAPTURED_UNVERIFIED',
    changed_files_count:null }, {}), /檔案數未確認.*尚未由 Codex 驗證或接受/);
  assert.equal(api.workerChangeLabel('W1', { code_changes:'UNPROVEN', files_modified:'UNPROVEN' }, {}),
    '尚未證實有同任務程式修改。');
  assert.match(html, /snapshot\.publisher_login/);
  assert.match(html, /snapshot\.comment_author_login/);
});

test('check-run states stay bound to exact SHA and skipped/cancelled are not passes', () => {
  const script = readFileSync(new URL('../operator-panel/index.html', import.meta.url), 'utf8')
    .match(/<script>([\s\S]*?)<\/script>/)[1];
  const window = { __PTYSD_TEST__: true };
  vm.runInNewContext(script, { window, document: {}, Date, Number, String, Array, JSON, RegExp });
  const api = window.PTYSDOperatorPanel;
  const sha = 'a'.repeat(40);
  const summarize = rows => api.summarizeChecks({check_runs:rows},sha,437);
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
  store.bindPullRequest({ number: 437 });
  const checkUrl1 = store.bindChecksHead(head1);
  assert.equal(await store.loadResource('checks',checkUrl1,api.constants.CHECKS_POLL_MS),original);
  assert.equal(store.resources.checks.data,original);
  assert.equal(Object.hasOwn(store.resources.checks.data,'payload'),false);
  assert.equal(Object.hasOwn(store.resources.checks.data,'headSha'),false);
  let summary = store.checksSummaryForHead(head1,437);
  assert.equal(summary.head_sha,head1);
  assert.equal(summary.counts.total,5);
  assert.equal(summary.counts.success,3);
  assert.equal(summary.counts.pending,1);
  assert.equal(summary.counts.skipped,1);

  clock += api.constants.ISSUE_POLL_MS;
  store.bindChecksHead(head1);
  assert.equal(await store.loadResource('checks',checkUrl1,api.constants.CHECKS_POLL_MS),original);
  assert.equal(calls.length,1,'the 5-minute dashboard poll reuses the 15-minute checks resource');
  assert.equal(store.checksSummaryForHead(head1,437).counts.pending,1);

  clock += api.constants.CHECKS_POLL_MS - api.constants.ISSUE_POLL_MS;
  assert.equal(await store.loadResource('checks',checkUrl1,api.constants.CHECKS_POLL_MS),original);
  assert.equal(calls.length,2,'the 15-minute refresh revalidates with GitHub');
  assert.equal(calls[1].init.headers['If-None-Match'],'"checks-v1"');
  assert.equal(store.resources.checks.data,original,'ETag 304 restores the raw cached API response');
  assert.equal(store.checksSummaryForHead(head1,437).counts.success,3);

  clock += 1;
  assert.equal(await store.loadResource('checks',checkUrl1,api.constants.CHECKS_POLL_MS,true),original);
  assert.equal(calls.length,3,'manual sync revalidates even while the regular resource TTL is fresh');
  assert.equal(calls[2].init.cache,'no-cache');
  assert.equal(calls[2].init.headers['If-None-Match'],'"checks-v1"');
  assert.equal(store.resources.checks.data,original);
  assert.equal(store.checksSummaryForHead(head1,437).counts.skipped,1);

  const checkUrl2 = store.bindChecksHead(head2);
  assert.notEqual(checkUrl2,checkUrl1);
  assert.equal(store.resources.checks.data,null,'a changed HEAD cannot reuse the previous HEAD body');
  assert.equal(store.checksSummaryForHead(head2,437),null);
  assert.equal(await store.loadResource('checks',checkUrl2,api.constants.CHECKS_POLL_MS),changedHead);
  summary = store.checksSummaryForHead(head2,437);
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
    const timestamp=new Date(time).toISOString();
    const snapshot={schema:1,project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE',
      repo:'PT-Original-Point/ptysd-autonomous-factory',issue:407,host_alias:'win11-primary',
      snapshot_id:'11111111-1111-4111-8111-111111111111',sequence:1,observed_at:timestamp,
      expires_at:new Date(time+10*60_000).toISOString(),source:{comment_id:42},
      native_worker:{latest_task:{request_id:'PTYSD_PANEL_HOUR_TEST_20261016',
        kind:'opencode_edit',source_pr:437,source_sha:head,state:'QUEUED_NOT_STARTED'}}};
    const data=url.includes('/issues/407') ? [{id:42,user:{login:'wfvupu1212'},updated_at:timestamp,
      body:'PTYSD_OPERATOR_OBSERVATION_V1\n'+JSON.stringify(snapshot)}]
      : url.endsWith('/pulls/437') ? {number:437,state:'open',head:{sha:head,
        repo:{id:1352411536,full_name:'PT-Original-Point/ptysd-autonomous-factory'}},
        base:{sha:'b'.repeat(40),ref:'main',repo:{id:1352411536,
          full_name:'PT-Original-Point/ptysd-autonomous-factory'}}}
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
    pr:'https://api.github.com/pulls/437',main:'https://api.github.com/commits/main'};
  await Promise.all([api.runSyncCycle(store,client,urls),api.runSyncCycle(store,client,urls)]);
  assert.equal(requests.length,4,'overlapping same-page refreshes share each resource request');
  assert.equal(maxActive,1,'startup requests are serialized rather than burst in parallel');
  assert.match(requests[0],/issues\/407/);
  assert.match(requests[1],/pulls\/437/);
  assert.match(requests[2],/commits\/main/);
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
    pr:'https://api.github.com/pulls/437',main:'https://api.github.com/commits/main'};
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
  const sha='a'.repeat(40);
  const observedAt = new Date(Date.now()-30_000).toISOString();
  const snapshot = observation({
    observed_at:observedAt,
    expires_at:new Date(Date.now()+5*60_000).toISOString(),
    source:{main_sha:'a'.repeat(40),comment_id:42},
    windows:{status:'FRESH',observed_at:observedAt,
      legacy_monitor_registered:false,listener_2667:false,
      native_task:{registered:true,enabled:true,state:'READY',action_kind:'WINDOWLESS_LAUNCHER',
        identity_class:'INTERACTIVE_LIMITED',multiple_instances:'IGNORENEW',
        trigger_interval_minutes:5,last_run:observedAt,last_result:'0x00000000'},
      runner_service_count:1,runner_service_running:1},
    native_worker:{current_task:null,latest_task:{request_id:'PTYSD_PANEL_RENDER_TEST_20261016',
      kind:'opencode_edit',source_pr:437,source_sha:sha,state:'QUEUED_NOT_STARTED'}},
    opencode_v2:{installed_version:'opencode v2.0.27',process_count:0,
      process_observed_at:observedAt,historical_sessions_count:42},
    runtime_deployment:{status:'MANIFEST_MATCHED',observed_at:observedAt,source_main_sha:sha,
      deployment_pr:462,deployment_pr_head:'b'.repeat(40),bundle_sha256:'c'.repeat(64),
      component_sha256:{'worker.mjs':'d'.repeat(64),'operator-observation.mjs':'e'.repeat(64),
        'codex-continuation.mjs':'f'.repeat(64),'safe-error-code.mjs':'1'.repeat(64),
        'opencode-v2.mjs':'2'.repeat(64),'v2-readiness.mjs':'3'.repeat(64),
        'antigravity-quota.mjs':'6'.repeat(64),
        'captured-process.mjs':'4'.repeat(64),'windows-executor.mjs':'5'.repeat(64)}},
  });
  const comments=[{id:42,body:encodeOperatorObservation(snapshot),
    user:{login:'wfvupu1212'},created_at:observedAt,
    updated_at:new Date(Date.now()-20_000).toISOString()}];
  const refreshedComments = () => {
    const timestamp=new Date(testNow-30_000).toISOString();
    snapshot.observed_at=timestamp;
    snapshot.expires_at=new Date(testNow+5*60_000).toISOString();
    snapshot.windows.observed_at=timestamp;
    comments[0].updated_at=new Date(testNow-20_000).toISOString();
    comments[0].body=encodeOperatorObservation(snapshot);
    return comments;
  };
  const pr={number:437,draft:true,merged:false,state:'open',head:{sha,
    repo:{id:1352411536,full_name:'PT-Original-Point/ptysd-autonomous-factory'}},
    base:{sha,ref:'main',repo:{id:1352411536,full_name:'PT-Original-Point/ptysd-autonomous-factory'}}};
  const payload=(url) => url.includes('/issues/407') ? refreshedComments()
    : url.endsWith('/pulls/437') ? pr
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
  assert.equal(elements.get('w1-activity').textContent,'沒有可核對的近期活動時間',
    'process observation time alone is not model or tool activity');
  assert.equal(elements.get('w2-badge').textContent,'狀態未確認');
  assert.equal(elements.get('w3-badge').textContent,'狀態未確認');
  assert.equal(elements.get('runner-badge').textContent,'等待檢查結果');
  assert.match(elements.get('runner-checks').textContent,/成功 3／失敗 0／queued 0／pending 1/);
  assert.match(elements.get('runner-checks').textContent,/略過或 neutral 1/);
  assert.match(elements.get('pr-state').textContent,/Draft/);
  assert.match(elements.get('runtime-source').textContent,/PR #462/);
  assert.match(elements.get('runtime-source').textContent,/與目前正式 main 相符/);
  assert.equal(elements.get('runtime-bundle').textContent,'c'.repeat(64) + '；本次有效觀測');
  assert.match(elements.get('opencode-detail').textContent,/42/);
  assert.match(elements.get('rate-alert-title').textContent,/跨分頁鎖與公開快取未確認/);
  assert.equal(browserCalls,5,'startup reads the four operational sources plus the W2 task source');
  testNow += 5*60*1000;
  intervalCallbacks[0]();
  await new Promise(resolve => setTimeout(resolve,20));
  assert.equal(browserCalls,5,'without cross-tab quota coordination, automatic polling is disabled after startup');
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

async function publishReceiptProjection(rows, { enableAntigravityModelRuns } = {}) {
  const at = Date.now();
  const host = 'DESKTOP-1B6PD2P';
  const mainSha = 'e'.repeat(40);
  const goalBody = '<!-- PTYSD_V53R4_DELETE_FIRST_AUTONOMY_GOAL_20261015 -->';
  const goalBodySha = createHash('sha256').update(goalBody).digest('hex');
  const comments = [];
  const heads = new Map();
  rows.forEach((row, index) => {
    const job = {
      schema: 6, project_id: PROJECT, host, request_id: row.requestId,
      kind: row.kind, source_sha: row.sourceSha,
      spec_path: 'native-bridge/tasks/projection-receipt.md', spec_sha256: 'a'.repeat(64),
      model: row.kind === 'opencode_edit' ? 'opencode/deepseek-v4.1-flash-free' : 'gemini-3.8-flash-high',
      variant: row.kind === 'opencode_edit' ? null : 'high',
      edit_paths: ['native-bridge/v2-readiness.mjs'], source_pr: row.sourcePr,
      goal_comment_id: 6188322050, goal_body_sha256: goalBodySha,
    };
    const jobId = 700 + index * 2;
    comments.push({ id: jobId, user: { login: 't14210184' }, body: JOB_MARKER + JSON.stringify(job) });
    if (!row.queued) {
      const terminal = workerReceipt(job.request_id, row.attemptId, row.state, job, {
        outcome: row.outcome, exit_code: row.state === 'BLOCKED' ? -1 : 0,
        diff_sha256: row.diffSha, diff_bytes: row.bytes, changed_files: row.files,
        coding_state: 'DIFF_CAPTURED_UNVERIFIED', scope_valid: row.scopeValid,
      });
      comments.push({ id: jobId + 1, user: { login: 't14210184' }, body: RECEIPT_MARKER + JSON.stringify(terminal) });
    }
    heads.set(row.sourcePr, row.sourceSha);
  });
  const prior = observation({
    snapshot_id: randomUUID(), sequence: 7,
    observed_at: new Date(at - 60_000).toISOString(),
    expires_at: new Date(at + 60_000).toISOString(),
    source: { ...observation().source, comment_id: OPERATOR_COMMENT_ID, main_sha: mainSha },
  });
  const obsComment = { id: OPERATOR_COMMENT_ID, user: { login: 'wfvupu1212' },
    body: encodeOperatorObservation(prior), updated_at: new Date(at - 30_000).toISOString() };
  comments.unshift(obsComment);
  const runtimeFiles = ['worker.mjs', 'opencode-v2.mjs', 'v2-readiness.mjs',
    'antigravity-quota.mjs', 'codex-continuation.mjs', 'operator-observation.mjs', 'captured-process.mjs',
    'safe-error-code.mjs', 'windows-executor.mjs'];
  const config = { repo: REPO, project_id: PROJECT, host, issue: 407,
    enable_antigravity_model_runs: enableAntigravityModelRuns,
    dispatchers: ['t14210184'], state_dir: 'unused' };
  const dependencies = {
    now: () => new Date(at),
    collectWindowsObservation: () => ({ status: 'FRESH', observed_at: new Date(at).toISOString(),
      native_task: { registered: true, enabled: true, state: 'READY' },
      opencode_process_count: 0, runner_service_count: 0, runner_service_running: false }),
    collectRuntimeDeployment: () => ({ status: 'UNKNOWN', observed_at: new Date(at).toISOString(),
      bundle_sha256: '3'.repeat(64), component_sha256: Object.fromEntries(runtimeFiles.map(name => [name, null])),
      reason_code: 'RUNTIME_FILES_UNAVAILABLE' }),
    readRunnerRegistration: () => ({ total_count: 0 }),
    readComment: id => structuredClone(comments.find(item => item.id === id)),
    patchComment: (id, body) => {
      const target = comments.find(item => item.id === id);
      target.body = body;
      target.updated_at = new Date(at + 1_000).toISOString();
    },
    readComments: () => structuredClone(comments),
  };
  return publishOperatorObservation(config, 't14210184', comments, mainSha,
    dependencies, heads);
}

test('queued W2 observation names the disabled model gate without inventing an attempt or blocking W1', async () => {
  const result = await publishReceiptProjection([
    { kind: 'opencode_edit', requestId: 'W1_QUEUE_WITH_W2_DISABLED_20261028',
      sourceSha: 'b'.repeat(40), sourcePr: 505, queued: true },
    { kind: 'antigravity_edit', requestId: 'W2_QUEUE_WITH_MODEL_DISABLED_20261028',
      sourceSha: 'c'.repeat(40), sourcePr: 586, queued: true },
  ], { enableAntigravityModelRuns: false });
  assert.equal(result.status, 'UPDATED');
  const w1 = result.observation.workers.find(item => item.worker_id === 'W1');
  assert.equal(w1.status, 'PENDING');
  assert.equal(w1.model_eligibility, 'UNKNOWN');
  assert.equal(Object.hasOwn(w1, 'blocker_code'), false,
    'the W2 lane flag must not block an independent W1 task');
  const w2 = result.observation.workers.find(item => item.worker_id === 'W2');
  assert.equal(w2.status, 'PENDING');
  assert.equal(w2.task_state, 'QUEUED_NOT_STARTED');
  assert.equal(Object.hasOwn(w2, 'attempt_id'), false);
  assert.equal(w2.model_eligibility, 'WAITING');
  assert.equal(w2.blocker_code, 'ANTIGRAVITY_MODEL_RUNS_NOT_ENABLED');
  assert.equal(w2.code_changes, 'UNPROVEN');
  assert.equal(w2.files_modified, 'UNPROVEN');
});

test('worker observation reports captured W1 and blocked W2 diffs as unverified, never active or accepted', async () => {
  const result = await publishReceiptProjection([
    { kind: 'opencode_edit', requestId: 'W1_PROJECTION_CAPTURED_20261023',
      sourceSha: 'b'.repeat(40), sourcePr: 505, attemptId: '3f9246cd-f968-4290-9c76-0514bb7775b5',
      state: 'FINISHED', outcome: 'V2_EDIT_DIFF_CAPTURED_UNVERIFIED', scopeValid: true,
      diffSha: '1'.repeat(64), bytes: 12151,
      files: ['native-bridge/v2-readiness.mjs', 'tests/v2-readiness.test.mjs'] },
    { kind: 'antigravity_edit', requestId: 'W2_PROJECTION_CAPTURED_20261023',
      sourceSha: 'c'.repeat(40), sourcePr: 461, attemptId: '24331e45-62db-4f55-ad40-87776a799c5d',
      state: 'BLOCKED', outcome: 'ANTIGRAVITY_EDIT_TOOL_EXECUTION_FAILED_DIFF_PRESERVED', scopeValid: true,
      diffSha: '2'.repeat(64), bytes: 23710,
      files: ['native-bridge/antigravity-quota.mjs', 'tests/antigravity-quota.test.mjs', 'package.json'] },
  ]);
  assert.equal(result.status, 'UPDATED');
  assert.equal(result.observation.workers.filter(item => item.worker_id === 'W1' || item.worker_id === 'W2').length, 2);
  const w1 = result.observation.workers.find(item => item.worker_id === 'W1');
  assert.equal(w1.status, 'UNKNOWN', 'a finished receipt is not live activity');
  assert.equal(w1.task_state, 'FINISHED_NOT_ACCEPTANCE');
  assert.equal(w1.delivery_status, 'FINISHED_UNVERIFIED');
  assert.equal(w1.code_changes, 'DIFF_CAPTURED_UNVERIFIED');
  assert.equal(w1.files_modified, 'COUNT_REPORTED_UNVERIFIED');
  assert.equal(w1.changed_files_count, 2);
  assert.equal(w1.diff_sha256, '1'.repeat(64));
  assert.equal(w1.diff_bytes, 12151);
  assert.equal(w1.scope_valid, true, 'this is only the Worker receipt claim');
  const w2 = result.observation.workers.find(item => item.worker_id === 'W2');
  assert.equal(w2.status, 'BLOCKED');
  assert.equal(w2.task_state, 'BLOCKED');
  assert.equal(w2.blocker_code, 'ANTIGRAVITY_EDIT_TOOL_EXECUTION_FAILED_DIFF_PRESERVED');
  assert.equal(w2.code_changes, 'DIFF_CAPTURED_UNVERIFIED');
  assert.equal(w2.files_modified, 'COUNT_REPORTED_UNVERIFIED');
  assert.equal(w2.changed_files_count, 3);
  assert.equal(w2.delivery_status, 'BLOCKED_DIFF_CAPTURED_UNVERIFIED');
});

test('worker observation rejects invalid diff digest or scope claims and keeps changes unproven', async () => {
  const result = await publishReceiptProjection([
    { kind: 'opencode_edit', requestId: 'W1_PROJECTION_INVALID_20261023',
      sourceSha: 'b'.repeat(40), sourcePr: 505, attemptId: '3f9246cd-f968-4290-9c76-0514bb7775b5',
      state: 'FINISHED', outcome: 'V2_EDIT_DIFF_CAPTURED_UNVERIFIED', scopeValid: false,
      diffSha: 'not-a-digest', bytes: 12151, files: ['native-bridge/v2-readiness.mjs'] },
  ]);
  const w1 = result.observation.workers.find(item => item.worker_id === 'W1');
  assert.equal(w1.status, 'UNKNOWN');
  assert.equal(w1.task_state, 'FINISHED_NOT_ACCEPTANCE');
  assert.equal(w1.code_changes, 'UNPROVEN');
  assert.equal(w1.files_modified, 'UNPROVEN');
  assert.equal(Object.hasOwn(w1, 'diff_sha256'), false);
});
