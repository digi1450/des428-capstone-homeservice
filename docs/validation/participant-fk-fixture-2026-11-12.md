# Payments missing-intent fixture correction — 12 November 2026

Base main `f803fb2` (PR83). The failing push run43185842541 expected FK violation
`23503` in `participant.test.js` but received uniqueness violation `23505` on
`payment_provisioning_intent_id_key`. PR83 only added the Jaeger demo shell script;
Payments runtime, tests and its service workflow were unchanged by that PR.

## Cause and correction

The test read `max(payment_intents.id)+1` and updated its provisioning in a later
statement. Other Node test files use the same disposable PostgreSQL concurrently;
a writer can allocate and bind that supposedly missing ID between the statements.

The FK-negative check now runs on one transaction client. A test-only
`LOCK TABLE payment_intents IN SHARE MODE` precedes candidate selection and stays
held through the failing UPDATE. Concurrent inserts wait until rollback; the
candidate remains absent when FK checking occurs. The same exact `23503` assertion
and the referenced-intent DELETE assertion remain. The transaction helper rolls
back after rejection and releases the lock before other scenarios continue.
No application, migration, constraints, workflow parallelism or error handling changed.

## Observed local validation

A separate Node22/two-connection/PostgreSQL16 probe used the real migrated tables:

1. Original schedule: read the next ID; another connection inserts and binds it;
   updating the first provisioning to that ID yields `23505` deterministically.
2. Corrected schedule: hold SHARE lock, read candidate, launch a competing insert;
   `pg_stat_activity` confirms that writer waiting on a lock. The UPDATE now gives
   `23503`; rollback then lets the writer finish. The original reference is preserved.

The unchanged `npm test` command (`node --test test/*.test.js`) then ran three times
with normal parallel test files, on a fresh database each time. Each run reported
140 tests:138 passed,0 failed,2 skipped. The skipped tests explicitly require
RabbitMQ (wallet consumer and its lifecycle), which this PG-only local run did not
provide. All participant FK and concurrency tests executed.

The first local harness attempt lacked the mount for `tools/cutover/operator.mjs`;
that harness error was corrected before the three successful runs above. It was
not an application failure and no test was removed to obtain a pass.

The PostgreSQL instance was tmpfs, without host ports, on a dedicated network.
Only those test resources were removed. No useful database or running deployment
was modified. Hosted CI must run on the pushed fix; local results do not replace
its result. No rerun of the old failed main run is claimed here.
