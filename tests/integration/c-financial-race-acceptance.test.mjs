// Must be the first import: in-memory SQLite for the Booking interleaving scenario.
import { freshBoot, getDb } from "../../bangkok-homeservice/test-helpers/boot.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createDatabase } from "../../services/payments-wallet/src/database.js";
import { migrate } from "../../services/payments-wallet/src/migrations.js";
import { createPaymentsRuntime } from "../../services/payments-wallet/src/runtime.js";
import { createFinancialOperations } from "../../services/payments-wallet/src/financial/index.js";
import { HttpError } from "../../services/payments-wallet/src/errors.js";
import { run as consistencyCheck } from "../../tools/consistency/c-check.mjs";
import { configureBookingFinancialAccess, resetBookingFinancialAccess, cancelBookingFinancial } from "../../bangkok-homeservice/lib/modules/booking/financial-access.js";
import { createBookingFinalization, resetBookingFinalization, recoverFinalizationOnce } from "../../bangkok-homeservice/lib/modules/booking/finalization.js";
import { createFinancialClient } from "../../bangkok-homeservice/lib/modules/payments/financial-client.js";
import * as booking from "../../bangkok-homeservice/lib/modules/booking/service.js";

// Area C × D: financial race acceptance through the REAL Payments HTTP routes (A's router, strict
// v1/v1.1 validation, C financial operations, settlement gate, PostgreSQL locks). Every request is
// a real concurrent HTTP call; auth is an explicit fixture verifier (B's real verifiers are
// covered by the authenticated-stack suites). Each scenario runs ROUNDS times with alternating
// start order plus a random 0–6 ms head start, for both NEW (saga-provisioned) and LEGACY
// (approved import binding) bookings. After all rounds the read-only C checker must report
// zero violations. Alternating launch order does not guarantee both database winners.
// Opt-in, DISPOSABLE PostgreSQL: TEST_PAYMENTS_DATABASE_URL.
const url = process.env.TEST_PAYMENTS_DATABASE_URL;
const ROUNDS = Number(process.env.C_RACE_ROUNDS ?? 20);
const MANIFEST = "c".repeat(64);
const canonical = (v) => Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v);

// Check the response AND its durable effect: an empty ledger alone is not a safe cancellation.
function assertCancellation(result, entries, hasFence, expectedOutcome) {
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.state, "ready");
  assert.equal(result.body.settlement_fenced, true);
  assert.equal(hasFence, true, "successful cancellation must persist its fence");
  assert.ok(["voided", "refunded"].includes(result.body.outcome), JSON.stringify(result.body));
  if (expectedOutcome) assert.equal(result.body.outcome, expectedOutcome);
  assert.deepEqual(entries, result.body.outcome === "refunded" ? { charge: 1, refund: 1 } : {});
}

test("cancellation evidence rejects failed requests, absent fences and absent refunds", () => {
  const ready = (outcome) => ({ status: 200, body: { state: "ready", settlement_fenced: true, outcome } });
  assert.throws(() => assertCancellation({ status: 500, body: { error: "failure" } }, {}, false));
  assert.throws(() => assertCancellation(ready("voided"), {}, false));
  assert.throws(() => assertCancellation(ready("refunded"), { charge: 1 }, true));
  assert.throws(() => assertCancellation(ready("voided"), { charge: 1 }, true));
});

