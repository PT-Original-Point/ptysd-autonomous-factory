import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { discoverV2Executables, qualifyOpenCodeV2 } from '../native-bridge/opencode-v2.mjs';
import { readV2ProviderAuth } from '../native-bridge/v2-readiness.mjs';
import { runPlan } from '../native-bridge/worker.mjs';

test('Windows V2 discovery finds and signature-checks the per-user APPDATA Desktop CLI', () => {
  const tmp=mkdtempSync(join(tmpdir(),'oc2-appdata-cli-'));
  try {
    const home=join(tmp,'user'), appData=join(tmp,'roaming');
    const exe=join(appData,'ai.opencode.desktop','cli','2.0.32-x64','opencode-cli.exe');
    mkdirSync(home);
    mkdirSync(join(appData,'ai.opencode.desktop','cli','2.0.32-x64'),{recursive:true});
    writeFileSync(exe,'synthetic executable');
    const env={PATH:'',USERPROFILE:home,APPDATA:appData};
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
    assert.deepEqual(calls,[['signature',exe],['version',exe,['--version']]]);
  } finally {rmSync(tmp,{recursive:true,force:true});}
});

test('Windows V2 APPDATA discovery orders numeric versions newest-first', () => {
  const tmp=mkdtempSync(join(tmpdir(),'oc2-appdata-order-'));
  try {
    const home=join(tmp,'user'), appData=join(tmp,'roaming');
    const cli=join(appData,'ai.opencode.desktop','cli');
    mkdirSync(home);
    for (const version of ['2.0.9-x64','2.0.32-beta.2-x64','2.0.32-beta.10-x64',
      '2.0.32-x64','2.0.31-x64']) {
      mkdirSync(join(cli,version),{recursive:true});
      writeFileSync(join(cli,version,'opencode-cli.exe'),'synthetic executable');
    }
    const env={PATH:'',USERPROFILE:home,APPDATA:appData};
    const expected=['2.0.32-x64','2.0.32-beta.10-x64','2.0.32-beta.2-x64',
      '2.0.31-x64','2.0.9-x64'].map(version=>join(cli,version,'opencode-cli.exe'));
    assert.deepEqual(discoverV2Executables(env,true),expected);
    assert.deepEqual(discoverV2Executables(env,true),expected,
      'repeated scans must preserve deterministic ordering');
  } finally {rmSync(tmp,{recursive:true,force:true});}
});

test('Windows V2 APPDATA candidates are not version-probed unless Authenticode passes', () => {
  const tmp=mkdtempSync(join(tmpdir(),'oc2-appdata-signature-'));
  try {
    const home=join(tmp,'user'), appData=join(tmp,'roaming');
    const exe=join(appData,'ai.opencode.desktop','cli','2.0.32-x64','opencode-cli.exe');
    mkdirSync(home);
    mkdirSync(join(appData,'ai.opencode.desktop','cli','2.0.32-x64'),{recursive:true});
    writeFileSync(exe,'synthetic executable');
    const calls=[];
    const result=qualifyOpenCodeV2({PATH:'',USERPROFILE:home,APPDATA:appData},true,
      (path,args)=>{calls.push(['version',path,args]);return 'opencode v2.0.32';},
      path=>{calls.push(['signature',path]);return false;});
    assert.equal(result.ready,false);
    assert.deepEqual(calls,[['signature',exe]],
      'an untrusted APPDATA candidate must not execute even a --version probe');
  } finally {rmSync(tmp,{recursive:true,force:true});}
});

