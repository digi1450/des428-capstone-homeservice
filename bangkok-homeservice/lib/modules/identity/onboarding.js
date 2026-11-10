// Monolith-owned profile creation + durable identity-binding work. No cross-service SQL.
import {randomBytes} from 'node:crypto';
import {z} from 'zod';
import {getDb} from '../../db/index.js';
import {insertEvent} from '../../db/events.js';
import {registerCustomer,registerProvider} from './service.js';
import {createIdentityMappingStore} from '../../security/identity-mapping.js';
import {logger} from '../../logger.js';
import {ConflictError,ForbiddenError} from '../../errors.js';
export const IDENTITY_PROFILE_EVENT='identity.profile_created';
const identitySchema=z.object({issuer:z.string().url().max(512).refine(value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&/^\/realms\/[^/]+$/.test(u.pathname)&&u.href===value;}catch{return false;}}),sub:z.string().min(1).max(255),email:z.string().email().max(254)}).strict();
export const profileSchema=z.object({role:z.enum(['customer','provider']),name:z.string().trim().min(1).max(120),phone:z.string().trim().max(40).optional(),company_name:z.string().trim().max(160).optional()}).strict();
const eventFor=(issuer,sub)=>getDb().prepare("SELECT * FROM events WHERE type=? AND json_extract(payload_json,'$.issuer')=? AND json_extract(payload_json,'$.sub')=? ORDER BY id LIMIT 1").get(IDENTITY_PROFILE_EVENT,issuer,sub);
function bind(event,path){
 const data=JSON.parse(event.payload_json);
 if(data.issuer==null||data.sub==null||!['customer','provider'].includes(data.role)||event.aggregate_type!=='identity'||data.domainId!==event.aggregate_id)throw new ConflictError('identity work requires review');
 let store;
 try{
  store=createIdentityMappingStore({path});let found=store.lookup(data);
  if(!found){
   try{found=store.provision(data);}catch(error){found=store.lookup(data);if(!found)throw error;}
  }
  if(found.role!==data.role||found.domainId!==data.domainId)throw new ConflictError('identity binding conflict requires review');
  // Sidecar commits first. A crash here leaves repeatable work, never a second profile.
  getDb().prepare("UPDATE events SET processed_at=COALESCE(processed_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id=?").run(event.id);
  return found;
 }finally{store?.close();}
}
export function recoverIdentityBinding({issuer,sub},{path}={}){
 const event=eventFor(issuer,sub);return event?bind(event,path):null;
}
export function recoverIdentityBindings({path,limit=25}={}){
 const rows=getDb().prepare('SELECT * FROM events WHERE type=? AND processed_at IS NULL ORDER BY id LIMIT ?').all(IDENTITY_PROFILE_EVENT,limit);
 let processed=0;
 for(const row of rows){
  try{bind(row,path);processed++;}catch(error){
   // Preserve pending work; never overwrite a conflicting mapping or block other identities.
   logger.warn({eventId:row.id,requiresReview:error instanceof ConflictError,kind:error?.name||'Error'},'identity binding pending');
  }
 }
 return {processed,pending:rows.length-processed};
}
export function completeIdentityProfile(identity,input,{path,deliver=bind}={}){
 const verified=identitySchema.parse(identity),profile=profileSchema.parse(input);
 const event=getDb().transaction(()=>{
  const existing=eventFor(verified.issuer,verified.sub);
  if(existing){
   const data=JSON.parse(existing.payload_json);
   if(JSON.stringify(data.profile)!==JSON.stringify(profile))throw new ConflictError('profile already submitted with different details');
   return existing;
  }
  let mappings;
  try{mappings=createIdentityMappingStore({path});if(mappings.lookup(verified))throw new ForbiddenError('identity already has a profile');}finally{mappings?.close();}
  const email=verified.email.trim().toLowerCase();
  // Email is profile metadata, never authority to link an existing legacy account.
  for(const table of ['customers','providers','admins'])if(getDb().prepare(`SELECT 1 FROM ${table} WHERE lower(email)=?`).get(email))throw new ConflictError('email belongs to an existing profile; ask an administrator to verify the identity binding');
  // No Keycloak password is accepted, copied or stored. Legacy password login is unusable.
  const password=randomBytes(48).toString('base64url');
  const created=profile.role==='customer'?registerCustomer({...profile,email,password}):registerProvider({...profile,email,password});
  const id=insertEvent(IDENTITY_PROFILE_EVENT,'identity',created.id,{issuer:verified.issuer,sub:verified.sub,role:profile.role,domainId:created.id,profile});
  return getDb().prepare('SELECT * FROM events WHERE id=?').get(id);
 }).immediate();
 return deliver(event,path);
}
