import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {freshBoot,getDb} from '../test-helpers/boot.js';
import {completeIdentityProfile,recoverIdentityBinding,recoverIdentityBindings,profileSchema,IDENTITY_PROFILE_EVENT} from '../lib/modules/identity/onboarding.js';
import {createIdentityMappingStore} from '../lib/security/identity-mapping.js';
import {configureProviderEventWrites,resetProviderEventWrites} from '../lib/modules/providers/event-writes.js';
import {PUBLISHED_TYPES} from '../lib/messaging/broker-relay.js';
freshBoot();
const issuer='https://id.example.test/realms/homeservice';
test('verified-subject onboarding durably creates one profile and never links by email',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'oidc-onboard-')),path=join(directory,'bindings.sqlite');t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const identity={issuer,sub:'new-customer',email:'new-oidc@example.test'},input={role:'customer',name:'New Customer'};
 await t.test('crash after profile commit is recoverable without duplicate profile or business schema change',()=>{
  const before=getDb().prepare('SELECT count(*) n FROM customers').get().n;
  assert.throws(()=>completeIdentityProfile(identity,input,{path,deliver(){throw Error('interrupted before mapping');}}),/interrupted/);
  assert.equal(getDb().prepare('SELECT count(*) n FROM customers').get().n,before+1);
  const found=recoverIdentityBinding(identity,{path});assert.equal(found.role,'customer');
  assert.deepEqual(completeIdentityProfile(identity,input,{path}),found);
  assert.equal(getDb().prepare('SELECT count(*) n FROM customers').get().n,before+1);
  assert.equal(getDb().prepare('SELECT count(*) n FROM events WHERE type=?').get(IDENTITY_PROFILE_EVENT).n,1);
  assert.equal(PUBLISHED_TYPES.includes(IDENTITY_PROFILE_EVENT),false,'identity work must never leave the identity owner');
 });
 await t.test('same subject cannot change role or requested profile on replay',()=>{
  assert.throws(()=>completeIdentityProfile(identity,{role:'provider',name:'Different'},{path}),/different details/);
  assert.equal(profileSchema.safeParse({role:'admin',name:'Admin'}).success,false);
  assert.equal(profileSchema.safeParse({role:'customer',name:'New',domainId:1}).success,false);
 });
 await t.test('email metadata cannot claim existing profile even with a different issuer/subject',()=>{
  const old=getDb().prepare('SELECT email FROM customers ORDER BY id LIMIT 1').get().email;
  assert.throws(()=>completeIdentityProfile({issuer,sub:'attacker',email:old.toUpperCase()},input,{path}),/existing profile/);
  let store;try{store=createIdentityMappingStore({path});assert.equal(store.lookup({issuer,sub:'attacker'}),null);}finally{store.close();}
 });
 await t.test('provider profile and wallet-provisioning event commit together; no local wallet in event mode',()=>{
  configureProviderEventWrites({mode:'events'});
  try{
   const result=completeIdentityProfile({issuer,sub:'new-provider',email:'new-provider-oidc@example.test'},{role:'provider',name:'Provider',company_name:'Fixture'},{path});
   assert.equal(getDb().prepare('SELECT is_approved FROM provider_profiles WHERE provider_id=?').get(result.domainId).is_approved,0);
   assert.equal(getDb().prepare('SELECT count(*) n FROM provider_wallets WHERE provider_id=?').get(result.domainId).n,0);
   assert.equal(getDb().prepare("SELECT count(*) n FROM events WHERE type='provider.registered' AND aggregate_id=?").get(result.domainId).n,1);
  }finally{resetProviderEventWrites();}
 });
 await t.test('an incompatible trusted binding is never overwritten',()=>{
  const pending={issuer,sub:'pending',email:'pending-oidc@example.test'};
  assert.throws(()=>completeIdentityProfile(pending,input,{path,deliver(){throw Error('stop');}}));
  const store=createIdentityMappingStore({path});store.provision({...pending,role:'customer',domainId:getDb().prepare('SELECT id FROM customers ORDER BY id LIMIT 1').get().id});store.close();
  assert.throws(()=>recoverIdentityBinding(pending,{path}),/binding conflict/);
  const another={issuer,sub:'recoverable-after-conflict',email:'recover-after-conflict@example.test'};
  assert.throws(()=>completeIdentityProfile(another,input,{path,deliver(){throw Error('interrupted');}}));
  const recovered=recoverIdentityBindings({path});assert.equal(recovered.processed,1);assert.equal(recovered.pending,1);
  const check=createIdentityMappingStore({path});try{assert.equal(check.lookup(another).role,'customer');}finally{check.close();}
 });
});