test('Windows V2 skips an unsigned newer APPDATA CLI, falls back to an older signed CLI, and does not launch a model', async () => {
  const tmp=mkdtempSync(join(tmpdir(),'oc2-appdata-signed-fallback-'));
  try {
    const home=join(tmp,'user'), appData=join(tmp,'roaming');
    const workspace=join(tmp,'workspace'), stateDir=join(tmp,'state');
    const cliRoot=join(appData,'ai.opencode.desktop','cli');
    const newer=join(cliRoot,'2.1.3-x64','opencode-cli.exe');
    const older=join(cliRoot,'2.1.2-x64','opencode-cli.exe');
    mkdirSync(home);
    mkdirSync(workspace);
    mkdirSync(stateDir);
    mkdirSync(join(cliRoot,'2.1.3-x64'),{recursive:true});
    mkdirSync(join(cliRoot,'2.1.2-x64'),{recursive:true});
    writeFileSync(newer,'synthetic untrusted executable');
    writeFileSync(older,'synthetic signed executable');

    const env={PATH:'',USERPROFILE:home,APPDATA:appData};
    const signatureCalls=[],versionCalls=[];
    let authCalls=0,modelLaunches=0;
    const model='opencode/deepseek-v4.1-flash-free';
    const job={schema:6,project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE',host:'W1-REGRESSION',
      request_id:'PTYSD_W1_SIGNED_CLI_FALLBACK_20261029',kind:'opencode_edit',source_pr:900001,
      source_sha:'a'.repeat(40),goal_comment_id:900002,goal_body_sha256:'b'.repeat(64),
      spec_path:'native-bridge/tasks/w1-opencode-signed-cli-fallback.md',
      spec_sha256:'c'.repeat(64),model,variant:null,edit_paths:['src/worker.mjs']};
    const config={workspace,state_dir:stateDir,enable_v2_model_runs:true,
      allowed_models:{[model]:[null]},unauthenticated_free_models:[model]};
    const result=await runPlan('Synthetic W1 fallback regression; no provider or model process may run.',
      config,job,'55555555-5555-4555-8555-555555555555',{
        qualifyOpenCodeV2:()=>qualifyOpenCodeV2(env,true,(path,args)=>{
          versionCalls.push([path,args]);
          return 'opencode v2.1.2';
        },path=>{
          signatureCalls.push(path);
          return path===older;
        }),
        readV2ProviderAuth:(bin,provider,directory)=>{
          authCalls++;
          assert.equal(bin,older,'the older trusted CLI is selected for metadata checks');
          assert.equal(provider,'opencode');
          assert.equal(directory,workspace);
          return {status:'AUTH_PROVIDER_METADATA_UNKNOWN'};
        },
        async runCapturedProcess(){
          modelLaunches++;
          throw new Error('MODEL_PROCESS_MUST_NOT_BE_REACHED');
        },
      });

    assert.deepEqual(signatureCalls,[newer,older],
      'newest APPDATA candidate is rejected before falling back to the older signed CLI');
    assert.deepEqual(versionCalls,[[older,['--version']]],
      'the untrusted newer candidate must never receive a --version call');
    assert.equal(authCalls,1);
    assert.equal(result.outcome,'OPENCODE_V2_AUTH_METADATA_UNKNOWN');
    assert.equal(result.eligibility_state,'WAITING');
    assert.equal(result.model_invoked,false);
    assert.equal(modelLaunches,0,'unknown auth metadata must stop before any model launch');
  } finally {rmSync(tmp,{recursive:true,force:true});}
});

test('real provider-auth parser reports an absent saved-provider record without auth login', () => {
  const calls=[];
  for (const raw of ['[]','{}']) {
    const result=readV2ProviderAuth('C:\\bin\\opencode.exe','opencode','C:\\workspace',
      (_bin,args,options)=>{
        calls.push({args,options});
        return raw;
      },{});
    assert.deepEqual(result,{status:'AUTH_PROVIDER_RECORD_ABSENT'});
  }
  assert.equal(calls.length,2);
  for (const call of calls) {
    assert.deepEqual(call.args,['auth','list','--format','json']);
    assert.equal(call.options.cwd,'C:\\workspace');
  }
  assert.equal(calls.some(call=>call.args.includes('login')),false,
    'reading provider metadata must never invoke auth login');
});

function initializeCleanGitWorkspace(prefix) {
  const root=mkdtempSync(join(tmpdir(),prefix));
  const workspace=join(root,'workspace'), stateDir=join(root,'state');
  try {
    mkdirSync(join(workspace,'src'),{recursive:true});
    mkdirSync(stateDir);
    const git=(...args)=>{
      const result=spawnSync('git',['-C',workspace,...args],{encoding:'utf8',windowsHide:true});
      assert.equal(result.status,0,result.stderr||result.error?.message||'git failed');
      return result.stdout.trim();
    };
    git('init','--quiet');
    git('config','user.name','PTYSD W1 regression');
    git('config','user.email','test@example.invalid');
    git('config','core.autocrlf','false');
    git('config','commit.gpgsign','false');
    writeFileSync(join(workspace,'src','worker.mjs'),'export const value = 1;\n');
    git('add','src/worker.mjs');
    git('commit','--quiet','-m','W1 regression baseline');
    return {root,workspace,stateDir,git,sourceSha:git('rev-parse','HEAD')};
  } catch (error) {
    rmSync(root,{recursive:true,force:true});
    throw error;
  }
}

