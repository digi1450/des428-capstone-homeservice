import test from "node:test";
import assert from "node:assert/strict";
import { createAuthorizationRequest, exchangeAuthorizationCode } from "../lib/security/oidc-pkce.js";
const issuer="https://id.example.test/realms/homeservice", redirectUri="https://app.example.test/api/auth/keycloak/callback";
test("PKCE creates distinct unpredictable state, nonce and SHA256 challenge",()=>{
 const first=createAuthorizationRequest({issuer,redirectUri});
 const second=createAuthorizationRequest({issuer,redirectUri});
 const url=new URL(first.url);
 assert.equal(url.searchParams.get("response_type"),"code");
 assert.equal(url.searchParams.get("code_challenge_method"),"S256");
 assert.equal(url.searchParams.get("redirect_uri"),redirectUri);
 assert.equal(first.state.length,43);
 assert.notEqual(first.state,second.state);
 assert.notEqual(first.verifier,second.verifier);
 assert.notEqual(first.nonce,second.nonce);
 assert.notEqual(url.searchParams.get("code_challenge"),first.verifier);
});
test("PKCE rejects non-TLS issuers and public non-TLS callbacks",()=>{
 assert.throws(()=>createAuthorizationRequest({issuer:"http://id.example.test/realms/homeservice",redirectUri}));
 assert.throws(()=>createAuthorizationRequest({issuer,redirectUri:"http://app.example.test/callback"}));
});
test("code exchange sends PKCE verifier only to configured token endpoint",async()=>{
 let request;
 const result=await exchangeAuthorizationCode({issuer,redirectUri,code:"one-use-code",verifier:"secret-verifier",fetchImpl:async(url,options)=>{request={url,options};return {ok:true,json:async()=>({access_token:"access",id_token:"id",token_type:"Bearer"})};}});
 assert.equal(result.access_token,"access");
 assert.equal(request.url.toString(),issuer+"/protocol/openid-connect/token");
 assert.equal(request.options.redirect,"error");
 assert.equal(new URLSearchParams(request.options.body).get("code_verifier"),"secret-verifier");
});
test("code exchange fails closed on invalid response",async()=>{
 await assert.rejects(exchangeAuthorizationCode({issuer,redirectUri,code:"code",verifier:"verifier",fetchImpl:async()=>({ok:true,json:async()=>({access_token:"access"})})}));
});
