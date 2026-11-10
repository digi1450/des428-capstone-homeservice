import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {verifyOidcIdToken} from '../lib/security/oidc-id-token.js';
const issuer='https://id.example.test/realms/homeservice',now=Math.floor(Date.now()/1000);
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...publicKey.export({format:'jwk'}),kid:'key',alg:'RS256',use:'sig'};
const token=extra=>{const h=Buffer.from(JSON.stringify({alg:'RS256',kid:'key'})).toString('base64url'),p=Buffer.from(JSON.stringify({iss:issuer,sub:'user-sub',aud:'homeservice-web',iat:now-1,exp:now+300,...extra})).toString('base64url');return h+'.'+p+'.'+sign('RSA-SHA256',Buffer.from(h+'.'+p),privateKey).toString('base64url');};
test('initial login requires nonce; refresh may omit it but cannot change it',async()=>{
 const options={issuer,nonce:'initial-nonce',fetchImpl:async(_url,init)=>{assert.equal(init.cache,'no-store','Next persistent fetch cache must not pin signing keys');return Response.json({keys:[jwk]});}};
 await assert.rejects(verifyOidcIdToken({...options,token:token({})}),/claims/);
 assert.equal((await verifyOidcIdToken({...options,token:token({}),refresh:true})).sub,'user-sub');
 assert.equal((await verifyOidcIdToken({...options,token:token({nonce:'initial-nonce'}),refresh:true})).sub,'user-sub');
 await assert.rejects(verifyOidcIdToken({...options,token:token({nonce:'changed'}),refresh:true}),/claims/);
 await assert.rejects(verifyOidcIdToken({...options,token:token({iss:'https://evil.example.test'}),refresh:true}),/claims/);
 await assert.rejects(verifyOidcIdToken({...options,token:token({aud:'other'}),refresh:true}),/claims/);
 await assert.rejects(verifyOidcIdToken({...options,token:token({exp:now-1}),refresh:true}),/claims/);
});
