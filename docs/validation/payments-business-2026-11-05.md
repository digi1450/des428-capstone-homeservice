# Payments business validation — 5 November 2026

Scope: A's financial business primitives, ledger migration and wallet/history read APIs. Command/fence/saga, real auth and durable broker integration remain pending; no complete payment extraction or public application cutover is claimed.

## Observed final results

| Check | Result |
|---|---|
| Payments tests on host Node 26, isolated real PostgreSQL | 22 passed, 0 failed, 0 skipped |
| Same Payments tests in image Node v22.23.4 with the same isolated PostgreSQL | 22 passed, 0 failed, 0 skipped |
| OpenAPI/fixture suite | 9 passed, 0 failed (3 new wallet/history + 6 existing) |
| Final image build / isolated Compose boot with migrations 001 + 002 | Passed, app and database healthy |
| Deployed health/ready | 200 |
| Deployed wallet/history with forged bearer and role/user headers, verifier absent | 503 for both |
| Deployed internal create intent endpoint | 404, unmounted |
| Deployed public webhook without real verifier | 503, no mutation |

Distinct test total is 31; repeating the Payments suite on Node 22 is not counted twice. Without TEST_DATABASE_URL the six non-database checks passed and two database suites were explicitly skipped. PostgreSQL-enabled runs above contain no skips.

An initial integration run caught an implementation error that copied intent status requires_payment into a charge ledger row. The charge now explicitly writes status succeeded. The final tests exercise settlement, so the failure is corrected rather than suppressed. Additional tests reject incomplete imported receipts and refunds of failed charges.

## Coverage and limits

Tests execute parameterized SQL, actual HTTP reads and real concurrent calls. They cover per-order intent convergence/context conflicts, repeated void/no reactivation, missing-create unknown outcome, owner-only intent reads, explicit provisioning eligibility gating, rollback of intent/charge/receipt AND a same-client SQL event probe on staging failure, webhook replay/changed-payload conflict, offline simulation ownership, wallet provisioning without reset, gateway earnings/COD commission once under replay/concurrency, exact completion payload validation, single full refund and rejected post-refund completion, failed-charge rejection, and supplied-client rollback of wallet/ledger changes. Public ledger projections exclude private context/owner IDs and use ISO dates.

Eligibility/auth callbacks are synthetic test doubles. Event staging writes a temporary SQL probe table in the supplied transaction; it is NOT C's outbox/RabbitMQ implementation. These checks do not establish real Keycloak, absent-create cancellation fences, command-response replay, saga recovery, D's full fault/race rubric, Pact, nginx, traces or the final memory budget. Completion consumes trusted Booking facts; OTP/order state policy stays with Booking.

No monolith source/dependencies/handlers were changed. The monolith's 67-test run belongs to the preceding Notifications slice and was not rerun for this standalone service change. The 135 inherited source hashes remain unchanged. No original rating/wallet/booking behavior is claimed migrated into active public flows yet.

## Reproduction

Use the [Payments handoff](../payments-business-handoff.md) and [service setup](../../services/README.md). Start only the disposable Payments app/database under the homeservice-payments-check Compose project:

```sh
docker compose --env-file services/.env.example -f services/compose.dev.yml -p homeservice-payments-check up -d --build --wait payments-wallet
TEST_DATABASE_URL='postgresql://USER:PASSWORD@127.0.0.1:PORT/DB' npm --prefix services/payments-wallet test
npm --prefix contracts test
```

For Node 22, run the Payments image on that project network, mount its test directory read-only at /app/test and set TEST_DATABASE_URL from the service DATABASE_URL, as in the scaffold validation recipe. Tests delete only their generated ledger/intent/wallet rows and SQL probe table. The validation project is stopped afterward, retaining volumes; no unrelated project is stopped or reset.
