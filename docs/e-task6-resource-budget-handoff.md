# E Task6 — measured8GB runtime resource budget

Continues main84f2542, including Task5 PR61 and C PR59/60. This task is resource
acceptance, not browser/offline/dossier work or useful-data cutover. AI assistance
was used for the harness, measurement and validation.

## Budget declared before the run

- Target: **8,000,000,000 bytes**, deliberately decimal8GB rather than8GiB.
- Actual sixteen-service configured RAM ceilings:6.250GiB =6,710,886,400 bytes.
  Both resource overlays now set `memswap_limit` equal to `mem_limit` on every
  service, disabling extra container swap. Runtime inspection verifies it.
- A64MiB no-network/read-only cgroup observer is outside the16 application services;
  its ENTIRE hard cap is charged to the budget, not just an optimistic reading.
- A1GiB **explicit reserve allowance**, not a measured OS result, is charged for
  the host/daemon. Limits + observer + reserve total7,851,737,088 bytes, below8GB.
  Builds and development tools are excluded and need separate headroom.
- Actual observations must also fit8GB using the sum of each service's kernel
  memory high-water mark + full observer allowance + reserve. No observed swap,
  cgroup OOM/OOM kill, Docker OOM or automatic restart is permitted. All16 must
  have real samples; sampler errors/missing coverage fail acceptance.

The Docker host RAM/CPU/cgroup version are recorded. Running on a larger host
does not simulate an entire8GB physical machine. Passing is evidence for this
declared runtime workload/budget with enforced per-service caps and reserve;
it is not proof of every8GB OS configuration or unlimited production capacity.
The harness never changes Docker/WSL settings or stops unrelated stacks.

## Workload declared before the run

Use the actual fresh authenticated16-service runner with
`FINAL_STACK_TELEMETRY=true`, `FINAL_STACK_FAULTS=true`, and
`FINAL_STACK_RESOURCES=true`. Its existing real Keycloak provisioning/login,
normal/fault fixture operations, worker crashes and full-stack
restart checks remain active. The load driver is a child inside the deployed
Notifications container, so its RAM counts inside that service's hard limit.

Closed-loop HTTP requests with100ms think time, fixed concurrency and a5s request
deadline (not an open-arrival or maximum-throughput model):

| Stage | Concurrent clients | Target duration/work |
|---|---:|---|
| Warm |5|20s mixed reads|
| Steady |15|60s mixed reads|
| Peak |30|60s mixed reads|
| Financial |2|20 distinct real gateway bookings:10 complete/payout,10 paid cancel/refund|
| Cooldown |5|20s mixed reads|

Read mix rotates equally through inbox, provider wallet, customer transaction
history, booking details, identity and server-rendered wallet HTML. These are
repeated sessions for two synthetic seeded identities, not30 distinct humans.
Real Keycloak refresh is performed BETWEEN stages with in-flight work drained;
there is no auth bypass or simultaneous session rotation that manufactures401s.
The driver is an HTTP client, not a graphical browser/JavaScript rendering test.

Each read stage must execute at least10 requests/client, have zero unexpected
HTTP/transport failures and p95<3s. Financial flow p95 must be<15s, with exactly
10 completions/10 refunds and zero failed assertions. These are chosen bounded
acceptance thresholds, not an existing production SLO. Timings include response
body consumption. Own-PG counts must show one charge plus one payout/refund for
each order; broker ready/unacknowledged counts must drain. A fresh post-load trace
must still reach Jaeger. The subsequent existing crash/recovery and full-stack
restart must pass while memory monitoring continues.

## Measurement and observability bounds

An independent host sampler runs while the main runner blocks in Docker commands.
It inspects ONLY containers with the exact disposable Compose project label and
sends those IDs to a64MiB Linux helper with no network, no capabilities, read-only
rootfs and read-only `/sys/fs/cgroup` mount. No Docker socket is given to an app.
Cgroup v2 is required; unsupported counters fail rather than silently substituting
cache-adjusted `docker stats` values. Sampling targets2s plus collection time.
Explicit checkpoints collect before auth recreation, Next kill and whole-stack stop.

The helper reads raw `memory.current`, kernel `memory.peak`, swap and OOM counters.
Raw charges INCLUDE cache. Report sampled simultaneous aggregate peak separately
from the sum of individual service high-water marks: the latter is conservative,
since peaks need not occur simultaneously. Maxima persist across service container
recreation/restarts in the report; intentionally stopped services are not missing
coverage. Samples are grouped by startup/load/fault/recovery/restart phases.

Jaeger1.68's memory store was previously unbounded. `--memory.max-traces=3000`
now bounds its retained recent traces while tracing stays enabled at the existing
sampling policy. This is a retention tradeoff: old traces can be evicted. Normal
Task5 graphs are asserted before load; new post-load/recovery traces are checked
afterward. In-memory retention/persistence is not claimed.
See [Docker memory/swap semantics](https://docs.docker.com/engine/containers/resource_constraints/),
[Docker cache-adjusted stats](https://docs.docker.com/reference/cli/docker/container/stats/)
and [Jaeger memory-store bounds](https://www.jaegertracing.io/docs/1.76/deployment/).
The exact1.68 image's `--help` confirmed `--memory.max-traces` before the run.

## Reproduce and evidence

Prerequisites/safety remain in [the runner README](../tests/final-stack/README.md).
Use a NEW owned project and free ports; never point it at useful databases/realms.

```powershell
$env:FINAL_STACK_TELEMETRY='true'
$env:FINAL_STACK_FAULTS='true'
$env:FINAL_STACK_RESOURCES='true'
node tests/final-stack/run.mjs
```

Private task output contains credentials as before. Only sanitized
`task6-memory-summary.json`, `task6-memory-samples.jsonl` and
`task6-load-summary.json` may be used for reviewed evidence. They contain resource
numbers, synthetic order/trace IDs and status/count/timing aggregates, never
cookies/passwords/tokens/bodies. A passing run does not authorize activation against
useful data or close historical eligibility/cutover. See [dated results](validation/e-task6-resource-budget-2026-11-10.md).
