// Receipt protocol v1. Local deployment authority is a private signing key,
// independent of user/service JWTs. No request body/header can select this file.
import {sign,verify,createPrivateKey,createPublicKey} from 'node:crypto';
import {openSync,fstatSync,readFileSync,closeSync,constants} from 'node:fs';
export const canonical=value=>value&&typeof value==='object'&&!Array.isArray(value)
 ? '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}'
 : Array.isArray(value)?'['+value.map(canonical).join(',')+']':JSON.stringify(value);
export function trustedFile(file,{secret=false}={}){
 const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const s=fstatSync(fd);if(!s.isFile()||(s.mode&(secret?0o077:0o022))||s.size>64*1024*1024)throw Error('private file required');return readFileSync(fd);}finally{closeSync(fd);}
}
export const privateFile=file=>trustedFile(file,{secret:true});
const hash=v=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
function shape(v){
 const fields=['version','state','manifest_sha256','snapshot_id','phase_digest','backup_set_id','operator_id','approved_at','freeze_digest'];
 if(!v||Object.keys(v).sort().join(',')!==fields.sort().join(',')||v.version!==1||v.state!=='approved'||!hash(v.manifest_sha256)||!hash(v.phase_digest)||!hash(v.freeze_digest)||!uuid(v.snapshot_id)||!uuid(v.backup_set_id)||typeof v.operator_id!=='string'||!v.operator_id||v.operator_id.length>256||typeof v.approved_at!=='string'||new Date(v.approved_at).toISOString()!==v.approved_at)throw Error('invalid checkpoint');
}
export function sealCheckpoint(payload,key){
 shape(payload);const parsed=createPrivateKey(key);if(parsed.asymmetricKeyType!=='ed25519')throw Error('Ed25519 signing key required');
 return {payload,signature:sign(null,Buffer.from(canonical(payload)),parsed).toString('base64url')};
}
export function verifyCheckpoint(value,key){
 shape(value?.payload);if(Object.keys(value).sort().join(',')!=='payload,signature'||typeof value.signature!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(value.signature))throw Error('invalid receipt');
 const parsed=createPublicKey(key);if(parsed.asymmetricKeyType!=='ed25519'||!verify(null,Buffer.from(canonical(value.payload)),parsed,Buffer.from(value.signature,'base64url')))throw Error('invalid receipt');return structuredClone(value.payload);
}
export function readCheckpoint(file,publicKeyFile){
 const raw=trustedFile(file),value=JSON.parse(raw.toString('utf8'));
 if(raw.toString('utf8')!==canonical(value)+'\n')throw Error('noncanonical receipt');
 return verifyCheckpoint(value,trustedFile(publicKeyFile));
}
export function deploymentLegacyApproval(env=process.env){
 if(!env.LEGACY_CHECKPOINT_FILE&&!env.LEGACY_CHECKPOINT_PUBLIC_KEY_FILE)return undefined;
 if(!env.LEGACY_CHECKPOINT_FILE||!env.LEGACY_CHECKPOINT_PUBLIC_KEY_FILE)throw Error('both checkpoint files required');
 return readCheckpoint(env.LEGACY_CHECKPOINT_FILE,env.LEGACY_CHECKPOINT_PUBLIC_KEY_FILE).manifest_sha256;
}
