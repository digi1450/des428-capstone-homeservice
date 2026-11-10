# A-led B live authentication/signup evidence — 10 November 2026

Based on PR53 main be230cc, then integrated with E's newer main. This is an actual
isolated integration deployment, not mocked token issuance/JWKS/HTTP/PostgreSQL.

## Observed local acceptance

A source-only Node22 image installed all three package lockfiles and built the
production Next14.2.35 server. Keycloak26.4.0 issued real RS256 tokens over trusted
TLS. The actual A/B/C applications used two owning PostgreSQL16 databases, protected
HTTPS identity resolver, real RabbitMQ4.1 subscriptions and persisted SQLite sidecars.

**11 acceptance groups passed, twice**, with an empty re-imported realm and NEW
signing keys/PG/broker stores between runs while retaining the task's Next cache:

1. Verified-TLS Keycloak discovery.
2. Real authorization-code PKCE, ID-token signature/nonce and issuer/sub mapping
   for two customers and a provider.
3. Unmapped identity confined to onboarding; admin role and cross-origin submission
   refused; customer profile bound once before issuing a full application session.
4. Both services validate real user JWTs via protected HTTPS resolver; Notes BOLA,
   spoofed user headers and a tampered real JWT refused; actual wallet RSC succeeds.
5. Real refresh without nonce, opaque-session rotation, stale local-session replay
   rejection and Keycloak rejection of the rotated refresh token.
6. Real Keycloak self-registration form -> provider profile pending approval ->
   durable provider.registered event -> owning Payments wallet through RabbitMQ.
7. Booking/Gateway/user client-role isolation on the real internal API.
8. Booking create/activate, gateway-only webhook/replay, Rabbit paid-state delivery,
   cross-customer Booking rejection and provider OTP completion; exactly one charge
   and one payout_credit.
9. Paid cancellation replay; exactly one refund and no payout for that booking.
10. Payments outage returns pending and preserves holds. Restarted Next autonomously
    recovers using the same service subject/command and releases holds only after
    safe acknowledgement.
11. Restart preserves mapping/session/booking data; application logout invalidates
    the persisted session.

Logs: `/tmp/homeservice-a-live-oidc/onboarding-live-final.log` and
`reimport-live-final.log`. Image `homeservice-live-oidc-48265-acceptance` built from
`source.tar` under the task's `homeservice-live-oidc.IqVSWC` directory in system temp.
Production source bytes were checked against that archive. Later profile JSON input
bounds were tested separately; all source is also checked by the PR CI suite.

Full monolith **294/294 passed, zero skips** in a serial Node22 run after the
integration services were stopped (`unit-serial-final.log`). Focused auth/signup,
realm and original HTTP saga tests **18/18 passed** (`targeted-final.log`). New
profile input-limit assertions are in `profile-limit-final.log`.

## Defects found and corrected

- Fresh baseline import referenced missing profile/email/roles scopes. It also
  omitted `basic` subject mapping, so a real access token lacked sub and correctly
  failed callback validation. Explicit scopes/subject mapping now support fresh
  imports; fixtures do not patch missing subject claims into real tokens.
- Actual TLS reverse proxy exposed Next's internal Request URL port. Canonical
  configured origin plus exact trusted Host/scheme checks fixes start/callback/
  refresh/logout without accepting arbitrary forwarded-host values. Unit testing
  additionally caught and fixed a default443 URL retaining the internal port.
- Next persistent JWKS fetch-cache retained an obsolete key across fresh realm
  import; actual callback failed unknown signing key. `cache:no-store` fixes this;
  new-key re-import acceptance passes.
- Real refresh ID token omitted nonce. Initial login still requires nonce; refresh
  may omit it but any present nonce must match. Signature/issuer/audience/subject/
  expiry checks remain. See [OIDC Core12.2](https://openid.net/specs/openid-connect-core-1_0.html#RefreshTokenResponse).
- Fixture Rabbit health diagnostics racing as root could create a root-owned
  Erlang cookie before daemon initialization (actual eacces/exit1). The disposable
  broker now runs as rabbitmq with an owned tmpfs and bounded server/CLI threads.
  This was fixed in the test fixture; it is not a claim that E's stack was changed.
- Early parallel local suites hit inherited short HTTP deadlines under Docker
  load. Isolated exact-main baseline and current HTTP saga tests passed; the final
  serial294 run passed without widening production or test deadlines.

## Limits and remaining work

This is an HTTP cookie-jar/form driver, not a graphical browser screenshot test.
Realm/users/data/TLS keys are disposable; no useful Keycloak/H2/profile data or
shared environment was changed. The mock gateway remains the offline course
simulation. E final Compose volumes/secrets/ACLs/readiness/8GB/tracing, historical
account verification, legacy eligibility/checkpoint/cutover and full D acceptance
remain separate closure gates. No global access-token revocation is claimed.

The original monolith npm audit reports six package entries (one critical, four
high, one moderate). Both service locked installs report zero. These are advisory
matches, not validated exploitation findings; major framework/schema-library
remediation requires a separate compatibility review. No dependency versions or
lockfiles changed in this slice. It is not a production-ready security assertion.

## Compatibility with newly merged E work

Integrated main aae5f1d (#54/#55) without dropping E's env/ignore/status/ownership
changes. Added only the default-false signup flag to E's authenticated overlay and
env generator; no infrastructure, ports or credential ownership changed.
A separate temporary preparation/config check passed, retaining explicit basic/
profile/email/roles scopes and disabled signup. The signup startup gate tests
passed9/9 after adding invalid/mixed-mode validation. The final PR CI runs the
combined source, including E's optional worker-readiness callbacks.

## Refresh response review regression

A consumed-ID refresh originally returned401 plus a cookie-clear header. If its
response arrived after another tab's successful rotation, it could erase the new
browser cookie. The new assertion failed before the fix (`stale-cookie-before.log`).
Failure responses now revoke only their original server record and never clear a
possibly newer browser cookie; explicit logout still clears it. Large-session
rotation/replay and signed subject-switch rejection tests passed2/2 afterward
(`stale-cookie-after.log`). This is a session-consistency fix, not global Keycloak
revocation. The actual live CI test also checks that stale response header.

The first GitHub run passed the other14 checks but timed out on fresh Keycloak
discovery before application assertions. Its cold-start wait is bounded at90s
with5s individual discovery attempts and sanitized status/cause diagnostics;
business request deadlines are unchanged. Final exact-head CI determines whether
the repeatable deployment passes.
