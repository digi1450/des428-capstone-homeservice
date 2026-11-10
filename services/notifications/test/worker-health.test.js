import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {startWorkerHealth} from '../src/worker-health.js';

// Covers readiness loss and recovery, including disconnect during the DB probe.
test('worker readiness requires current broker subscription AND owning migration',async()=>{
 let connected=false,dbReady=true,duringProbe=()=>{};
 const health=startWorkerHealth({database:{checkReady:async()=>{duringProbe();if(!dbReady)throw Error('DB secret must not leak');}},isConnected:()=>connected,port:0});
 await once(health.server,'listening');
 const url='http://127.0.0.1:'+health.server.address().port+'/health/ready';
 try{
  assert.equal((await fetch(url)).status,503);
  connected=true;assert.equal((await fetch(url)).status,200);
  dbReady=false;const response=await fetch(url);assert.equal(response.status,503);assert.deepEqual(await response.json(),{status:'not_ready'});
  dbReady=true;assert.equal((await fetch(url)).status,200);
  duringProbe=()=>{connected=false;};assert.equal((await fetch(url)).status,503);
 }finally{await health.close();}
});
