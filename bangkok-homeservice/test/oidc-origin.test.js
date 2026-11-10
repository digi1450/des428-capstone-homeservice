import test from 'node:test';
import assert from 'node:assert/strict';
import {oidcRequestUrl} from '../lib/security/oidc-origin.js';
const redirectUri='https://app.example.test/api/auth/keycloak/callback';
test('OIDC canonical origin supports exact trusted TLS ingress without trusting forwarded-host',()=>{
 const req=(url,headers={})=>new Request(url,{headers});
 assert.equal(oidcRequestUrl(req('https://app.example.test/api/auth/keycloak/start'),{redirectUri}).origin,'https://app.example.test');
 const proxy=req('http://127.0.0.1:3000/api/auth/keycloak/callback?code=fixture&state=fixture',{host:'app.example.test','x-forwarded-proto':'https'});
 assert.equal(oidcRequestUrl(proxy,{redirectUri}).href,'https://app.example.test/api/auth/keycloak/callback?code=fixture&state=fixture');
 for(const headers of [{host:'evil.example.test','x-forwarded-host':'app.example.test','x-forwarded-proto':'https'},{host:'app.example.test','x-forwarded-proto':'http'},{host:'app.example.test','x-forwarded-proto':'https,http'},{}])assert.throws(()=>oidcRequestUrl(req('http://127.0.0.1:3000/callback',headers),{redirectUri}));
 assert.throws(()=>oidcRequestUrl(proxy,{redirectUri:'https://app.example.test/other'}));
});
