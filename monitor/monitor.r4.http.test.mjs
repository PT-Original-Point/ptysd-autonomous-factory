import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHttpServer } from './server.mjs';

test('loopback HTTP reads do not dispatch models, expose private endpoints, or claim worker liveness', async () => {
  const ctx = {
    config: {humanW1Paused:true}, codexData:{threads:[]}, windowsData:{status:'UNKNOWN',data:null},
    vmData:{status:'UNKNOWN',data:null}, githubData:{status:'UNKNOWN',runs:[]}, phaseAttempts:[], changes:[]
  };
  const server = createHttpServer(ctx);
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', err => err ? reject(err) : resolve()));
  try {
    const address = `http://127.0.0.1:${server.address().port}`;
    const health = await fetch(address+'/health');
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, 'ok');
    const html = await fetch(address+'/');
    assert.equal(html.status, 200);
    assert.match(await html.text(), /<html lang="zh-Hant">/);
    assert.equal(html.headers.get('x-content-type-options'), 'nosniff');
    for(let i=0;i<10;i++){
      const result = await fetch(address+'/api/state');
      assert.equal(result.status,200);
      const state=await result.json();
      assert.equal(state.home.factoryOverview.activeWorkersCount,'未知');
      assert.notEqual(state.home.factoryOverview.canonical.control_readback,'PROVIDER_CONFIRMED');
      assert.equal(state.home.factoryOverview.canonical.accepted,false);
    }
    const denied=await fetch(address+'/api/state',{method:'POST'});
    assert.equal(denied.status,405);
    const hostStatus=await new Promise((resolve,reject)=>{
      const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/api/state',headers:{Host:'attacker.example'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
      req.on('error',reject);req.end();
    });
    assert.equal(hostStatus,400);
  } finally {
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});
