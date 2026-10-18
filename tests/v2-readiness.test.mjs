import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { summarizeV2AuthJson, summarizeV2AuthProviderJson, summarizeV2Models, readV2ProviderAuth,
  runV2Readiness, summarizeAntigravityCreditSetting, summarizeAntigravityV2Models,
  runAntigravityV2Readiness, summarizeAntigravityUsage,
  antigravityV2ReadinessExecutionFailure, readAntigravityV2RunEvidence }
  from '../native-bridge/v2-readiness.mjs';

test('auth JSON excludes provider identities, keys and account details', () => {
  const secret = 'S3cr3t-DO-NOT-LEAK';
  const summary = summarizeV2AuthJson(JSON.stringify([{ provider: 'openai', token: secret, email: 'no@example.com' }]));
  assert.deepEqual(summary, { status: 'SAVED_ACCOUNT_RECORDS_PRESENT', saved_account_count: 1 });
  assert.equal(JSON.stringify(summary).includes(secret), false);
  assert.equal(JSON.stringify(summary).includes('example.com'), false);
  assert.deepEqual(summarizeV2AuthJson('[]'), { status: 'NO_SAVED_ACCOUNT_RECORDS', saved_account_count: 0 });
  assert.equal(summarizeV2AuthJson('not-json').status,'AUTH_JSON_UNREADABLE');
  assert.equal(summarizeV2AuthJson('{"provider":"a"}').status,'AUTH_JSON_SCHEMA_UNKNOWN');
});
test('auth metadata reports exact account count above the former 10000 cap', () => {
  const summary = summarizeV2AuthJson(JSON.stringify(Array(10001).fill(null)));
  assert.deepEqual(summary, { status: 'SAVED_ACCOUNT_RECORDS_PRESENT', saved_account_count: 10001 });
});
test('provider auth treats an empty supported list as known absence, not unknown metadata', () => {
  for (const raw of ['[]', '{}', '{"accounts":[]}', '{"integrations":[]}'])
    assert.deepEqual(summarizeV2AuthProviderJson(raw, 'opencode'),
      { status: 'AUTH_PROVIDER_RECORD_ABSENT' });
  assert.deepEqual(summarizeV2AuthProviderJson('[{"provider":"opencode"}]', 'opencode'),
    { status: 'AUTH_PROVIDER_RECORD_PRESENT' });
  assert.deepEqual(summarizeV2AuthProviderJson('[{"provider":"openai"}]', 'opencode'),
    { status: 'AUTH_PROVIDER_RECORD_ABSENT' });
  assert.deepEqual(summarizeV2AuthProviderJson('[{"token":"PRIVATE"}]', 'opencode'),
    { status: 'AUTH_PROVIDER_METADATA_UNKNOWN' });
  for (const raw of ['null', '"text"', '{"other":[]}'])
    assert.deepEqual(summarizeV2AuthProviderJson(raw, 'opencode'),
      { status: 'AUTH_PROVIDER_METADATA_UNKNOWN' });
});
test('provider auth command classifies an empty object without exposing command data', () => {
  let invocation;
  const result = readV2ProviderAuth('C:\\bin\\opencode.exe', 'opencode', 'C:\\workspace',
    (_bin, args) => { invocation = args; return '{}'; }, {});
  assert.deepEqual(invocation, ['auth', 'list', '--format', 'json']);
  assert.deepEqual(result, { status: 'AUTH_PROVIDER_RECORD_ABSENT' });
  assert.equal(JSON.stringify(result).includes('token'), false);
});
test('model catalog reports count/hash only; not available-to-use or actually free', () => {
  const summary = summarizeV2Models('opencode/muse-spark-1.3-free\r\nopenrouter/anthropic/a\nnot a model\nopencode/muse-spark-1.3-free\n');
  assert.equal(summary.catalog_count,2);
  assert.equal(summary.candidate_free_name_count,1);
  assert.match(summary.catalog_sha256,/^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(summary).includes('muse-spark'));
  assert.equal(summarizeV2Models('unparseable').status,'CATALOG_IDS_UNRECOGNIZED');
  assert.equal(summarizeV2Models('x'.repeat(1024*1024+2)).status, 'MODEL_LIST_OVERSIZED_OR_INVALID');
});
test('bounded official V2 metadata commands invoke no model, login, shell or mutation', () => {
  const calls=[];
  const env={ USERPROFILE:'C:\\Users\\x', OPENCODE_CONFIG_CONTENT:'UNTRUSTED' };
  const run=(bin,args,opts)=>{
    calls.push({bin,args,opts});
    if(args[0]==='auth')return '[{"provider":"openai","token":"HIDDEN"}]';
    if(args[0]==='models')return 'opencode/spark-free\n';
    throw Error('Unexpected command');
  };
  const result=runV2Readiness('C:\\bin\\opencode.exe','C:\\state',run,env);
  assert.equal(calls.length,2);
  assert.deepEqual(calls.map(c=>c.args),[['auth','list','--format','json'],['models']]);
  assert.equal(calls[0].opts.timeout,12000);
  assert.equal(calls[0].opts.env.OPENCODE_CONFIG_CONTENT,undefined);
  assert.equal(calls[0].opts.env.USERPROFILE,env.USERPROFILE);
  assert.equal(result.inference_executed,false);
  assert.equal(result.credential_values_collected,false);
  assert.ok(!JSON.stringify(result).includes('HIDDEN'));
});
test('non-JSON and command failures remain explicitly unknown, never auto-approved', () => {
  const r=runV2Readiness('/bin/opencode','/tmp',()=>{throw Error('FAIL')});
  assert.deepEqual(r.issues,['AUTH_LIST_COMMAND_FAILED','MODELS_COMMAND_FAILED']);
  assert.equal(r.auth.saved_account_count,null);
  assert.equal(r.models.catalog_count,null);
  assert.equal(r.inference_executed,false);
});


