# Payment command HTTP preparation — 7 November 2026

Base: `f77114032b2738a1fe9d64661e3940b7d7d4e92b` after importer review. Scope: HTTP/validation/auth+participant seams, existing draft alignment and reserved activation; not a real C command store/fence/eligibility implementation.

## Executed checks

- Targeted HTTP shell tests: 10 passed on host Node 26 before full image-compatible testing. Tests use real Express HTTP and explicit B/C doubles, never SQL or header-trust auth.
- Complete Payments service suite on Node 22 with a dedicated PostgreSQL 16 tmpfs database: **42 passed, 0 failed/skipped**. Includes inherited A/C/E tests and 10 new HTTP tests. No real application DB/server was started.
- Actual prepared monolith client → actual new HTTP shell boundary on Node 22: **3 passed, 0 failed/skipped**. Create/query/cancel DTOs and metadata interoperate; unknown lookup remains UNKNOWN and an unwired runtime produces the existing client's unknown 503 classification. Consumer/provider contract behavior was tested, but C's responses/auth are doubles, not durable or Keycloak proof.
- Contract/schema suite: **17 passed, 0 failed/skipped** on host Node 26, including OpenAPI validation, existing fixtures, dot-key protection and the activation operation having no promised 2xx contract. These are schema tests, not Pact.
- Coverage includes absent integrations, forged/missing/end-user credentials, stable caller scoping at adapter boundary, create201/replay200 chosen by C double, cancellation key distinction, invalid fields/IDs/cents/currency/keys, malformed/oversized/encoded JSON, query hints, 409/503/500 sanitization and rejection of mismatched/private C success payloads.
- Initial full suite found two historical assertions expecting 404 for the then-unmounted create route. Updated them to the new documented fail-closed 503 + Retry-After and retained an unknown-internal-route 404 check. This was an intentional routing behavior change, not a weakened business/auth test. Final suite above passed.
- Isolated project `homeservice-command-http` exposed no host ports and removed its test container/network/tmpfs database after checks. It mounted only the test sources/dependencies needed; root .env and useful application volumes were not used. No useful DB or unrelated Docker project was stopped/reset.
- JavaScript syntax, changed documentation links and whitespace checked. No dependency/migration changes. Full monolith suite was not rerun: monolith runtime source is unchanged; its actual transport was exercised by the boundary tests.

Local Node22 harness: a temporary Compose file started only the fixture PostgreSQL and a node:22-slim runner with Payments source/tests, contract fixtures, integration test and the monolith lib/dependencies mounted read-only. Inside the runner, `npm test` used TEST_DATABASE_URL for that database; `node --test /workspace/tests/integration/payment-command-http-boundary.test.mjs` ran the transport boundary. The temporary fixture credentials were never committed. CI separately runs the service suites and does not replace these new boundary/schema results.

## Remaining limits

Production bootstrap supplies neither authenticateService nor paymentCommands. No real create/query/cancel success is enabled there. Activation remains unavailable even with an arbitrary injected activate function; its response contract and durable recovery still require agreement. No C persistence/fence/race/eligibility/settlement or B real JWT behavior, no wallet provisioning/caller cutover, no AMQP or multi-service business trace, no real data migration and no final stack/resource claim.

See [HTTP integration handoff](../payment-command-http-handoff.md) for exact proposed injected methods and owner responsibilities.
