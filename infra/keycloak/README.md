# Area B Keycloak baseline — development setup

This is an **importable starting realm**, not an activated production IdP or a complete account migration. It contains no credentials.

## Local trial

1. Start a disposable Keycloak instance (Keycloak 26.x) with a separate test database. For example, from the repository root:
   ```sh
   docker run --rm --name homeservice-keycloak-dev -p 8080:8080 \
     -e KC_BOOTSTRAP_ADMIN_USERNAME=admin \
     -e KC_BOOTSTRAP_ADMIN_PASSWORD=change-me-for-local-test-only \
     -v "$PWD/infra/keycloak:/opt/keycloak/data/import:ro" \
     quay.io/keycloak/keycloak:26.4.0 start-dev --import-realm
   ```
   This **development-only** command uses HTTP, so it is not sufficient for the verifier's trusted HTTPS issuer requirement.
2. In the Keycloak Admin Console, review imported clients, assign `payments-wallet-service` roles `booking:*` only to the `booking-service` service-account user and `mock-gateway:settle_webhook` only to the `mock-gateway-service` service-account user. Assign `user:read` for each API audience only to authorized human users/groups. Never grant service roles to browser users.
3. Confirm the imported audience client scopes appear in access tokens. For each client-credentials token, inspect the signed `azp`, `aud` and `resource_access.payments-wallet-service.roles`. Merely defining roles does not grant them.
4. Set up a stable HTTPS hostname and TLS trusted by both service containers. Configure the verifier issuer to the **exact** `iss` in the access token (for example `https://id.example.test/realms/homeservice`). Do not turn off TLS verification or accept an untrusted JWKS URL.
5. Provision client secrets through environment/secrets management outside Git; rotate them in Keycloak **and** update consuming runtimes. Changing only a local `.env` does not rotate persisted Keycloak credentials.

## Outstanding integration

- The realm export allows only the exact local callback `http://localhost:3000/api/auth/keycloak/callback`; replace it with the reviewed exact HTTPS callback URI before deploying. Wildcard redirects must not be introduced.
- The client-role assignments, browser login/session implementation, confidential server-side credential callback, and monolith-owned `(issuer,sub)->(role,domainId)` mapping are **not provisioned** by this export.
- Both service entrypoints now have opt-in verifier wiring via AREA_B_AUTH_ENABLED=true; they remain disabled by default. Do not enable the cutover or claim Keycloak integration success without testing real signed tokens, ownership/BOLA, refresh, webhook rejection and final Compose.
- E owns final Compose/secret management; A owns browser/Next.js API and Server Component wiring; C owns financial transactions/recovery. B provides verifiers and role contracts.

See `docs/b-authentication-handoff.md`.

## Repeatable service-account role assignments

After authenticating `kcadm.sh` as a realm administrator, run `bash infra/keycloak/assign-service-roles.sh` (set `KCADM` if not on PATH). It grants Booking's seven operation roles and Gateway's one webhook role to their respective service accounts. Audit the resulting effective roles and client scopes before activating; the script does not grant human user roles, configure secrets, or prove tokens have the expected `resource_access`.

## OIDC login status

`bangkok-homeservice/lib/security/oidc-pkce.js` implements cryptographically random state, nonce, S256 PKCE challenge and authorization-code exchange as **server-side primitives only**. A complete browser session flow must verify the ID token signature, issuer, audience, nonce and state; bind tokens to an HttpOnly server session; implement refresh and logout; and preserve the legacy login until migration. The opt-in login routes now exist under `/api/auth/keycloak/`, but remain disabled by default and have not been validated with a live Keycloak realm. See the handoff for callback, refresh and session limitations.

## Human role provisioning and contract test

For an already-created human Keycloak account, authenticate `kcadm.sh` and run `KEYCLOAK_USERNAME=<username> bash infra/keycloak/assign-user-roles.sh`. This grants `user:read` for Notifications and Payments Wallet only; it refuses service-account usernames and does not create credentials or map legacy IDs. Separately provision `(issuer,sub)` using the monolith identity-binding CLI.

The CI contract test `bangkok-homeservice/test/keycloak-realm-contract.test.js` checks client isolation, configured audiences and role names. It does not replace a Keycloak import or signed-token integration test. A deployment still needs actual TLS, reviewed callback URIs, service account credentials and verified token claims.

## Real service-token smoke test (requires external Keycloak)

After importing the realm, granting service-account roles and configuring an HTTPS issuer trusted by Node, run:

```sh
KEYCLOAK_ISSUER=https://your-idp.example/realms/homeservice \\
KEYCLOAK_BOOKING_CLIENT_SECRET=... \\
KEYCLOAK_GATEWAY_CLIENT_SECRET=... \\
node infra/keycloak/smoke-real-service-tokens.mjs
```

Supply secrets via a secure environment/CI secret store, never commit them or run this command with secrets in a shared shell history. The script requests **real** client-credentials access tokens and verifies Booking/Gateway operation roles, audience, issuer, forged-signature rejection, cross-client role isolation and stable Booking caller identity across separately issued tokens. It prints no tokens. A successful run is necessary but not sufficient for full Area B acceptance: user authorization-code login, ownership, expired/wrong-audience real-token HTTP tests, TLS deployment and token refresh still need integration evidence. This script has not been executed against a live Keycloak instance in this branch.
