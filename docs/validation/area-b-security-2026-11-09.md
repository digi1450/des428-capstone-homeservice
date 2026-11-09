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

## Remaining acceptance gates

1. **Local live Node verifier smoke test completed (developer-reported).** Repeat in coordinated deployment as needed, with service-container trust and routing.
2. Run opt-in service HTTP ownership/BOLA tests against a coordinated deployment with real identity bindings and data. Fixture CI tests alone are not enough.
3. Validate browser authorization-code PKCE login, refresh, session and replay behavior against the live realm; avoid claiming replay resistance without evidence.
4. Coordinate final HTTPS hostname/certificate trust **inside service containers** and secret provisioning with Area E. `localhost` inside another container does not point to the Mac-host Keycloak proxy.
5. Obtain A/C/E acceptance before enabling opt-in auth or merging. Keep `AREA_B_AUTH_ENABLED=false` until integration gates pass.

No production runtime feature flags or other teams' business logic were changed to produce this evidence.
