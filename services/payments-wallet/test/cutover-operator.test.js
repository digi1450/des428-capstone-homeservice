import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,randomBytes} from 'node:crypto';
import {createCutoverOperatorVerifier} from '../../../tools/cutover/operator.mjs';
import {sealCheckpoint,verifyCheckpoint} from '../src/legacy-checkpoint.js';
const issuer='https://issuer.fixture/realms/homeservice';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...publicKey.export({format:'jwk'}),kid:'fixture',alg:'RS256'};
const enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
const token=changes=>{const body={iss:issuer,aud:'homeservice-cutover',azp:'homeservice-cutover-operator',sub:'operator-1',exp:2000,resource_access:{'homeservice-cutover':{roles:['cutover:approve_checkpoint','cutover:revoke_checkpoint']}},...changes};const input=enc({alg:'RS256',kid:'fixture'})+'.'+enc(body);return input+'.'+sign('RSA-SHA256',Buffer.from(input),privateKey).toString('base64url');};
test('operator verifies signature, expiry, distinct audience/client and least privilege roles',async()=>{
 const verify=createCutoverOperatorVerifier({issuer,now:()=>1000*1000,fetchImpl:async(url,options)=>{assert.equal(String(url),issuer+'/protocol/openid-connect/certs');assert.equal(options.redirect,'error');return{ok:true,json:async()=>({keys:[jwk]})};}});
 assert.equal((await verify(token({}),'approve_checkpoint')).service,'cutover');
 for(const changes of [{iss:'https://evil.fixture'},{exp:999},{aud:'payments-wallet-service'},{azp:'booking-service'},{resource_access:{'homeservice-cutover':{roles:['user:read']}}}])await assert.rejects(verify(token(changes),'approve_checkpoint'));
 const valid=token({});await assert.rejects(verify(valid.slice(0,-10)+'a'.repeat(10),'approve_checkpoint'));
 await assert.rejects(verify(valid,'create'));
});
test('sealed checkpoint cannot be edited, forged, or opened with a different deployment key',()=>{
 const pair=generateKeyPairSync('ed25519'),key=pair.privateKey.export({type:'pkcs8',format:'pem'}),pub=pair.publicKey.export({type:'spki',format:'pem'}),payload={version:1,state:'approved',manifest_sha256:'a'.repeat(64),snapshot_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',phase_digest:'b'.repeat(64),backup_set_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',operator_id:'fixture',approved_at:'2026-11-11T00:00:00.000Z',freeze_digest:'c'.repeat(64)};
 const receipt=sealCheckpoint(payload,key);assert.deepEqual(verifyCheckpoint(receipt,pub),payload);
 assert.throws(()=>verifyCheckpoint(receipt,generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'})));
 const changed=structuredClone(receipt);changed.payload.manifest_sha256='d'.repeat(64);assert.throws(()=>verifyCheckpoint(changed,pub));
 assert.throws(()=>sealCheckpoint({...payload,extra:true},key));
});
