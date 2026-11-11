import {test} from 'node:test';
import assert from 'node:assert/strict';
import {composeFailureDiagnostic as diagnose} from './compose-diagnostic.mjs';
test('Compose failure categories never expose raw command output or spawn errors',()=>{
 const cases=[['registry-rate-limit','toomanyrequests: pull rate limit'],['registry-auth','unauthorized: authentication required'],
 ['registry-network','dial tcp: TLS handshake timeout'],['image-missing','manifest unknown'],['disk-full','no space left on device'],
 ['port-conflict','port is already allocated'],['container-unhealthy','container is unhealthy'],['resource-exhaustion','cannot allocate memory'],['unclassified','secret-only']];
 for(const [category,message] of cases){
  const result=diagnose({status:1,stderr:message+' https://user:private-token@example.invalid secret-value',error:{message:'private secret'}});
  assert.ok(result.categories.includes(category));assert.ok(!JSON.stringify(result).includes('private'));assert.ok(!JSON.stringify(result).includes('example'));
 }
 assert.deepEqual(diagnose({status:null,signal:'SECRET',error:{code:'ENOBUFS',message:'private'}}),{exitStatus:null,signal:null,categories:['capture-buffer-exceeded']});
});
