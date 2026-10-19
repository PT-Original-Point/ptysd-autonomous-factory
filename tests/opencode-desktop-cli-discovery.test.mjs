import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverV2Executables, qualifyOpenCodeV2 } from '../native-bridge/opencode-v2.mjs';

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
