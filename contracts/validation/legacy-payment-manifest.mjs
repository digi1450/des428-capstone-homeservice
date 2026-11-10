// Contract conformance ONLY. No SQLite/PG/HTTP, authorization, writes or cutover.
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import Ajv from 'ajv';
export const schema=JSON.parse(await readFile(new URL('../legacy-payment-manifest.schema.json',import.meta.url),'utf8'));
const ajv=new Ajv({strict:false}), envelopeShape=ajv.compile(schema);
const coreShape=ajv.compile({$ref:'#/definitions/ManifestCore',definitions:schema.definitions});
const requireValid=(ok,label)=>{if(!ok)throw new TypeError(label);};
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const ascii=value=>typeof value==='string'&&/^[\x20-\x7e]*$/.test(value);
function canonical(value){
 if(typeof value==='string'){requireValid(ascii(value),'MANIFEST_NON_ASCII_STRING');return JSON.stringify(value);}
 if(typeof value==='number'){requireValid(Number.isSafeInteger(value),'MANIFEST_NON_INTEGER');return JSON.stringify(value);}
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 requireValid(value!==null&&typeof value==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(value)),'MANIFEST_NON_JSON_VALUE');
 return '{'+Object.keys(value).sort().map(key=>{requireValid(ascii(key),'MANIFEST_NON_ASCII_KEY');return JSON.stringify(key)+':'+canonical(value[key]);}).join(',')+'}';
}
export function assertManifestCore(core){
 requireValid(coreShape(core),'MANIFEST_SCHEMA');
 requireValid(core.bundles.map(x=>x.service).join(',')==='notifications,payments-wallet','MANIFEST_BUNDLE_ORDER_OR_DUPLICATE');
 let previous=0;const intents=new Set(),charges=new Set();
 for(const row of core.bindings){
  requireValid(row.order_id>previous,'MANIFEST_BINDING_ORDER_OR_DUPLICATE');previous=row.order_id;
  requireValid(!intents.has(row.intent_id),'MANIFEST_DUPLICATE_INTENT');intents.add(row.intent_id);
  if(row.charge_transaction_id!==undefined){requireValid(!charges.has(row.charge_transaction_id),'MANIFEST_DUPLICATE_CHARGE');charges.add(row.charge_transaction_id);}
 }
 return core;
}
export const canonicalManifestCore=core=>Buffer.from(canonical(assertManifestCore(core)),'utf8');
export const manifestDigest=core=>sha256(canonicalManifestCore(core));
export function deriveLegacyBindingId(digest,orderId){
 requireValid(typeof digest==='string'&&/^[0-9a-f]{64}$/.test(digest)&&Number.isInteger(orderId)&&orderId>0&&orderId<=2147483647,'LEGACY_BINDING_ID');
 return `legacy:${digest}:${orderId}`;
}
export function createManifestEnvelope(core){
 return {manifest:structuredClone(assertManifestCore(core)),manifest_sha256:manifestDigest(core)};
}
export function assertManifestEnvelope(value){
 requireValid(envelopeShape(value),'MANIFEST_ENVELOPE_SCHEMA');
 requireValid(manifestDigest(value.manifest)===value.manifest_sha256,'MANIFEST_HASH_MISMATCH');return value;
}
export const serializeManifestEnvelope=value=>Buffer.from(canonical(assertManifestEnvelope(value))+'\n','utf8');
export function parseManifestEnvelope(bytes){
 let text,value;
 try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);value=JSON.parse(text);}
 catch{throw new TypeError('MANIFEST_INVALID_JSON_UTF8');}
 assertManifestEnvelope(value);
 // Canonical envelope encoding also rejects duplicate keys hidden by JSON.parse.
 const raw=text.endsWith('\n')?text.slice(0,-1):text;
 requireValid(raw===canonical(value),'MANIFEST_NON_CANONICAL_FILE');return value;
}
export function assertLegacyReference(request){
 const ref=request?.legacy_binding;if(ref===undefined)return request;
 requireValid(ref.binding_id===deriveLegacyBindingId(ref.manifest_sha256,request.order_id),'LEGACY_REFERENCE_HASH_OR_ORDER');return request;
}
export function assertLegacyManifestContext(request,envelope){
 assertManifestEnvelope(envelope);assertLegacyReference(request);
 requireValid(request.payment_method==='gateway'&&request.legacy_binding?.manifest_sha256===envelope.manifest_sha256,'LEGACY_REFERENCE_MANIFEST');
 const entry=envelope.manifest.bindings.find(x=>x.order_id===request.order_id);
 requireValid(entry&&['order_id','customer_id','provider_id','amount_cents','currency','payment_method'].every(k=>entry[k]===request[k]),'LEGACY_REFERENCE_CONTEXT');
 return entry; // Initial snapshot eligibility is not proof of current settlement or a DB lock.
}
function jsonBytes(bytes){
 requireValid(Buffer.isBuffer(bytes)||bytes instanceof Uint8Array,'MANIFEST_ARTIFACT_BYTES');
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes));}catch{throw new TypeError('MANIFEST_ARTIFACT_JSON');}
}
export function assertManifestArtifacts(envelope,{backupBytes,bundleBytes}={}){
 assertManifestEnvelope(envelope);const core=envelope.manifest;
 requireValid((Buffer.isBuffer(backupBytes)||backupBytes instanceof Uint8Array)&&sha256(backupBytes)===core.source.sqlite_backup_sha256,'MANIFEST_BACKUP_HASH');
 requireValid(bundleBytes&&Object.keys(bundleBytes).sort().join(',')==='notifications,payments-wallet','MANIFEST_ARTIFACT_SET');
 let payments;
 for(const item of core.bundles){
  const bytes=bundleBytes[item.service];requireValid((Buffer.isBuffer(bytes)||bytes instanceof Uint8Array)&&sha256(bytes)===item.sha256,'MANIFEST_BUNDLE_HASH');
  const bundle=jsonBytes(bytes);
  requireValid(bundle?.format_version===1&&bundle.service===item.service&&bundle.snapshot_id===core.snapshot_id&&bundle.legacy_event_watermark===core.legacy_event_watermark,'MANIFEST_BUNDLE_CONTEXT');
  if(item.service==='payments-wallet')payments=bundle;
 }
 requireValid(Array.isArray(payments?.tables?.payment_intents)&&Array.isArray(payments.tables.transactions),'MANIFEST_PAYMENT_TABLES');
 for(const entry of core.bindings){
  const intents=payments.tables.payment_intents.filter(x=>x.order_id===entry.order_id);
  const intent=intents[0];
  requireValid(intents.length===1&&intent.id===entry.intent_id&&['order_id','customer_id','provider_id','amount_cents','currency'].every(k=>intent[k]===entry[k])&&intent.status===entry.intent_status,'MANIFEST_INTENT_CONTEXT');
  const ledger=payments.tables.transactions.filter(x=>x.order_id===entry.order_id);
  if(entry.eligibility==='open_unpaid')requireValid(ledger.length===0,'MANIFEST_UNPAID_LEDGER');
  else requireValid(ledger.length===1&&ledger[0].id===entry.charge_transaction_id&&ledger[0].kind==='charge'&&ledger[0].status==='succeeded'&&ledger[0].method==='gateway'&&ledger[0].gateway_ref===intent.gateway_ref&&['order_id','customer_id','provider_id','amount_cents'].every(k=>ledger[0][k]===entry[k]),'MANIFEST_PAID_LEDGER');
 }
 return envelope; // Does NOT parse/verify consistent SQLite, source rows, operator approval or all bundle invariants.
}

// Exact deterministic projections for the future two owner-local binding writers.
// created_at is owner-local audit metadata; do not regenerate it on identical replay.
export function bindingRowsFor(envelope,owner){
 assertManifestEnvelope(envelope);requireValid(['payments-wallet','booking'].includes(owner),'MANIFEST_BINDING_OWNER');
 return envelope.manifest.bindings.map(entry=>{
  const shared={order_id:entry.order_id,binding_id:deriveLegacyBindingId(envelope.manifest_sha256,entry.order_id),manifest_sha256:envelope.manifest_sha256};
  if(owner==='booking')return shared;
  const {intent_id,customer_id,provider_id,amount_cents,currency,eligibility}=entry;
  return {...shared,intent_id,customer_id,provider_id,amount_cents,currency,eligibility};
 });
}
