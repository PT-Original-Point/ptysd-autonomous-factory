import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeV2AuthJson, summarizeV2AuthProviderJson, summarizeV2Models,
  readV2ProviderAuth, runV2Readiness } from '../native-bridge/v2-readiness.mjs';

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

test('valid empty provider record collections mean no saved provider record', () => {
  for (const json of ['[]', '{"accounts":[]}', '{"integrations":[]}']) {
    assert.deepEqual(summarizeV2AuthProviderJson(json, 'openai'),
      { status: 'AUTH_PROVIDER_RECORD_ABSENT' });
  }
});

test('unrecognized non-empty provider records remain unknown', () => {
  for (const json of ['[{}]', '[{"provider":null}]', '{"accounts":[{"name":"account"}]}']) {
    assert.deepEqual(summarizeV2AuthProviderJson(json, 'openai'),
      { status: 'AUTH_PROVIDER_METADATA_UNKNOWN' });
  }
});

test('provider records distinguish a matching provider from a different provider', () => {
  assert.deepEqual(summarizeV2AuthProviderJson('[{"provider":"OpenAI"}]', 'openai'),
    { status: 'AUTH_PROVIDER_RECORD_PRESENT' });
  assert.deepEqual(summarizeV2AuthProviderJson('[{"provider":"anthropic"}]', 'openai'),
    { status: 'AUTH_PROVIDER_RECORD_ABSENT' });
});

test('provider auth command preserves coarse status without exposing returned data', () => {
  let called = false;
  const result = readV2ProviderAuth('opencode', 'openai', 'C:\\workspace',
    (_bin, args, options) => {
      called = true;
      assert.deepEqual(args, ['auth', 'list', '--format', 'json']);
      assert.equal(options.cwd, 'C:\\workspace');
      return '[]';
    }, {});
  assert.equal(called, true);
  assert.deepEqual(result, { status: 'AUTH_PROVIDER_RECORD_ABSENT' });
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