test('Antigravity metadata parser recognizes only the pinned model ID, not its display label', () => {
  const summary=summarizeAntigravityV2Models('Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\n');
  assert.equal(summary.status,'PINNED_MODEL_CATALOGED_NOT_ENTITLEMENT');
  assert.equal(summary.catalog_count,2);
  assert.equal(summary.pinned_model_cataloged,true);
  assert.match(summary.catalog_sha256,/^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(summary).includes('Flash (High)'),false);
});

const validAntigravityUsage = 'Gemini Models\tWeekly Limit Remaining\t95%\t2026-10-23T22:50:38Z\n' +
  'Gemini Models\tFive Hour Limit Remaining\t99%\t2026-10-18T05:46:39Z\n';

test('Antigravity credit-setting summary requires an explicit false setting and keeps cost unknown', () => {
  assert.equal(summarizeAntigravityCreditSetting('{"useG1Credits":false}'), 'CREDIT_FALLBACK_DISABLED');
  assert.equal(summarizeAntigravityCreditSetting('{"useG1Credits":true}'), 'CREDIT_FALLBACK_ENABLED');
  assert.equal(summarizeAntigravityCreditSetting('{"permissions":{}}'), 'CREDIT_FALLBACK_SETTING_ABSENT');
  assert.equal(summarizeAntigravityCreditSetting('{"useG1Credits":"false"}'), 'SETTING_INVALID');
  assert.equal(summarizeAntigravityCreditSetting('{'), 'SETTINGS_JSON_INVALID');
  assert.equal(summarizeAntigravityCreditSetting('x'.repeat(64 * 1024 + 1)), 'SETTINGS_INVALID_OR_OVERSIZED');
});

test('Antigravity usage parser keeps only validated aggregate Gemini quota rows', () => {
  const raw = [
    'Gemini Models\tWeekly Limit Remaining\t95%\t2026-10-23T22:50:38Z',
    'Gemini Models\tFive Hour Limit Remaining\t99%\t2026-10-18T05:46:39Z',
    'Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-10-25T00:58:04Z',
  ].join('\n');
  const result = summarizeAntigravityUsage(raw);
  assert.deepEqual(result, { status: 'GEMINI_AGGREGATE_QUOTA_READ',
    source: 'GEMINI_MODELS_AGGREGATE', weekly_remaining_percent: 95,
    weekly_reset_at: '2026-10-23T22:50:38Z', five_hour_remaining_percent: 99,
    five_hour_reset_at: '2026-10-18T05:46:39Z' });
  assert.equal(JSON.stringify(result).includes('Claude'), false);
  assert.equal(JSON.stringify(result).includes(raw), false);
});

