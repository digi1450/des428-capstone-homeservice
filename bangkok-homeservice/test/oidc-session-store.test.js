import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {createOidcSessionStore} from '../lib/security/oidc-session-store.js';
import {oidcSessionFixture} from '../test-helpers/oidc-sessions.js';
const secret='s'.repeat(32),clock=1800000000000;
const value={issuer:'https://id.example.test/realms/homeservice',sub:'subject',role:'customer',domainId:42,exp:1800000300,accessToken:'access-'.repeat(1000),refreshToken:'refresh-'.repeat(1000)};

test('large sessions survive reopening, use opaque IDs, and encrypt tokens at rest',t=>{
 const fixture=oidcSessionFixture(t,{secret,now:()=>clock});
 const id=fixture.issue(value);assert.match(id,/^[A-Za-z0-9_-]{43}$/);
 const reopened=createOidcSessionStore({path:fixture.path,secret,now:()=>clock});
 try{assert.deepEqual(reopened.get(id),value);assert.equal(reopened.get(id.slice(1)),null);assert.equal(reopened.get('x'.repeat(43)),null);}finally{reopened.close();}
 const raw=new Database(fixture.path);
 try{const row=raw.prepare('SELECT * FROM oidc_server_sessions').get();assert.notEqual(row.id_hash,id);assert.equal(row.sealed.includes(value.accessToken),false);assert.equal(row.sealed.includes(value.refreshToken),false);assert.equal(row.sealed.includes('subject'),false);}finally{raw.close();}
 const wrongKey=createOidcSessionStore({path:fixture.path,secret:'k'.repeat(32),now:()=>clock});
 try{assert.equal(wrongKey.get(id),null);}finally{wrongKey.close();}
});
test('refresh rotation consumes an ID once, and logout prevents stale rotation resurrection',t=>{
 const fixture=oidcSessionFixture(t,{secret,now:()=>clock});
 const store=createOidcSessionStore({path:fixture.path,secret,now:()=>clock});
 try{
  const id=store.create(value),next=store.rotate(id,{...value,refreshToken:'rotated'});
  assert.notEqual(next,id);assert.equal(store.get(id),null);assert.equal(store.get(next).refreshToken,'rotated');
  assert.equal(store.rotate(id,value),null);store.remove(next);assert.equal(store.rotate(next,value),null);assert.equal(store.get(next),null);
 }finally{store.close();}
});
test('expiry and failed replacement never admit an expired session or destroy a valid original',t=>{
 const fixture=oidcSessionFixture(t,{secret,now:()=>clock}),id=fixture.issue(value);
 const store=createOidcSessionStore({path:fixture.path,secret,now:()=>clock});
 try{assert.throws(()=>store.rotate(id,{...value,accessToken:'x'.repeat(70000)}));assert.deepEqual(store.get(id),value);}finally{store.close();}
 const expired=createOidcSessionStore({path:fixture.path,secret,now:()=>clock+300000});
 try{assert.equal(expired.get(id),null);assert.equal(expired.rotate(id,{...value,exp:1800000900}),null);assert.throws(()=>expired.create(value));}finally{expired.close();}
});
