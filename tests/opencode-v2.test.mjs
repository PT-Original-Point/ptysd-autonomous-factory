import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync, symlinkSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { discoverV2Executables, qualifyOpenCodeV2, parseOpenCodeV2Version, validateV2Model, buildV2ScopedEditConfig, buildV2ScopedEditArgs, readOpenCodeV2RunEvidence } from '../native-bridge/opencode-v2.mjs';

test('OpenCode V2 JSONL evidence separates session, model usage, tool execution and file edits without retaining text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc2-jsonl-evidence-'));
  const output = join(dir, 'stdout.jsonl');
  const sessionID = 'ses_1234567890abcdef';
  try {
    const events = [
      { type:'step_start', sessionID },
      { type:'text', sessionID, part:{ type:'text', text:'private model content must not enter the receipt' } },
      { type:'tool_use', sessionID, part:{ type:'tool', tool:'edit', callID:'call-1', state:{ status:'running' } } },
      { type:'tool_use', sessionID, part:{ type:'tool', tool:'edit', callID:'call-1', state:{ status:'completed' } } },
      { type:'step_finish', sessionID, part:{ type:'step-finish', tokens:{
        input:11, output:3, reasoning:1, cache:{ read:2, write:0 } } } },
    ];
    writeFileSync(output, `${events.map(event => JSON.stringify(event)).join('\n')}\n`);
    const evidence = await readOpenCodeV2RunEvidence(output);
    assert.equal(evidence.valid, true);
    assert.equal(evidence.session_id, sessionID);
    assert.equal(evidence.session_started, true);
    assert.equal(evidence.provider_usage_evidence, 'CONFIRMED');
    assert.equal(evidence.model_activity_evidence, 'CONFIRMED');
    assert.equal(evidence.tool_execution_evidence, 'OBSERVED');
    assert.equal(evidence.tool_execution_count, 1, 'running and completion updates for one call count once');
    assert.equal(evidence.file_change_tool_evidence, 'COMPLETED');
    assert.equal(evidence.file_change_tool_completed_count, 1);
    assert.deepEqual(evidence.token_usage, {
      input_tokens:11, output_tokens:3, cached_input_tokens:2, reasoning_output_tokens:1,
    });
    assert.equal(evidence.model_invoked, true);
    assert.equal(JSON.stringify(evidence).includes('private model content'), false);
  } finally { rmSync(dir, { recursive:true, force:true }); }
});

test('OpenCode session evidence alone never claims model activity, usage or tool execution', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc2-jsonl-session-only-'));
  const output = join(dir, 'stdout.jsonl');
  try {
    writeFileSync(output, `${JSON.stringify({ type:'step_start', sessionID:'ses_abcdefgh12345678' })}\n`);
    const evidence = await readOpenCodeV2RunEvidence(output);
    assert.equal(evidence.valid, true);
    assert.equal(evidence.session_started, true);
    assert.equal(evidence.provider_usage_evidence, 'UNKNOWN');
    assert.equal(evidence.model_activity_evidence, 'UNKNOWN');
    assert.equal(evidence.tool_execution_evidence, 'UNKNOWN');
    assert.equal(evidence.model_invoked, null,
      'absence of activity evidence is unknown, not proof that the model was not called');
  } finally { rmSync(dir, { recursive:true, force:true }); }
});

test('OpenCode partial token records preserve unknown dimensions instead of inventing zero usage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc2-jsonl-partial-usage-'));
  const output = join(dir, 'stdout.jsonl');
  try {
    writeFileSync(output, `${JSON.stringify({ type:'step_finish', sessionID:'ses_abcdefgh12345678',
      part:{ type:'step-finish', tokens:{ output:5 } } })}\n`);
    const evidence = await readOpenCodeV2RunEvidence(output);
    assert.equal(evidence.valid, true);
    assert.equal(evidence.provider_usage_evidence, 'CONFIRMED');
    assert.deepEqual(evidence.token_usage, {
      input_tokens:null, output_tokens:5, cached_input_tokens:null, reasoning_output_tokens:null,
    });
  } finally { rmSync(dir, { recursive:true, force:true }); }
});