test('Antigravity usage parser fails closed on missing, malformed, duplicate, invalid or oversized rows', () => {
  const goodWeekly = 'Gemini Models\tWeekly Limit Remaining\t95%\t2026-10-23T22:50:38Z';
  const goodFiveHour = 'Gemini Models\tFive Hour Limit Remaining\t99%\t2026-10-18T05:46:39Z';
  const unknown = () => ({ status: 'GEMINI_AGGREGATE_QUOTA_UNKNOWN', source: 'GEMINI_MODELS_AGGREGATE',
    weekly_remaining_percent: null, weekly_reset_at: null,
    five_hour_remaining_percent: null, five_hour_reset_at: null });
  for (const raw of [
    goodWeekly,
    `${goodWeekly}\nGemini Models\tFive Hour Remaining\t99%\t2026-10-18T05:46:39Z`,
    `${goodWeekly}\n${goodFiveHour}\nGemini Models\tWeekly Limit Remaining\tNaN%\t2026-10-23T22:50:38Z`,
    `${goodWeekly}\n${goodFiveHour}\n${goodWeekly}`,
    `${goodWeekly.replace('95%', '101%')}\n${goodFiveHour}`,
    `${goodWeekly.replace('95%', '-1%')}\n${goodFiveHour}`,
    `${goodWeekly.replace('2026-10-23T22:50:38Z', 'not-a-time')}\n${goodFiveHour}`,
    'x'.repeat(32 * 1024 + 1),
  ]) assert.deepEqual(summarizeAntigravityUsage(raw), unknown());
  assert.deepEqual(summarizeAntigravityUsage(null), unknown());
});

test('Antigravity metadata readiness requires explicit no-G1 setting and leaves auth to the Worker gate', () => {
  const ready = { status: 'CLI_AND_PINNED_MODEL_CATALOGED_NOT_EXECUTION_AUTH',
    model: 'gemini-3.8-flash-high', signature_verified: true, issues: [],
    credit_fallback_setting: 'CREDIT_FALLBACK_DISABLED', authentication_checked: false,
    authentication_evidence: 'QUOTA_ONLY_NOT_AUTH_PROOF',
    gemini_aggregate_quota: { status: 'GEMINI_AGGREGATE_QUOTA_READ',
      source: 'GEMINI_MODELS_AGGREGATE', weekly_remaining_percent: 95,
      five_hour_remaining_percent: 99 } };
  assert.equal(antigravityV2ReadinessExecutionFailure(ready), null);
  assert.equal(antigravityV2ReadinessExecutionFailure({...ready,
    credit_fallback_setting:'CREDIT_FALLBACK_DISABLED_BY_DEFAULT'}),
  'ANTIGRAVITY_CREDIT_FALLBACK_SETTING_UNKNOWN');
  assert.equal(antigravityV2ReadinessExecutionFailure({...ready,
    credit_fallback_setting:'CREDIT_FALLBACK_ENABLED'}),
  'ANTIGRAVITY_CREDIT_OVERAGE_NOT_DISABLED');
  assert.equal(antigravityV2ReadinessExecutionFailure({...ready,
    credit_fallback_setting:'SETTINGS_READ_ERROR'}),
  'ANTIGRAVITY_CREDIT_FALLBACK_SETTING_UNKNOWN');
  assert.equal(antigravityV2ReadinessExecutionFailure({...ready, authentication_evidence:'LOGIN_REQUIRED'}),
    'ANTIGRAVITY_AUTH_NOT_LOGGED_IN');
  assert.equal(antigravityV2ReadinessExecutionFailure({...ready,
    credit_fallback_setting:'SETTINGS_FILE_MISSING', authentication_evidence:'LOGIN_REQUIRED',
    issues:['ANTIGRAVITY_AUTH_NOT_LOGGED_IN']}), 'ANTIGRAVITY_AUTH_NOT_LOGGED_IN');
  assert.equal(antigravityV2ReadinessExecutionFailure({...ready,
    credit_fallback_setting:'SETTINGS_FILE_MISSING', authentication_evidence:'QUOTA_ONLY_NOT_AUTH_PROOF'}),
  'ANTIGRAVITY_CREDIT_FALLBACK_SETTING_UNKNOWN');
  assert.equal(antigravityV2ReadinessExecutionFailure({...ready,
    gemini_aggregate_quota:{...ready.gemini_aggregate_quota,five_hour_remaining_percent:0}}),
  'ANTIGRAVITY_QUOTA_EMPTY');
  assert.equal(antigravityV2ReadinessExecutionFailure({...ready,
    gemini_aggregate_quota:{...ready.gemini_aggregate_quota,weekly_remaining_percent:null}}),
  'ANTIGRAVITY_AGGREGATE_QUOTA_UNKNOWN');
});

