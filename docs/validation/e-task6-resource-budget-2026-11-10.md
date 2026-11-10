# Task6 resource budget — 10 November 2026

Base main84f2542 (includes merged Task5 PR61 and C PR59/60). Actual local run on
`feat/e-task6-resource-budget`, new project `homeservice-e-auth-task6-budget`.
AI assisted measurement/implementation/validation. Shared flags stayed false;
the disposable copy alone enabled auth/telemetry/fault/resource flags. Useful
data, existing realms, host CA/DNS, Docker/WSL settings and unrelated stacks were
unchanged. Task-only containers were stopped afterward with volumes retained.

## Result: PASS for the declared runtime workload/budget

**39 actual16-service assertion groups passed; process exit0.**
The Docker host had16,376,291,328 bytes RAM and16 CPUs, cgroupfs/v2. This is NOT
an entire8GB physical-machine or OS/build-memory measurement. The budget uses
enforced per-service caps, measured raw memory and an explicit reserve as defined
in [the predeclared method](../e-task6-resource-budget-handoff.md).

| Measure | Observed bytes | Decimal GB |
|---|---:|---:|
| Sampled simultaneous aggregate peak (includes cache) |2,430,230,528|2.430|
| Sum of each service's kernel high-water mark (conservative) |2,813,542,400|2.814|
| Full observer hard-cap allowance |67,108,864|0.067|
| Explicit host/daemon reserve allowance, not measured OS usage |1,073,741,824|1.074|
| **Conservative measured total + allowances** |**3,954,393,088**|**3.954**|
| Target budget |8,000,000,000|8.000|

All service RAM ceilings sum6,710,886,400 bytes (6.250GiB); with observer/reserve
the configured total is7,851,737,088 bytes. Both measured and configured totals
fit the decimal8GB target. No observed container swap, cgroup OOM/OOM kill,
Docker OOM or automatic restart occurred. Every service had real kernel samples
and every configured healthcheck was healthy after full-stack restart.

The observer collected152 samples across349,380ms, about2.31s/sample including
collection overhead. All required startup/load/financial/recovery/restart phases
were present. The strengthened phase-coverage gate was also run against the saved
data after the run. Kernel peaks complement sampling, rather than claiming a
sampled aggregate captures every instant. Maxima are retained across recreation.

## Actual HTTP/business load

Closed-loop workload,100ms think time, two synthetic authenticated identities;
in-flight work drained before between-stage real Keycloak refresh. Reads rotate
through inbox/wallet/history/booking/identity and server-rendered wallet HTML.

| Stage | Concurrent clients | Requests | Unexpected failures | Actual req/s | p95 ms |
|---|---:|---:|---:|---:|---:|
| Warm20s |5|814|0|40.54|47.87|
| Steady60s |15|5,104|0|84.83|211.63|
| Peak60s |30|5,398|0|89.54|388.71|
| Cooldown20s |5|816|0|40.61|54.70|
| **Total staged reads** | |**12,132**|**0**| | |

Separate financial concurrency2 completed20 distinct real gateway bookings:
10 OTP completions/payouts and10 paid cancellations/refunds, in5,940.71ms;
flow p95=959.42ms. Real Keycloak Gateway credentials/webhook, automatic relay and
paid-event delivery were used. Owning Payments PG queries verified exactly one
charge plus one payout/refund for EVERY load order. Broker ready/unacknowledged
counts drained; a fresh post-load trace still reached Jaeger.

All predeclared p95/error/work-count gates passed. Throughput plateaued from
15→30 clients while latency rose; this does not establish unlimited capacity or
linear scaling. The dataset/identities/durations are bounded synthetic acceptance,
not a large production history, long soak or graphical-browser measurement.

## Per-service raw kernel peaks

| Service | Peak MiB | Configured MiB |
|---|---:|---:|
| keycloak |1024.02|1024|
| grafana |256.99|256|
| rabbitmq |253.41|512|
| edemand |153.51|512|
| keycloak-db |139.19|256|
| prometheus |132.26|256|
| notifications (includes load child) |121.21|512|
| payments-wallet |108.49|512|
| notifications-db |107.19|512|
| payments-db |96.04|512|
| jaeger |66.03|512|
| notifications-event-consumer |65.31|256|
| payments-outbox-relay |61.88|256|
| payments-wallet-consumer |60.44|256|
| tls |29.58|128|
| gateway |7.66|128|

Small raw peaks above memory.max are retained honestly, not clipped to configured
values. The [kernel documentation](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html)
describes temporary over-limit usage; OOM/swap/automatic-restart counters remained0.
Jaeger now bounds retained traces at3000; tracing/sampling was not disabled to
reduce load. Old in-memory traces can be evicted, as documented in the handoff.

Normal Task5 trace/dashboard/log checks, all three child-worker SIGKILL checkpoints,
actual Next SIGKILL and autonomous cancellation recovery, broker readiness recovery,
and persistent whole16-service restart/logout all passed while monitoring ran.
No application business/auth/schema/dependency changes were needed for Task6.

## Reviewed artifacts and limits

- [Memory summary](e-task6-resource-budget-2026-11-10-memory.json)
- [Raw numeric samples](e-task6-resource-budget-2026-11-10-samples.jsonl)
- [Load/ledger/backlog summary](e-task6-resource-budget-2026-11-10-load.json)
- [Sanitized assertion transcript](e-task6-resource-budget-2026-11-10.txt)

Production image builds, Compose configuration, JavaScript syntax and diff checks
passed. Full monolith/service suites were not unnecessarily repeated for these
resource/harness-only changes; PR CI covers the relevant existing boundaries and
now repeats Task6 with both Task5 flags, uploading ONLY the three sanitized files.
Hosted results are separate from this local record.

Browser/offline/demo/dossier/recording are separate final-delivery work, not this
Task6 resource-budget title. Historical eligibility/useful-data cutover and broader
D races remain separate. Reserve is an assumption, builds need headroom, and a
larger-host run cannot certify an arbitrary full8GB machine configuration.
