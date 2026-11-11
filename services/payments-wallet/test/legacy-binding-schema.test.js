import test from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase} from '../src/database.js';
import {migrate} from '../src/migrations.js';

test('006 binds exact intent context, rejects conflicting identities, and rolls back atomically', {skip:!process.env.TEST_DATABASE_URL},async()=>{
 const db=createDatabase(process.env.TEST_DATABASE_URL);
 const digest='a'.repeat(64), id=19000601;
 try{
  await migrate(db);assert.deepEqual(await migrate(db),[]);
  await assert.rejects(db.withTransaction(async c=>{
   await c.query('INSERT INTO payment_intents (id,order_id,customer_id,provider_id,amount_cents,gateway_ref) VALUES ($1,$1,5,7,1000,$2)',[id,'schema006-test-'+id]);
   const insert=async ({order=id,intent=id,customer=5,amount=1000,hash=digest,binding=`legacy:${hash}:${order}`,eligibility='open_unpaid'}={})=>{
    await c.query('SAVEPOINT invalid_binding');
    try{await c.query('INSERT INTO legacy_payment_bindings (order_id,binding_id,manifest_sha256,intent_id,customer_id,provider_id,amount_cents,currency,eligibility) VALUES ($1,$2,$3,$4,$5,7,$6,\'THB\',$7)',[order,binding,hash,intent,customer,amount,eligibility]);}
    catch(error){await c.query('ROLLBACK TO SAVEPOINT invalid_binding');throw error;}
   };
   for(const overrides of [{customer:6},{amount:999},{order:id+1},{intent:id+1}])
    await assert.rejects(insert(overrides),e=>e.code==='23503');
   for(const overrides of [{hash:'b'.repeat(63)},{binding:'legacy:wrong'},{eligibility:'approved'}])
    await assert.rejects(insert(overrides),e=>e.code==='23514');
   await insert();
   await assert.rejects(insert(),e=>e.code==='23505');
   assert.equal((await c.query('SELECT count(*)::int AS n FROM legacy_payment_bindings WHERE order_id=$1',[id])).rows[0].n,1);
   throw Error('rollback fixture');
  }),/rollback fixture/);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM legacy_payment_bindings WHERE order_id=$1',[id])).rows[0].n,0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM payment_intents WHERE id=$1',[id])).rows[0].n,0);
 }finally{await db.close();}
});