test('Antigravity readiness reads only the bounded credit flag and keeps cost UNKNOWN', () => {
  const profile = mkdtempSync(join(tmpdir(), 'pty-agy-settings-'));
  const settingsDir = join(profile, '.gemini', 'antigravity-cli');
  mkdirSync(settingsDir, { recursive: true });
  const secret = 'DO-NOT-LEAK-API-KEY';
  writeFileSync(join(settingsDir, 'settings.json'), JSON.stringify({ useG1Credits: false, apiKey: secret }));
  const help = '--print --output-format stream-json --model --effort --sandbox --mode';
  const runner = (_bin, args) => args[0] === '--version' ? '1.4.1' :
    args[0] === '--help' ? help : args[0] === 'models' ? 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n' :
      args[0] === '--print' ? validAntigravityUsage :
      (() => { throw new Error('Unexpected command'); })();
  try {
    const result = runAntigravityV2Readiness(process.execPath, process.cwd(), runner,
      { USERPROFILE: profile }, () => true);
    assert.equal(result.credit_fallback_setting, 'CREDIT_FALLBACK_DISABLED');
    assert.equal(result.cost, 'UNKNOWN');
    assert.equal(result.entitlement, 'UNKNOWN');
    assert.equal(result.inference_executed, false);
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(JSON.stringify(result).includes(profile), false);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});

test('Antigravity absent settings file remains unknown and cannot authorize a model run', () => {
  const profile = mkdtempSync(join(tmpdir(), 'pty-agy-default-settings-'));
  const help = '--print --output-format stream-json --model --effort --sandbox --mode accept-edits';
  const runner = (_bin, args) => args[0] === '--version' ? '1.4.1' :
    args[0] === '--help' ? help : args[0] === 'models' ? 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n' :
      args[0] === '--print' ? validAntigravityUsage :
      (() => { throw new Error('Unexpected command'); })();
  try {
    const result = runAntigravityV2Readiness(process.execPath, process.cwd(), runner,
      { USERPROFILE: profile }, () => true);
    assert.equal(result.credit_fallback_setting, 'SETTINGS_FILE_MISSING');
    assert.equal(antigravityV2ReadinessExecutionFailure(result),
      'ANTIGRAVITY_CREDIT_FALLBACK_SETTING_UNKNOWN');
    assert.equal(antigravityV2ReadinessExecutionFailure({...result, authentication_checked:true,
      authentication_evidence:'AUTHENTICATED', issues:[]}),
    'ANTIGRAVITY_CREDIT_FALLBACK_SETTING_UNKNOWN');
    assert.equal(result.cost, 'UNKNOWN');
    assert.equal(result.entitlement, 'UNKNOWN');
    assert.equal(result.inference_executed, false);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});

test('Antigravity readiness uses only no-inference version, help and model-catalog commands', () => {
  const profile=mkdtempSync(join(tmpdir(),'pty-agy-metadata-only-'));
  const settingsDir=join(profile,'.gemini','antigravity-cli');
  mkdirSync(settingsDir,{recursive:true});
  writeFileSync(join(settingsDir,'settings.json'),JSON.stringify({useG1Credits:false}));
  const calls=[];
  // Captured from the installed CLI; readiness must confirm the per-run mode override.
  const help=`Usage of agy.exe:
  --print Run a single prompt non-interactively
  --model Model for the current CLI session
  --effort Reasoning effort for the current CLI session (low|medium|high|xhigh|max)
  --mode Execution mode (default|accept-edits|plan)
  --output-format Output format (text, json, stream-json)
  --input-format Input format (text, stream-json)
  --sandbox Run with terminal sandbox restrictions enabled`;
  const models='Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\n';
  const runner=(bin,args,options)=>{
    calls.push({bin,args,options});
    if(args[0]==='--version') return '1.4.1';
    if(args[0]==='--help') return { stdout:'', stderr:help };
    if(args[0]==='models') return { stdout:models, stderr:'' };
    if(args[0]==='--print') return { stdout:validAntigravityUsage, stderr:'' };
    throw new Error('Unexpected command');
  };
  try {
    const r=runAntigravityV2Readiness(process.execPath,process.cwd(),runner,
      {PATH:'clean',USERPROFILE:profile,OPENCODE_API_KEY:'SECRET'},()=>true);
    assert.equal(r.status,'CLI_AND_PINNED_MODEL_CATALOGED_NOT_EXECUTION_AUTH');
    assert.equal(r.version,'1.4.1');
    assert.equal(r.model,'gemini-3.8-flash-high');
    assert.equal(r.headless_print_supported,true);
    assert.equal(r.stream_json_supported,true);
    assert.equal(r.model_flag_supported,true);
    assert.equal(r.effort_flag_supported,true);
    assert.equal(r.sandbox_flag_supported,true);
    assert.equal(r.mode_flag_supported,true);
    assert.equal(r.inference_executed,false);
    assert.equal(r.signature_verified,true);
    assert.equal(r.authentication_checked,false);
    assert.equal(r.authentication_evidence,'QUOTA_ONLY_NOT_AUTH_PROOF');
    assert.equal(r.issues.includes('ANTIGRAVITY_AUTH_STATUS_UNVERIFIED'),false);
    assert.equal(r.gemini_aggregate_quota.status,'GEMINI_AGGREGATE_QUOTA_READ');
    assert.equal(r.gemini_aggregate_quota.weekly_remaining_percent,95);
    assert.equal(r.gemini_aggregate_quota.five_hour_remaining_percent,99);
    assert.equal(r.entitlement,'UNKNOWN');
    assert.equal(r.cost,'UNKNOWN');
    assert.equal(r.write_scope,'UNKNOWN');
    assert.deepEqual(calls.map(c=>c.args),[['--version'],['--help'],['models'],['--print','/usage']]);
    assert.ok(calls.every(c=>c.options.shell===false && c.options.windowsHide===true));
    assert.ok(calls.slice(0,3).every(c=>c.options.timeout===12000));
    assert.equal(calls[3].options.timeout,15000);
    assert.equal(calls[3].options.maxBuffer,32*1024);
    assert.ok(calls.every(c=>c.options.env.AGY_CLI_DISABLE_AUTO_UPDATE==='true'));
    assert.ok(calls.every(c=>c.options.env.OPENCODE_API_KEY===undefined));
  } finally { rmSync(profile,{recursive:true,force:true}); }
});

test('Antigravity readiness does not treat cached /usage quota as login and preserves explicit login failure', () => {
  const profile=mkdtempSync(join(tmpdir(),'pty-agy-login-required-'));
  const settingsDir=join(profile,'.gemini','antigravity-cli');
  mkdirSync(settingsDir,{recursive:true});
  writeFileSync(join(settingsDir,'settings.json'),JSON.stringify({useG1Credits:false}));
  const help='--print --output-format stream-json --model --effort --sandbox --mode accept-edits';
  const runner=(_bin,args)=>args[0]==='--version' ? '1.4.2' : args[0]==='--help'
    ? help : args[0]==='models' ? 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n'
      : {stdout:validAntigravityUsage,stderr:'You are not logged into Antigravity.'};
  try {
    const r=runAntigravityV2Readiness(process.execPath,process.cwd(),runner,{USERPROFILE:profile},()=>true);
    assert.equal(r.gemini_aggregate_quota.status,'GEMINI_AGGREGATE_QUOTA_READ');
    assert.equal(r.authentication_checked,false);
    assert.equal(r.authentication_evidence,'LOGIN_REQUIRED');
    assert.ok(r.issues.includes('ANTIGRAVITY_AUTH_NOT_LOGGED_IN'));
    assert.equal(antigravityV2ReadinessExecutionFailure(r),'ANTIGRAVITY_AUTH_NOT_LOGGED_IN');
    assert.equal(r.inference_executed,false);
  } finally { rmSync(profile,{recursive:true,force:true}); }
});

test('Antigravity readiness does not invent a model or effort option absent from real CLI help', () => {
  const runner=(_bin,args)=>args[0]==='--version' ? '1.4.1' : args[0]==='--help'
    ? '--print --output-format stream-json --sandbox'
    : 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)';
  const r=runAntigravityV2Readiness(process.execPath,process.cwd(),runner,{},()=>true);
  assert.equal(r.status,'METADATA_QUALIFICATION_INCOMPLETE');
  assert.equal(r.model_flag_supported,false);
  assert.equal(r.effort_flag_supported,false);
  assert.equal(r.mode_flag_supported,false);
  assert.ok(r.issues.includes('REQUIRED_HEADLESS_FLAGS_NOT_CONFIRMED'));
  assert.equal(r.inference_executed,false);
  assert.equal(r.authentication_checked,false);
  assert.equal(r.entitlement,'UNKNOWN');
  assert.equal(r.cost,'UNKNOWN');
});

test('Antigravity readiness requires the advertised accept-edits mode, not only a generic --mode flag', () => {
  const runner=(_bin,args)=>args[0]==='--version' ? '1.4.1' : args[0]==='--help'
    ? '--print --output-format stream-json --model --effort --sandbox --mode (default|plan)'
    : args[0]==='models' ? 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)' :
      'Gemini Models Weekly Limit Remaining 95% 2026-10-19T00:00:00Z\n' +
      'Gemini Models Five Hour Limit Remaining 98% 2026-10-18T12:00:00Z';
  const r=runAntigravityV2Readiness(process.execPath,process.cwd(),runner,{},()=>true);
  assert.equal(r.mode_flag_supported,true);
  assert.equal(r.accept_edits_mode_supported,false);
  assert.equal(r.status,'METADATA_QUALIFICATION_INCOMPLETE');
  assert.ok(r.issues.includes('REQUIRED_HEADLESS_FLAGS_NOT_CONFIRMED'));
  assert.equal(r.inference_executed,false);
});

