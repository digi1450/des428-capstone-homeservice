# Area B — authentication implementation handoff (work in progress)

## Implemented in this branch

- `services/payments-wallet/src/security/booking-verifier.js`: `createBookingServiceVerifier` and `createGatewayWebhookVerifier` validate RS256 signatures from the configured Keycloak issuer's JWKS, exact issuer, service audience, expiry/time claims, authorized client and service-specific operation roles. Booking and mock gateway are distinct clients and principals. Caller identity is issuer + verified subject, never token/jti.
- `services/{notifications,payments-wallet}/src/security/user-verifier.js`: `createUserVerifier({issuer,audience,resolveIdentity})` verifies the signed Keycloak access token before resolving an immutable legacy identity. No JWT-provided integer ID, user headers, query or body fields are accepted.
- Booking verifier unit fixtures cover signature tampering, invalid claims, wrong client/permission, key refresh and JWKS outage. These are fixtures, not real-Keycloak results.

## Proposed contract — requires A/C/E review

| Caller | Token client (azp) | Target audience | Keycloak client role |
| --- | --- | --- | --- |
| Browser/Next.js user | homeservice-web | notifications-service | user:read |
| Browser/Next.js user | homeservice-web | payments-wallet-service | user:read |
| Booking monolith service account | booking-service | payments-wallet-service | booking:create, booking:query, booking:cancel, booking:activate, booking:complete_financial, booking:cancel_financial, booking:query_financial |
| Offline mock gateway service account | mock-gateway-service | payments-wallet-service | mock-gateway:settle_webhook |

Audience must be explicitly mapped into Keycloak access tokens. Client identity is not a substitute for audience. End-user and service clients must not share credentials. Do not add confidential client secrets to the browser.

## Identity mapping proposal — not activated

The monolith owns customer/provider/admin records and their existing integer IDs. It should also own a unique, immutable mapping from `(issuer, keycloak_sub)` to `(role, domain_id)`, with uniqueness for both the Keycloak identity and the `(role,domain_id)` pair. Only trusted server-side signup/migration/admin provisioning may create or update mappings; self-service profile edits must not.

A server-side resolver must read only the monolith-owned mapping through a reviewed trusted API/delegation boundary, **not** cross-service SQL. Missing or conflicting mapping rejects access. Database outage fails closed. Provision existing accounts through a verified one-time migration, without changing their integer IDs. Do not assume Keycloak UUID equals a legacy integer. A/C must agree how the Next.js cookie/session is replaced with Keycloak login and how Server Components obtain a user-bound token; the existing monolith JWT is not accepted by these verifiers.

The current verifier accepts an injected resolver and is **not** a complete production identity provisioning system. Mapping source, its API and browser login require coordinated review before enabling readers.

## Runtime activation gates

The default service `server.js` files are intentionally unchanged. They still return 503 for protected routes until the real verifier, mapping resolver, C financial operations and coordinated E infrastructure are composed. Do not activate a partial auth/cutover mode.

E must provide a trusted HTTPS issuer reachable from the service containers, real Keycloak realm/clients/roles/audience mappers and secrets through deployment secret management; never commit credentials. The issuer must match the token's `iss` exactly. The current verifier requires HTTPS, including in test deployment; document TLS/trust configuration rather than disabling issuer validation.

## Evidence

- Implemented: standalone verifier modules and synthetic tests.
- Fixture-tested: **not yet executed**; test source committed.
- Real-Keycloak-tested: **not yet**.
- Final-stack-tested: **not yet**.
- Browser/API/Server Component credentials: **not yet implemented**.
- Production runtime injection: **not yet implemented**.

Suggested unit command (with dependencies installed): `node --test services/payments-wallet/test/booking-verifier.test.js`. Run in an isolated environment before reviewing for merge. Follow with actual Keycloak integration, ownership/BOLA tests, token refresh/replay, and A/C/E cutover review.

## Opt-in service wiring added

Both `services/notifications/src/server.js` and `services/payments-wallet/src/server.js` now support explicit `AREA_B_AUTH_ENABLED=true`. With this unset/false the original protected boundaries remain 503. If enabled without required configuration, startup fails rather than silently trusting request headers.

Required **server-only** environment variables:
```dotenv
AREA_B_AUTH_ENABLED=false
KEYCLOAK_ISSUER=https://id.example.test/realms/homeservice
IDENTITY_RESOLVER_URL=https://identity.internal.example.test/internal/resolve
IDENTITY_RESOLVER_TOKEN=replace-with-deployment-managed-secret
```
These are placeholders, **not live values**. Never set the opt-in flag true until the identity owner exposes an authenticated resolver and all service clients/roles are provisioned. The resolver endpoint must accept POST JSON `{issuer,sub}`, return exactly `{role,domainId}` on unique mapping, 404 on missing, 409 on conflict and 5xx on outage; it must reject unauthorized callers and ensure the caller cannot forge a mapping. The resolver must be maintained by the monolith identity owner; it is not implemented by this branch.

