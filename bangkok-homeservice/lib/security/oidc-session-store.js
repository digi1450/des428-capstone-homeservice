// Monolith-owned persistent sidecar. Cookies hold opaque random IDs; tokens are
// encrypted at rest and never copied into a browser cookie or log.
import Database from "better-sqlite3";
import {randomBytes,createHash} from "node:crypto";
import {sealServerSession,unsealServerSession} from "./oidc-session.js";

export const isOidcSessionId=value=>typeof value==="string"&&/^[A-Za-z0-9_-]{43}$/.test(value);
export const oidcSessionPath=()=>process.env.OIDC_SESSION_DB_PATH||process.env.IDENTITY_MAPPING_DB_PATH;
const hash=value=>createHash("sha256").update(value).digest("hex");
export function createOidcSessionStore({path=oidcSessionPath(),secret=process.env.OIDC_SESSION_SECRET,now=Date.now}={}){
 if(!path||path===":memory:")throw Error("persistent OIDC session sidecar path required");
 if(typeof secret!=="string"||secret.length<32)throw Error("OIDC session secret unavailable");
 const db=new Database(path);
 db.pragma("journal_mode = WAL");
 db.pragma("busy_timeout = 5000");
 db.exec(`CREATE TABLE IF NOT EXISTS oidc_server_sessions (
  id_hash TEXT PRIMARY KEY, sealed TEXT NOT NULL, expires_at INTEGER NOT NULL
 ); CREATE INDEX IF NOT EXISTS oidc_server_sessions_expiry ON oidc_server_sessions(expires_at)`);
 const seconds=()=>Math.floor(now()/1000);
 const prepare=value=>{
  if(!value||!Number.isSafeInteger(value.exp)||value.exp<=seconds())throw Error("invalid session expiry");
  return {id:randomBytes(32).toString("base64url"),sealed:sealServerSession(value,secret),exp:value.exp};
 };
 const insert=row=>db.prepare("INSERT INTO oidc_server_sessions(id_hash,sealed,expires_at) VALUES(?,?,?)").run(hash(row.id),row.sealed,row.exp);
 return {
  create(value){
   const row=prepare(value);
   db.transaction(()=>{db.prepare("DELETE FROM oidc_server_sessions WHERE expires_at<=?").run(seconds());insert(row);}).immediate();
   return row.id;
  },
  get(id){
   if(!isOidcSessionId(id))return null;
   const row=db.prepare("SELECT sealed,expires_at FROM oidc_server_sessions WHERE id_hash=?").get(hash(id));
   if(!row||row.expires_at<=seconds())return null;
   try{const value=unsealServerSession(row.sealed,secret);return value?.exp===row.expires_at?value:null;}catch{return null;}
  },
  rotate(id,value){
   if(!isOidcSessionId(id))return null;
   const row=prepare(value);
   return db.transaction(()=>{
    // A concurrent refresh/logout that removed this ID wins; never resurrect it.
    if(db.prepare("DELETE FROM oidc_server_sessions WHERE id_hash=? AND expires_at>?").run(hash(id),seconds()).changes!==1)return null;
    insert(row);return row.id;
   }).immediate();
  },
  remove(id){if(isOidcSessionId(id))db.prepare("DELETE FROM oidc_server_sessions WHERE id_hash=?").run(hash(id));},
  close(){db.close();},
 };
}
