# A-led B authentication completion and user onboarding

10 November 2026. The lead authorized A to complete the remaining B implementation
and evidence using B's existing interfaces. B remains the academic area owner;
these follow-up fixes/tests are A-led AI-assisted integration work, not a claim
that another member authored or independently verified them.

## Selected account policy

The lead selected: register/authenticate with Keycloak, then fill an application
profile, selecting **customer or provider only**. Admin identities require trusted
administrator provisioning. Existing accounts are bound using the verified issuer,
Keycloak subject and existing integer ID; email is never authority to claim one.

- `OIDC_SELF_REGISTRATION_ENABLED=false` remains the default. Enable only with the
  reviewed authenticated startup/identity deployment and the matching realm settings.
- Customer/provider register pages redirect to Keycloak's PKCE registration endpoint
  only when authenticated composition is selected. Local password login/registration
  HTTP endpoints refuse in that mode; legacy mode keeps the inherited behavior.
- After verified code exchange/ID-token nonce and access-token checks, an unmapped
  user gets a short-lived opaque `homeservice_oidc_onboarding` cookie, backed by the
  encrypted B server session store. They do not get a business-user session yet.
- `/onboarding` displays the signed identity's email and collects profile fields.
  `POST /api/auth/keycloak/profile` requires that onboarding authority, exact same
  origin and a strict schema. It accepts no issuer, subject, domain ID, email,
  password or admin role from the form. Email is metadata from the signed identity;
  it is not used to auto-link an old account. Existing email conflicts require
  administrator review. The pre-existing realm email-verification policy is not
  a new account-linking authority; configure mail verification separately if needed.
- A full OIDC user session is created only after the trusted mapping is confirmed.
  The onboarding ID is atomically consumed; retries cannot create another profile.
  Provider profiles remain unapproved and wallet setup uses C's existing event flow.
- No Keycloak password is copied to SQLite. A random unusable legacy credential
  satisfies the inherited schema, with local password auth disabled in this mode.

## Durable profile/mapping boundary

Profile creation and private `identity.profile_created` work commit in the SAME
monolith SQLite transaction. Provider creation additionally commits the existing
`provider.registered` outbox event in that transaction. No business schema, migration
fingerprint or service-owned PostgreSQL schema is changed.

The private identity work contains issuer/sub/role/domainId and submitted profile
metadata, never tokens/passwords. It is **not a cross-service domain event**:
never add it to `PUBLISHED_TYPES`, RabbitMQ mappings or telemetry payloads.
The monolith-owned sidecar binding commits before the work is marked processed.
If interrupted, callback recovery, a POST retry or the existing A recovery scheduler
finishes the saved work. Delivery is idempotent; a different mapping/role is never
overwritten. Conflicts stay pending for review and do not block other identities.
Use the event ID from sanitized warning logs to inspect the private work offline.
A lost success response can be recovered by signing in again; it does not justify
email-based linking or creating a second profile.

## Real-deployment corrections

- Fresh Keycloak26 import previously referenced missing profile/email/roles scopes
  and omitted access-token subject mapping. The source realm now explicitly defines
  them plus `basic`/`oidc-sub-mapper` for browser/Booking/gateway clients. The browser
  alone receives `user:read` for the two audiences through its protocol mappers.
  No Booking/Gateway/admin privileges are granted to new browser users.
- Source realm enables user registration and refresh rotation/reuse rejection.
  Re-import does not update an existing realm automatically. E/B must apply reviewed
  changes to existing deployments through their admin procedure; do not recreate
  or overwrite a useful Keycloak/H2 container to apply this file.
- Next14's reconstructed Request URL can use the internal listener port behind TLS
  ingress. `oidcRequestUrl` pins the configured callback origin, checks exact Host
  and a single matching X-Forwarded-Proto for the proxy case, and ignores forwarded
  host as authority. E ingress must REPLACE these headers and preserve the external
  port in Host. Arbitrary callback targets/forwarded chains are not accepted.
- ID-token JWKS uses `cache: no-store` to avoid Next persistent fetch-cache pinning
  obsolete keys after fresh realm import/key replacement. JWT signature/issuer/
  audience/time/subject checks remain mandatory.
- Initial authorization-code login still requires the original nonce. Refresh may
  omit nonce; if present it must equal the original. This follows
  [OIDC Core12.2](https://openid.net/specs/openid-connect-core-1_0.html#RefreshTokenResponse).
  Subject changes remain forbidden; application session invalidation is not general
  Keycloak access-token/global-session revocation.

## Reproducible actual acceptance

Run `bash tests/live-keycloak/run.sh`. This builds a Node22 locked-dependency image
from source-only files, creates a separate TLS Keycloak26.4.0 realm, two PG16 owners,
RabbitMQ4.1 and compiled Next. No host ports or E final Compose files are changed.
The HTTP cookie-jar driver submits real Keycloak login/registration forms and
executes real token exchanges; it is not a graphical browser test.

The runner repeats after fresh ephemeral stores/new signing keys while preserving
its task-only Next cache volume. Cleanup targets only its own Compose project.
Logs contain assertions/request metadata, not token/cookie/credential dumps. Test
TLS keys and disposable account credentials must never become deployment secrets.

A new CI job runs this acceptance alongside the existing unit/Pact/importer/HTTP
boundaries. See [dated evidence](validation/a-b-live-keycloak-2026-11-10.md).

## Remaining closure gates

E's final deployed TLS/secrets/volumes/ACLs/readiness/resource/tracing integration,
legacy account verification/data checkpoint/cutover, and full D failure/race/defence
acceptance still apply. The test realm, seeded profiles and mock gateway do not
migrate historical users/data or establish whole-project completion.

The inherited monolith still reports six npm audit package entries (one critical,
four high, one moderate); the two service installs report zero in the observed
locked installs. These are registry advisory matches, not six demonstrated exploits.
The suggested fixes include major Next16/Zod4/UUID upgrades. No blind framework or
lockfile upgrade is hidden in this auth PR; dependency remediation needs its own
compatibility review before any production-ready security claim.
