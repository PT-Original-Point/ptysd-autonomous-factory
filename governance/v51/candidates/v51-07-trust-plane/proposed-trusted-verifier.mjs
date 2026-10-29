import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const OID=/^[0-9a-f]{40}$/;
export const TRUSTED_EXPECTED_SET_PATH='governance/csg/trust-root/trusted-transition-expected-set.json';
const AUTHORITY_EXACT=[
  'governance/csg/current.json',
  'governance/project-directory/current.json'
];
const AUTHORITY_PREFIX=[
  '.github/workflows/',
  '.github/actions/',
  'governance/csg/checkpoints/',
  'governance/csg/trust-root/',
  'governance/csg/trust-template/',
  'governance/project-directory/',
  'directory/projects/'
];
const CANONICAL_ALLOWED=['governance/csg/','schemas/csg/','scripts/csg-','tests/csg/','tools/csg/'];

function fail(code,detail=''){
  const error=new Error(detail?code+':'+detail:code);
  error.code=code;
  throw error;
}
function oid(value,name){
  if(typeof value!=='string'||!OID.test(value)) fail('INVALID_'+name);
  return value;
}
function cleanPath(value){
  if(typeof value!=='string'||value.length===0||value.includes('\0')||value.includes('\\')||value.startsWith('/')||/^[a-zA-Z]:/.test(value)) fail('INVALID_PATH',String(value));
  const parts=value.split('/');
  if(parts.some(part=>part===''||part==='.'||part==='..')) fail('INVALID_PATH',value);
  return value;
}
function isProtectedPath(value){
  const p=value.toLowerCase();
  if(AUTHORITY_EXACT.some(item=>p===item)) return true;
  if(AUTHORITY_PREFIX.some(prefix=>p.startsWith(prefix))) return true;
  return /^governance\/v[0-9]+\/(current-mission|current-execution-policy)\.json$/.test(p);
}
function git(cwd,args){
  return execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
}
function gitRaw(cwd,args){
  return execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});
}
function normalizedChanges(changes){
  if(!Array.isArray(changes)||changes.length===0) fail('EMPTY_CHANGESET');
  const output=changes.map(change=>{
    if(!change||typeof change!=='object'||Array.isArray(change)) fail('INVALID_CHANGE_RECORD');
    if(Object.keys(change).sort().join(',')!=='blobOid,path,status') fail('INVALID_CHANGE_RECORD_FIELDS');
    const filePath=cleanPath(change.path);
    if(!['A','M','D'].includes(change.status)) fail('INVALID_CHANGE_STATUS',String(change.status));
    if(change.status==='D'){
      if(change.blobOid!==null) fail('INVALID_DELETED_BLOB_OID',filePath);
    }else{
      oid(change.blobOid,'BLOB_OID');
    }
    return {path:filePath,status:change.status,blobOid:change.blobOid};
  }).sort((a,b)=>(a.path<b.path?-1:a.path>b.path?1:0));
  const exact=new Set();
  const folded=new Set();
  for(const change of output){
    if(exact.has(change.path)||folded.has(change.path.toLowerCase())) fail('DUPLICATE_OR_CASE_COLLIDING_PATH',change.path);
    exact.add(change.path);
    folded.add(change.path.toLowerCase());
  }
  return output;
}
export function verifyPathSet(paths,{baseRef}={}){
  if(!Array.isArray(paths)||paths.length===0) fail('EMPTY_CHANGESET');
  if(!['main','v45/factory-control'].includes(baseRef)) fail('UNAUTHORIZED_BASE_REF',String(baseRef));
  const normalized=paths.map(cleanPath);
  const exact=new Set();
  const folded=new Set();
  for(const filePath of normalized){
    if(exact.has(filePath)||folded.has(filePath.toLowerCase())) fail('DUPLICATE_OR_CASE_COLLIDING_PATH',filePath);
    exact.add(filePath);
    folded.add(filePath.toLowerCase());
    if(isProtectedPath(filePath)) fail('TRUST_ROOT_OR_AUTHORITY_CHANGE_FORBIDDEN',filePath);
    if(baseRef==='v45/factory-control'&&!CANONICAL_ALLOWED.some(prefix=>filePath.startsWith(prefix)) ) fail('OUT_OF_SCOPE_CANONICAL_PATH',filePath);
  }
  return {paths:normalized.slice().sort((a,b)=>a.localeCompare(b,'en')),count:normalized.length,baseRef};
}
export function verifyExactProtectedTransition({actual,expectedSet,expectedSetSourceSha,expectedSetBlobOid,workflowSha}={}){
  oid(workflowSha,'WORKFLOW_SHA');
  oid(expectedSetSourceSha,'EXPECTED_SET_SOURCE_SHA');
  oid(expectedSetBlobOid,'EXPECTED_SET_BLOB_OID');
  if(expectedSetSourceSha!==workflowSha) fail('EXPECTED_SET_NOT_FROM_PINNED_WORKFLOW_SOURCE');
  if(!expectedSet||typeof expectedSet!=='object'||Array.isArray(expectedSet)) fail('INVALID_EXPECTED_SET');
  const required=['baseOid','baseRef','changes','headOid','repository_id','schema','treeOid'].sort().join(',');
  if(Object.keys(expectedSet).sort().join(',')!==required) fail('INVALID_EXPECTED_SET_FIELDS');
  if(expectedSet.schema!=='csg.trusted-transition-expected-set.v1') fail('INVALID_EXPECTED_SET_SCHEMA');
  if(String(expectedSet.repository_id)!=='1352411536') fail('EXPECTED_SET_REPOSITORY_MISMATCH');
  const baseOid=oid(expectedSet.baseOid,'EXPECTED_BASE_OID');
  const headOid=oid(expectedSet.headOid,'EXPECTED_HEAD_OID');
  const treeOid=oid(expectedSet.treeOid,'EXPECTED_TREE_OID');
  if(!['main','v45/factory-control'].includes(expectedSet.baseRef)) fail('UNAUTHORIZED_EXPECTED_BASE_REF');
  if(!actual||typeof actual!=='object') fail('INVALID_ACTUAL_EVIDENCE');
  if(actual.baseRef!==expectedSet.baseRef) fail('EXPECTED_BASE_REF_MISMATCH');
  if(oid(actual.baseOid,'ACTUAL_BASE_OID')!==baseOid) fail('EXPECTED_BASE_OID_MISMATCH');
  if(oid(actual.headOid,'ACTUAL_HEAD_OID')!==headOid) fail('EXPECTED_HEAD_OID_MISMATCH');
  if(oid(actual.treeOid,'ACTUAL_TREE_OID')!==treeOid) fail('EXPECTED_TREE_OID_MISMATCH');
  if(!Array.isArray(actual.parentOids)||actual.parentOids.length!==1||actual.parentOids[0]!==baseOid) fail('DIRECT_PARENT_MISMATCH');
  const expectedChanges=normalizedChanges(expectedSet.changes);
  const actualChanges=normalizedChanges(actual.changes);
  if(JSON.stringify(actualChanges)!==JSON.stringify(expectedChanges)) fail('EXPECTED_PATH_STATUS_OR_BLOB_SET_MISMATCH');
  return {
    paths:actualChanges.map(change=>change.path),
    count:actualChanges.length,
    baseRef:actual.baseRef,
    baseOid:actual.baseOid,
    headOid:actual.headOid,
    treeOid:actual.treeOid,
    trustedExpectedSetPath:TRUSTED_EXPECTED_SET_PATH,
    trustedExpectedSetSourceSha:expectedSetSourceSha,
    trustedExpectedSetBlobOid:expectedSetBlobOid
  };
}
function loadTrustedExpectedSet(trustedRoot,workflowSha){
  const root=path.resolve(trustedRoot);
  const checkedOutSha=oid(git(root,['rev-parse','HEAD']),'TRUSTED_CHECKOUT_SHA');
  if(checkedOutSha!==workflowSha) fail('TRUSTED_CHECKOUT_NOT_PINNED_WORKFLOW_SOURCE');
  if(git(root,['status','--porcelain'])) fail('TRUSTED_WORKTREE_NOT_CLEAN');
  const objectRef=workflowSha+':'+TRUSTED_EXPECTED_SET_PATH;
  const sourceBlobOid=oid(git(root,['rev-parse','--verify',objectRef]),'EXPECTED_SET_SOURCE_BLOB_OID');
  let expectedSet;
  try{
    expectedSet=JSON.parse(gitRaw(root,['show',objectRef]));
  }catch(error){
    fail('TRUSTED_EXPECTED_SET_INVALID_JSON',error.message);
  }
  return {expectedSet,sourceSha:workflowSha,sourceBlobOid};
}
function readChanges(repo,baseOid,headOid){
  const output=gitRaw(repo,['diff','--name-status','--no-renames','-z',baseOid,headOid]);
  const fields=output.split('\0');
  const changes=[];
  for(let i=0;i<fields.length;){
    const status=fields[i++];
    if(!status) break;
    const filePath=fields[i++];
    if(!filePath) fail('MALFORMED_GIT_NAME_STATUS');
    const clean=cleanPath(filePath);
    const blobOid=status==='D'?null:oid(git(repo,['--literal-pathspecs','rev-parse','--verify',headOid+':'+clean]),'CANDIDATE_BLOB_OID');
    changes.push({path:clean,status,blobOid});
  }
  return normalizedChanges(changes);
}
function readParentOids(repo,headOid){
  const line=git(repo,['rev-list','--parents','-n','1',headOid]).split(/\s+/);
  if(line[0]!==headOid||line.length<2) fail('HEAD_MUST_HAVE_PARENT');
  return line.slice(1).map((value,index)=>oid(value,'PARENT_'+index));
}
export function verifyRepositoryCandidate({repo,baseOid,headOid,baseRef,trustedRoot,workflowSha}={}){
  oid(baseOid,'BASE_OID');
  oid(headOid,'HEAD_OID');
  if(!['main','v45/factory-control'].includes(baseRef)) fail('UNAUTHORIZED_BASE_REF',String(baseRef));
  const parentOids=readParentOids(repo,headOid);
  const treeOid=oid(git(repo,['rev-parse','--verify',headOid+'^{tree}']),'HEAD_TREE_OID');
  const changes=readChanges(repo,baseOid,headOid);
  const protectedChanges=changes.some(change=>isProtectedPath(change.path));
  if(protectedChanges){
    if(!trustedRoot||!workflowSha) fail('PROTECTED_PATH_REQUIRES_TRUSTED_EXPECTED_SET');
    const trusted=loadTrustedExpectedSet(trustedRoot,workflowSha);
    const verified=verifyExactProtectedTransition({
      actual:{baseRef,baseOid,headOid,treeOid,parentOids,changes},
      expectedSet:trusted.expectedSet,
      expectedSetSourceSha:trusted.sourceSha,
      expectedSetBlobOid:trusted.sourceBlobOid,
      workflowSha
    });
    const status=git(repo,['status','--porcelain']);
    if(status) fail('CANDIDATE_WORKTREE_NOT_CLEAN');
    return {...verified,worktreeClean:true,protectedTransition:true};
  }
  verifyPathSet(changes.map(change=>change.path),{baseRef});
  if(parentOids.length!==1||parentOids[0]!==baseOid) fail('DIRECT_PARENT_MISMATCH');
  const status=git(repo,['status','--porcelain']);
  if(status) fail('CANDIDATE_WORKTREE_NOT_CLEAN');
  return {
    paths:changes.map(change=>change.path),
    changes,
    count:changes.length,
    baseRef,
    baseOid,
    headOid,
    treeOid,
    worktreeClean:true,
    protectedTransition:false
  };
}
const cliEntry=process.argv[1]?pathToFileURL(path.resolve(process.argv[1])).href:'';
if(import.meta.url===cliEntry){
  const [repo,baseOid,headOid,baseRef,trustedRoot,workflowSha]=process.argv.slice(2);
  try{
    const out=verifyRepositoryCandidate({repo:path.resolve(repo),baseOid,headOid,baseRef,trustedRoot,workflowSha});
    process.stdout.write(JSON.stringify({result:'PASS',...out})+'\n');
  }catch(error){
    process.stderr.write(JSON.stringify({result:'FAIL',code:error.code||'ERROR',message:error.message})+'\n');
    process.exit(2);
  }
}