test('Antigravity metadata commands never start before Google Authenticode verification', () => {
  let calls=0;
  const r=runAntigravityV2Readiness(process.execPath,process.cwd(),
    ()=>{calls++;return ''},{PATH:'clean'},()=>false);
  assert.equal(r.status,'ANTIGRAVITY_GOOGLE_SIGNATURE_NOT_VERIFIED');
  assert.equal(r.signature_verified,false);
  assert.equal(r.inference_executed,false);
  assert.equal(calls,0);
});

test('Antigravity readiness rejects a relative executable without launching commands', () => {
  let calls=0;
  const r=runAntigravityV2Readiness('agy.exe','C:\\workspace',()=>{calls++;return ''});
  assert.equal(calls,0);
  assert.equal(r.status,'READINESS_UNKNOWN');
  assert.deepEqual(r.issues,['ABSOLUTE_EXECUTABLE_AND_CWD_REQUIRED']);
  assert.equal(r.inference_executed,false);
});

test('Antigravity metadata failures stay UNKNOWN and do not expose command errors', () => {
  const secret='credential-shaped-provider-output';
  const r=runAntigravityV2Readiness(process.execPath,process.cwd(),
    ()=>{throw new Error(secret)},{},()=>true);
  assert.equal(r.status,'METADATA_QUALIFICATION_INCOMPLETE');
  assert.deepEqual(r.issues,['VERSION_COMMAND_FAILED','HELP_COMMAND_FAILED','MODELS_COMMAND_FAILED',
    'ANTIGRAVITY_USAGE_COMMAND_FAILED']);
  assert.equal(r.entitlement,'UNKNOWN');
  assert.equal(r.cost,'UNKNOWN');
  assert.equal(JSON.stringify(r).includes(secret),false);
});

