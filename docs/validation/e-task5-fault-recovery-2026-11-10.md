# Task5 crash/recovery acceptance — 10 November 2026

Base main8494aa2 (merged PR58), branch `feat/e-task5-fault-recovery`.
AI assisted implementation and verification. Local evidence; hosted CI is separate.

**PASS31 assertion groups** in fresh project `homeservice-e-auth-task5-crashes`.
The real16-service authenticated deployment ran from a fresh source snapshot,
new credentials/realm/SQLite/owning PG databases and normal migrations. Shared
defaults remained false; no useful data, existing realm, host CA/DNS or unrelated
stack was modified. Both FINAL_STACK_TELEMETRY and FINAL_STACK_FAULTS were true,
with FINAL_STACK_KEEP=true for evidence collection. The complete run exited0.

[Sanitized transcript](e-task5-fault-recovery-2026-11-10.txt),
[sanitized effect/trace summary](e-task5-fault-recovery-2026-11-10.json),
[implementation/reproduce/limits](../e-task5-fault-recovery-handoff.md).

## Observed messaging crash windows

The actual authenticated webhook committed payment event
`0ecb3242-14c6-4091-bc99-5d8ac5407696`, trace
`2a9a0ab5fee64cd5bff028cedf40ae65`, while normal relay/Notifications worker
were stopped. Independent child processes used the production libraries and
owning containers' database credentials; every crash required Docker exit137
and a matching checkpoint. No test event was inserted into the broker or DB.

- After real broker confirm and observed exported producer span, SIGKILL before
  the PG publication mark left the original row unpublished, attempts1 and leased.
  Its saved carrier stayed unchanged. Booking still became paid via its own queue.
- SIGKILL after real notification SQL writes, before transaction commit: both the
  dedupe record and notification were absent afterward. The message remained
  deliverable and was handled by a fresh consumer process.
- SIGKILL after real dedupe/effect commit, before ack: one dedupe/effect existed.
  Restarting the normal worker logged duplicate_skipped with the same event/trace,
  leaving exactly one notification.
- Restarting the actual relay naturally reclaimed the expired lease; the same
  event UUID/carrier was marked published with attempts2. Jaeger producer IDs
  `d3fb16f79e2cdabf` and `bb81696f8a2736f2` differed but shared parent
  `c5bfeeec140fdc49`. Normal Notifications processing spans were children of each.
- Own-store queries proved one charge, one Booking dedupe record and one
  payment_received notification. Both owning queues had ready0/unacknowledged0.

## Actual standalone restart recovery

Stopped real Payments, submitted customer cancellation and observed202/pending
with slot holds retained. The failed delivery span was observed in Jaeger before
SIGKILL of the actual standalone Next container. With Payments still down, Next
restart preserved the session/work/holds. Restoring Payments allowed autonomous
cancellation recovery without another cancel request; holds then reached0.

Trace `0dce4f1d23c4464799f5758398f077bf` preserved operation
`549c5699-d817-4825-8d78-7d43ac25c10b`, command
`cancel:549c5699-d817-4825-8d78-7d43ac25c10b` and parent `cd1f422547ae0157`.
The observed failed span `289c1344053030d4` had ERROR/pending; recovered span
`e5c5a042064eac2f` was ready. Three delivery spans were observed in this run;
that count is timing-dependent, not a fixed test expectation. The final monolith
producer and Notifications processing span continued the same trace.

All prior normal flows, dashboard/log assertions, financial replay owner counts,
RabbitMQ readiness200→503→200 and whole16-service persistent restart/logout checks
also passed. Every configured healthcheck was healthy at completion; all16 reported
OOMKilled=false. This is functional acceptance, not load/peak8GB evidence. The
task-only containers were stopped afterward with their volumes retained.

## Regression and diagnosis

- Full monolith Node20 suite, serial files: **298 passed**,0 failed/skipped.
  Includes four exact historical schema fingerprints and new context-isolation/
  failed-attempt/stable-key/runtime-replacement regression.
- Legacy exporter Python fixture suite with the new metadata table: **17 passed**.
- Production image builds, JavaScript syntax and diff checks passed.
- Initial parallel monolith run hit the inherited100ms financial-client fixture
  timeout; serial execution passed without changing that fixture or retry policy.
- First stack attempt rejected the new booking fixture at08:00 (provider opens09:00).
  Fixed fixture to10:00 on another open day; preserved/stopped that project and ran
  the complete recorded acceptance from fresh stores. No product guard was relaxed.

The test-only wrappers identify exact library checkpoints; they do not claim a
random kill of a normal consumer/relay PID1 necessarily reaches the same window.
An active consumer span can be lost at SIGKILL; recovery's completed normal spans
and explicit checkpoints are used instead. All trace assertions preceded Jaeger's
in-memory restart, so listed IDs are historical evidence, not retention guarantees.
Broader Area D financial races and Task6/load/browser/offline/demos/dossier/recording,
historical eligibility and useful-data cutover remain outside this Task5 scope.
