# A B/C review validation — 7 November 2026

Follow-up to C #27 commit `3efd566` with restored same-service intent FK and updated A regression tests. B #26 commit `fa162ec` was inspected and tested separately; its files were not cherry-picked into C's branch.

| Check | Observed result |
|---|---|
| `sh tools/data-migration/run-tests.sh` | Python exporter 8 pass; Node importer 33 pass, 0 skip. Includes all three added participant/inbox guards for fresh import and exact replay. |
| Payments `npm test`, Node 22 + PostgreSQL 16 disposable tmpfs DB | 57 pass, 0 fail/skip. Includes restored FK checks, cross-provisioning concurrent command reuse and C participant's existing races. |
| `node --test tests/integration/payments-boundary.test.mjs tests/integration/payment-command-http-boundary.test.mjs`, same isolated PostgreSQL harness | 4 pass, 0 fail/skip. Default missing integration returns unknown/503; explicit test-doubles cover real router/client behavior. |
| `npm --prefix contracts test` | 17 pass, 0 fail/skip. |
| B's `service-token.test.js` + `booking-payments-security.test.js` on exact B source, Node 20 test image | 7 pass, 0 fail/skip. Mock responses/configuration only; no real Keycloak. |
| B redirect rehearsal | Two owned loopback HTTP servers; issuer returns 307 to second endpoint. Current provider forwarded a dummy secret and accepted dummy token (`controlled_local_redirect_forwarded_dummy_secret: true`). Servers closed; no actual secret/network destination used. Fix remains assigned to B. |
| `git diff --check` and Markdown references in new handoff | Passed. |

Final participant race rehearsal (12 rounds): 6 fenced/failed/no charge; 6 activated/succeeded/one charge. This is observed isolated concurrency evidence, not live saga recovery or a guarantee based on a fixed probability split.

The FK exception reported by C was reproduced against PostgreSQL in the fixture reset test (error `0A000`): PostgreSQL TRUNCATE requires naming the referencing table even when it is empty. The revised fixture includes it explicitly; production importer INSERT/rollback remains unchanged. No CASCADE, shared DB shortcut or production truncation was introduced.

Service/boundary harness: dedicated `homeservice-c-review` Compose project with Node 22, PostgreSQL 16 tmpfs and a read-only repository mount, no host ports, running the commands above. Migration runner uses its existing `homeservice-migration-test` disposable project. Both projects were removed after checks. B tests mount exact B archive's security modules/tests over the cached Node 20 monolith test image; no Keycloak/containerized full stack was started. Useful databases and the user's untracked document were untouched.

Not run: full-stack Compose, real Keycloak/JWKS or client configuration, real auth/activation flow, root broker/IdP secret setup, audit remediation, live migration/cutover, Pact, cross-service traces or combined memory budget. Green service CI on teammate PRs does not establish those results.
