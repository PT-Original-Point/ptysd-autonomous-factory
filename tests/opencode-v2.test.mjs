import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, chmodSync, symlinkSync, linkSync, lstatSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { discoverV2Executables, qualifyOpenCodeV2, parseOpenCodeV2Version, validateV2Model,
  buildV2ReadOnlyArgs, buildV2ReadOnlyConfig, buildV2ScopedEditConfig, buildV2ScopedEditArgs,
  readOpenCodeV2RunEvidence } from '../native-bridge/opencode-v2.mjs';
import { runPlan } from '../native-bridge/worker.mjs';

test('V2 model argument builders preserve the exact model ID and use isolated standalone mode', () => {
  const model='opencode/deepseek-v4.1-flash-free';
  const workspace=join(tmpdir(),'pty-v2-free-model-workspace');
  const job={model,variant:null,request_id:'PTYSD_FREE_MODEL_ARGS_20261018',edit_paths:['src/worker.mjs']};
  assert.equal(validateV2Model(model,null),true);
  const readonly=buildV2ReadOnlyArgs(job,workspace,'Read the assigned source.');
  const edit=buildV2ScopedEditArgs(job,workspace,'Edit only the assigned source.');
  assert.ok(readonly.includes('--standalone'), 'read-only runs must not attach to a desktop background service');
  assert.ok(edit.includes('--standalone'), 'edit runs must not attach to a desktop background service');
  assert.equal(readonly[readonly.indexOf('--model')+1],model);
  assert.equal(edit[edit.indexOf('--model')+1],model);
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

test('OpenCode free-tier rejection is retained as a sanitized reason without claiming model activity', async () => {
  const dir=mkdtempSync(join(tmpdir(),'oc2-jsonl-free-tier-error-'));
  const output=join(dir,'stdout.jsonl');
  const privateMessage='account-specific provider detail must not be retained';
  try {
    writeFileSync(output,[
      {type:'step_start',sessionID:'ses_freetier12345678'},
      {type:'error',error:{type:'FreeTierError',message:privateMessage}},
    ].map(event=>JSON.stringify(event)).join('\n')+'\n');
    const evidence=await readOpenCodeV2RunEvidence(output);
    assert.equal(evidence.valid,true,'the JSONL capture is structurally valid');
    assert.equal(evidence.reason,'OPEN_CODE_FREE_TIER_REJECTED');
    assert.equal(evidence.session_started,true);
    assert.equal(evidence.provider_usage_evidence,'UNKNOWN');
    assert.equal(evidence.model_activity_evidence,'UNKNOWN');
    assert.equal(evidence.tool_execution_evidence,'UNKNOWN');
    assert.equal(evidence.model_invoked,null,
      'a provider rejection does not establish whether inference began');
    assert.equal(JSON.stringify(evidence).includes(privateMessage),false);
    assert.equal(JSON.stringify(evidence).includes('FreeTierError'),false);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('OpenCode runPlan carries a sanitized provider rejection into local attempt evidence', async () => {
  const root=mkdtempSync(join(tmpdir(),'oc2-runplan-provider-error-'));
  const workspace=join(root,'workspace'),stateDir=join(root,'state');
  const model='opencode/deepseek-v4.1-flash-free';
  const privateMessage='provider diagnostic with private request details';
  mkdirSync(workspace); mkdirSync(stateDir);
  try {
    const result=await runPlan('Synthetic bounded task; transport is stubbed.',
      {workspace,state_dir:stateDir,enable_v2_model_runs:true,
        allowed_models:{[model]:[null]}},
      {schema:2,kind:'opencode_plan',request_id:'PTYSD_OPENCODE_PROVIDER_REJECT_20261019',
        model,variant:null},
      '00000000-0000-4000-8000-000000000099',{
        qualifyOpenCodeV2:()=>({ready:true,bin:'synthetic-opencode-v2',version:'2.0.32'}),
        readV2ProviderAuth:()=>({status:'AUTH_PROVIDER_RECORD_PRESENT'}),
        runCapturedProcess:async(_bin,_args,options)=>{
          const bytes=Buffer.from(`${JSON.stringify({type:'error',
            error:{type:'FreeTierError',message:privateMessage}})}\n`);
          writeFileSync(options.stdoutPath,bytes);
          return {outcome:'OPENCODE_V2_CLI_EXIT_1_UNVERIFIED',exit_code:1,
            local_evidence:{stdout_file:basename(options.stdoutPath),
              stdout_sha256:createHash('sha256').update(bytes).digest('hex')}};
        },
      });
    assert.equal(result.outcome,'OPENCODE_V2_CLI_EXIT_1_UNVERIFIED');
    assert.equal(result.local_evidence.opencode_run.valid,true);
    assert.equal(result.local_evidence.opencode_run.reason,'OPEN_CODE_FREE_TIER_REJECTED');
    assert.equal(result.model_invoked,null);
    assert.equal(JSON.stringify(result.local_evidence).includes(privateMessage),false);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('runPlan dispatches an explicitly allowlisted no-auth OpenCode edit and keeps its diff unverified', async () => {
  const root=mkdtempSync(join(tmpdir(),'oc2-noauth-edit-runplan-'));
  const workspace=join(root,'workspace'),state_dir=join(root,'state');
  const model='opencode/deepseek-v4.1-flash-free';
  mkdirSync(join(workspace,'src'),{recursive:true});
  mkdirSync(state_dir);
  writeFileSync(join(workspace,'src','answer.mjs'),'export const answer = 41;\n');
  execFileSync('git',['-C',workspace,'init','--quiet']);
  execFileSync('git',['-C',workspace,'config','user.name','PTYSD W1 Test Baseline']);
  execFileSync('git',['-C',workspace,'config','user.email','w1-test-baseline@invalid']);
  execFileSync('git',['-C',workspace,'add','--','src/answer.mjs']);
  execFileSync('git',['-C',workspace,'commit','--quiet','-m','test baseline']);
  const source_sha=execFileSync('git',['-C',workspace,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
  const job={schema:4,kind:'opencode_edit',request_id:'PTYSD_W1_NOAUTH_EDIT_20261019',
    model,variant:null,source_sha,edit_paths:['src/answer.mjs']};
  const config={workspace,state_dir,enable_v2_model_runs:true,
    allowed_models:{[model]:[null]},unauthenticated_free_models:[model]};
  let launches=0;
  try {
    const result=await runPlan(
      'Change only src/answer.mjs so the exported answer is 42.',
      config,job,'11111111-1111-4111-8111-111111111111',{
        qualifyOpenCodeV2:()=>({ready:true,bin:'qualified-opencode-v2',version:'2.0.32'}),
        readV2ProviderAuth:()=>({status:'AUTH_PROVIDER_RECORD_ABSENT'}),
        runCapturedProcess:async(bin,args,options)=>{
          launches++;
          assert.equal(bin,'qualified-opencode-v2');
          assert.equal(args[0],'run');
          assert.equal(args.includes('--standalone'),true);
          assert.equal(args[args.indexOf('--agent')+1],'ptysd-scoped-write');
          assert.equal(args[args.indexOf('--model')+1],model);
          assert.equal(options.cwd,workspace);
          assert.equal(options.env.GITHUB_TOKEN,undefined);
          assert.equal(options.env.GH_TOKEN,undefined);
          assert.equal(options.env.OPENCODE_CONFIG_CONTENT,undefined);
          writeFileSync(join(workspace,'src','answer.mjs'),'export const answer = 42;\n');
          const bytes=Buffer.from(JSON.stringify({type:'step_start',sessionID:'ses_noauthedit1234567'})+'\n');
          writeFileSync(options.stdoutPath,bytes);
          return {outcome:'OPENCODE_V2_CLI_EXIT_0_UNVERIFIED',exit_code:0,
            local_evidence:{stdout_file:basename(options.stdoutPath),
              stdout_sha256:createHash('sha256').update(bytes).digest('hex'),
              stdout_bytes:bytes.length,termination_state:'NOT_REQUESTED'}};
        },
      });
    assert.equal(launches,1);
    assert.equal(result.outcome,'V2_EDIT_DIFF_CAPTURED_UNVERIFIED');
    assert.equal(result.coding_state,'DIFF_CAPTURED_UNVERIFIED');
    assert.equal(result.local_evidence.provider_authorization,
      'EXPLICIT_LOCAL_UNAUTHENTICATED_FREE_MODEL_ALLOWLIST');
    assert.equal(result.scope_valid,true);
    assert.deepEqual(result.changed_files,['src/answer.mjs']);
    assert.ok(result.diff_sha256);
    assert.equal(readFileSync(join(workspace,'src','answer.mjs'),'utf8'),'export const answer = 42;\n');
    assert.equal(existsSync(join(workspace,'opencode.json')),false);
  } finally {rmSync(root,{recursive:true,force:true});}
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
test('Windows V2 discovery includes the official OpenCode Desktop bundled CLI and still qualifies it', () => {
  const tmp=mkdtempSync(join(tmpdir(),'oc2-desktop-cli-'));
  try {
    const home=join(tmp,'user'), localAppData=join(tmp,'local');
    const exe=join(localAppData,'Programs','@opencodedesktop','resources','opencode-cli.exe');
    mkdirSync(home);mkdirSync(join(localAppData,'Programs','@opencodedesktop','resources'),{recursive:true});
    writeFileSync(exe,'synthetic executable');
    const env={PATH:'',USERPROFILE:home,LOCALAPPDATA:localAppData};
    assert.deepEqual(discoverV2Executables(env,true),[exe]);

    const calls=[];
    const result=qualifyOpenCodeV2(env,true,(path,args)=>{
      calls.push(['version',path,args]);
      return 'opencode v2.0.32';
    },path=>{
      calls.push(['signature',path]);
      return path===exe;
    });
    assert.equal(result.ready,true);
    assert.equal(result.bin,exe);
    assert.equal(result.version,'2.0.32');
    assert.deepEqual(calls,[['signature',exe],['version',exe,['--version']]],
      'the bundled candidate must pass Authenticode verification before version execution');
  } finally {rmSync(tmp,{recursive:true,force:true});}
});
test('Windows V2 discovery prefers the verified Desktop CLI over an older user-local candidate', () => {
  const tmp=mkdtempSync(join(tmpdir(),'oc2-desktop-priority-'));
  try {
    const home=join(tmp,'user'), bin=join(home,'.opencode','bin'), localAppData=join(tmp,'local');
    const oldExe=join(bin,'opencode2.exe');
    const desktopExe=join(localAppData,'Programs','@opencodedesktop','resources','opencode-cli.exe');
    mkdirSync(bin,{recursive:true});
    mkdirSync(join(localAppData,'Programs','@opencodedesktop','resources'),{recursive:true});
    writeFileSync(oldExe,'older official executable');
    writeFileSync(desktopExe,'desktop official executable');
    const env={PATH:bin,USERPROFILE:home,LOCALAPPDATA:localAppData};
    assert.deepEqual(discoverV2Executables(env,true),[desktopExe,oldExe]);

    const result=qualifyOpenCodeV2(env,true,(path,args)=>{
      assert.equal(path,desktopExe,'the current Desktop CLI is probed before the older user-local V2');
      assert.deepEqual(args,['--version']);
      return 'opencode v2.0.32';
    },path=>path===desktopExe);
    assert.equal(result.ready,true);
    assert.equal(result.bin,desktopExe);
    assert.equal(result.version,'2.0.32');
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
test('readonly V2 policy fails closed for unknown browser, computer and mcp actions', () => {
  const cfg=buildV2ReadOnlyConfig();
  const policies=[
    ['readonly-global',cfg.permissions],
    ['readonly-agent',cfg.agents['ptysd-readonly'].permissions],
  ];
  const matches=(pattern,resource)=>new RegExp('^'+pattern.replaceAll('.','\\.').replaceAll('*','.*')+'$',
    platform()==='win32'?'i':'').test(resource);
  const decide=(rules,action,resource)=>rules
    .filter(rule=>(rule.action===action||rule.action==='*')&&matches(rule.resource,resource)).at(-1)?.effect;
  for(const [name,rules] of policies){
    for(const action of ['browser','computer_use','browser_click','mcp__computer_use__click',
      'mcp__filesystem__read_file','mcp__unknown'])
      assert.equal(decide(rules,action,'*'),'deny',`${name} must fail closed for ${action}`);
    for(const action of ['edit','shell','subagent'])
      assert.equal(decide(rules,action,'*'),'deny',`${name} must keep denying ${action}`);
    assert.equal(decide(rules,'read','src/index.mjs'),'allow',`${name} must keep read allowed`);
    assert.equal(decide(rules,'glob','src/**'),'allow',`${name} must keep glob allowed`);
    assert.equal(decide(rules,'read','.env'),'deny',`${name} must still protect secret files`);
    assert.equal(decide(rules,'read','src/.env.example'),'allow',`${name} must still allow the example exception`);
  }
});
test('V2 worker read policy blocks secret env variants and unscoped content search', () => {
  const writer=buildV2ScopedEditConfig(process.cwd(),['README.md']);
  const configs=[
    ['readonly',buildV2ReadOnlyConfig().permissions],
    ['writer-global',writer.permissions],
    ['writer-agent',writer.agents['ptysd-scoped-write'].permissions],
  ];
  const matches=(pattern,resource)=>new RegExp('^'+pattern.replaceAll('.','\\.').replaceAll('*','.*')+'$',
    platform()==='win32'?'i':'').test(resource);
  const decide=(rules,action,resource)=>rules
    .filter(rule=>(rule.action===action||rule.action==='*')&&matches(rule.resource,resource)).at(-1)?.effect;
  for(const [name,rules] of configs){
    for(const path of ['.env','.env.production','src/.env.local','.npmrc','src/credentials.json'])
      assert.equal(decide(rules,'read',path),'deny',`${name} can read ${path}`);
    assert.equal(decide(rules,'read','src/.env.example'),'allow',`${name} should allow non-secret examples`);
    assert.equal(decide(rules,'grep','API_KEY'),'deny',`${name} can search file contents without a path boundary`);
  }
});
test('V2 policies deny external-directory access before read exceptions are applied', () => {
  const writer=buildV2ScopedEditConfig(process.cwd(),['README.md']);
  const externalDirectory=join(tmpdir(),'unrelated-opencode-worktree');
  const externalExample=join(externalDirectory,'.env.example');
  const configs=[
    ['readonly-global',buildV2ReadOnlyConfig().permissions],
    ['readonly-agent',buildV2ReadOnlyConfig().agents['ptysd-readonly'].permissions],
    ['writer-global',writer.permissions],
    ['writer-agent',writer.agents['ptysd-scoped-write'].permissions],
  ];
  const matches=(pattern,resource)=>new RegExp('^'+pattern.replaceAll('.','\\.').replaceAll('*','.*')+'$',
    platform()==='win32'?'i':'').test(resource);
  const decide=(rules,action,resource)=>rules
    .filter(rule=>(rule.action===action||rule.action==='*')&&matches(rule.resource,resource)).at(-1)?.effect;
  for(const [name,rules] of configs){
    assert.equal(decide(rules,'read',externalExample),'allow',
      `${name} must retain the documented in-workspace .env.example exception`);
    assert.equal(decide(rules,'external_directory',externalDirectory),'deny',
      `${name} must deny an external workspace before evaluating read`);
    const pathAccess=decide(rules,'external_directory',externalDirectory)==='deny'
      ? 'deny' : decide(rules,'read',externalExample);
    assert.equal(pathAccess,'deny',`${name} must not read an external .env.example`);
  }
});
test('V2 arguments use provider/model#variant; never call V1 --pure/--variant', () => {
  const args=buildV2ReadOnlyArgs({request_id:'PTYSD_NATIVE_V2_PLAN_20261013',model:'openrouter/a/b',variant:'deep'},process.cwd(),'Read README only');
  assert.equal(args[0],'run');
  assert.equal(args[args.indexOf('--model')+1],'openrouter/a/b#deep');
  assert.ok(!args.includes('--variant'));assert.ok(!args.includes('--pure'));
  assert.ok(!args.includes('--dir'),'the native Worker supplies workspace as process cwd; V2 run has no --dir flag');
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
    const expectedResources=[exact,'src/output.mjs'];
    if(platform()==='win32') expectedResources.push(join(workspace,'src','output.mjs'),'src\\output.mjs');
    assert.deepEqual(agent.permissions.filter(p=>p.action==='edit' && p.effect==='allow')
      .map(p=>p.resource).sort(),expectedResources.sort());
    assert.equal(agent.permissions.filter(p=>p.action==='shell'&&p.effect==='allow').length,0);
    assert.equal(agent.permissions.filter(p=>p.action==='external_directory'&&p.effect==='allow').length,0);
    for (const file of ['../escape.mjs','src/../escape.mjs','.github/workflows/ci.yml',
      '.git/config','governance/policy.json','runs/last.json',
      'src/.env','src/auth.json','src/token.txt','src/opencode.json','src/*.mjs'])
      assert.throws(()=>buildV2ScopedEditConfig(workspace,[file]),file);
    assert.throws(()=>buildV2ScopedEditConfig(workspace,['src/output.mjs','src/output.mjs']));
    const nativeBridgeCfg=buildV2ScopedEditConfig(workspace,['native-bridge/worker.mjs']);
    assert.deepEqual(nativeBridgeCfg.agents['ptysd-scoped-write'].permissions
      .filter(p=>p.action==='edit' && p.effect==='allow').map(p=>p.resource).sort(),
    [join(workspace,'native-bridge','worker.mjs').replaceAll('\\','/'),
      'native-bridge/worker.mjs', ...(platform()==='win32' ? [join(workspace,'native-bridge','worker.mjs'),
        'native-bridge\\worker.mjs'] : [])].sort(),
    'ordinary native-bridge source may be explicitly scoped while trust-root paths stay denied');
    const broaderScope=Array.from({length:17},(_,index)=>`src/output-${index}.mjs`);
    const broaderCfg=buildV2ScopedEditConfig(workspace,broaderScope);
    assert.equal(new Set(broaderCfg.agents['ptysd-scoped-write'].permissions
      .filter(p=>p.action==='edit' && p.effect==='allow' && p.resource.startsWith('src/'))
      .map(p=>p.resource)).size,17,
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
    assert.ok(!args.includes('--dir'),'the native Worker supplies workspace as process cwd; V2 run has no --dir flag');
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

test('scoped V2 writer rejects an in-workspace hard link to an outside file', (t) => {
  const workspace=mkdtempSync(join(tmpdir(),'ptysd-v2-code-hardlink-'));
  const outside=mkdtempSync(join(tmpdir(),'ptysd-v2-code-hardlink-outside-'));
  try {
    const outsideFile=join(outside,'outside.mjs');
    writeFileSync(outsideFile,'export const outside = true;\n');
    const hardLink=join(workspace,'linked.mjs');
    try {
      linkSync(outsideFile,hardLink);
    } catch (error) {
      // A platform that cannot create hard links cannot build this fixture.
      t.skip(`hard links unsupported: ${error.code ?? error.message}`);
      return;
    }
    assert.ok(lstatSync(hardLink).nlink>1,
      'the fixture must actually share an inode with the outside file');
    assert.throws(()=>buildV2ScopedEditConfig(workspace,['linked.mjs']),
      /SCOPED_EDIT_HARD_LINK/);
    writeFileSync(join(workspace,'plain.mjs'),'export const plain = true;\n');
    assert.doesNotThrow(()=>buildV2ScopedEditConfig(workspace,['plain.mjs']));
  } finally {
    rmSync(workspace,{recursive:true,force:true});
    rmSync(outside,{recursive:true,force:true});
  }
});

test('scoped V2 writer rejects UNC workspace roots before filesystem access on Windows', () => {
  if (platform() !== 'win32') return;
  assert.throws(() => buildV2ScopedEditConfig('\\\\server\\share\\repo',['src/output.mjs']),
    /SCOPED_EDIT_WORKSPACE_UNC_PATH/);
});
test('scoped V2 writer rejects a reparse point at the workspace root', () => {
  const parent=mkdtempSync(join(tmpdir(),'ptysd-v2-code-root-parent-'));
  const target=join(parent,'real-workspace');
  const alias=join(parent,'workspace-alias');
  mkdirSync(target);
  try {
    symlinkSync(target,alias,process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => buildV2ScopedEditConfig(alias,['src/output.mjs']),
      /SCOPED_EDIT_WORKSPACE_REPARSE_POINT/);
  } finally { rmSync(parent,{recursive:true,force:true}); }
});
test('scoped V2 writer requires existing non-link parent directories', () => {
  const workspace=mkdtempSync(join(tmpdir(),'ptysd-v2-code-parent-'));
  try {
    assert.throws(() => buildV2ScopedEditConfig(workspace,['missing/output.mjs']),
      /SCOPED_EDIT_PARENT_PATH_MISSING/);
  } finally {rmSync(workspace,{recursive:true,force:true});}
});

test('scoped V2 writer accepts exact existing paths with spaces, Unicode and literal punctuation', () => {
  const workspace=mkdtempSync(join(tmpdir(),'ptysd-v2-code-literal-'));
  try {
    mkdirSync(join(workspace,'src'));
    const relativePaths=['src/module with spaces.mjs','src/控制器.mjs',
      'src/a+b.mjs','src/module(1).mjs','src/file@draft.mjs','src/file!draft.mjs'];
    for (const relativePath of relativePaths)
      writeFileSync(join(workspace,...relativePath.split('/')),'export default true;\n');
    const cfg=buildV2ScopedEditConfig(workspace,relativePaths);
    const allowed=cfg.agents['ptysd-scoped-write'].permissions
      .filter(p=>p.action==='edit' && p.effect==='allow').map(p=>p.resource);
    const expected=[];
    for (const relativePath of relativePaths) {
      const native=join(workspace,...relativePath.split('/'));
      expected.push(relativePath,native.replaceAll('\\','/'));
      if (platform()==='win32') expected.push(relativePath.replaceAll('/','\\'),native);
    }
    assert.deepEqual(allowed.sort(),expected.sort(),
      'each literal path grants only its exact relative and absolute resource strings');
    for (const relativePath of relativePaths)
      assert.ok(allowed.includes(relativePath),relativePath);
  } finally {rmSync(workspace,{recursive:true,force:true});}
});

test('scoped V2 writer accepts @/_ leading segments but still denies top-level dotfiles', () => {
  const workspace=mkdtempSync(join(tmpdir(),'ptysd-v2-code-prefix-'));
  try {
    mkdirSync(join(workspace,'@types'));
    mkdirSync(join(workspace,'_helpers'));
    writeFileSync(join(workspace,'@types','bridge.d.ts'),'export {};\n');
    writeFileSync(join(workspace,'_helpers','worker.mjs'),'export const worker = true;\n');
    const relativePaths=['@types/bridge.d.ts','_helpers/worker.mjs'];
    const cfg=buildV2ScopedEditConfig(workspace,relativePaths);
    const allowed=cfg.agents['ptysd-scoped-write'].permissions
      .filter(p=>p.action==='edit' && p.effect==='allow').map(p=>p.resource);
    const expected=[];
    for (const relativePath of relativePaths) {
      const native=join(workspace,...relativePath.split('/'));
      expected.push(relativePath,native.replaceAll('\\','/'));
      if (platform()==='win32') expected.push(relativePath.replaceAll('/','\\'),native);
    }
    assert.deepEqual(allowed.sort(),expected.sort(),
      'a leading @ or _ grants only its exact relative and absolute resource strings');
    for (const relativePath of relativePaths)
      assert.ok(allowed.includes(relativePath),relativePath);
    // A top-level dotfile stays denied even though interior dots are allowed.
    assert.throws(()=>buildV2ScopedEditConfig(workspace,['.gitmodules']),
      /SCOPED_EDIT_FILE_PATH_INVALID/);
    assert.doesNotThrow(()=>buildV2ScopedEditConfig(workspace,['@types/bridge.d.ts']));
    assert.doesNotThrow(()=>buildV2ScopedEditConfig(workspace,['_helpers/worker.mjs']));
  } finally {rmSync(workspace,{recursive:true,force:true});}
});

test('scoped V2 writer rejects active glob and extglob path patterns', () => {
  const workspace=mkdtempSync(join(tmpdir(),'ptysd-v2-code-glob-'));
  try {
    mkdirSync(join(workspace,'src'));
    writeFileSync(join(workspace,'src','plain.mjs'),'export default true;\n');
    // An edit resource is matched as a glob: wildcards, character classes, brace
    // expansion and extglob openers would silently widen the exact grant, so they
    // must fail closed. A lone + @ ! or parenthesis (accepted elsewhere) must not.
    for (const file of ['src/*.mjs','src/mod?.mjs','src/[ab].mjs','src/{a,b}.mjs',
      'src/!(exact).mjs','src/@(a).mjs','src/+(a).mjs','src/?(a).mjs','src/*(a).mjs',
      'src\\plain.mjs','C:/src/plain.mjs','src/module\nspace.mjs','src/module\tspace.mjs',
      '.gitmodules']) {
      assert.throws(()=>buildV2ScopedEditConfig(workspace,[file]),file);
    }
    if (platform()==='win32') {
      for (const file of ['src/trailing-dot.','src/trailing-space ',
        'src/CON','src/NUL.mjs','src/COM1.txt','src/LPT9','src/COM¹.log']) {
        assert.throws(()=>buildV2ScopedEditConfig(workspace,[file]),
          /SCOPED_EDIT_FILE_PATH_INVALID/,file);
      }
      assert.doesNotThrow(()=>buildV2ScopedEditConfig(workspace,['src/CONtainer.mjs']));
    }
    // Traversal is still rejected with its dedicated reason.
    assert.throws(()=>buildV2ScopedEditConfig(workspace,['src/../plain.mjs']),
      /SCOPED_EDIT_FILE_TRAVERSAL/);
    // The plain path remains a valid exact allowlist entry.
    assert.doesNotThrow(()=>buildV2ScopedEditConfig(workspace,['src/plain.mjs']));
    assert.throws(()=>buildV2ScopedEditConfig(workspace,['src/plain.mjs','src/plain.mjs']),
      /SCOPED_EDIT_DUPLICATE_PATH/);
  } finally {rmSync(workspace,{recursive:true,force:true});}
});
