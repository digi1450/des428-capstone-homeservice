# C proposal — legacy gateway bookings after cutover (for A review)

Status: **C proposal, not agreed or implemented.** It answers item 1 of
[legacy rehearsal "What remains"](legacy-cutover-rehearsal-handoff.md#what-remains-before-a-real-cutover):
an auditable legacy binding/eligibility mechanism for old open gateway bookings,
without generated historical command IDs. The format follows the earlier A/C
interface exchange (#24/#25): A reviews, then we confirm a revision before code.

## Problem

New-mode gateway work needs saved provisioning references (`create_command_id`,
`saga_id`) from a COMPLETED saga. An imported legacy gateway intent has none.
Today the result is safe but blocking:

- create/activate return 409, and legacy intents are never adopted;
- the settlement gate refuses (`assertSettlementAllowed` needs `activated`);
- Booking `complete`/`cancel` get 409 ("legacy gateway booking requires financial reconciliation");
- Payments financial commands return attention `legacy_reconciliation_required`.

So after a cutover an open legacy gateway booking could be neither paid, completed
nor cancelled. Terminal history is fine as it is.

## Proposal: an explicit, audited binding created only by the cutover procedure

A **legacy payment binding** is a reviewed, immutable statement that "order N's
imported intent M may be finished by the new protocol". It is produced **once**, by
the same reviewed import step that imports the intent, from the same audited
snapshot manifest. It is never created by request handling, recovery or a retry.

### Cohorts (fixtures in `test_export.py`)

| Cohort | Binding | New-mode behaviour |
|---|---|---|
| 10 gateway completed/paid | none | terminal: Booking refuses complete/cancel; webhooks already deduped/refused |
| 11 gateway cancelled/refunded | none | terminal; late events cannot revive it |
| 12 COD completed | none | terminal; no new commission |
| **13 gateway awaiting/unpaid** | **`open_unpaid`** | the customer can pay the existing intent (settlement allowed); completion waits for the charge; cancellation **voids** and fences |
| **14 gateway confirmed/paid** | **`open_paid`** | completion pays out **once**; cancellation **refunds once** and fences; a repeated webhook stays `already_settled` |
| 15 COD confirmed/open | none needed | already works with v1 (COD has no provisioning); C adds a regression test |
| 16 gateway cancelled/unpaid | none | terminal; callbacks refused (as now) |
| 17 COD cancelled | none | terminal |

Eligibility is decided at import time from the snapshot. An order whose state does
not fit 13/14 exactly (e.g. a payout already exists, a refund exists, or the intent
has failed) gets **no** binding, and future commands stay in attention.

### Payments (C schema, A importer)

Migration `006_legacy_payment_bindings.sql`:

```sql
CREATE TABLE legacy_payment_bindings (
  binding_id      TEXT PRIMARY KEY,         -- 'legacy:' || manifest_sha256[0:16] || ':' || order_id
  manifest_sha256 TEXT NOT NULL,            -- audited export manifest the binding comes from
  order_id        INTEGER NOT NULL UNIQUE,
  intent_id       INTEGER NOT NULL UNIQUE REFERENCES payment_intents(id),
  customer_id INTEGER NOT NULL, provider_id INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL, currency TEXT NOT NULL,
  eligibility     TEXT NOT NULL CHECK (eligibility IN ('open_unpaid','open_paid')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- Written by A's importer **in the same transaction** as the imported intents, and
  only for rows that the exporter classified as 13/14. It is included in the
  identical-replay comparison. There is no runtime INSERT path.
- The binding id is derived deterministically from the manifest and the order,
  and recorded on both sides. It is an audited reference to a reviewed fact, not a
  fabricated historical command key.
- **Settlement gate:** `assertSettlementAllowed` = (provisioning `activated` for
  this intent) **or** (a binding for this intent) — in both cases only when there is
  no `financial_fences` row. Fences win, as now.
- **Participant:** create/activate still refuse legacy intents (unchanged).

### Contract v1.1 (A): one more gateway reference form

A gateway completion/cancellation request carries **exactly one** of:

- `provisioning: { create_command_id, saga_id }` — unchanged v1 form;
- `legacy_binding: { binding_id, manifest_sha256 }` — new.

Payments checks the binding against the order/customer/provider/amount/currency and
then runs exactly the same rules:

- completion is pending until there is a matching succeeded charge, then pays out once;
- cancellation voids an unpaid intent, refunds a paid one once, and always fences.

A missing or mismatching binding gives attention `context_mismatch` (or
`legacy_reconciliation_required` when there is none at all), never an adoption. COD
keeps forbidding both forms. v1 requests stay valid; this is a minor version.

### Booking (C schema + operator CLI, A review)

- `booking_legacy_payment_bindings (order_id PK, binding_id UNIQUE, manifest_sha256)`,
  added through `migrate.js` `UPGRADES` step 3, starting empty.
- An **operator CLI** reads the same audited manifest and fills it after the
  Payments import. The CLI:
  - verifies the manifest hash and that each order is still open in SQLite with the same customer/provider/amount;
  - is idempotent for the identical manifest;
  - refuses a different manifest or any existing financial work/saga on the order;
  - writes nothing else.
- `finalization.js` snapshot: a saga's provisioning refs if present, **else** the
  binding, **else** today's 409. `paymentSetupFor`: a bound open order is `ready`
  (the intent already exists and settlement is allowed).
- Booking's own guards are unchanged. Terminal orders still refuse complete/cancel;
  pending cancellation still keeps holds and blocks transitions.

### Checker (C)

`tools/consistency/c-check.mjs` gains invariants:

- a binding without a matching imported intent;
- a binding whose order also has a saga;
- a Booking binding without a Payments binding (and the reverse);
- a binding on a fenced order that still has an unrefunded charge.

## Alternatives considered

1. **Generate legacy `create_command_id`s and run create/activate** — rejected. It is
   exactly the fabricated identity the handoff forbids, and it would make a fake
   saga history.
2. **Adopt lazily on the first new command** — rejected. There is no audit point,
   and adoption would race with webhooks and cancellations at runtime.
3. **Drain before cutover** (recommended fallback): stop taking new gateway bookings
   in legacy mode, let open ones finish in legacy, and cancel or refund the rest by
   admin action, then cut over with only terminal history. Simple, no new schema, but
   it needs a freeze window and a policy for customers who never pay. If A/lead
   prefer this for the course timeline, C only adds the "no open gateway booking"
   check to the checker.

## Questions for A

1. Binding (this proposal) or drain (alternative 3) for the course timeline?
2. Should the binding live in the importer's apply transaction (proposed), or in a separate reviewed step after import?
3. Is `legacy_binding` as a v1.1 sibling of `provisioning` acceptable, or do you prefer a single tagged `payment_reference`?
4. UI: for a bound open-unpaid order, is "ready" correct, or should it show a distinct "legacy" label?

## Work split if accepted

- **A:** contract v1.1 and fixtures, importer classification and binding insert, replay comparison, client/validation, UI label.
- **C:** migration 006, settlement gate, financial ops reference check, Booking step 3, operator CLI, finalization snapshot, checker invariants, tests for 13/14/15 (including races with webhook and cancel).
- **B:** operator CLI authorization (who may run it).
- **D/E:** rehearsal fault runs.
