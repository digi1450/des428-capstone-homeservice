import {createCipheriv,createDecipheriv,randomBytes,createHash} from "node:crypto";
function key(secret){if(typeof secret!=="string"||secret.length<32)throw Error("OIDC_SESSION_SECRET must be at least 32 characters");return createHash("sha256").update(secret).digest();}
function encrypt(value,secret,maxBytes){
 const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",key(secret),iv);
 const plaintext=Buffer.from(JSON.stringify(value));
 if(plaintext.length>maxBytes)throw Error("session too large");
 const encrypted=Buffer.concat([cipher.update(plaintext),cipher.final()]);
 return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString("base64url");
}
function decrypt(value,secret,maxBytes){
 if(typeof value!=="string"||value.length>maxBytes||!/^[A-Za-z0-9_-]+$/.test(value))throw Error("invalid session");
 const data=Buffer.from(value,"base64url");
 if(data.length<29)throw Error("invalid session");
 const decipher=createDecipheriv("aes-256-gcm",key(secret),data.subarray(0,12));
 decipher.setAuthTag(data.subarray(12,28));
 return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]).toString("utf8"));
}
export function cookie(name,value,{maxAge=600,secure=true}={}){
 return name+"="+value+"; Path=/; HttpOnly; SameSite=Lax; Max-Age="+maxAge+(secure?"; Secure":"");
}
export function readCookie(req,name){
 const raw=req.headers.get("cookie")||"";
 const part=raw.split(";").map(s=>s.trim()).find(s=>s.startsWith(name+"="));
 return part?part.slice(name.length+1):null;
}

// Browser transaction cookies stay small. Token-bearing sessions live in the server store.
export const seal=(value,secret)=>encrypt(value,secret,2800);
export const unseal=(value,secret)=>decrypt(value,secret,4096);
export const sealServerSession=(value,secret)=>encrypt(value,secret,65536);
export const unsealServerSession=(value,secret)=>decrypt(value,secret,90000);