test('exact built-in free model with no saved provider record reaches the captured process exactly once', async () => {
  const {root,workspace,stateDir,sourceSha}=initializeCleanGitWorkspace('oc2-w1-free-model-');
  try {
    const model='opencode/deepseek-v4.1-flash-free';
    const otherFreeModel='opencode/another-free-model';
    const job={schema:4,project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE',host:'W1-REGRESSION',
      request_id:'PTYSD_W1_FREE_MODEL_CAPTURED_20261023',kind:'opencode_edit',
      source_sha:sourceSha,spec_path:'native-bridge/tasks/w1-free-model.md',
      spec_sha256:'b'.repeat(64),model,variant:null,edit_paths:['src/worker.mjs']};
    const config={workspace,state_dir:stateDir,enable_v2_model_runs:true,
      allowed_models:{[model]:[null]},unauthenticated_free_models:[model]};
    const authCommands=[];
    let authCalls=0,processCalls=0,capturedArgs=null;
    const result=await runPlan('Synthetic W1 regression; only the injected process boundary may run.',
      config,job,'33333333-3333-4333-8333-333333333333',{
        qualifyOpenCodeV2:()=>({ready:true,bin:'qualified-opencode-v2',version:'2.0.32'}),
        readV2ProviderAuth:(bin,provider,directory)=>{
          authCalls++;
          assert.equal(bin,'qualified-opencode-v2');
          assert.equal(provider,'opencode');
          assert.equal(directory,workspace);
          return readV2ProviderAuth(bin,provider,directory,(_bin,args)=>{
            authCommands.push(args);
            return '[]';
          },{});
        },
        async runCapturedProcess(bin,args,options){
          processCalls++;
          assert.equal(bin,'qualified-opencode-v2');
          capturedArgs=args;
          writeFileSync(join(workspace,'src','worker.mjs'),'export const value = 2;\n');
          const sessionID='ses_w1_builtin_free_model_20261023';
          const events=[
            {type:'step_start',sessionID},
            {type:'text',sessionID,part:{type:'text',text:'synthetic W1 free-model output'}},
            {type:'tool_use',sessionID,part:{type:'tool',tool:'edit',callID:'w1-free-edit',
              state:{status:'completed'}}},
            {type:'step_finish',sessionID,part:{type:'step-finish',tokens:{input:10,output:2,
              reasoning:1,cache:{read:0}}}},
          ];
          const out=Buffer.from(`${events.map(event=>JSON.stringify(event)).join('\n')}\n`);
          const err=Buffer.alloc(0);
          writeFileSync(options.stdoutPath,out,{flag:'wx'});
          writeFileSync(options.stderrPath,err,{flag:'wx'});
          const combined=createHash('sha256').update(out)
            .update(Buffer.from('\n--- STDERR ---\n')).update(err).digest('hex');
          return {outcome:'SYNTHETIC_CAPTURED_PROCESS_EXITED',exit_code:0,evidence_sha256:combined,
            evidence_bytes:out.length+Buffer.byteLength('\n--- STDERR ---\n'),local_evidence:{
              stdout_file:basename(options.stdoutPath),
              stdout_sha256:createHash('sha256').update(out).digest('hex'),
              stdout_bytes:out.length,stderr_file:basename(options.stderrPath),
              stderr_sha256:createHash('sha256').update(err).digest('hex'),stderr_bytes:0,
              termination_state:'NOT_REQUESTED'}};
        },
      });
    assert.equal(authCalls,1,'the real provider-auth parser is read once');
    assert.equal(processCalls,1,'the injected process boundary is reached exactly once');
    assert.deepEqual(authCommands,[['auth','list','--format','json']]);
    assert.equal(authCommands.some(args=>args.includes('login')),false);
    assert.ok(capturedArgs,'the process boundary captured its arguments');
    assert.equal(capturedArgs.filter(value=>value==='--model').length,1);
    assert.equal(capturedArgs[capturedArgs.indexOf('--model')+1],model,
      'the exact built-in free model stays pinned');
    assert.equal(capturedArgs.some(value=>typeof value==='string'&&value.startsWith(`${model}#`)),false,
      'a null variant must not be replaced by a fallback variant reference');
    assert.equal(capturedArgs.includes(otherFreeModel),false,
      'no fallback provider/model may replace the pinned model');
    assert.equal(result.local_evidence.provider_authorization,
      'EXPLICIT_LOCAL_UNAUTHENTICATED_FREE_MODEL_ALLOWLIST');
    assert.equal(result.outcome,'V2_EDIT_DIFF_CAPTURED_UNVERIFIED');
    assert.equal(result.model_invoked,true);
    assert.deepEqual(result.changed_files,['src/worker.mjs']);
    assert.equal(result.scope_valid,true);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('absent provider auth never reaches the process boundary without exact dual allowlisting', async () => {
  const {root,workspace,stateDir,sourceSha}=initializeCleanGitWorkspace('oc2-w1-free-model-guard-');
  try {
    const model='opencode/deepseek-v4.1-flash-free';
    const makeJob=()=>({schema:4,project_id:'CHATGPT_GLOBAL_SKILL_GOVERNANCE',host:'W1-REGRESSION',
      request_id:'PTYSD_W1_FREE_MODEL_GUARD_20261023',kind:'opencode_edit',
      source_sha:sourceSha,spec_path:'native-bridge/tasks/w1-free-model-guard.md',
      spec_sha256:'b'.repeat(64),model,variant:null,edit_paths:['src/worker.mjs']});
    const baseConfig={workspace,state_dir:stateDir,enable_v2_model_runs:true,
      allowed_models:{[model]:[null]},unauthenticated_free_models:[model]};
    // The absent-auth free-model allowance is only consulted after the exact
    // model already passes the ordinary model allowlist. These cases prove both
    // guards stay WAITING and never reach the injected process boundary.
    const cases=[
      {label:'free-model allowlist omitted',
        config:{workspace,state_dir:stateDir,enable_v2_model_runs:true,
          allowed_models:{[model]:[null]}},
        outcome:'OPENCODE_V2_AUTH_NOT_READY',authReads:1},
      {label:'free-model allowlist mismatched',
        config:{...baseConfig,unauthenticated_free_models:['opencode/another-free-model']},
        outcome:'OPENCODE_V2_AUTH_NOT_READY',authReads:1},
      {label:'allowed-models omitted',
        config:{workspace,state_dir:stateDir,enable_v2_model_runs:true,
          unauthenticated_free_models:[model]},
        outcome:'MODEL_NOT_EXPLICITLY_ALLOWED',authReads:0},
      {label:'allowed-models variant mismatched',
        config:{...baseConfig,allowed_models:{[model]:['high']}},
        outcome:'MODEL_NOT_EXPLICITLY_ALLOWED',authReads:0},
    ];
    const authCommands=[];
    let authCalls=0,processCalls=0;
    for (const entry of cases) {
      const authBefore=authCalls;
      const result=await runPlan('Synthetic W1 guard regression; no model process may launch.',
        entry.config,makeJob(),'44444444-4444-4444-8444-444444444444',{
          qualifyOpenCodeV2:()=>({ready:true,bin:'qualified-opencode-v2',version:'2.0.32'}),
          readV2ProviderAuth:(bin,provider,directory)=>{
            authCalls++;
            return readV2ProviderAuth(bin,provider,directory,(_bin,args)=>{
              authCommands.push(args);
              return '[]';
            },{});
          },
          async runCapturedProcess(){
            processCalls++;
            throw new Error('PROCESS_BOUNDARY_MUST_NOT_BE_REACHED');
          },
        });
      assert.equal(result.outcome,entry.outcome,entry.label);
      assert.equal(result.eligibility_state,'WAITING',entry.label);
      assert.equal(result.model_invoked,false,entry.label);
      assert.equal(authCalls-authBefore,entry.authReads,entry.label);
    }
    assert.equal(processCalls,0,'no non-allowlisted model may cross the process boundary');
    assert.equal(authCommands.length,2,'only exact-model cases reach the absent-auth gate');
    assert.deepEqual(authCommands,[['auth','list','--format','json'],['auth','list','--format','json']]);
    assert.equal(authCommands.some(args=>args.includes('login')),false);
  } finally {rmSync(root,{recursive:true,force:true});}
});
