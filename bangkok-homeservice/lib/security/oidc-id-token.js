import {createPublicKey,verify} from "node:crypto";
const decode=s=>{if(typeof s!=="string"||!/^[A-Za-z0-9_-]+$/.test(s)||s.length>8192)throw Error("invalid JWT");return JSON.parse(Buffer.from(s,"base64url").toString("utf8"));};
export async function verifyOidcIdToken({token,issuer,clientId="homeservice-web",nonce,fetchImpl=fetch,now=Date.now}) {
 if(typeof token!=="string"||token.length>16384||!nonce)throw Error("invalid ID token");
 const parts=token.split(".");
 if(parts.length!==3)throw Error("invalid ID token");
 const [h,p,s]=parts,header=decode(h),claims=decode(p);
 if(!header||header.alg!=="RS256"||typeof header.kid!=="string"||!header.kid||header.jku||header.jwk||header.x5u||header.crit)throw Error("invalid ID token header");
 const seconds=Math.floor(now()/1000);
 if(!claims||claims.iss!==issuer||claims.aud!==clientId||claims.nonce!==nonce||typeof claims.sub!=="string"||!claims.sub||
 !Number.isSafeInteger(claims.exp)||claims.exp<=seconds||!Number.isSafeInteger(claims.iat)||claims.iat>seconds||
 (claims.nbf!==undefined&&(!Number.isSafeInteger(claims.nbf)||claims.nbf>seconds))||
 (claims.azp!==undefined&&claims.azp!==clientId))throw Error("invalid ID token claims");
 const endpoint=new URL(issuer);
 if(endpoint.protocol!=="https:"||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||!/^\/realms\/[^/]+$/.test(endpoint.pathname)||endpoint.href!==issuer)throw Error("invalid issuer");
 const response=await fetchImpl(issuer+"/protocol/openid-connect/certs",{redirect:"error",signal:AbortSignal.timeout(5000)});
 if(!response.ok)throw Error("ID token key unavailable");
 const jwks=await response.json();
 if(!Array.isArray(jwks.keys))throw Error("invalid keys");
 const candidates=jwks.keys.filter(k=>k?.kid===header.kid&&k.kty==="RSA"&&k.use!=="enc"&&(!k.alg||k.alg==="RS256"));
 if(candidates.length!==1)throw Error("unknown signing key");
 let key;
 try{key=createPublicKey({key:candidates[0],format:"jwk"});}catch{throw Error("invalid signing key");}
 if(!verify("RSA-SHA256",Buffer.from(h+"."+p),key,Buffer.from(s,"base64url")))throw Error("invalid signature");
 return {issuer:claims.iss,sub:claims.sub,exp:claims.exp};
}
