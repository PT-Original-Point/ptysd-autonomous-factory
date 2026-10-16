import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync, symlinkSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { discoverV2Executables, qualifyOpenCodeV2, parseOpenCodeV2Version, validateV2Model, buildV2ScopedEditConfig, buildV2ScopedEditArgs } from '../native-bridge/opencode-v2.mjs';

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