test('OpenCode usage is counted only from step-finish events, avoiding repeated metadata totals', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc2-jsonl-usage-events-'));
  const output = join(dir, 'stdout.jsonl');
  try {
    writeFileSync(output, [
      { type:'session.updated', sessionID:'ses_abcdefgh12345678', tokens:{ input:99, output:20 } },
      { type:'step_finish', sessionID:'ses_abcdefgh12345678',
        part:{ type:'step-finish', tokens:{ input:2, output:1, reasoning:0, cache:{ read:0 } } } },
    ].map(event => JSON.stringify(event)).join('\n'));
    const evidence = await readOpenCodeV2RunEvidence(output);
    assert.equal(evidence.provider_usage_evidence, 'CONFIRMED');
    assert.deepEqual(evidence.token_usage, {
      input_tokens:2, output_tokens:1, cached_input_tokens:0, reasoning_output_tokens:0,
    });
  } finally { rmSync(dir, { recursive:true, force:true }); }
});

test('OpenCode JSONL evidence fails closed for absent, empty, malformed or mixed-session output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc2-jsonl-invalid-'));
  const output = join(dir, 'stdout.jsonl');
  try {
    const missing = await readOpenCodeV2RunEvidence(join(dir, 'missing.jsonl'));
    assert.equal(missing.valid, false);
    assert.equal(missing.reason, 'OPEN_CODE_JSONL_UNAVAILABLE');
    writeFileSync(output, ' \n');
    assert.equal((await readOpenCodeV2RunEvidence(output)).reason, 'OPEN_CODE_JSONL_EMPTY');
    writeFileSync(output, '{"type":"step_start","sessionID":"ses_abcdefgh12345678"}\n{bad json\n');
    const corrupt = await readOpenCodeV2RunEvidence(output);
    assert.equal(corrupt.valid, false);
    assert.equal(corrupt.reason, 'OPEN_CODE_JSONL_INVALID');
    assert.equal(corrupt.session_id, null, 'partial evidence is discarded after corruption');
    writeFileSync(output, [
      { type:'step_start', sessionID:'ses_abcdefgh12345678' },
      { type:'step_start', sessionID:'ses_87654321abcdefgh' },
    ].map(event => JSON.stringify(event)).join('\n'));
    assert.equal((await readOpenCodeV2RunEvidence(output)).reason, 'OPEN_CODE_JSONL_MULTIPLE_SESSIONS');
  } finally { rmSync(dir, { recursive:true, force:true }); }
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
    const dirs=Array.from({length:121},(_,index)=>join(tmp,`bin-${index}`));
    for (const dir of dirs) mkdirSync(dir);
    const executable=join(dirs[120],'opencode');
    writeFileSync(executable,'binary');chmodSync(executable,0o755);
    assert.deepEqual(discoverV2Executables({PATH:dirs.join(delimiter),HOME:tmp},false),[executable]);
  } finally {rmSync(tmp,{recursive:true,force:true});}
});
test('V2 prompt builders preserve 25000-character task specs without a hard-coded cutoff', () => {
  const spec = 'x'.repeat(25_000);
  const job = { request_id:'PTYSD_LONG_SPEC_20261016', model:'openrouter/a/b', variant:'high' };
  const scopedEdit = buildV2ScopedEditArgs(job, process.cwd(), spec);
  assert.ok(scopedEdit.at(-1).startsWith(spec));
  assert.equal(scopedEdit.at(-1).length, spec.length + '\n\nOnly the separately enforced exact file allowlist is mutable. Do not execute shell or request wider permissions.'.length);
});

test('Win32 passes a 25000-character OpenCode prompt argument without launching a model',
  { skip: platform() !== 'win32' }, () => {
    const prompt = 'x'.repeat(25_000);
    const child = spawnSync(process.execPath,
      ['-e', 'process.stdout.write(String(process.argv.at(-1).length))', prompt],
      { encoding:'utf8', shell:false, windowsHide:true });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0);
    assert.equal(child.stdout, '25000');
  });

