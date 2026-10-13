import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverV2Executables, qualifyOpenCodeV2, parseOpenCodeV2Version, validateV2Model, buildV2ReadOnlyArgs, buildV2ReadOnlyConfig } from '../native-bridge/opencode-v2.mjs';

test('V2-only version recognition rejects V1, nonversion and contaminated output', () => {
  for (const s of ['2.0.27', 'v2.0.27', 'opencode v2.0.27', 'opencode2 2.0.27', '2.3.0-beta.2']) assert.ok(parseOpenCodeV2Version(s));
  for (const s of ['1.9.0', 'opencode 1.9.0', 'opencode v1.9.0', 'not a version', '2.0.27 extra', '2.0.27\nsecret']) assert.equal(parseOpenCodeV2Version(s), null);
});
test('V2 model ID preserves multi-slash provider references and exact variant', () => {
  assert.equal(validateV2Model('openrouter/anthropic/claude-4.5', 'high'), true);
  assert.equal(validateV2Model('provider/spark-2', 'max'), true);
  for (const m of ['oldv1', 'openrouter/../secret', 'aa/#evil', 'a/x']) assert.equal(validateV2Model(m,'high'), false);
  for (const v of ['bad#escape','../../../secret','HIGH']) assert.equal(validateV2Model('provider/spark-2',v),false);
});
test('V2 native executable can be selected only when exact version is 2.x', () => {
  const tmp=mkdtempSync(join(tmpdir(),'oc2-'));
  try {
    const home=join(tmp,'user'), bin=join(tmp,'bin'); mkdirSync(home);mkdirSync(bin);
    writeFileSync(join(bin,'opencode'),'binary');chmodSync(join(bin,'opencode'),0o755);
    const env={PATH:bin,HOME:home};
    assert.deepEqual(discoverV2Executables(env,false),[join(bin,'opencode')]);
    let calls=0;
    assert.equal(qualifyOpenCodeV2(env,false,(_cmd,args)=>{calls++;assert.deepEqual(args,['--version']);return '1.9.0'}).ready,false);
    assert.equal(qualifyOpenCodeV2(env,false,()=> '2.0.27').version,'2.0.27');
    assert.equal(calls,1);
  } finally {rmSync(tmp,{recursive:true,force:true});}
});
test('readonly V2 permissions use V2 names and deny mutations after any source', () => {
  const c=buildV2ReadOnlyConfig();
  assert.equal(c.permission,undefined);
  assert.equal(c.agent,undefined);
  assert.equal(c.permissions.find(x=>x.action==='shell')?.effect,'deny');
  assert.equal(c.permissions.find(x=>x.action==='edit')?.effect,'deny');
  assert.equal(c.permissions.find(x=>x.action==='subagent')?.effect,'deny');
  assert.ok(c.permissions.find(x=>x.action==='read'&&x.effect==='allow'));
  assert.equal(c.agents['ptysd-readonly'].mode,'primary');
  assert.equal(c.agents['ptysd-readonly'].permissions.find(x=>x.action==='shell')?.effect,'deny');
  assert.deepEqual(c.plugins,[]);
});
test('V2 arguments use provider/model#variant; never call V1 --pure/--variant', () => {
  const args=buildV2ReadOnlyArgs({request_id:'PTYSD_NATIVE_V2_PLAN_20261013',model:'openrouter/a/b',variant:'deep'},process.cwd(),'Read README only');
  assert.equal(args[0],'run');
  assert.equal(args[args.indexOf('--model')+1],'openrouter/a/b#deep');
  assert.ok(!args.includes('--variant'));assert.ok(!args.includes('--pure'));
  assert.ok(!args.includes('build'));
  assert.throws(()=>buildV2ReadOnlyArgs({model:'bad',variant:'high'},process.cwd(),''));
});
