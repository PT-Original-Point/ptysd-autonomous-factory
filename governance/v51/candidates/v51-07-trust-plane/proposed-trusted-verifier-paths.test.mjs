import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {TRUSTED_EXPECTED_SET_PATH,verifyExactProtectedTransition,verifyPathSet,verifyRepositoryCandidate} from './proposed-trusted-verifier.mjs';

const repeat=char=>char.repeat(40);
const BASE=repeat('a');
const HEAD=repeat('b');
const TREE=repeat('c');
const FILE_BLOB=repeat('d');
const EXPECTED_SET_BLOB=repeat('e');
const WORKFLOW_SHA=repeat('f');
const WORKFLOW_PATH='.github/workflows/factory-bounded.yml';

function expectCode(fn,code){
  assert.throws(fn,error=>error?.code===code);
}
function makeExpected(overrides={}){
  return {
    schema:'csg.trusted-transition-expected-set.v1',
    repository_id:'1352411536',
    baseRef:'main',
    baseOid:BASE,
    headOid:HEAD,
    treeOid:TREE,
    changes:[{path:WORKFLOW_PATH,status:'M',blobOid:FILE_BLOB}],
    ...overrides
  };
}
function makeActual(overrides={}){
  return {
    baseRef:'main',
    baseOid:BASE,
    headOid:HEAD,
    treeOid:TREE,
    parentOids:[BASE],
    changes:[{path:WORKFLOW_PATH,status:'M',blobOid:FILE_BLOB}],
    ...overrides
  };
}
function verify(actual=makeActual(),expectedSet=makeExpected(),sourceSha=WORKFLOW_SHA){
  return verifyExactProtectedTransition({
    actual,
    expectedSet,
    expectedSetSourceSha:sourceSha,
    expectedSetBlobOid:EXPECTED_SET_BLOB,
    workflowSha:WORKFLOW_SHA
  });
}

test('ordinary changes cannot add workflow code on either supported base',()=>{
  for(const baseRef of ['main','v45/factory-control']){
    for(const filePath of [
      '.github/workflows/factory-bounded.yml',
      '.GITHUB/WORKFLOWS/nested/escape.yml',
      '.github/actions/privileged/action.yml'
    ]){
      expectCode(()=>verifyPathSet([filePath],{baseRef}),'TRUST_ROOT_OR_AUTHORITY_CHANGE_FORBIDDEN');
    }
  }
});

test('main default-denies current control, checkpoints, all versioned Mission/Policy, and Directory authority paths',()=>{
  for(const filePath of [
    'governance/csg/current.json',
    'governance/csg/checkpoints/000192.json',
    'governance/v47/current-mission.json',
    'governance/v50/current-execution-policy.json',
    'governance/v99/current-mission.json',
    'directory/projects/CHATGPT_GLOBAL_SKILL_GOVERNANCE.json',
    'governance/project-directory/project.json'
  ]){
    expectCode(()=>verifyPathSet([filePath],{baseRef:'main'}),'TRUST_ROOT_OR_AUTHORITY_CHANGE_FORBIDDEN');
  }
});

test('ordinary non-trust candidate data remains admissible on main',()=>{
  const out=verifyPathSet([
    'governance/v51/candidates/v51-07-trust-plane/README.md',
    'tools/csg/factory-mcp/src/index.mjs'
  ],{baseRef:'main'});
  assert.equal(out.count,2);
});

test('path parsing fails closed on traversal, backslashes, and case collisions',()=>{
  for(const filePath of ['/root.yml','C:/root.yml','../escape.yml','a/../escape.yml','a\\b.yml']){
    expectCode(()=>verifyPathSet([filePath],{baseRef:'main'}),'INVALID_PATH');
  }
  expectCode(()=>verifyPathSet(['tools/a.mjs','TOOLS/a.mjs'],{baseRef:'main'}),'DUPLICATE_OR_CASE_COLLIDING_PATH');
});

test('protected transition passes only against a trusted pinned exact head, tree, parent, paths, and blobs',()=>{
  const out=verify();
  assert.equal(out.headOid,HEAD);
  assert.equal(out.treeOid,TREE);
  assert.equal(out.trustedExpectedSetSourceSha,WORKFLOW_SHA);
  assert.equal(out.trustedExpectedSetBlobOid,EXPECTED_SET_BLOB);
  assert.deepEqual(out.paths,[WORKFLOW_PATH]);
});

test('protected transition rejects an expected set not read from the pinned workflow source',()=>{
  expectCode(()=>verify(makeActual(),makeExpected(),repeat('9')),'EXPECTED_SET_NOT_FROM_PINNED_WORKFLOW_SOURCE');
});

test('protected transition rejects exact head, tree, base, parent, changed path, and blob drift',()=>{
  expectCode(()=>verify(makeActual({headOid:repeat('9')})),'EXPECTED_HEAD_OID_MISMATCH');
  expectCode(()=>verify(makeActual({treeOid:repeat('9')})),'EXPECTED_TREE_OID_MISMATCH');
  expectCode(()=>verify(makeActual({baseOid:repeat('9')})),'EXPECTED_BASE_OID_MISMATCH');
  expectCode(()=>verify(makeActual({parentOids:[repeat('9')]})),'DIRECT_PARENT_MISMATCH');
  expectCode(()=>verify(makeActual({parentOids:[BASE,repeat('8')]})),'DIRECT_PARENT_MISMATCH');
  expectCode(()=>verify(makeActual({changes:[{path:WORKFLOW_PATH,status:'M',blobOid:repeat('9')}]})),'EXPECTED_PATH_STATUS_OR_BLOB_SET_MISMATCH');
  expectCode(()=>verify(makeActual({changes:[{path:WORKFLOW_PATH,status:'M',blobOid:FILE_BLOB},{path:'extra.txt',status:'A',blobOid:repeat('7')}]})),'EXPECTED_PATH_STATUS_OR_BLOB_SET_MISMATCH');
});