The Booking monolith already has `lib/security/service-token.js` for client credentials, but its token provider must be configured for the actual Keycloak client and exercised end-to-end. The legacy `edemand_token` cookie is **not** a Keycloak token and must never be forwarded to these services.

## Added test source (not executed)

- `services/notifications/test/user-verifier.test.js`
- `services/notifications/test/identity-resolver.test.js`
- `services/payments-wallet/test/identity-resolver.test.js`
- `services/payments-wallet/test/gateway-verifier.test.js`

No local runtime or actual Keycloak test results are claimed.

## Monolith identity owner implementation added

- `bangkok-homeservice/lib/security/identity-mapping.js`: a separate, monolith-owned SQLite sidecar binding store. A unique `(issuer,subject)` and unique `(role,domain_id)` prevent rebinds; provisioning checks that the legacy user exists. Existing legacy IDs and the fingerprinted legacy schema are unchanged.
- `bangkok-homeservice/app/api/internal/identity/resolve/route.js`: server-to-server POST with a deployment-managed `IDENTITY_RESOLVER_TOKEN`; only `{issuer,sub}` accepted; 404 on missing, 503 on storage/config failure.
- `bangkok-homeservice/scripts/provision-keycloak-identity.js`: offline administrative provisioning. Example:
  ```sh
  cd bangkok-homeservice
  IDENTITY_MAPPING_DB_PATH=/secure/identity-bindings.sqlite node scripts/provision-keycloak-identity.js \
    https://id.example.test/realms/homeservice keycloak-subject-uuid customer 42
  ```
  This will refuse provisioning unless customer 42 already exists. Back up and protect the sidecar SQLite file; do not publish it or the resolver token.
- Services must use `IDENTITY_RESOLVER_URL=https://<trusted-monolith-host>/api/internal/identity/resolve` (not the placeholder `/internal/resolve` in the earlier example).
- The sidecar is a staged mapping, not an automatic account migration or browser login replacement. Coordinate provisioned accounts with Keycloak `sub` values; legacy login tokens remain distinct.

## CI evidence (2026-11-09)

GitHub Actions **Area B security verification** run 42634091148 completed successfully for both Notifications and Payments Wallet tests. These are Node test suites with synthetic JWT/JWKS fixtures and mock identity responses; this does **not** constitute real-Keycloak or final-stack verification. The new monolith SQLite mapping test was added afterward and has a separate CI run pending. Financial operations from Area C are now composed at Payments startup; cross-team acceptance and database migration still require verification.

**Cutover blockers:** real Keycloak issuer and client credentials, Keycloak service-account/client-role grants, browser authorization-code login and credential forwarding, deployed identity owner endpoint and secret provisioning, full ownership/BOLA matrix, and final E stack integration. Keep `AREA_B_AUTH_ENABLED=false` until these are verified.

## Opt-in browser OIDC flow implemented (not production-validated)

- `GET /api/auth/keycloak/start` generates a state, nonce and S256 PKCE verifier, stores the pending transaction in an AES-GCM authenticated HttpOnly SameSite cookie and redirects to Keycloak.
- `GET /api/auth/keycloak/callback` checks callback origin, state and age; exchanges the one-time code; validates the ID token's RS256 signature, issuer, audience, expiry and nonce; checks the monolith-owned binding; then issues a short-lived encrypted HttpOnly session.
- `POST /api/auth/keycloak/logout` clears local OIDC cookies. This is **not** Keycloak global logout or token revocation.
- `lib/security/oidc-server-session.js` supplies a **server-only** Authorization header for Next server-side service calls. It is not a client/browser token endpoint.
- Configuration: `OIDC_LOGIN_ENABLED=true`, `KEYCLOAK_ISSUER`, `OIDC_REDIRECT_URI` (exact public callback URL), `OIDC_SESSION_SECRET` (at least 32 random characters), `IDENTITY_MAPPING_DB_PATH`. Deploy over HTTPS; the callback URI must be allowlisted in Keycloak.
- Browser session is intentionally capped to ten minutes and **does not implement refresh-token rotation**. Existing legacy login is not replaced. Application pages/API handlers must explicitly adopt the new session; legacy JWT and Keycloak sessions are not interchangeable.
- Test source: `bangkok-homeservice/test/oidc-session.test.js`. The CI workflow now runs the new tests. Real TLS/Keycloak and full E stack remain external acceptance gates.
