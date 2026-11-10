# E Task5 — crash windows and financial recovery tracing

Continues merged PR58, base main8494aa2. E supplies acceptance/telemetry over
the existing A/B/C/D implementations; this does not claim completion of all D
financial races or historical migration. AI assisted implementation and validation.

## Acceptance boundary

Run the existing fresh16-service runner with both `FINAL_STACK_TELEMETRY=true`
and `FINAL_STACK_FAULTS=true`. The existing full-flow CI now enables both.
No production fault switch, new runtime service, fake issuer, synthetic broker
event, business-state rewrite, forced checkpoint or queue deletion is introduced.
The fault event originates in a real authenticated gateway webhook for a new
booking, using the same real Keycloak/HTTPS/runtime path as ordinary acceptance.

The runner stops only its disposable real relay/consumer, then replaces them
briefly with child Node processes in the owning deployed HTTP containers. Those
processes call the unchanged production relay, confirm publisher, consumer,
inbox and writer libraries against actual RabbitMQ and owning PG databases.
Test-only wrappers kill ONLY the child PID at a confirmed boundary; Docker must
report exit137 and the expected sanitized checkpoint. These are real process
deaths using production protocol/storage code, not a claim that an arbitrary
timing-based kill of the normal PID1 landed at those exact boundaries.

1. Publish confirmed, before outbox mark: original PG event stays unpublished,
   leased and attempts1, with unchanged persisted carrier. Booking still becomes
   paid from the real broker delivery. The real restarted relay reclaims the
   expired lease and publishes the same UUID with attempts2.
2. Notifications SQL effects written, before transaction commit: SIGKILL closes
   the PG connection. Both dedupe and notification must be absent afterward.
   The unacked message is redelivered to the next real consumer process.
3. Notifications transaction committed, before RabbitMQ ack: one dedupe/effect
   must already exist. Restarting the normal independent worker must log a
   duplicate with the same event/trace and leave the effect count at one.
4. After relay restart, both owning queues drain. Jaeger must show distinct first/
   retry producer spans sharing the persisted parent, and normal consumer spans
   parented to each producer. Own-store checks require one charge, one Booking
   dedupe record and one payment notification, despite redelivery/republish.
5. With real Payments down, cancellation becomes pending and slot holds stay.
   Once the failed attempt is actually exported, SIGKILL the real standalone
   Next container, restart it with Payments still down, then restore Payments.
   Autonomous recovery must finish without another cancel request, preserve the
   original command/operation/trace parent, release holds only after acknowledgement,
   and link the final event producer to the Notifications consumer in Jaeger.

No additional retry layer is added around C recovery. D's existing capped jitter,
saved-key semantics, work leases and state transitions are retained. Test waits
observe real checkpoints/delivery/export; they do not force business readiness or
change stored attempt/lease timestamps to manufacture recovery.

## Durable financial-work context

Monolith-owned `booking_work_trace_context` stores only the same allowlisted carrier
as PR58, with a FK to `booking_financial_work.operation_id`. It commits inside the
existing work/business transaction and contains no user/service token, OTP, actor,
baggage or command payload. The exact PR58 fingerprint
`563012fa4064904c7007c7bbdc8bad063e922468702a285fd597793f445a0ee2` gains an
empty table through the existing atomic upgrader. Prior known upgrades still work;
unknown schemas fail closed, old rows are not given invented historical context.
No useful deployment was migrated. Older images need a compatible rollback plan;
never drop metadata/markers to bypass the startup guard.

Each delivery restores the saved parent from ROOT_CONTEXT. New spans use the same
operation/key and a fresh span ID per attempt; pending transport failures mark the
attempt ERROR. Structured delivery logs include bounded correlation fields, not
raw errors/credentials. Background credentials remain the existing Booking service
credential; stored trace context grants no authority. An unrelated active request
cannot become the parent of recovered work. Historical work without a carrier
starts a root with the original operation/key for correlation.

SIGKILL cannot guarantee export of the span active at the instant of death. The
before-commit/before-ack consumer checkpoints deliberately kill inside that active
span; the recovered normal worker provides the completed processing span. The
producer span and the failed financial attempt are observed in Jaeger BEFORE their
respective crash, avoiding a false span-retention claim. Jaeger is still in-memory;
all trace checks occur before the existing whole-stack restart.

## Completion and limits

This is the Task5 retry/redelivery/recovery scope agreed after PR58. Together with
that PR's three normal flows, logs and three dashboard queries, successful local
and hosted acceptance supplies those Task5 checklist items. It does not close
every Area D race/fault, Task6 load/peak8GB/browser/offline/demo/dossier/recording,
historical account/data eligibility or useful-data cutover. Shared activation flags
remain false. See [dated evidence](validation/e-task5-fault-recovery-2026-11-10.md).