test('expected transition schema and blob identities are strict',()=>{
  expectCode(()=>verify(makeActual(),makeExpected({extra:true})),'INVALID_EXPECTED_SET_FIELDS');
  expectCode(()=>verify(makeActual(),makeExpected({repository_id:'other'})),'EXPECTED_SET_REPOSITORY_MISMATCH');
  expectCode(()=>verify(makeActual(),makeExpected({changes:[{path:WORKFLOW_PATH,status:'D',blobOid:FILE_BLOB}]})),'INVALID_DELETED_BLOB_OID');
});

function runGit(cwd,args){
  return execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
}
function initGit(cwd){
  mkdirSync(cwd,{recursive:true});
  runGit(cwd,['init','--initial-branch=main']);
  runGit(cwd,['config','user.name','V51-07 isolated test']);
  runGit(cwd,['config','user.email','v51-07-test@example.invalid']);
}
function commitFile(cwd,filePath,contents,message){
  const fullPath=path.join(cwd,...filePath.split('/'));
  mkdirSync(path.dirname(fullPath),{recursive:true});
  writeFileSync(fullPath,contents,'utf8');
  runGit(cwd,['add','--',filePath]);
  runGit(cwd,['commit','-m',message]);
  return runGit(cwd,['rev-parse','HEAD']);
}
function gitBlob(cwd,commit,filePath){
  return runGit(cwd,['rev-parse','--verify',commit+':'+filePath]);
}

test('repository readback derives direct parent, tree, changed paths, and blobs from Git',t=>{
  const candidate=mkdtempSync(path.join(os.tmpdir(),'v51-07-candidate-'));
  t.after(()=>rmSync(candidate,{recursive:true,force:true}));
  initGit(candidate);
  const filePath='tools/csg/app.mjs';
  const base=commitFile(candidate,filePath,'export const version=1;\n','base');
  const head=commitFile(candidate,filePath,'export const version=2;\n','candidate');
  const result=verifyRepositoryCandidate({repo:candidate,baseOid:base,headOid:head,baseRef:'main'});
  assert.equal(result.baseOid,base);
  assert.equal(result.headOid,head);
  assert.equal(result.treeOid,runGit(candidate,['rev-parse','--verify',head+'^{tree}']));
  assert.deepEqual(result.changes,[{path:filePath,status:'M',blobOid:gitBlob(candidate,head,filePath)}]);
  assert.equal(result.protectedTransition,false);
});

test('repository readback denies a protected change without an expected set from trusted checkout',t=>{
  const candidate=mkdtempSync(path.join(os.tmpdir(),'v51-07-deny-'));
  t.after(()=>rmSync(candidate,{recursive:true,force:true}));
  initGit(candidate);
  const filePath='.github/workflows/factory-bounded.yml';
  const base=commitFile(candidate,filePath,'name: old\n','base');
  const head=commitFile(candidate,filePath,'name: new\n','candidate');
  expectCode(()=>verifyRepositoryCandidate({repo:candidate,baseOid:base,headOid:head,baseRef:'main'}),'PROTECTED_PATH_REQUIRES_TRUSTED_EXPECTED_SET');
});

test('repository readback accepts only the exact protected transition loaded from pinned trusted checkout',t=>{
  const candidate=mkdtempSync(path.join(os.tmpdir(),'v51-07-exact-'));
  const trusted=mkdtempSync(path.join(os.tmpdir(),'v51-07-trusted-'));
  t.after(()=>rmSync(candidate,{recursive:true,force:true}));
  t.after(()=>rmSync(trusted,{recursive:true,force:true}));
  initGit(candidate);
  const filePath='.github/workflows/factory-bounded.yml';
  const base=commitFile(candidate,filePath,'name: old\n','base');
  const head=commitFile(candidate,filePath,'name: exact\n','candidate');
  const tree=runGit(candidate,['rev-parse','--verify',head+'^{tree}']);
  const expected={
    schema:'csg.trusted-transition-expected-set.v1',
    repository_id:'1352411536',
    baseRef:'main',
    baseOid:base,
    headOid:head,
    treeOid:tree,
    changes:[{path:filePath,status:'M',blobOid:gitBlob(candidate,head,filePath)}]
  };
  initGit(trusted);
  const trustedSha=commitFile(trusted,TRUSTED_EXPECTED_SET_PATH,JSON.stringify(expected)+'\n','trusted expected set');
  const result=verifyRepositoryCandidate({repo:candidate,baseOid:base,headOid:head,baseRef:'main',trustedRoot:trusted,workflowSha:trustedSha});
  assert.equal(result.protectedTransition,true);
  assert.equal(result.trustedExpectedSetSourceSha,trustedSha);
  assert.equal(result.trustedExpectedSetBlobOid,gitBlob(trusted,trustedSha,TRUSTED_EXPECTED_SET_PATH));
  assert.deepEqual(result.paths,[filePath]);
});
