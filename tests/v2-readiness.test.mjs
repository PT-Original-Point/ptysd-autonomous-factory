import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeV2AuthJson, summarizeV2AuthProviderJson, summarizeV2Models,
  runV2Readiness } from '../native-bridge/v2-readiness.mjs';

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
test('provider auth treats an empty supported list as known absence, not unknown metadata', () => {
  for (const raw of ['[]', '{"accounts":[]}', '{"integrations":[]}'])
    assert.deepEqual(summarizeV2AuthProviderJson(raw, 'opencode'),
      { status: 'AUTH_PROVIDER_RECORD_ABSENT' });
  assert.deepEqual(summarizeV2AuthProviderJson('[{"provider":"opencode"}]', 'opencode'),
    { status: 'AUTH_PROVIDER_RECORD_PRESENT' });
  assert.deepEqual(summarizeV2AuthProviderJson('[{"provider":"openai"}]', 'opencode'),
    { status: 'AUTH_PROVIDER_RECORD_ABSENT' });
  assert.deepEqual(summarizeV2AuthProviderJson('[{"token":"PRIVATE"}]', 'opencode'),
    { status: 'AUTH_PROVIDER_METADATA_UNKNOWN' });
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
