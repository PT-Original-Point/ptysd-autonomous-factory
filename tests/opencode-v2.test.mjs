import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync, symlinkSync,
  readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { discoverV2Executables, qualifyOpenCodeV2, parseOpenCodeV2Version, validateV2Model,
  buildV2ReadOnlyArgs, buildV2ReadOnlyConfig, buildV2ScopedEditConfig, buildV2ScopedEditArgs,
  readOpenCodeV2RunEvidence } from '../native-bridge/opencode-v2.mjs';
import { runPlan } from '../native-bridge/worker.mjs';
import { readV2ProviderAuth } from '../native-bridge/v2-readiness.mjs';

test('empty OpenCode auth JSON reaches recoverable WAITING without model or workspace effects', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oc2-empty-auth-wait-'));
  const workspace = join(root, 'workspace');
  const stateDir = join(root, 'state');
  mkdirSync(workspace);
  mkdirSync(stateDir);
  let authReads = 0;
  let modelLaunches = 0;
  try {
    const result = await runPlan('Read the assigned source only.', {
      workspace, state_dir: stateDir, enable_v2_model_runs: true,
      allowed_models: { 'openai/test-model': ['high'] },
    }, {
      schema: 2, kind: 'opencode_plan', request_id: 'PTYSD_EMPTY_AUTH_WAIT_20261017',
      model: 'openai/test-model', variant: 'high',
    }, '00000000-0000-4000-8000-000000000030', {
      qualifyOpenCodeV2: () => ({ ready: true, bin: 'qualified-opencode-v2' }),
      readV2ProviderAuth: (bin, provider, directory) => readV2ProviderAuth(
        bin, provider, directory, (actualBin, args, options) => {
          authReads++;
          assert.equal(actualBin, 'qualified-opencode-v2');
          assert.deepEqual(args, ['auth', 'list', '--format', 'json']);
          assert.equal(options.cwd, workspace);
          return '[]';
        }, {}),
      runCapturedProcess: async () => {
        modelLaunches++;
        throw new Error('MODEL_LAUNCH_FORBIDDEN_IN_TEST');
      },
    });
    assert.equal(authReads, 1);
    assert.equal(result.outcome, 'OPENCODE_V2_AUTH_NOT_READY');
    assert.equal(result.eligibility_state, 'WAITING');
    assert.equal(result.model_invoked, false);
    assert.equal(modelLaunches, 0);
    assert.deepEqual(readdirSync(workspace), []);
    assert.deepEqual(readdirSync(stateDir), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('OpenCode JSONL evidence separates session, inference, tool writes and tokens without retaining text', async () => {
  const dir=mkdtempSync(join(tmpdir(),'oc2-jsonl-evidence-'));
  const output=join(dir,'stdout.jsonl');
  const sessionID='ses_1234567890abcdef';
  const privateText='synthetic private model text must not be copied into evidence';
  try {
    const events=[
      {type:'step_start',sessionID},
      {type:'text',sessionID,part:{type:'text',text:privateText}},
      {type:'tool_use',sessionID,part:{type:'tool',tool:'edit',callID:'call-1',state:{status:'running'}}},
      {type:'tool_use',sessionID,part:{type:'tool',tool:'edit',callID:'call-1',state:{status:'completed'}}},
      {type:'step_finish',sessionID,part:{type:'step-finish',tokens:{input:11,output:3,reasoning:1,cache:{read:2,write:0}}}},
    ];
    const bytes=Buffer.from(`${events.map(event=>JSON.stringify(event)).join('\n')}\n`);
    writeFileSync(output,bytes);
    const hash=createHash('sha256').update(bytes).digest('hex');
    const evidence=await readOpenCodeV2RunEvidence(output,hash);
    assert.equal(evidence.valid,true);
    assert.equal(evidence.session_id,sessionID);
    assert.equal(evidence.session_started,true);
    assert.equal(evidence.provider_usage_evidence,'CONFIRMED');
    assert.equal(evidence.model_activity_evidence,'CONFIRMED');
    assert.equal(evidence.tool_execution_evidence,'OBSERVED');
    assert.equal(evidence.tool_execution_count,1,'running and completed updates for one call count once');
    assert.equal(evidence.file_change_tool_evidence,'COMPLETED');
    assert.equal(evidence.file_change_tool_completed_count,1);
    assert.deepEqual(evidence.token_usage,{input_tokens:11,output_tokens:3,
      cached_input_tokens:2,reasoning_output_tokens:1});
    assert.equal(evidence.model_invoked,true);
    assert.equal(JSON.stringify(evidence).includes(privateText),false);
    assert.equal(evidence.stdout_bytes,bytes.length);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('OpenCode session alone is not model activity, usage, or tool execution', async () => {
  const dir=mkdtempSync(join(tmpdir(),'oc2-jsonl-session-only-'));
  const output=join(dir,'stdout.jsonl');
  try {
    writeFileSync(output,`${JSON.stringify({type:'step_start',sessionID:'ses_abcdefgh12345678'})}\n`);
    const evidence=await readOpenCodeV2RunEvidence(output);
    assert.equal(evidence.valid,true);
    assert.equal(evidence.session_started,true);
    assert.equal(evidence.provider_usage_evidence,'UNKNOWN');
    assert.equal(evidence.model_activity_evidence,'UNKNOWN');
    assert.equal(evidence.tool_execution_evidence,'UNKNOWN');
    assert.equal(evidence.model_invoked,null);

    writeFileSync(output,`${JSON.stringify({type:'text',part:{type:'text',text:'activity without session id'}})}\n`);
    const withoutSession=await readOpenCodeV2RunEvidence(output);
    assert.equal(withoutSession.valid,true);
    assert.equal(withoutSession.session_id,null);
    assert.equal(withoutSession.session_started,null,
      'a missing session identifier is unknown, not evidence that no session started');
    assert.equal(withoutSession.model_activity_evidence,'CONFIRMED');
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('OpenCode partial usage stays unknown and invalid or changed captures fail closed', async () => {
  const dir=mkdtempSync(join(tmpdir(),'oc2-jsonl-negative-'));
  const output=join(dir,'stdout.jsonl');
  try {
    const partial=Buffer.from(`${JSON.stringify({type:'step_finish',sessionID:'ses_abcdefgh12345678',
      part:{type:'step-finish',tokens:{output:5}}})}\n`);
    writeFileSync(output,partial);
    const hash=createHash('sha256').update(partial).digest('hex');
    const evidence=await readOpenCodeV2RunEvidence(output,hash);
    assert.deepEqual(evidence.token_usage,{input_tokens:null,output_tokens:5,
      cached_input_tokens:null,reasoning_output_tokens:null});
    assert.equal(evidence.model_invoked,true);
    assert.equal((await readOpenCodeV2RunEvidence(join(dir,'missing.jsonl'))).reason,
      'OPEN_CODE_JSONL_UNAVAILABLE');
    assert.equal((await readOpenCodeV2RunEvidence(output,'0'.repeat(64))).reason,
      'OPEN_CODE_CAPTURE_HASH_MISMATCH');
    writeFileSync(output,'{bad json\n');
    assert.equal((await readOpenCodeV2RunEvidence(output)).reason,'OPEN_CODE_JSONL_INVALID');
    writeFileSync(output,[
      {type:'step_start',sessionID:'ses_abcdefgh12345678'},
      {type:'step_start',sessionID:'ses_87654321abcdefgh'},
    ].map(event=>JSON.stringify(event)).join('\n'));
    assert.equal((await readOpenCodeV2RunEvidence(output)).reason,'OPEN_CODE_JSONL_MULTIPLE_SESSIONS');
  } finally {rmSync(dir,{recursive:true,force:true});}
});

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
test('Windows discovers the signed OpenCode Desktop CLI before PATH fallbacks', () => {
  const tmp=mkdtempSync(join(tmpdir(),'oc2-desktop-cli-'));
  try {
    const local=join(tmp,'local'), home=join(tmp,'user'), pathBin=join(tmp,'path');
    const desktopDir=join(local,'Programs','@opencodedesktop','resources');
    const homeBin=join(home,'.opencode','bin');
    mkdirSync(desktopDir,{recursive:true});mkdirSync(homeBin,{recursive:true});mkdirSync(pathBin);
    const desktopCli=join(desktopDir,'opencode-cli.exe');
    const homeCli=join(homeBin,'opencode2.exe');
    const pathCli=join(pathBin,'opencode.exe');
    for (const exe of [desktopCli,homeCli,pathCli]) writeFileSync(exe,'synthetic executable');
    const env={LOCALAPPDATA:local,USERPROFILE:home,PATH:pathBin};
    assert.deepEqual(discoverV2Executables(env,true),[desktopCli,homeCli,pathCli]);

    let signatureCalls=0,versionCalls=0;
    const result=qualifyOpenCodeV2(env,true,path=>{
      versionCalls++;assert.equal(path,desktopCli);return 'opencode v2.0.32';
    },path=>{signatureCalls++;assert.equal(path,desktopCli);return true;});
    assert.equal(result.ready,true);
    assert.equal(result.bin,desktopCli);
    assert.equal(result.version,'2.0.32');
    assert.equal(signatureCalls,1);
    assert.equal(versionCalls,1);

    let rejectedVersionCalls=0;
    const rejected=qualifyOpenCodeV2(env,true,()=>{rejectedVersionCalls++;return 'opencode v2.0.32';},()=>false);
    assert.equal(rejected.ready,false,'an unsigned Desktop path never qualifies');
    assert.equal(rejectedVersionCalls,0,'Authenticode failure prevents launching the binary');
  } finally {rmSync(tmp,{recursive:true,force:true});}
});
test('V2 executable discovery does not silently omit entries after the first 120 PATH directories', () => {
  const tmp=mkdtempSync(join(tmpdir(),'oc2-long-path-'));
  try {
    const win=process.platform==='win32';
    const dirs=Array.from({length:121},(_,index)=>join(tmp,`bin-${index}`));
    for (const dir of dirs) mkdirSync(dir);
    const executable=join(dirs[120],win?'opencode.exe':'opencode');
    writeFileSync(executable,'binary');
    if (!win) chmodSync(executable,0o755);
    assert.deepEqual(discoverV2Executables({PATH:dirs.join(delimiter),HOME:tmp},win),[executable]);
  } finally {rmSync(tmp,{recursive:true,force:true});}
});
test('Windows V2 qualification verifies the signed publisher before executing a discovered CLI', () => {
  const tmp=mkdtempSync(join(tmpdir(),'oc2-signature-'));
  try {
    const exe=join(tmp,'opencode-cli.exe');
    const home=join(tmp,'user');
    mkdirSync(home);
    writeFileSync(exe,'synthetic executable');
    const env={PTYSD_OPENCODE_V2_EXE:exe,USERPROFILE:home,PATH:''};
    let signatureCalls=0, versionCalls=0;
    const unsigned=qualifyOpenCodeV2(env,true,()=>{versionCalls++;return 'opencode v2.0.27';},path=>{
      signatureCalls++;assert.equal(path,exe);return false;
    });
    assert.equal(unsigned.ready,false,'an unsigned V2-shaped binary must never be executed');
    assert.equal(signatureCalls,1);
    assert.equal(versionCalls,0);

    const signed=qualifyOpenCodeV2(env,true,()=>{versionCalls++;return 'opencode v2.0.27';},path=>{
      assert.equal(path,exe);return true;
    });
    assert.equal(signed.ready,true);
    assert.equal(signed.signature_status,'VALID');
    assert.equal(versionCalls,1);
  } finally {rmSync(tmp,{recursive:true,force:true});}
});
test('native Windows Authenticode rejects an unsigned V2-shaped executable before version probing', {
  skip: process.platform !== 'win32',
}, () => {
  const tmp=mkdtempSync(join(tmpdir(),'oc2-unsigned-windows-'));
  try {
    const home=join(tmp,'user'), exe=join(tmp,'opencode2.exe');
    mkdirSync(home);
    writeFileSync(exe,'not a signed executable');
    let versionCalls=0;
    const result=qualifyOpenCodeV2({PTYSD_OPENCODE_V2_EXE:exe,USERPROFILE:home,PATH:''},true,
      ()=>{versionCalls++;return 'opencode v2.0.27';});
    assert.equal(result.ready,false);
    assert.equal(versionCalls,0,'Authenticode rejection happens before running the candidate binary');
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
  assert.equal(Object.hasOwn(c.agents['ptysd-readonly'],'steps'),false);
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

test('scoped V2 writer has only explicit edit paths; no implicit shell, external or secret grant', () => {
  const workspace=mkdtempSync(join(tmpdir(),'ptysd-v2-code-contract-'));
  try {
    mkdirSync(join(workspace,'src'));
    mkdirSync(join(workspace,'native-bridge'));
    writeFileSync(join(workspace,'native-bridge','worker.mjs'),'export const candidate = true;\n');
    const cfg=buildV2ScopedEditConfig(workspace,['src/output.mjs']);
    const agent=cfg.agents['ptysd-scoped-write'];
    const exact=join(workspace,'src','output.mjs').replaceAll('\\','/');
    assert.equal(cfg.default_agent,'ptysd-scoped-write');
    assert.equal(Object.hasOwn(agent,'steps'),false);
    assert.equal(cfg.permissions[0].action,'*');
    assert.equal(cfg.permissions[0].effect,'deny');
    assert.deepEqual(agent.permissions.filter(p=>p.action==='edit' && p.effect==='allow').map(p=>p.resource),[exact]);
    assert.equal(agent.permissions.filter(p=>p.action==='shell'&&p.effect==='allow').length,0);
    assert.equal(agent.permissions.filter(p=>p.action==='external_directory'&&p.effect==='allow').length,0);
    for (const file of ['../escape.mjs','src/../escape.mjs','.github/workflows/ci.yml',
      '.git/config','governance/policy.json','runs/last.json',
      'src/.env','src/auth.json','src/token.txt','src/opencode.json','src/*.mjs'])
      assert.throws(()=>buildV2ScopedEditConfig(workspace,[file]),file);
    assert.throws(()=>buildV2ScopedEditConfig(workspace,['src/output.mjs','src/output.mjs']));
    const nativeBridgeCfg=buildV2ScopedEditConfig(workspace,['native-bridge/worker.mjs']);
    assert.deepEqual(nativeBridgeCfg.agents['ptysd-scoped-write'].permissions
      .filter(p=>p.action==='edit' && p.effect==='allow').map(p=>p.resource),
    [join(workspace,'native-bridge','worker.mjs').replaceAll('\\','/')],
    'ordinary native-bridge source may be explicitly scoped while trust-root paths stay denied');
    const broaderScope=Array.from({length:17},(_,index)=>`src/output-${index}.mjs`);
    const broaderCfg=buildV2ScopedEditConfig(workspace,broaderScope);
    assert.equal(broaderCfg.agents['ptysd-scoped-write'].permissions
      .filter(p=>p.action==='edit' && p.effect==='allow').length,17,
    'an exact editable-file allowlist is not capped at the former arbitrary 16 files');
    const longPath=`src/${'x'.repeat(177)}.mjs`;
    assert.ok(longPath.length>180);
    assert.doesNotThrow(()=>buildV2ScopedEditConfig(workspace,[longPath]),
      'a valid worktree-relative path is not rejected by an arbitrary character ceiling');
    const args=buildV2ScopedEditArgs({request_id:'PTYSD_CODE_CANARY_20261013',
      model:'opencode/muse',variant:'high'},workspace,'Edit exact reviewed file');
    assert.equal(args[args.indexOf('--agent')+1],'ptysd-scoped-write');
    assert.equal(args[args.indexOf('--model')+1],'opencode/muse#high');
    assert.ok(!args.includes('--pure')&&!args.includes('--variant'));
  } finally {rmSync(workspace,{recursive:true,force:true});}
});

test('V2 task argument builders do not impose an arbitrary task-spec character ceiling', () => {
  const spec='x'.repeat(25_000);
  const job={request_id:'PTYSD_LONG_SPEC_20261016',model:'openrouter/a/b',variant:'high'};
  assert.ok(buildV2ReadOnlyArgs(job,process.cwd(),spec).at(-1).startsWith(spec));
  assert.ok(buildV2ScopedEditArgs(job,process.cwd(),spec).at(-1).startsWith(spec));
});

test('scoped V2 writer rejects NTFS junctions and symbolic links escaping the worktree', () => {
  const workspace=mkdtempSync(join(tmpdir(),'ptysd-v2-code-junction-'));
  const outside=mkdtempSync(join(tmpdir(),'ptysd-v2-code-outside-'));
  try {
    symlinkSync(outside,join(workspace,'src'),process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => buildV2ScopedEditConfig(workspace,['src/escaped.mjs']),
      /SCOPED_EDIT_REPARSE_POINT/);
  } finally {
    rmSync(workspace,{recursive:true,force:true});
    rmSync(outside,{recursive:true,force:true});
  }
});

test('scoped V2 writer requires existing non-link parent directories', () => {
  const workspace=mkdtempSync(join(tmpdir(),'ptysd-v2-code-parent-'));
  try {
    assert.throws(() => buildV2ScopedEditConfig(workspace,['missing/output.mjs']),
      /SCOPED_EDIT_PARENT_PATH_MISSING/);
  } finally {rmSync(workspace,{recursive:true,force:true});}
});
