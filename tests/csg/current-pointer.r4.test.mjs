import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {canonicalDigest, validateCsg} from '../../scripts/csg-schema.mjs';
function checkedPath(ref){
  if(typeof ref !== 'string' || !/^governance\/csg\/checkpoints\/[0-9]+\.json$/.test(ref)) throw new Error('INVALID_CP_PATH');
  return new URL('../../'+ref, import.meta.url);
}
function readCurrent(){
  const pointer=JSON.parse(fs.readFileSync(new URL('../../governance/csg/current.json',import.meta.url),'utf8'));
  validateCsg(pointer);
  const cp=JSON.parse(fs.readFileSync(checkedPath(pointer.checkpoint_path),'utf8'));
  validateCsg(cp,{selfPath:pointer.checkpoint_path});
  assert.equal(pointer.project_id,cp.project_id);
  assert.equal(pointer.checkpoint_seq,cp.checkpoint_seq);
  assert.equal(pointer.checkpoint_digest,cp.payload_digest);
  assert.equal(canonicalDigest(cp),cp.payload_digest);
  return {pointer,cp};
}
test('R4 dynamic CSG pointer binds the accepted checkpoint by path, project and payload hash',()=>{
  const {pointer,cp}=readCurrent();
  assert.ok(pointer.checkpoint_seq >= 1);
  assert.equal(cp.schema_version,'csg.checkpoint.v1');
});
test('R4 pointer cannot point outside accepted CSG checkpoints',()=>{
  assert.throws(()=>checkedPath('../other.json'),/INVALID_CP_PATH/);
  assert.throws(()=>checkedPath('governance/csg/checkpoints/not-a-cp.json'),/INVALID_CP_PATH/);
});
test('R4 changing checkpoint content invalidates its anchored hash',()=>{
  const {pointer,cp}=readCurrent();
  const mutated=structuredClone(cp);
  mutated.stop_requested=!cp.stop_requested;
  assert.notEqual(canonicalDigest(mutated),pointer.checkpoint_digest);
});
