# Area B security verification evidence — 2026-11-09

## Scope and provenance

This record distinguishes independently observed GitHub Actions results from the developer's reported local Keycloak output. It does not assert production or final-stack acceptance.

## CI — independently verified

Commit `7e86af5d2afc806306194b0903496aa4a65d0c39` added `services/payments-wallet/test/area-b-negative-jwt.test.js`.

GitHub Actions associated with this commit returned **completed / success**:
- [Area B security verification, run 42657010125](https://github.com/digi1450/des428-capstone-homeservice/actions/runs/42657010125)
- [Area E service tests, run 42657010072](https://github.com/digi1450/des428-capstone-homeservice/actions/runs/42657010072)
- [Offline legacy migration rehearsal, run 42657010142](https://github.com/digi1450/des428-capstone-homeservice/actions/runs/42657010142)
- [Pact contract tests, run 42657010071](https://github.com/digi1450/des428-capstone-homeservice/actions/runs/42657010071)
- [Financial caller and HTTP boundary, run 42657010170](https://github.com/digi1450/des428-capstone-homeservice/actions/runs/42657010170)

The Area B workflow executes Notifications and Payments Wallet Node test suites, monolith identity/OIDC tests, and a syntax check of the real-Keycloak smoke script. **The workflow does not launch a live Keycloak or prove full-stack integration.**

The new negative JWT fixture test covers missing/malformed/tampered tokens, wrong issuer/audience, expired/future claims, wrong authorized party, unsafe JOSE headers, missing roles, cross-client impersonation, operation isolation, and JWKS unavailability. These are synthetic signed fixtures, not live realm tokens.

## Developer-reported local Keycloak evidence

The developer ran Keycloak 26.4.0 on Docker Desktop behind an Nginx HTTPS proxy, using a local trusted certificate and issuer `https://localhost:8443/realms/homeservice`. Their terminal output showed:
- OIDC discovery issuer matched the HTTPS URL; HTTPS JWKS retrieval succeeded and returned two public keys.
- Both `booking-service` and `mock-gateway-service` service accounts were enabled and their confidential client secrets were available (not printed).
- A PyJWT 2.15.1 script obtained new client-credentials tokens over HTTPS, verified RS256 signatures against the realm JWKS, issuer, Payments Wallet audience, expiry and authorized party.
- Booking had all seven expected operation roles and no gateway webhook role. Gateway had its webhook role and no Booking roles.
- The script finished with `PASS: ALL JWT VERIFICATION TESTS`.

This Python/PyJWT evidence is developer-supplied terminal evidence and is distinct from the repository's Node verifier test below. Neither establishes final-stack or HTTP endpoint acceptance. No credentials or token values are recorded here.

## Developer-reported local repository Node verifier integration — 2026-11-10

The developer ran `python3 run_keycloak_test.py` from the repository root in VS Code on macOS. The local helper checked HTTPS OIDC discovery using `~/homeservice-https/localhost.crt`, retrieved Booking and Gateway client secrets through the local Keycloak container's `kcadm.sh` without printing them, and launched `node infra/keycloak/smoke-real-service-tokens.mjs` with the local CA and live issuer. Their terminal returned to the shell prompt after printing:

```
Running real Keycloak integration test...
PASS: real Keycloak Booking/Gateway issuance, role grants, audience, signature and client isolation
```

The helper propagated the Node process exit status; the prompt returned without a visible error. This is **developer-reported live Keycloak Node integration evidence**, not independently executed by GitHub Actions. The output did not include the separately anticipated `PASS: Area B real Keycloak Node.js integration test` line; do not claim that exact line appeared. The developer also reported local `npm test` for `services/payments-wallet`: **68 total, 57 passed, 0 failed, 11 skipped** (opt-in infrastructure-dependent tests were skipped).

## Developer-reported live Payments Wallet HTTP JWT checks — 2026-11-10

The developer launched a **separate local Node process** inside the existing Payments Wallet container on port `3102`, with `AREA_B_AUTH_ENABLED=true`, the HTTPS Keycloak issuer and `NODE_EXTRA_CA_CERTS` pointing to the locally trusted certificate. The existing service on port `3002` was not reconfigured. A temporary TCP forwarder in the container network namespace routed loopback port `8443` to the local HTTPS proxy; this is **test-only** and not a deployment configuration. The identity resolver was a nonfunctional placeholder; human-user authentication and BOLA were not tested.

Developer terminal output:
- HTTPS discovery from Node: `HTTPS Status: 200`; Node `fetch` JWKS: `JWKS HTTP Status: 200`, `RSA Keys: 2`.
- Auth-enabled test process started and `GET /health/ready` returned `HTTP 200`, `{"service":"payments-wallet","status":"ready"}`.
- Real HTTP `GET /internal/financial-operations/:command_id` without JWT: `PASS: Missing JWT -> HTTP 401`; malformed bearer: `PASS: Malformed JWT -> HTTP 401`.
- After refreshing an expired Keycloak `kcadm.sh` admin session, a local helper obtained **fresh real Booking and Gateway client-credentials JWTs**, without printing secrets or tokens. For a syntactically valid `complete:<UUID>` test command identifier, the observed results were:
  ```
  Requesting real Keycloak service tokens...
  PASS: Booking JWT -> HTTP 404
  PASS: Gateway JWT blocked -> HTTP 401
  ```
- The initial invalid command identifier produced `HTTP 400` for Booking; repository `financialKey()` validation requires `complete:<UUID>` or `cancel:<UUID>`. After correcting the identifier, Booking reached the unknown-command response (404), consistent with authentication/authorization passing, while Gateway remained rejected (401).

These are **developer-reported local live HTTP checks**, not CI results. They demonstrate Booking/Gateway service role isolation at this GET endpoint and fail-closed handling for missing/malformed JWTs. They do **not** establish live user identity resolution, BOLA, successful lookup of an existing financial command, webhook authorization, browser PKCE/refresh, or coordinated multi-service production readiness. No credentials, access tokens or private keys are included.

## Remaining acceptance gates

1. **Local live Node verifier smoke and read-only Payments Wallet HTTP JWT checks completed (developer-reported).** Repeat in coordinated deployment as needed; test a real existing financial command and webhook authorization separately.
2. Run opt-in service HTTP ownership/BOLA tests against a coordinated deployment with real identity bindings and data. Fixture CI tests alone are not enough.
3. Validate browser authorization-code PKCE login, refresh, session and replay behavior against the live realm; avoid claiming replay resistance without evidence.
4. Coordinate final HTTPS hostname/certificate trust **inside service containers** and secret provisioning with Area E. Local TLS/JWKS worked with a temporary loopback TCP forwarder and CA injection; this is not a production-grade service-to-service routing solution.
5. Obtain A/C/E acceptance before enabling opt-in auth or merging. Keep `AREA_B_AUTH_ENABLED=false` until integration gates pass.

No production runtime feature flags or other teams' business logic were changed to produce this evidence.
