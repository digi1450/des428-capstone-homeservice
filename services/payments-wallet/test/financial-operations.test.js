// Area C: durable financial finalization participant (step 5C, contract v1.0.0).
// Real PostgreSQL (DISPOSABLE, TEST_DATABASE_URL), real A business primitives, the real
// provisioning participant/settlement gate and A's real HTTP router with explicit test verifiers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { createDatabase } from "../src/database.js";
import { migrate } from "../src/migrations.js";
import { createPaymentsRuntime } from "../src/runtime.js";
import { createFinancialOperations, CODES } from "../src/financial/index.js";
import { createPaymentsService } from "../src/service.js";
import { SETUP_CANCELLED } from "../src/participant/index.js";
import { HttpError } from "../src/errors.js";
import { financialResult, financialRequest } from "../src/financial-validation.js";

test("financial operations on PostgreSQL", { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
  const db = createDatabase(process.env.TEST_DATABASE_URL);
  await migrate(db);
  const callerId = `booking-fin:${randomUUID()}`;
  const runtime = createPaymentsRuntime({ database: db, createFinancialOperations });
  const { business, participant, financialOperations: fin } = runtime;
  const orders = [];
  t.after(async () => {
    try {
      await db.query("DELETE FROM financial_fences WHERE order_id = ANY($1::int[])", [orders]);
      await db.query("DELETE FROM financial_commands WHERE order_id = ANY($1::int[])", [orders]);
      await db.query("DELETE FROM payment_commands WHERE caller_id LIKE $1", [`${callerId}%`]);
      await db.query("DELETE FROM payment_provisioning WHERE caller_id LIKE $1", [`${callerId}%`]);
      await db.query("DELETE FROM outbox_events WHERE aggregate_id = ANY($1::text[])", [orders.map(String)]);
      await db.query("DELETE FROM webhook_events WHERE payload_json->>'gateway_ref' IN (SELECT gateway_ref FROM payment_intents WHERE order_id = ANY($1::int[]))", [orders]);
      await db.query("DELETE FROM transactions WHERE order_id = ANY($1::int[])", [orders]);
      await db.query("DELETE FROM payment_intents WHERE order_id = ANY($1::int[])", [orders]);
    } finally { await db.close(); }
  });

  const newOrder = () => { const id = randomInt(1200000000, 1300000000); orders.push(id); return id; };
  const ctx = (orderId, over = {}) => ({ order_id: orderId, customer_id: 7, provider_id: randomInt(800000000, 900000000), amount_cents: 10700, currency: "THB", ...over });
  async function provision(orderId, { activate = true, base = ctx(orderId) } = {}) {
    const create = `create:${randomUUID()}`, saga = `saga:${randomUUID()}`;
    const { result } = await participant.create({ callerId, commandId: create, request: { ...base, saga_id: saga } });
    if (activate) await participant.activate({ callerId, commandId: `activate:${randomUUID()}`, request: { create_command_id: create, saga_id: saga } });
    return { base, create, saga, intent: result.payment_intent };
  }
  const settle = (intent) => business.settleWebhook({ gateway_event_id: `evt:${randomUUID()}`, type: "payment_intent.succeeded", gateway_ref: intent.gateway_ref });
  const completion = (p, over = {}) => {
    const operation = randomUUID();
    const request = { operation_id: operation, ...p.base, payment_method: p.create ? "gateway" : "cod", commission_cents: 1070,
      ...(p.create ? { provisioning: { create_command_id: p.create, saga_id: p.saga } } : {}), ...over };
    return { callerId, commandId: `complete:${operation}`, request };
  };
  const cancellation = (p, over = {}) => {
    const operation = randomUUID();
    const request = { operation_id: operation, ...p.base, payment_method: p.create ? "gateway" : "cod", reason: "customer_cancelled",
      ...(p.create ? { provisioning: { create_command_id: p.create, saga_id: p.saga } } : {}), ...over };
    return { callerId, commandId: `cancel:${operation}`, request };
  };
  // Every returned result must pass A's own strict v1 result validation.
  const valid = (kind, input, result) => financialResult(kind, input.commandId, financialRequest(kind, input.commandId, input.request), result);
  const ledger = async (orderId) => (await db.query("SELECT kind, amount_cents, status FROM transactions WHERE order_id=$1 ORDER BY id", [orderId])).rows;
  const wallet = async (providerId) => (await db.query("SELECT balance_cents, commission_owed_cents FROM provider_wallets WHERE provider_id=$1", [providerId])).rows[0];
  // Alternate which side starts first (plus a small random head start) so both orders really occur.
  const race = (round, a, b) => {
    const later = (fn) => new Promise((r) => setTimeout(r, 1 + randomInt(0, 6))).then(fn);
    return Promise.allSettled(round % 2 ? [a(), later(b)] : [later(a), b()]);
  };
  const isCoded = (code) => (error) => error instanceof HttpError && error.statusCode === 409 && error.code === code;

  await t.test("gateway completion waits for a real settled charge, then credits the payout once", async () => {
    const orderId = newOrder();
    const p = await provision(orderId);
    const input = completion(p);
    let out = await fin.complete(input);
    valid("completion", input, out.result);
    assert.deepEqual([out.replayed, out.result.state, out.result.reason], [false, "pending", "awaiting_settlement"]);
    assert.deepEqual(await ledger(orderId), [], "no payout from a merely existing intent");
    out = await fin.complete(input);
    assert.equal(out.result.state, "pending", "same key re-evaluates, still pending");
    assert.equal((await fin.get(input)).state, "pending");
    await settle(p.intent);
    out = await fin.complete(input);
    valid("completion", input, out.result);
    assert.equal(out.result.state, "ready");
    assert.deepEqual([out.result.accounting.kind, out.result.accounting.amount_cents], ["payout_credit", 10700 - 1070]);
    const replay = await fin.complete(input);
    assert.deepEqual(replay, { replayed: true, result: out.result }, "terminal result replays unchanged");
    assert.deepEqual((await ledger(orderId)).map((r) => r.kind), ["charge", "payout_credit"]);
    assert.equal((await wallet(p.base.provider_id)).balance_cents, 9630);
    assert.deepEqual(await fin.get(input), out.result);
    assert.equal(await fin.get({ callerId: `${callerId}:other`, commandId: input.commandId }), null, "lookup is caller-scoped");
  });

  await t.test("COD completion records commission once; changed request or second key is a coded conflict", async () => {
    const orderId = newOrder();
    const p = { base: ctx(orderId) };
    const input = completion(p);
    const out = await fin.complete(input);
    valid("completion", input, out.result);
    assert.deepEqual([out.result.state, out.result.accounting.kind, out.result.accounting.amount_cents], ["ready", "commission_owed", 1070]);
    await assert.rejects(fin.complete({ ...input, request: { ...input.request, commission_cents: 999 } }), isCoded(CODES.COMMAND_CONFLICT));
    await assert.rejects(fin.complete(completion(p)), isCoded(CODES.COMMAND_CONFLICT), "another completion key for the same order");
    assert.deepEqual(await fin.complete(input), { replayed: true, result: out.result }, "the stored result was not overwritten");
    assert.deepEqual((await ledger(orderId)).map((r) => r.kind), ["commission_owed"]);
    assert.equal((await wallet(p.base.provider_id)).commission_owed_cents, 1070);
  });

  await t.test("cancel unpaid gateway: void + fence; late settle/activate/create and completion are all refused", async () => {
    const orderId = newOrder();
    const p = await provision(orderId);
    const input = cancellation(p);
    const out = await fin.cancel(input);
    valid("cancellation", input, out.result);
    assert.deepEqual([out.result.state, out.result.outcome, out.result.settlement_fenced, out.result.voided_intent_id], ["ready", "voided", true, p.intent.id]);
    assert.deepEqual(await fin.cancel(input), { replayed: true, result: out.result });
    await assert.rejects(settle(p.intent), (e) => e.statusCode === 409);
    assert.deepEqual(await ledger(orderId), [], "no charge after the fence");
    await assert.rejects(participant.activate({ callerId, commandId: `activate:${randomUUID()}`, request: { create_command_id: p.create, saga_id: p.saga } }), isCoded(SETUP_CANCELLED));
    const late = completion(p);
    const done = await fin.complete(late);
    valid("completion", late, done.result);
    assert.deepEqual([done.result.state, done.result.reason], ["attention", "cancellation_fenced"]);
    await assert.rejects(fin.cancel(cancellation(p)), isCoded(CODES.COMMAND_CONFLICT), "a second cancellation key");
  });

  await t.test("cancel after settlement refunds exactly once and fences further activation", async () => {
    const orderId = newOrder();
    const p = await provision(orderId);
    await settle(p.intent);
    const input = cancellation(p);
    const out = await fin.cancel(input);
    valid("cancellation", input, out.result);
    assert.deepEqual([out.result.outcome, typeof out.result.refund_transaction_id], ["refunded", "number"]);
    assert.deepEqual(await fin.cancel(input), { replayed: true, result: out.result });
    assert.deepEqual((await ledger(orderId)).map((r) => r.kind), ["charge", "refund"]);
    await assert.rejects(participant.activate({ callerId, commandId: `activate:${randomUUID()}`, request: { create_command_id: p.create, saga_id: p.saga } }), isCoded(SETUP_CANCELLED));
  });

  await t.test("absent-create cancellation fences the late create; COD cancellation is no_payment", async () => {
    const orderId = newOrder();
    const p = { base: ctx(orderId), create: `create:${randomUUID()}`, saga: `saga:${randomUUID()}` };
    const input = cancellation(p);
    const out = await fin.cancel(input);
    valid("cancellation", input, out.result);
    assert.equal(out.result.outcome, "no_payment");
    await assert.rejects(participant.create({ callerId, commandId: p.create, request: { ...p.base, saga_id: p.saga } }), isCoded(SETUP_CANCELLED));
    await assert.rejects(participant.create({ callerId, commandId: `create:${randomUUID()}`, request: { ...p.base, saga_id: p.saga } }), isCoded(SETUP_CANCELLED), "even under another create key");
    assert.equal((await db.query("SELECT 1 FROM payment_intents WHERE order_id=$1", [orderId])).rowCount, 0);

    const codOrder = newOrder();
    const cod = cancellation({ base: ctx(codOrder) });
    const codOut = await fin.cancel(cod);
    valid("cancellation", cod, codOut.result);
    assert.equal(codOut.result.outcome, "no_payment");
  });

  await t.test("cancellation versus completion: accounted -> attention (no fence); in-flight -> blocked (not stored)", async () => {
    const codOrder = newOrder();
    const cod = { base: ctx(codOrder) };
    await fin.complete(completion(cod));
    const late = cancellation(cod);
    const out = await fin.cancel(late);
    valid("cancellation", late, out.result);
    assert.deepEqual([out.result.state, out.result.reason], ["attention", "completion_accounted"]);
    assert.equal((await db.query("SELECT 1 FROM financial_fences WHERE order_id=$1", [codOrder])).rowCount, 0);

    const gwOrder = newOrder();
    const gw = await provision(gwOrder);
    await fin.complete(completion(gw)); // pending awaiting_settlement
    const blocked = cancellation(gw);
    await assert.rejects(fin.cancel(blocked), isCoded(CODES.OPERATION_BLOCKED));
    assert.equal(await fin.get(blocked), null, "a blocked command is not stored");
    assert.equal((await db.query("SELECT status FROM payment_intents WHERE order_id=$1", [gwOrder])).rows[0].status, "requires_payment");
  });

  await t.test("wrong provisioning references -> context_mismatch; legacy intent -> legacy_reconciliation_required", async () => {
    const orderId = newOrder();
    const p = await provision(orderId);
    const wrong = cancellation(p, { provisioning: { create_command_id: p.create, saga_id: "saga:someone-else" } });
    const out = await fin.cancel(wrong);
    valid("cancellation", wrong, out.result);
    assert.deepEqual([out.result.state, out.result.reason], ["attention", "context_mismatch"]);
    assert.equal((await db.query("SELECT status FROM payment_intents WHERE order_id=$1", [orderId])).rows[0].status, "requires_payment", "nothing voided");
    const amount = completion(p, { amount_cents: 1 , commission_cents: 0 });
    assert.equal((await fin.complete(amount)).result.reason, "context_mismatch");

    const legacyOrder = newOrder();
    await business.prepareIntent(ctx(legacyOrder)); // imported/legacy intent: no provisioning row
    const legacy = cancellation({ base: ctx(legacyOrder), create: `create:${randomUUID()}`, saga: `saga:${randomUUID()}` });
    const legacyOut = await fin.cancel({ ...legacy, request: { ...legacy.request, provider_id: (await db.query("SELECT provider_id FROM payment_intents WHERE order_id=$1", [legacyOrder])).rows[0].provider_id } });
    assert.deepEqual([legacyOut.result.state, legacyOut.result.reason], ["attention", "legacy_reconciliation_required"]);
  });

  await t.test("a failing money effect rolls back the command, fence and provisioning change together", async () => {
    const orderId = newOrder();
    const p = await provision(orderId);
    await settle(p.intent);
    const broken = createFinancialOperations({ database: db, business: { ...business, applyRefund: async () => { throw new Error("simulated database failure"); } } });
    const input = cancellation(p);
    await assert.rejects(broken.cancel(input), /simulated/);
    assert.equal(await fin.get(input), null);
    assert.equal((await db.query("SELECT 1 FROM financial_fences WHERE order_id=$1", [orderId])).rowCount, 0);
    assert.deepEqual((await ledger(orderId)).map((r) => r.kind), ["charge"]);
    const out = await fin.cancel(input); // the same key then succeeds
    assert.equal(out.result.outcome, "refunded");
  });

  await t.test("different completion keys queued on the same order yield ready plus coded409, never500", async () => {
    const orderId=newOrder(),p={base:ctx(orderId)};
    const inputs=[completion(p),completion(p)];
    const http=createPaymentsRuntime({database:db,createFinancialOperations,
      authenticate:async()=>{throw new HttpError(403,"not a user flow");},
      authenticateService:async()=>({service:"booking",callerId}),
    });
    const server=http.app.listen(0,"127.0.0.1");await new Promise(resolve=>server.once("listening",resolve));
    let release,held;
    const heldPromise=new Promise(resolve=>held=resolve),releasePromise=new Promise(resolve=>release=resolve);
    const holder=db.withTransaction(async tx=>{
      await tx.query("SELECT pg_advisory_xact_lock(42801,$1::integer)",[orderId]);
      held();await releasePromise;
    });
    try {
      await heldPromise;
      const calls=Promise.all(inputs.map(input=>fetch(`http://127.0.0.1:${server.address().port}/internal/booking-completions`,{
        method:"POST",headers:{Authorization:"Bearer booking-fixture","Content-Type":"application/json","Idempotency-Key":input.commandId},body:JSON.stringify(input.request),
      })));
      try {
        const deadline=Date.now()+1500;let queued=0;
        do {
          queued=(await db.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND classid=42801::oid AND objid=$1::oid AND NOT granted",[orderId])).rows[0].n;
          if(queued<2)await new Promise(resolve=>setTimeout(resolve,10));
        } while(queued<2&&Date.now()<deadline);
        assert.equal(queued,2,"both transactions must wait on the real order lock before release");
      } finally {release();await holder;}
      const responses=await calls,body=await Promise.all(responses.map(response=>response.json()));
      assert.deepEqual(responses.map(response=>response.status).sort(),[200,409]);
      const good=responses.findIndex(response=>response.status===200),conflict=responses.findIndex(response=>response.status===409);
      valid("completion",inputs[good],body[good]);
      assert.equal(body[conflict].code,CODES.COMMAND_CONFLICT);
      assert.equal((await db.query("SELECT count(*)::int AS n FROM financial_commands WHERE order_id=$1",[orderId])).rows[0].n,1);
      assert.equal((await ledger(orderId)).length,1);
      assert.equal((await wallet(p.base.provider_id)).commission_owed_cents,1070);
    } finally {release();await holder;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  });

  await t.test("absent-create cancellation rejects a create key already bound to another order", async () => {
    for(const state of ["created","activated","fenced"]){
      const orderA=newOrder(),orderB=newOrder(),p=await provision(orderA,{activate:state==="activated"});
      if(state==="fenced")await fin.cancel(cancellation(p));
      const before=(await db.query("SELECT * FROM payment_provisioning WHERE order_id=$1",[orderA])).rows;
      const input=cancellation({...p,base:{...p.base,order_id:orderB}}),out=await fin.cancel(input);
      valid("cancellation",input,out.result);
      assert.deepEqual([out.result.state,out.result.reason],["attention","context_mismatch"]);
      assert.equal((await db.query("SELECT 1 FROM financial_fences WHERE order_id=$1",[orderB])).rowCount,0);
      assert.deepEqual((await db.query("SELECT * FROM payment_provisioning WHERE order_id=$1",[orderA])).rows,before);
    }
    // A genuine order-less compensation fence for the same saga remains compatible.
    const p={base:ctx(newOrder()),create:`create:${randomUUID()}`,saga:`saga:${randomUUID()}`};
    await participant.cancel({callerId,commandId:`cancel-setup:${randomUUID()}`,request:{create_command_id:p.create,saga_id:p.saga,reason:"booking_setup_failed"}});
    const input=cancellation(p),out=await fin.cancel(input);valid("cancellation",input,out.result);
    assert.equal(out.result.outcome,"no_payment");
    const bound=(await db.query("SELECT order_id FROM payment_provisioning WHERE caller_id=$1 AND create_command_id=$2",[callerId,p.create])).rows[0];
    assert.equal(bound.order_id,p.base.order_id,"the old order-less setup fence now retains the financial order binding");
    const other=cancellation({...p,base:{...p.base,order_id:newOrder()}}),reused=await fin.cancel(other);
    assert.deepEqual([reused.result.state,reused.result.reason],["attention","context_mismatch"]);
    assert.equal((await db.query("SELECT 1 FROM financial_fences WHERE order_id=$1",[other.request.order_id])).rowCount,0);
    const fresh={base:ctx(newOrder()),create:`create:${randomUUID()}`,saga:`saga:${randomUUID()}`};
    await fin.cancel(cancellation(fresh));
    const wrong=cancellation({...fresh,base:{...fresh.base,order_id:newOrder()}});
    assert.equal((await fin.cancel(wrong)).result.reason,"context_mismatch","a fresh absent-create financial fence cannot be reused on another order either");
  });

  await t.test("race: settlement vs cancellation never ends with an unrefunded charge after a fence", async () => {
    const seen = {};
    for (let round = 0; round < 20; round += 1) {
      const orderId = newOrder();
      const p = await provision(orderId);
      const input = cancellation(p);
      const [settled, cancelled] = await race(round, () => settle(p.intent), () => fin.cancel(input));
      assert.equal(cancelled.status, "fulfilled", String(cancelled.reason));
      const kinds = (await ledger(orderId)).map((r) => r.kind).join("+") || "none";
      const outcome = cancelled.value.result.outcome;
      if (outcome === "refunded") assert.equal(kinds, "charge+refund");
      else { assert.equal(outcome, "voided"); assert.equal(kinds, "none"); assert.equal(settled.status, "rejected"); }
      seen[`${outcome}/${kinds}`] = (seen[`${outcome}/${kinds}`] ?? 0) + 1;
    }
    t.diagnostic(JSON.stringify(seen));
  });

  await t.test("race: completion vs cancellation on a paid booking never produces both payout and refund", async () => {
    const seen = {};
    for (let round = 0; round < 20; round += 1) {
      const orderId = newOrder();
      const p = await provision(orderId);
      await settle(p.intent);
      const [done, cancelled] = await race(round, () => fin.complete(completion(p)), () => fin.cancel(cancellation(p)));
      const kinds = (await ledger(orderId)).map((r) => r.kind);
      assert.ok(!(kinds.includes("payout_credit") && kinds.includes("refund")), kinds.join("+"));
      const label = `${done.value?.result.state ?? done.reason?.code}|${cancelled.value?.result.outcome ?? cancelled.value?.result.reason ?? cancelled.reason?.code}|${kinds.join("+")}`;
      seen[label] = (seen[label] ?? 0) + 1;
    }
    t.diagnostic(JSON.stringify(seen));
  });

  await t.test("through A's real HTTP router: 200 / 202 / 409 attention / 409 coded / GET 200 / GET 404", async () => {
    const http = createPaymentsRuntime({ database: db, createFinancialOperations,
      authenticate: async () => { throw new HttpError(403, "no user flow"); },
      authenticateService: async (req) => { if (req.get("authorization") !== "Bearer booking-fixture") throw new HttpError(401, "bad"); return { service: "booking", callerId }; },
    });
    const server = http.app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    t.after(() => { server.closeAllConnections(); return new Promise((r) => server.close(r)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const send = (path, input) => fetch(base + path, { method: "POST", headers: { Authorization: "Bearer booking-fixture", "Content-Type": "application/json", "Idempotency-Key": input.commandId }, body: JSON.stringify(input.request) });
    const get = (key) => fetch(`${base}/internal/financial-operations/${key}`, { headers: { Authorization: "Bearer booking-fixture" } });

    const cod = completion({ base: ctx(newOrder()) });
    let res = await send("/internal/booking-completions", cod);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).accounting.kind, "commission_owed");
    res = await send("/internal/booking-completions", { ...cod, request: { ...cod.request, commission_cents: 5 } });
    assert.deepEqual([res.status, (await res.json()).code], [409, CODES.COMMAND_CONFLICT]);

    const gw = await provision(newOrder());
    const pending = completion(gw);
    res = await send("/internal/booking-completions", pending);
    assert.deepEqual([res.status, (await res.json()).reason], [202, "awaiting_settlement"]);
    res = await send("/internal/booking-cancellations", cancellation(gw));
    assert.deepEqual([res.status, (await res.json()).code], [409, CODES.OPERATION_BLOCKED]);

    const other = await provision(newOrder());
    const cancel = cancellation(other);
    res = await send("/internal/booking-cancellations", cancel);
    const body = await res.json();
    assert.deepEqual([res.status, body.outcome, body.settlement_fenced], [200, "voided", true]);
    res = await send("/internal/booking-completions", completion(other));
    assert.deepEqual([res.status, (await res.json()).reason], [409, "cancellation_fenced"]);
    res = await get(cancel.commandId);
    assert.deepEqual([res.status, (await res.json()).outcome], [200, "voided"]);
    res = await get(`cancel:${randomUUID()}`);
    assert.equal(res.status, 404);
  });
});

test("factory rejects a business without the required primitives", () => {
  assert.throws(() => createFinancialOperations({ database: { withTransaction() {} }, business: createPaymentsService({ query() {}, withTransaction() {} }) && {} }), /applyCompletion/);
});