test('scoped V2 writer has only explicit edit paths; no implicit shell, external or secret grant', () => {
  const workspace=mkdtempSync(join(tmpdir(),'ptysd-v2-code-contract-'));
  try {
    mkdirSync(join(workspace,'src'));
    mkdirSync(join(workspace,'native-bridge'));
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
      'native-bridge/csg-trusted-pr-verifier.mjs','native-bridge/install.ps1',
      'native-bridge/install-codex-executor.ps1','native-bridge/HiddenWorker.vbs',
      'src/.env','src/auth.json','src/token.txt','src/opencode.json','src/*.mjs',
      'src/file?.mjs','src/[a].mjs','src/{a}.mjs'])
      assert.throws(()=>buildV2ScopedEditConfig(workspace,[file]),file);
    if (process.platform === 'win32')
      for (const file of ['src/NUL.txt','src/COM1','src/trailing.','src/trailing '])
        assert.throws(()=>buildV2ScopedEditConfig(workspace,[file]),file);
    assert.doesNotThrow(()=>buildV2ScopedEditConfig(workspace,['native-bridge/worker.mjs']),
      'ordinary source modules under native-bridge can be explicitly scoped');
    assert.doesNotThrow(()=>buildV2ScopedEditConfig(workspace,['src/tokenizer.mjs']),
      'a source filename containing the word tokenizer is not a credential file');
    const longPath=`src/${'x'.repeat(177)}.mjs`;
    assert.ok(longPath.length>180);
    assert.doesNotThrow(()=>buildV2ScopedEditConfig(workspace,[longPath]),
      'a valid worktree-relative path is not rejected by a fixed path-character ceiling');
    assert.throws(()=>buildV2ScopedEditConfig(workspace,['src/output.mjs','src/output.mjs']));
    const args=buildV2ScopedEditArgs({request_id:'PTYSD_CODE_CANARY_20261013',
      model:'opencode/muse',variant:'high'},workspace,'Edit exact reviewed file');
    assert.equal(args[args.indexOf('--agent')+1],'ptysd-scoped-write');
    assert.equal(args[args.indexOf('--model')+1],'opencode/muse#high');
    assert.ok(!args.includes('--pure')&&!args.includes('--variant'));
    assert.ok(!args.includes('--dir'),
      'OpenCode V2 run has no --dir option; the executor must set cwd to the isolated workspace');
    assert.ok(!args.includes(workspace),
      'workspace selection is carried by the child process working directory, not an unsupported CLI flag');
  } finally {rmSync(workspace,{recursive:true,force:true});}
});

test('scoped V2 writer preserves exact Unicode and space-containing source paths', () => {
  const workspace=mkdtempSync(join(tmpdir(),'ptysd-v2-unicode-path-'));
  try {
    mkdirSync(join(workspace,'src'));
    const file='src/工廠 狀態面板.mjs';
    const cfg=buildV2ScopedEditConfig(workspace,[file]);
    const resources=cfg.agents['ptysd-scoped-write'].permissions
      .filter(p=>p.action==='edit'&&p.effect==='allow').map(p=>p.resource);
    assert.deepEqual(resources,[join(workspace,'src','工廠 狀態面板.mjs').replaceAll('\\','/')]);
  } finally {rmSync(workspace,{recursive:true,force:true});}
});

test('scoped V2 writer allows an exact reviewed path set above the removed arbitrary 16-file cap', () => {
  const workspace=mkdtempSync(join(tmpdir(),'ptysd-v2-code-many-paths-'));
  try {
    mkdirSync(join(workspace,'src'));
    const paths=Array.from({length:17},(_,index)=>`src/reviewed-file-${index}.mjs`);
    const cfg=buildV2ScopedEditConfig(workspace,paths);
    const edit=cfg.agents['ptysd-scoped-write'].permissions.filter(p =>
      p.action==='edit' && p.effect==='allow').map(p => p.resource);
    assert.equal(edit.length,17);
    assert.deepEqual(edit,paths.map(file=>join(workspace,file).replaceAll('\\','/')));
  } finally {rmSync(workspace,{recursive:true,force:true});}
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
