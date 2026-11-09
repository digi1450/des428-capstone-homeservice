import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

// Separate process under node --test, with its own disposable FILE database.
process.env.NODE_ENV='test';
const directory=await mkdtemp(path.join(tmpdir(),'homeservice-bid-race-'));
process.env.DB_PATH=path.join(directory,'fixture.sqlite');
const {bootstrapDb}=await import('../lib/db/bootstrap.js');
const {getDb,closeDb}=await import('../lib/db/index.js');
const bidding=await import('../lib/modules/bidding/service.js');

test('a bid with a stale open precheck cannot insert after another connection accepts the job',async t=>{
  let worker;
  t.after(async()=>{if(worker)await worker.terminate();closeDb();await rm(directory,{recursive:true,force:true});});
  bootstrapDb(); // Normal initialization of a new fixture file; never reset a file database.
  const db=getDb(),customerId=db.prepare('SELECT id FROM customers ORDER BY id LIMIT 1').get().id;
  const [winner,late]=db.prepare('SELECT id FROM providers ORDER BY id LIMIT 2').all();
  db.prepare('UPDATE provider_profiles SET is_approved=1,is_accepting_custom_jobs=1 WHERE provider_id IN (?,?)').run(winner.id,late.id);
  const category=db.prepare('SELECT id FROM categories ORDER BY id LIMIT 1').get().id;
  const job=bidding.postJob(customerId,{category_id:category,title:'Shared SQLite race fixture',min_price_cents:100,max_price_cents:200,window_start:'2026-12-03T10:00',window_end:'2026-12-03T12:00'});
  const bid=bidding.placeBid(job.id,winner.id,{counter_price_cents:100,duration_min:60});
  const control=new Int32Array(new SharedArrayBuffer(8));
  worker=new Worker(new URL('../test-helpers/bid-race-worker.js',import.meta.url),{workerData:{database:process.env.DB_PATH,control:control.buffer,jobId:job.id,bidId:bid.id,customerId}});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('worker readiness timeout')),5000);worker.once('error',error=>{clearTimeout(timer);reject(error);});worker.once('message',message=>{clearTimeout(timer);message==='ready'?resolve():reject(Error('worker failed to initialize'));});});
  const prepare=db.prepare.bind(db);let interrupted=false;
  // Force the real service read/write gap, without adding a production yield/hook.
  db.prepare=function(sql){
    const statement=prepare(sql);
    if(sql==='SELECT * FROM job_requests WHERE id = ?'&&!interrupted)return {get(...args){
      const row=statement.get(...args);assert.equal(row.status,'open');interrupted=true;
      Atomics.store(control,0,1);Atomics.notify(control,0);
      assert.notEqual(Atomics.wait(control,1,0,5000),'timed-out','second connection must commit the accept');
      assert.equal(Atomics.load(control,1),1,'worker accept must succeed');
      return row;
    }};
    return statement;
  };
  try{assert.throws(()=>bidding.placeBid(job.id,late.id,{counter_price_cents:150,duration_min:60}),error=>error.statusCode===409);}
  finally{db.prepare=prepare;}
  assert.equal(interrupted,true);
  assert.equal(db.prepare('SELECT status FROM job_requests WHERE id=?').get(job.id).status,'booked');
  assert.equal(db.prepare("SELECT count(*) AS n FROM bids WHERE job_request_id=? AND status='pending'").get(job.id).n,0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM orders WHERE job_request_id=?').get(job.id).n,1);
  assert.equal(db.prepare('SELECT status FROM bids WHERE id=?').get(bid.id).status,'accepted');
});
