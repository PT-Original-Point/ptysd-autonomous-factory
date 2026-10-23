import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const OID=/^[0-9a-f]{40}$/;
const TRUST_ROOT=[
  '.github/workflows/factory-bounded.yml',
  '.github/workflows/csg-trusted-verifier.yml',
  'governance/csg/trust-root/',
  'governance/csg/trust-template/'
];
const AUTHORITY=[
  'governance/v47/current-mission.json',
  'governance/v47/current-execution-policy.json',
  'governance/v48/current-mission.json',
  'governance/v48/current-execution-policy.json',
  'governance/v49/current-mission.json',
  'governance/v49/current-execution-policy.json'
];
const CANONICAL_ALLOWED=['governance/csg/','schemas/csg/','scripts/csg-','tests/csg/','tools/csg/'];
function fail(code,detail=''){const e=new Error(detail?`${code}:${detail}`:code);e.code=code;throw e;}
function oid(v,name){if(typeof v!=='string'||!OID.test(v))fail(`INVALID_${name}`);return v;}
function git(cwd,args){return execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();}
function clean(p){return p.replaceAll('\\','/');}
function forbidden(p){
  if([...TRUST_ROOT,...AUTHORITY].some(f=>p===f||(f.endsWith('/')&&p.startsWith(f))))return true;
  const m=/^governance\/v[0-9]+\/(.+)$/i.exec(p);
  if(!m)return false;
  const rel=m[1];
  return /^current(?:[-_].*)?\.(?:json|ya?ml)$/i.test(rel)
    || /(?:^|[\/._-])(?:mission|policy|authority|authorization)(?:$|[\/._-])/i.test(rel)
    || /^(?:missions|policies|execution-policies|authority|authorization)\//i.test(rel);
}
export function verifyPathSet(paths,{baseRef}={}){
  if(!Array.isArray(paths)||paths.length<1)fail('EMPTY_CHANGESET');
  if(!['main','v45/factory-control'].includes(baseRef))fail('UNAUTHORIZED_BASE_REF',String(baseRef));
  for(const raw of paths){const p=clean(raw);if(!p||p.startsWith('/')||p.split('/').some(x=>x==='..'))fail('INVALID_PATH',p);
    if(forbidden(p))fail('TRUST_ROOT_OR_AUTHORITY_CHANGE_FORBIDDEN',p);
    if(baseRef==='v45/factory-control'&&!CANONICAL_ALLOWED.some(prefix=>p.startsWith(prefix)))fail('OUT_OF_SCOPE_CANONICAL_PATH',p);
  }
  return {paths:[...paths].map(clean).sort(),count:paths.length,baseRef};
}
export function verifyDirectParent({repo,baseOid,headOid,baseRef}){
  oid(baseOid,'BASE_OID');oid(headOid,'HEAD_OID');
  const line=git(repo,['rev-list','--parents','-n','1',headOid]).split(/\s+/);
  if(line.length!==2)fail('HEAD_MUST_HAVE_EXACTLY_ONE_PARENT');
  if(line[0]!==headOid||line[1]!==baseOid)fail('DIRECT_PARENT_MISMATCH');
  const names=git(repo,['diff','--name-only','--no-renames',`${baseOid}..${headOid}`]).split(/\r?\n/).filter(Boolean);
  return {...verifyPathSet(names,{baseRef}),baseOid,headOid};
}
export function verifyRepositoryCandidate({repo,baseOid,headOid,baseRef}){
  const direct=verifyDirectParent({repo,baseOid,headOid,baseRef});
  const status=git(repo,['status','--porcelain']);
  if(status)fail('WORKTREE_NOT_CLEAN');
  return {...direct,worktreeClean:true};
}
const cliEntry=process.argv[1]?pathToFileURL(path.resolve(process.argv[1])).href:'';
if(import.meta.url===cliEntry){
  const [repo,baseOid,headOid,baseRef]=process.argv.slice(2);
  try{const out=verifyRepositoryCandidate({repo:path.resolve(repo),baseOid,headOid,baseRef});process.stdout.write(JSON.stringify({result:'PASS',...out})+'\n');}
  catch(e){process.stderr.write(JSON.stringify({result:'FAIL',code:e.code||'ERROR',message:e.message})+'\n');process.exit(2);}
}
