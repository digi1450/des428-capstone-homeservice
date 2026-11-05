import { test } from "node:test";
import assert from "node:assert/strict";
import { randomInt,randomUUID } from "node:crypto";
import { createDatabase } from "../src/database.js";
import { migrate } from "../src/migrations.js";
import { createNotificationEventWriter } from "../src/event-writer.js";

test("PostgreSQL mapped notification batches",{skip:!process.env.TEST_DATABASE_URL},async t=>{
  const db=createDatabase(process.env.TEST_DATABASE_URL),base=randomInt(400000000,500000000);
  const probe="notification_dedupe_probe_"+randomUUID().replaceAll("-","");
  const data={order_id:base,job_request_id:base,winner_provider_id:base,loser_provider_ids:[base+1,base+2]};
  const writer=createNotificationEventWriter(db);
  const count=async()=>(await db.query("SELECT id FROM notifications WHERE recipient_id=ANY($1::integer[])",[[base,base+1,base+2]])).rowCount;
  const clear=()=>db.query("DELETE FROM notifications WHERE recipient_id=ANY($1::integer[])",[[base,base+1,base+2]]);
  try {
    await migrate(db);
    await db.query(`CREATE TABLE ${probe}(consumer_name TEXT,event_id TEXT,PRIMARY KEY(consumer_name,event_id))`);
    await t.test("standalone event writes all bid recipients in order and preserves null rejected order IDs",async()=>{
      const rows=await writer.recordEvent("bid.accepted",data);
      assert.equal(rows.length,3);assert.deepEqual(rows.map(row=>row.type),["bid_accepted","bid_rejected","bid_rejected"]);
      assert.deepEqual(rows.map(row=>row.order_id),[base,null,null]);assert.equal(await count(),3);await clear();
    });
    await t.test("second insert failure rolls back the first notification in a standalone batch",async()=>{
      let inserts=0;
      const failing=createNotificationEventWriter({withTransaction:work=>db.withTransaction(client=>work({query:(sql,values)=>{
        if(sql.includes("INSERT INTO notifications")&&++inserts===2)throw new Error("injected second-insert failure");
        return client.query(sql,values);
      }}))});
      await assert.rejects(failing.recordEvent("bid.accepted",data),/second-insert failure/);
      assert.equal(inserts,2);assert.equal(await count(),0);
    });
    await t.test("C-owned transaction rolls back its dedupe probe and ALL notification effects",async()=>{
      await assert.rejects(db.withTransaction(async client=>{
        await client.query(`INSERT INTO ${probe} VALUES ('notifications','rollback')`);
        await writer.recordEvent("bid.accepted",data,{client});
        throw new Error("consumer transaction failed");
      }),/consumer transaction failed/);
      assert.equal(await count(),0);assert.equal((await db.query(`SELECT * FROM ${probe} WHERE event_id='rollback'`)).rowCount,0);
    });
    await t.test("caller-supplied SQL dedupe pattern and writer share one transaction under replay",async()=>{
      const consume=()=>db.withTransaction(async client=>{
        const inserted=await client.query(`INSERT INTO ${probe} VALUES ('notifications','repeat') ON CONFLICT DO NOTHING RETURNING event_id`);
        if(!inserted.rowCount)return {replayed:true};
        await writer.recordEvent("bid.accepted",data,{client});return {replayed:false};
      });
      const results=await Promise.all(Array.from({length:4},consume));
      assert.equal(results.filter(result=>!result.replayed).length,1);assert.equal(await count(),3);
      assert.equal((await db.query(`SELECT * FROM ${probe} WHERE event_id='repeat'`)).rowCount,1);await clear();
    });
    await t.test("writer itself does not claim transport dedupe; approval and explicit no-recipient behavior are preserved",async()=>{
      await writer.recordEvent("provider.approved",{provider_id:base});await writer.recordEvent("provider.approved",{provider_id:base});
      assert.equal(await count(),2);
      const rows=(await db.query("SELECT * FROM notifications WHERE recipient_id=$1",[base])).rows;
      assert.ok(rows.every(row=>row.order_id===null&&row.type==="provider_approved"));
      assert.deepEqual(await writer.recordEvent("payment.succeeded",{order_id:base,provider_id:null,amount_cents:0}),[]);
      assert.equal(await count(),2);await clear();
    });
  } finally {
    try{await clear();await db.query(`DROP TABLE IF EXISTS ${probe}`);}finally{await db.close();}
  }
});