test("C/D financial race acceptance over real HTTP", { skip: !url, timeout: 120_000 }, async (t) => {
  assert.ok(Number.isInteger(ROUNDS) && ROUNDS >= 2 && ROUNDS <= 31, "C_RACE_ROUNDS must be an integer from 2 to 31");
  const db = createDatabase(url);
  await migrate(db);
  const callerId = `booking-race:${randomUUID()}`;
  const runtime = createPaymentsRuntime({ database: db, createFinancialOperations, legacyManifestSha256: MANIFEST,
    authenticate: async () => { throw new HttpError(403, "no user flow"); },
    authenticateService: async (req) => { if (req.get("authorization") !== "Bearer booking-service") throw new HttpError(401, "bad"); return { service: "booking", callerId }; },
    authenticateWebhook: async (req) => { if (req.get("authorization") !== "Bearer gateway") throw new HttpError(403, "gateway only"); return { service: "mock-gateway", callerId: "gateway-fixture" }; },
  });
  const server = runtime.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await db.close(); });

  const post = async (path, body, { key, token = "booking-service" } = {}) => {
    const res = await fetch(base + path, { method: "POST", body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) } });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const webhook = (intent, eventId = randomUUID()) => post("/api/payments/webhook", { gateway_event_id: eventId, type: "payment_intent.succeeded", gateway_ref: intent.gateway_ref }, { token: "gateway" });
  const command = (kind, ctx) => {
    const op = randomUUID();
    const body = { operation_id: op, ...ctx.base, payment_method: "gateway", ...ctx.reference,
      ...(kind === "completion" ? { commission_cents: 1070 } : { reason: "customer_cancelled" }) };
    const path = kind === "completion" ? "/internal/booking-completions" : "/internal/booking-cancellations";
    const key = `${kind === "completion" ? "complete" : "cancel"}:${op}`;
    return () => post(path, body, { key });
  };

  async function order(origin) {
    const id = randomInt(1600000000, 1700000000);
    const base = { order_id: id, customer_id: 7, provider_id: randomInt(800000000, 900000000), amount_cents: 10700, currency: "THB" };
    if (origin === "new") {
      const create = `create:${randomUUID()}`, saga = `saga:${randomUUID()}`;
      const { result } = await runtime.participant.create({ callerId, commandId: create, request: { ...base, saga_id: saga } });
      await runtime.participant.activate({ callerId, commandId: `activate:${randomUUID()}`, request: { create_command_id: create, saga_id: saga } });
      return { id, base, intent: result.payment_intent, reference: { provisioning: { create_command_id: create, saga_id: saga } } };
    }
    // LEGACY: an imported intent plus its approved binding (as the reviewed importer writes them).
    const intent = await runtime.business.prepareIntent(base);
    const binding = `legacy:${MANIFEST}:${id}`;
    await db.query(`INSERT INTO legacy_payment_bindings (order_id,binding_id,manifest_sha256,intent_id,customer_id,provider_id,amount_cents,currency,eligibility)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'THB','open_unpaid')`, [id, binding, MANIFEST, intent.id, base.customer_id, base.provider_id, base.amount_cents]);
    return { id, base, intent, reference: { legacy_binding: { binding_id: binding, manifest_sha256: MANIFEST } } };
  }
  const ledger = async (id) => {
    const rows = (await db.query("SELECT kind, count(*)::int AS n FROM transactions WHERE order_id=$1 GROUP BY kind", [id])).rows;
    return Object.fromEntries(rows.map((r) => [r.kind, r.n]));
  };
  const fenced = async (id) => (await db.query("SELECT 1 FROM financial_fences WHERE order_id=$1", [id])).rowCount === 1;
  const race = (round, a, b) => {
    const later = (fn) => new Promise((r) => setTimeout(r, randomInt(0, 7))).then(fn);
    return Promise.all(round % 2 ? [a(), later(b)] : [later(a), b()]);
  };
  const tally = {};
  const count = (scenario, label) => { tally[scenario] ??= {}; tally[scenario][label] = (tally[scenario][label] ?? 0) + 1; };

  for (const origin of ["new", "legacy"]) {
    await t.test(`${origin}: webhook × cancellation on an unpaid booking`, async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const o = await order(origin);
        const [hook, cancel] = await race(round, () => webhook(o.intent), command("cancellation", o));
        const l = await ledger(o.id);
        assertCancellation(cancel, l, await fenced(o.id));
        if (cancel.body.outcome === "refunded") {
          assert.equal(hook.status, 200);
          assert.deepEqual([l.charge, l.refund], [1, 1]);
        } else {
          assert.equal(cancel.body.outcome, "voided");
          assert.equal(hook.status, 409, "a late payment is refused after the fence");
          assert.deepEqual(l, {});
        }
        count(`${origin}.webhook×cancel`, `${cancel.body.outcome}/webhook ${hook.status}`);
      }
    });

    await t.test(`${origin}: completion × cancellation on a paid booking (never payout AND refund)`, async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const o = await order(origin);
        assert.equal((await webhook(o.intent)).status, 200);
        const [done, cancel] = await race(round, command("completion", o), command("cancellation", o));
        const l = await ledger(o.id);
        assert.ok(!(l.payout_credit && l.refund), JSON.stringify(l));
        assert.ok((l.payout_credit ?? 0) <= 1 && (l.refund ?? 0) <= 1 && l.charge === 1, JSON.stringify(l));
        if (l.payout_credit) {
          assert.equal(done.status, 200);
          assert.deepEqual(l, { charge: 1, payout_credit: 1 });
          assert.equal(cancel.status, 409);
          assert.equal(cancel.body.reason, "completion_accounted");
          assert.equal(await fenced(o.id), false);
        } else {
          assertCancellation(cancel, l, await fenced(o.id), "refunded");
          assert.equal(done.status, 409);
          assert.equal(done.body.reason, "cancellation_fenced");
        }
        count(`${origin}.complete×cancel`, `complete ${done.status} ${done.body?.reason ?? done.body?.code ?? "ready"} | cancel ${cancel.status} ${cancel.body?.outcome ?? cancel.body?.reason ?? cancel.body?.code}`);
      }
    });

    await t.test(`${origin}: duplicate + distinct webhooks × cancellation (at most one charge)`, async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const o = await order(origin);
        const event = randomUUID();
        const cancel = command("cancellation", o);
        const results = await Promise.all([webhook(o.intent, event), webhook(o.intent, event), webhook(o.intent), cancel()]);
        const l = await ledger(o.id);
        assertCancellation(results[3], l, await fenced(o.id));
        assert.ok(results.slice(0, 3).every((r) => [200, 409].includes(r.status)), JSON.stringify(results));
        const late = await webhook(o.intent);
        assert.equal(late.status, results[3].body.outcome === "voided" ? 409 : 200);
        if (late.status === 200) assert.equal(late.body.already_settled, true);
        assert.deepEqual(await ledger(o.id), l, "late payment must not change the cancelled ledger");
        count(`${origin}.webhooks×cancel`, `${results[3].body.outcome} charges=${l.charge ?? 0}`);
      }
    });

    await t.test(`${origin}: webhook × completion (no payout without a charge; one payout after retry)`, async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const o = await order(origin);
        const complete = command("completion", o);
        const [hook, first] = await race(round, () => webhook(o.intent), complete);
        assert.equal(hook.status, 200, JSON.stringify(hook.body));
        assert.ok([200, 202].includes(first.status), JSON.stringify(first.body));
        let l = await ledger(o.id);
        if (first.status === 202) assert.ok(!l.payout_credit, "pending completion never pays out");
        const retry = await complete(); // same key, as Booking recovery would do
        assert.equal(retry.status, 200, JSON.stringify(retry.body));
        l = await ledger(o.id);
        assert.deepEqual([l.charge, l.payout_credit], [1, 1]);
        count(`${origin}.webhook×complete`, `first ${first.status}`);
      }
    });

    await t.test(`${origin}: the same cancellation key sent 3× concurrently (one effect, identical results)`, async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const o = await order(origin);
        if (round % 2) assert.equal((await webhook(o.intent)).status, 200);
        const cancel = command("cancellation", o);
        const results = await Promise.all([cancel(), cancel(), cancel()]);
        assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.status)));
        // Same content; key ORDER may differ (a replay comes from a JSONB column), so compare canonically.
        assert.equal(new Set(results.map((r) => canonical(r.body))).size, 1, JSON.stringify(results.map((r) => r.body)));
        const l = await ledger(o.id);
        assertCancellation(results[0], l, await fenced(o.id), round % 2 ? "refunded" : "voided");
        const late = await webhook(o.intent);
        assert.equal(late.status, round % 2 ? 200 : 409);
        if (late.status === 200) assert.equal(late.body.already_settled, true);
        assert.deepEqual(await ledger(o.id), l);
        count(`${origin}.cancel×3`, results[0].body.outcome);
      }
    });
  }

  await t.test("Booking interleaving: customer cancellation × provider start (one process, real Payments HTTP)", async () => {
    freshBoot();
    const sqlite = getDb();
    resetBookingFinancialAccess();
    configureBookingFinancialAccess({ bookingFinalization: createBookingFinalization({ financial: createFinancialClient({ baseUrl: base }),
      credentials: async () => ({ token: "booking-service" }), baseBackoffMs: 1, maxBackoffMs: 1 }) });
    t.after(() => { resetBookingFinancialAccess(); resetBookingFinalization(); });
    const customer = sqlite.prepare("SELECT id FROM customers ORDER BY id LIMIT 1").get().id;
    const provider = sqlite.prepare("SELECT id FROM providers ORDER BY id LIMIT 1").get().id;
    for (let round = 0; round < ROUNDS; round += 1) {
      const day = `2028-01-${String(1 + round).padStart(2, "0")}`;
      const id = sqlite.prepare(`INSERT INTO orders (customer_id,provider_id,service_date,starting_time,ending_time,duration_min,subtotal_cents,tax_cents,total_cents,commission_pct,payment_method,otp,status)
        VALUES (?,?,?,'10:00','10:30',30,10000,700,10700,10,'cod',123456,'confirmed')`).run(customer, provider, day).lastInsertRowid;
      sqlite.prepare("INSERT INTO slot_holds (provider_id, service_date, slot_time, order_id) VALUES (?,?,'10:00',?)").run(provider, day, id);
      const start = () => Promise.resolve().then(() => booking.startBooking(id, provider)).then(() => "started", (e) => `refused:${e.statusCode}`);
      const cancel = () => cancelBookingFinancial(id, { role: "customer", sub: customer }).then((r) => `cancel:${r.cancellation_status}`, (e) => `cancel-refused:${e.statusCode}`);
      const [s, c] = await race(round, start, cancel);
      await recoverFinalizationOnce();
      const final = sqlite.prepare("SELECT status FROM orders WHERE id = ?").get(id).status;
      const holds = sqlite.prepare("SELECT count(*) AS n FROM slot_holds WHERE order_id = ?").get(id).n;
      if (final === "cancelled") { assert.equal(holds, 0); assert.equal(s, "refused:409"); assert.equal(c, "cancel:ready"); }
      else { assert.equal(final, "started"); assert.equal(holds, 1); assert.equal(s, "started"); assert.equal(c, "cancel-refused:409"); }
      count("booking.cancel×start", `${final} (${s}, ${c})`);
    }
  });

  await t.test("read-only C checker on Payments after all rounds: zero violations", async () => {
    const { code, summary, output } = await consistencyCheck(["--payments-url", url, "--json"]);
    assert.equal(code, 0, output);
    assert.equal(summary.violations, 0, JSON.stringify(summary.findings));
    t.diagnostic(`checker: ${summary.violations} violations, ${summary.attention} attention, ${summary.pending} pending`);
  });

  t.diagnostic(JSON.stringify(tally));
});
