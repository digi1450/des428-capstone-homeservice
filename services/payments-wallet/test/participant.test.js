// Area C: Payments participant (docs/c-payment-participant-interface.md, PRs #24/#25).
// Opt-in against a DISPOSABLE PostgreSQL database (TEST_DATABASE_URL). The HTTP case goes
// through A's real router with an explicit test verifier double (no Keycloak).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { createDatabase } from "../src/database.js";
import { migrate } from "../src/migrations.js";
import { createPaymentsService } from "../src/service.js";
import { createOutbox } from "../src/messaging/outbox.js";
import { createPaymentParticipant, SETUP_CANCELLED } from "../src/participant/index.js";
import { createApp } from "../src/app.js";
import { HttpError } from "../src/errors.js";

test("participant rejects missing dependencies", () => {
  assert.throws(() => createPaymentParticipant({}), TypeError);
  assert.throws(() => createPaymentParticipant({ database: { withTransaction() {} } }), TypeError);
});

test("payment participant on PostgreSQL", { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const db = createDatabase(process.env.TEST_DATABASE_URL);
  let participant;
  const business = createPaymentsService(db, {
    assertSettlementAllowed: (client, intent) => participant.assertSettlementAllowed(client, intent),
    stageEvent: createOutbox().stage,
  });
  participant = createPaymentParticipant({ database: db, business });
  const caller = "test-issuer|booking-" + randomUUID().slice(0, 8);
  const base = randomInt(800000000, 900000000);
  let seq = 0;
  const orders = [];
  const next = () => { seq += 1; const order = base + seq; orders.push(order); const saga = `saga-${order}`;
    return { order, saga, create: `create:${saga}`, cancel: `cancel:${saga}`, activate: `activate:${saga}`,
      request: { order_id: order, customer_id: 7, provider_id: 3, amount_cents: 1500, currency: "THB", saga_id: saga } }; };
  const create = (p, over = {}) => participant.create({ callerId: caller, commandId: p.create, request: { ...p.request, ...over }, context: {} });
  const cancel = (p, over = {}, key = p.cancel) => participant.cancel({ callerId: caller, commandId: key,
    request: { create_command_id: p.create, saga_id: p.saga, reason: "booking_setup_failed", ...over }, context: {} });
  const activate = (p, over = {}, key = p.activate) => participant.activate({ callerId: caller, commandId: key,
    request: { create_command_id: p.create, saga_id: p.saga, ...over }, context: {} });
  const get = p => participant.get({ callerId: caller, createCommandId: p.create, context: {} });
  const settle = async p => {
    const intent = (await db.query("SELECT gateway_ref FROM payment_intents WHERE order_id=$1", [p.order])).rows[0];
    return business.settleWebhook({ gateway_event_id: "pt-" + randomUUID(), type: "payment_intent.succeeded", gateway_ref: intent.gateway_ref });
  };
  const intentsFor = async p => (await db.query("SELECT * FROM payment_intents WHERE order_id=$1", [p.order])).rows;
  const isConflict = (code) => error => error instanceof HttpError && error.statusCode === 409 && (code === undefined ? true : error.code === code);
  try {
    await migrate(db);
    await db.checkReady();

    await t.test("create: fresh then exact replay; changed input or reused id for another kind conflicts", async () => {
      const p = next();
      const first = await create(p);
      assert.equal(first.replayed, false);
      assert.equal(first.result.outcome, "created");
      assert.equal(first.result.payment_intent.status, "requires_payment");
      const again = await create(p);
      assert.deepEqual(again, { replayed: true, result: first.result });
      await assert.rejects(create(p, { amount_cents: 1600 }), isConflict());
      await assert.rejects(cancel(p, {}, p.create), isConflict(), "create id reused as a cancel id");
      assert.equal((await intentsFor(p)).length, 1);
      const other = next();
      await assert.rejects(participant.create({ callerId: caller, commandId: other.create, request: { ...other.request, order_id: p.order } }), isConflict(),
        "another create identity for an already-bound booking");
    });

    await t.test("provisioning cannot reference a missing intent or lose its referenced intent", async () => {
      const p = next();
      const first = await create(p);
      await assert.rejects(db.withTransaction(async client => {
        // Other test files insert intents concurrently. Keep this candidate absent
        // until the FK check; rollback releases the test-only lock after rejection.
        await client.query("LOCK TABLE payment_intents IN SHARE MODE");
        const missing = await client.query("SELECT max(id)+1 AS id FROM payment_intents");
        await client.query("UPDATE payment_provisioning SET intent_id=$1 WHERE caller_id=$2 AND create_command_id=$3", [missing.rows[0].id,caller,p.create]);
      }), error => error.code === "23503");
      await assert.rejects(db.query("DELETE FROM payment_intents WHERE id=$1", [first.result.payment_intent.id]), error => error.code === "23503");
      assert.equal((await get(p)).payment_intent.id, first.result.payment_intent.id);
    });

    await t.test("concurrent reuse of one cancel command across provisionings commits exactly one fence", async () => {
      const p = next(), q = next(), shared = `shared-cancel-${p.order}`;
      const outcomes = await Promise.allSettled([cancel(p, {}, shared),cancel(q, {}, shared)]);
      assert.equal(outcomes.filter(item => item.status === "fulfilled").length, 1);
      const rejected = outcomes.find(item => item.status === "rejected");
      assert.ok(isConflict()(rejected.reason));
      const states = (await db.query("SELECT state FROM payment_provisioning WHERE caller_id=$1 AND create_command_id=ANY($2::text[])", [caller,[p.create,q.create]])).rows;
      assert.deepEqual(states.map(row => row.state), ["fenced"]);
      assert.equal((await intentsFor(p)).length+(await intentsFor(q)).length, 0);
    });

    await t.test("absent-create fence: the late create never makes an intent", async () => {
      const p = next();
      assert.equal(await get(p), null, "unknown is null, never a fence");
      assert.deepEqual(await cancel(p), { create_command_id: p.create, saga_id: p.saga, outcome: "cancelled" });
      await assert.rejects(create(p), isConflict(SETUP_CANCELLED));
      assert.equal((await intentsFor(p)).length, 0);
      assert.equal((await get(p)).outcome, "cancelled");
      assert.deepEqual(await cancel(p), { create_command_id: p.create, saga_id: p.saga, outcome: "cancelled" }, "cancel replay");
    });

    await t.test("create -> cancel -> replay create returns the historical result; fence stays effective", async () => {
      const p = next();
      const first = await create(p);
      await cancel(p);
      const [intent] = await intentsFor(p);
      assert.equal(intent.status, "failed", "unpaid intent voided");
      assert.deepEqual(await create(p), { replayed: true, result: first.result });
      assert.equal((await intentsFor(p)).length, 1, "no new intent");
      assert.equal((await get(p)).outcome, "cancelled");
      await assert.rejects(activate(p), isConflict(SETUP_CANCELLED));
      await assert.rejects(settle(p), /voided intent cannot settle/);
    });

    await t.test("cancel referencing another saga does not fence the original", async () => {
      const p = next();
      await create(p);
      await assert.rejects(cancel(p, { saga_id: "saga-someone-else" }), isConflict());
      assert.equal((await get(p)).outcome, "created");
    });

    await t.test("settlement: refused before activation, allowed after, and outbox event staged", async () => {
      const p = next();
      await create(p);
      await assert.rejects(settle(p), /not settleable/);
      const activated = await activate(p);
      assert.deepEqual(activated, { replayed: false, result: { create_command_id: p.create, saga_id: p.saga, outcome: "activated" } });
      assert.deepEqual(await activate(p), { replayed: true, result: activated.result });
      await settle(p);
      assert.equal((await intentsFor(p))[0].status, "succeeded");
      assert.equal((await db.query("SELECT count(*)::int AS n FROM outbox_events WHERE aggregate_id=$1 AND event_type='payment.succeeded'", [String(p.order)])).rows[0].n, 1);
      await assert.rejects(cancel(p), /refund, not void/, "cancel after settlement is reconciliation");
      assert.equal((await db.query("SELECT state FROM payment_provisioning WHERE order_id=$1", [p.order])).rows[0].state, "activated", "no fence written");
    });

    await t.test("activate: unknown create or saga mismatch is an uncoded conflict", async () => {
      const p = next();
      await assert.rejects(activate(p), error => isConflict()(error) && error.code === undefined);
      await create(p);
      await assert.rejects(activate(p, { saga_id: "saga-other" }), error => isConflict()(error) && error.code === undefined);
      await assert.rejects(activate(p, {}, p.create), isConflict(), "create id reused as activate id");
    });

    await t.test("cancel after activation removes eligibility", async () => {
      const p = next();
      await create(p);
      await activate(p);
      await cancel(p);
      await assert.rejects(settle(p), /voided intent cannot settle/);
      await assert.rejects(activate(p), isConflict(SETUP_CANCELLED), "replayed activate sees the fence");
    });

    await t.test("legacy intent without provisioning is never adopted", async () => {
      const p = next();
      await business.prepareIntent({ order_id: p.order, customer_id: 7, provider_id: 3, amount_cents: 1500, currency: "THB" });
      await assert.rejects(create(p), /reconciliation/);
      assert.equal((await db.query("SELECT 1 FROM payment_provisioning WHERE order_id=$1", [p.order])).rowCount, 0);
    });

    await t.test("races: activate vs cancel vs settle always end in one valid state", async () => {
      const outcomes = new Map();
      for (let i = 0; i < 12; i += 1) {
        const p = next();
        await create(p);
        if (i % 2) await activate(p); // half start activated so settlement can win
        const results = await Promise.allSettled([activate(p, {}, `${p.activate}-race`), cancel(p), settle(p)]);
        const state = (await db.query("SELECT state FROM payment_provisioning WHERE order_id=$1", [p.order])).rows[0].state;
        const [intent] = await intentsFor(p);
        const charged = (await db.query("SELECT count(*)::int AS n FROM transactions WHERE order_id=$1", [p.order])).rows[0].n;
        const key = `${state}/${intent.status}/${charged}`;
        outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
        // Invariants: fenced <=> intent failed and nothing charged; charged => activated + succeeded.
        if (state === "fenced") { assert.equal(intent.status, "failed"); assert.equal(charged, 0); }
        if (charged) { assert.equal(state, "activated"); assert.equal(intent.status, "succeeded"); }
        if (intent.status === "succeeded") assert.equal(state, "activated");
        assert.ok(results.some(r => r.status === "fulfilled"));
      }
      t.diagnostic("race end states: " + JSON.stringify(Object.fromEntries(outcomes)));
    });

    await t.test("scoped by caller: another caller sees nothing", async () => {
      const p = next();
      await create(p);
      assert.equal(await participant.get({ callerId: caller + "-other", createCommandId: p.create, context: {} }), null);
    });

    await t.test("activation HTTP with real participant: durable replay, uncoded conflict and effective coded fence", async () => {
      const p = next();
      const app = createApp({database: db,paymentCommands: participant,authenticateService: async(req,{operation}) => {
        assert.ok(["create","query","cancel","activate"].includes(operation));
        if(req.get("authorization") !== "Bearer participant-http-test") throw new HttpError(401,"invalid test token");
        return {service:"booking",callerId:caller};
      }});
      const server=app.listen(0,"127.0.0.1");
      await new Promise(resolve=>server.once("listening",resolve));
      const post=(path,body,key)=>fetch(`http://127.0.0.1:${server.address().port}/internal/payment-intents${path}`,{
        method:"POST",headers:{Authorization:"Bearer participant-http-test","Content-Type":"application/json","Idempotency-Key":key,"X-Request-Id":"real-activation-http"},body:JSON.stringify(body),
      });
      const body={create_command_id:p.create,saga_id:p.saga};
      const eligible=()=>db.withTransaction(async client=>{
        await client.query("SELECT pg_advisory_xact_lock(42801,$1::integer)",[p.order]);
        const intent=(await client.query("SELECT * FROM payment_intents WHERE order_id=$1",[p.order])).rows[0];
        return participant.assertSettlementAllowed(client,intent);
      });
      try {
        assert.equal((await post("",p.request,p.create)).status,201);
        assert.equal(await eligible(),false);
        const expected={...body,outcome:"activated"};
        for(let n=0;n<2;n++) {
          const response=await post("/activate-by-command",body,p.activate);
          assert.equal(response.status,200);assert.deepEqual(await response.json(),expected);
        }
        assert.equal(await eligible(),true);
        assert.equal((await db.query("SELECT count(*)::int AS n FROM payment_commands WHERE caller_id=$1 AND command_id=$2",[caller,p.activate])).rows[0].n,1);
        for(const request of [{...body,saga_id:"other-saga"},{create_command_id:"missing-create",saga_id:p.saga}]) {
          const response=await post("/activate-by-command",request,p.activate+"-conflict");
          assert.equal(response.status,409);assert.equal((await response.json()).code,undefined);
        }
        assert.equal((await post("/cancel-by-command",{...body,reason:"booking_setup_failed"},p.cancel)).status,200);
        const fenced=await post("/activate-by-command",body,p.activate);
        assert.equal(fenced.status,409);
        const error=await fenced.json();assert.equal(error.code,SETUP_CANCELLED);assert.equal(error.requestId,"real-activation-http");
        assert.equal(await eligible(),false);
        assert.equal((await db.query("SELECT state FROM payment_provisioning WHERE caller_id=$1 AND create_command_id=$2",[caller,p.create])).rows[0].state,"fenced");
        assert.equal((await intentsFor(p)).length,1);
      } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    });

    await t.test("through A's HTTP router: 201 create, 200 replay, get, cancel, 404 unknown", async () => {
      const p = next();
      const app = createApp({ database: db, paymentCommands: participant,
        authenticateService: async req => {
          if (req.get("authorization") !== "Bearer booking-test") throw new HttpError(401, "invalid test token");
          return { service: "booking", callerId: caller };
        } });
      const server = app.listen(0, "127.0.0.1");
      await new Promise(resolve => server.once("listening", resolve));
      try {
        const url = `http://127.0.0.1:${server.address().port}/internal`;
        const headers = key => ({ "Content-Type": "application/json", Authorization: "Bearer booking-test", "Idempotency-Key": key });
        const post = (path, body, key) => fetch(url + path, { method: "POST", headers: headers(key), body: JSON.stringify(body) });
        const created = await post("/payment-intents", p.request, p.create);
        assert.equal(created.status, 201);
        const body = await created.json();
        assert.equal(body.payment_intent.order_id, p.order);
        const replay = await post("/payment-intents", p.request, p.create);
        assert.equal(replay.status, 200);
        assert.deepEqual(await replay.json(), body);
        const changed = await post("/payment-intents", { ...p.request, amount_cents: 99 }, p.create);
        assert.equal(changed.status, 409);
        const query = await fetch(`${url}/payment-operations/${p.create}`, { headers: { Authorization: "Bearer booking-test" } });
        assert.equal((await query.json()).outcome, "created");
        const unknown = await fetch(`${url}/payment-operations/create:nobody`, { headers: { Authorization: "Bearer booking-test" } });
        assert.equal(unknown.status, 404);
        const cancelRes = await post("/payment-intents/cancel-by-command", { create_command_id: p.create, saga_id: p.saga, reason: "booking_setup_failed" }, p.cancel);
        assert.equal(cancelRes.status, 200);
        assert.equal((await cancelRes.json()).outcome, "cancelled");
        const afterFence = await post("/payment-intents", p.request, p.create);
        assert.equal(afterFence.status, 200, "historical create replay passes A's strict validation");
      } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    });
  } finally {
    try {
      await db.query("DELETE FROM payment_commands WHERE caller_id LIKE $1", [caller + "%"]);
      await db.query("DELETE FROM payment_provisioning WHERE caller_id LIKE $1", [caller + "%"]);
      await db.query("DELETE FROM outbox_events WHERE aggregate_id = ANY($1::text[])", [orders.map(String)]);
      await db.query("DELETE FROM webhook_events WHERE payload_json->>'gateway_ref' IN (SELECT gateway_ref FROM payment_intents WHERE order_id = ANY($1::integer[]))", [orders]);
      await db.query("DELETE FROM transactions WHERE order_id = ANY($1::integer[])", [orders]);
      await db.query("DELETE FROM payment_intents WHERE order_id = ANY($1::integer[])", [orders]);
    } finally { await db.close(); }
  }
});
