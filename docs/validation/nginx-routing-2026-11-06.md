# nginx routing preparation — 6 November 2026

Scope: A's prepared gateway configuration, baseline/candidate routing and isolated HTTP fixtures. No live application cutover. Base: `c9d20b76159baa4b762589d5eb1d8ebf4701ebb3` (PR #9 merged).

## Executed checks

From the repository root with Docker Desktop running:

```sh
sh tests/gateway/run.sh
sh -n tests/gateway/run.sh
git diff --check
docker run --rm --entrypoint nginx nginx:1.28-alpine -v
```

- Final fixture run exited 0: **12 tests passed, 0 failed/skipped**: 9 routing/forwarding tests, 2 outage checks, 1 recovery check. An earlier 12-test run also passed; totals do not count repeated runs twice.
- `docker compose ... config --quiet` passed. `nginx -t` passed on baseline and candidate, and again on a newly recreated candidate while Notifications was stopped.
- Actual runtime version: **nginx/1.28.3**, using `nginx:1.28-alpine`. Observed image digest: `nginx@sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236`. Test echo backends/runner used `node:22-alpine`.
- Baseline retained the migrated public paths on monolith; candidate sent notification/payment namespaces to their fixture owners and kept HTML, Next assets, Booking/Bidding, `/api/health` and similar prefixes on monolith.
- Actual HTTP verified unchanged path/query/method/body, bearer/cookie/trace forwarding, single request ID, generated IDs for invalid/missing input, removed identity/Forwarded headers and overwritten proxy metadata.
- 302/400/401/403/404/409/429/500/503 responses retained upstream status/JSON; redirect, cookie and Retry-After were preserved. Internal command paths, including tested encoded/repeated-slash variants, returned gateway 404.
- A fixture accepted a financial-path POST then closed its socket; gateway returned 502 and its request counter remained exactly one (no gateway replay).
- Stopping the Notifications fixture caused candidate inbox 502 without SQLite/monolith fallback. Other routes and gateway liveness stayed available. Candidate nginx could start with that backend absent. After recreating Notifications, the recovery test passed without another gateway reload (about 4.1 seconds for that final check; fixture/DNS timing, not an SLA or real-service latency).
- Runner removed only `homeservice-gateway-test` containers/network on exit. No host ports or volumes were used and no original monolith process/database was started or reseeded.
- SHA-256 comparison with the original source manifest found all 135 inherited monolith files unchanged. Shell syntax and whitespace checks passed; handoff file links/config paths were checked locally.

## Evidence limits

Backends were deliberately simple echo servers, not Next/Express/PostgreSQL/Keycloak/RabbitMQ. This establishes gateway routing and transport behavior only. It does not establish business success, ownership/security under real B auth, C saga/outbox/recovery, D fault rubric, full UI behavior, Pact, OTel spans, CI or the complete stack's 8 GB budget. Passing credential/trace headers is not token validation or a distributed-trace demonstration. Payment mutation HTTP endpoints remain unmounted in the real service, and existing monolith callers/writers still use SQLite.

The inherited monolith/business suites were not rerun because no application code or runtime Compose file changed. Their earlier results remain historical evidence, not a new integrated gateway result. E still owns final root Compose and telemetry; activation requires the [handoff acceptance checklist](../nginx-handoff.md).
