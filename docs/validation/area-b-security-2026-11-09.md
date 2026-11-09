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

This is **developer-supplied terminal evidence**, not a run of the repository's Node verifier against the live realm. It must not be described as final-stack or HTTP endpoint acceptance. No credentials or token values are recorded here.

## Remaining acceptance gates

1. Run `node infra/keycloak/smoke-real-service-tokens.mjs` with a Node runtime that trusts the local HTTPS CA, using securely supplied client secrets, to verify the **repository's** verifier against live Keycloak.
2. Run opt-in service HTTP ownership/BOLA tests against a coordinated deployment with real identity bindings and data. Fixture CI tests alone are not enough.
3. Validate browser authorization-code PKCE login, refresh, session and replay behavior against the live realm; avoid claiming replay resistance without evidence.
4. Coordinate final HTTPS hostname/certificate trust **inside service containers** and secret provisioning with Area E. `localhost` inside another container does not point to the Mac-host Keycloak proxy.
5. Obtain A/C/E acceptance before enabling opt-in auth or merging. Keep `AREA_B_AUTH_ENABLED=false` until integration gates pass.

No production runtime feature flags or other teams' business logic were changed to produce this evidence.
