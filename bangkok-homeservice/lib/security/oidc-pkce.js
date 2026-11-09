import { randomBytes, createHash } from "node:crypto";
const b64 = b => Buffer.from(b).toString("base64url");
export function createAuthorizationRequest({issuer,clientId="homeservice-web",redirectUri}) {
 const base=new URL(issuer);
 if(base.protocol!=="https:" || base.username || base.password || base.hash || base.search || !/^\/realms\/[^/]+$/.test(base.pathname))
   throw new Error("trusted Keycloak issuer required");
 const callback=new URL(redirectUri);
 if(!["https:","http:"].includes(callback.protocol) || callback.username || callback.password || callback.hash || callback.search)
   throw new Error("invalid OIDC callback");
 if(callback.protocol!=="https:" && !["localhost","127.0.0.1"].includes(callback.hostname)) throw new Error("HTTPS callback required");
 const state=b64(randomBytes(32)),verifier=b64(randomBytes(32)),nonce=b64(randomBytes(32));
 const challenge=b64(createHash("sha256").update(verifier).digest());
 const url=new URL(issuer+"/protocol/openid-connect/auth");
 url.search=new URLSearchParams({client_id:clientId,response_type:"code",scope:"openid",redirect_uri:redirectUri,state,nonce,code_challenge:challenge,code_challenge_method:"S256"}).toString();
 return {url:url.toString(),state,verifier,nonce};
}
export async function exchangeAuthorizationCode({issuer,clientId="homeservice-web",redirectUri,code,verifier,fetchImpl=fetch}) {
 const base = new URL(issuer);
 if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || !/^\/realms\/[^/]+$/.test(base.pathname) || base.href !== issuer || !code || !verifier) throw Error("invalid code exchange");
 const url=new URL(issuer+"/protocol/openid-connect/token");
 const response=await fetchImpl(url,{method:"POST",redirect:"error",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"authorization_code",client_id:clientId,code,redirect_uri:redirectUri,code_verifier:verifier}),signal:AbortSignal.timeout(5000)});
 if(!response.ok) throw Error("OIDC code exchange failed");
 const data=await response.json();
 if(typeof data.access_token!=="string" || !data.access_token || typeof data.id_token!=="string" || !data.id_token || typeof data.token_type!=="string" || data.token_type.toLowerCase()!=="bearer") throw Error("invalid OIDC response");
 return data;
}