test('Antigravity stream evidence binds one session, exact model and cwd without returning response bytes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pty-agy-stream-'));
  const stdoutPath = join(directory, 'stdout.jsonl');
  const session = '5eaf005b-c8fb-4904-8b5f-e2ccf9d28604';
  const cwd = 'C:\\Users\\worker\\candidate';
  const events = [
    { event: 'init', conversation_id: session,
      init: { model: 'gemini-3.8-flash-high', cwd, tools: [], permission_mode: 'accept-edits' } },
    { event: 'step_update', step_update: { conversation_id: session, step_index: 0,
      state: 'ACTIVE', step_type: 'agent_response', text_delta: 'working' } },
    { event: 'step_update', step_update: { conversation_id: session, step_index: 1,
      state: 'ACTIVE', step_type: 'tool', tool_name: 'replace_file_content' } },
    { event: 'step_update', step_update: { conversation_id: session, step_index: 1,
      state: 'DONE', step_type: 'tool', tool_name: 'replace_file_content',
      tool_info: { output: 'PRIVATE_TOOL_OUTPUT' } } },
    { event: 'step_update', step_update: { conversation_id: session, step_index: 2,
      state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command' } },
    { event: 'step_update', step_update: { conversation_id: session, step_index: 0,
      state: 'DONE', step_type: 'agent_response', text_delta: 'done' } },
    { event: 'result', result: { conversation_id: session, status: 'SUCCESS',
      response: 'PRIVATE_MODEL_RESPONSE', usage: { input_tokens: 100, output_tokens: 20,
        thinking_tokens: 10, cache_read_tokens: 0, total_tokens: 120 } } },
  ];
  const bytes = Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + '\n');
  writeFileSync(stdoutPath, bytes);
  try {
    const result = await readAntigravityV2RunEvidence(stdoutPath,
      createHash('sha256').update(bytes).digest('hex'), cwd);
    assert.equal(result.valid, true);
    assert.equal(result.session_id, session);
    assert.equal(result.cli_status, 'SUCCESS');
    assert.equal(result.permission_mode_evidence, 'ACCEPT_EDITS_CONFIRMED');
    assert.equal(result.model_invoked, true);
    assert.equal(result.model_activity_evidence, 'OBSERVED');
    assert.equal(result.tool_execution_count, 2);
    assert.equal(result.file_change_tool_completed_count, 1);
    assert.equal(result.file_change_tool_incomplete_count, 0);
    assert.equal(result.token_usage.total_tokens, 120);
    assert.equal(result.stdout_bytes, bytes.length);
    assert.equal(JSON.stringify(result).includes('PRIVATE_MODEL_RESPONSE'), false);
    assert.equal(JSON.stringify(result).includes('PRIVATE_TOOL_OUTPUT'), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Antigravity stream evidence fails closed on wrong model, cwd, capture hash and malformed NDJSON', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pty-agy-stream-invalid-'));
  const stdoutPath = join(directory, 'stdout.jsonl');
  const session = '5eaf005b-c8fb-4904-8b5f-e2ccf9d28604';
  const makeStream = (model = 'gemini-3.8-flash-high', permissionMode = 'accept-edits') => [
    { event: 'init', conversation_id: session,
      init: { model, cwd: 'C:\\Users\\worker\\candidate', tools: [],
        ...(permissionMode === null ? {} : { permission_mode: permissionMode }) } },
    { event: 'result', result: { conversation_id: session, status: 'SUCCESS', response: 'ok',
      usage: { input_tokens: 1, output_tokens: 1, thinking_tokens: 0,
        cache_read_tokens: 0, total_tokens: 2 } } },
  ].map(event => JSON.stringify(event)).join('\n') + '\n';
  try {
    const good = Buffer.from(makeStream());
    writeFileSync(stdoutPath, good);
    assert.equal((await readAntigravityV2RunEvidence(stdoutPath, null,
      'C:\\Users\\worker\\candidate')).valid, true);
    assert.equal((await readAntigravityV2RunEvidence(stdoutPath, null,
      'relative\\candidate')).reason, 'ANTIGRAVITY_EXPECTED_CWD_INVALID');
    assert.equal((await readAntigravityV2RunEvidence(stdoutPath, '0'.repeat(64),
      'C:\\Users\\worker\\candidate')).reason, 'ANTIGRAVITY_CAPTURE_HASH_MISMATCH');
    assert.equal((await readAntigravityV2RunEvidence(stdoutPath, null,
      'C:\\Users\\other\\candidate')).reason, 'ANTIGRAVITY_JSONL_INVALID');
    writeFileSync(stdoutPath, makeStream('gemini-3.8-flash-medium'));
    assert.equal((await readAntigravityV2RunEvidence(stdoutPath, null,
      'C:\\Users\\worker\\candidate')).reason, 'ANTIGRAVITY_JSONL_INVALID');
    writeFileSync(stdoutPath, makeStream('gemini-3.8-flash-high', 'auto'));
    assert.equal((await readAntigravityV2RunEvidence(stdoutPath, null,
      'C:\\Users\\worker\\candidate')).reason, 'ANTIGRAVITY_PERMISSION_MODE_UNRECOGNIZED');
    writeFileSync(stdoutPath, makeStream('gemini-3.8-flash-high', null));
    assert.equal((await readAntigravityV2RunEvidence(stdoutPath, null,
      'C:\\Users\\worker\\candidate')).reason, 'ANTIGRAVITY_PERMISSION_MODE_UNRECOGNIZED');
    writeFileSync(stdoutPath, '{not-json}\n');
    assert.equal((await readAntigravityV2RunEvidence(stdoutPath, null,
      'C:\\Users\\worker\\candidate')).reason, 'ANTIGRAVITY_JSONL_INVALID');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Antigravity headless request-review is distinct from accept-edits and zero-usage stays unverified', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pty-agy-request-review-'));
  const stdoutPath = join(directory, 'stdout.jsonl');
  const cwd = 'C:\\Users\\worker\\candidate';
  const session = 'f4c8b3b8-ceda-4013-9a57-17145fa54231';
  const events = [
    { event: 'init', conversation_id: session,
      init: { model: 'gemini-3.8-flash-high', cwd, tools: [], permission_mode: 'request-review' } },
    { event: 'step_update', step_update: { conversation_id: session, step_index: 0,
      state: 'DONE', step_type: 'user_input' } },
    { event: 'result', result: { conversation_id: session, status: 'SUCCESS', response: '',
      usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0,
        cache_read_tokens: 0, total_tokens: 0 } } },
  ];
  writeFileSync(stdoutPath, events.map(event => JSON.stringify(event)).join('\n') + '\n');
  try {
    const result = await readAntigravityV2RunEvidence(stdoutPath, null, cwd);
    assert.equal(result.valid, true);
    assert.equal(result.permission_mode_evidence, 'REQUEST_REVIEW_CONFIRMED');
    assert.equal(result.model_invoked, false);
    assert.equal(result.model_activity_evidence, 'NO_ACTIVITY_OBSERVED');
    assert.equal(result.tool_execution_evidence, 'NO_TOOL_CALLS_OBSERVED');
    assert.equal(result.file_change_tool_evidence, 'NO_FILE_CHANGE_TOOL_OBSERVED');
    assert.equal(result.session_id, session);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
