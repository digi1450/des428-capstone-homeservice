# A-led E Task 4: actual authenticated 16-service acceptance

10 November 2026. Base main `d3bef6bab86a582d697b19017a72e0e5ccaa0ad6`
(PR56), with the runtime-image provisioning fix recorded below. The lead asked A
to complete E Task4 so further A integration/cutover work is not blocked by an
unverified deployment. E remains the academic area owner; implementation and this
verification were A-led with AI assistance.

## Result and scope

**PASS for E Task4 in a new disposable deployment.** All sixteen services from the
actual four root Compose files ran together with authenticated mode enabled.
This is the actual Node20 standalone monolith, Node22 Express services, independent
relay/consumer processes, three PG16 owners, persistent SQLite/identity/session
sidecars, RabbitMQ4.1, Keycloak26.4.0, TLS nginx and the monitoring stack. It does
not substitute the smaller PR56 harness or in-process Express listeners.

[Sanitized assertion transcript](a-e-final-stack-2026-11-10.txt).

Run from the repository root with Docker Compose v2, Node22+ and OpenSSL:

```sh
node tests/final-stack/run.mjs
```

The runner copies tracked/nonignored source to a new temporary directory, generates
test-only credentials/certificates, checks disabled defaults, builds the real images
and starts the stack. It explicitly enables auth, cutover, OIDC/signup, both receiving
service verifiers and monolith AMQP **only in that fresh copy's ignored env**.
It submits actual Keycloak HTML forms through HTTPS using a cookie jar; this is
not a graphical browser check. The driver runs inside the already deployed
Notifications container, so it adds no seventeenth runtime service.

The observed successful project was `homeservice-e-auth-final-a`. Useful/shared
application data, realms, Docker settings, host DNS and OS CA trust were untouched.
Dify was temporarily stopped with the lead's explicit permission, preserving its
containers and volumes. After completion, only the acceptance containers/new
volumes were removed and the previously running Dify containers were started
again. Private generated test credentials remain only in the temporary directory.
All faults/restarts below selected only the disposable acceptance project.

## Observed checks

- Disabled-default config:16 services, every service has a memory limit; sum6.250GiB.
- Real Keycloak client credentials, issuer/signature/audience and Booking/Gateway
  permission isolation; trusted CA/DNS and blocked public internal paths.
- Existing seeded identities provisioned by the deployed monolith-owned CLI using
  explicit issuer/subject/role/ID, not email linking or SQL binding shortcuts.
- Real user PKCE login, opaque-session refresh rotation/stale replay rejection,
  anonymous denial and refusal of legacy password login in the selected mode.
- Real Keycloak provider registration/profile, unapproved provider, asynchronous
  `provider.registered` wallet provisioning through the independent broker worker,
  protected wallet/Notifications reads and wallet Server Component HTTP response.
- Actual booking/intent creation and activation, gateway-only webhook and replay,
  automatic outbox relay/paid consumer, cross-customer BOLA denial, provider
  confirm/start/OTP completion and notification delivery.
- Paid cancellation/refund and replay; owning Payments PostgreSQL queries proved
  exactly one charge/payout for the completed booking and one charge/refund for
  the cancelled booking.
- Stopped the actual Payments container: cancellation returned202/pending and
  SQLite slot holds remained. Restarted standalone Next while Payments remained
  down: session and held slots survived. Restoring Payments allowed autonomous
  recovery to cancelled with slots released, without another browser cancellation.
- Stopped/restarted actual RabbitMQ: all three independent workers went
  readiness200 ->503 ->200 and reconnected.
- Prometheus scraped both app targets successfully; Grafana/Jaeger HTTP checks
  passed and actual Notifications consumer spans were present in Jaeger.
  This is not proof of complete root/monolith/wallet trace continuity.
- Stopped and restarted the entire16-service deployment with volumes retained:
  Keycloak, user session/mapping and completed/cancelled bookings persisted,
  logout invalidated the app session, all16 were running and all configured
  healthchecks were healthy.

One non-load `docker stats --no-stream` snapshot of16 containers totaled about
1236.6MiB. After the final restart every container reported `OOMKilled=false` and
`RestartCount=0`. These observations do not establish peak RAM under load or close
E's8GB resource-budget acceptance; the6.250GiB configured ceiling is arithmetic.

## Deployment defect fixed

The original `.next/standalone` runtime omitted
`scripts/provision-keycloak-identity.js` and its source imports. Adding just the CLI
and `lib` reproduced `ERR_MODULE_NOT_FOUND: pino`, because Next bundles that logger
for the web server rather than retaining its external package. The Dockerfile now
includes the existing CLI/lib and installed production dependencies alongside the
standalone server, still non-root. No package versions/locks or public endpoints
changed. This increases runtime image contents/size and should be considered in
E's later offline-image packaging work; no RAM-budget conclusion follows from it.

The final complete run used source files byte-identical to these SHA256 values:

```text
9997681c48b99b9a2eae1f4cc34ddf4e94d05ce790c8114ebc7aa98f8f013377  bangkok-homeservice/Dockerfile
24f42f7f5dd0372e69c9f9dfe71b9a7bc96fec6747ce47eb96337ce69039dbd3  tests/final-stack/run.mjs
0606c6a7736e3413fb0d7d755f265fd613d3f4475a37bbf4b288f016cf60a609  tests/final-stack/driver.mjs
```

Initial attempts caught the missing CLI/dependency, then a test-driver placement
mistake (the driver was inside the intentionally stopped Payments container).
The final driver lives in Notifications. Previous disposable volumes were removed;
the final full run started from fresh stores and completed without manual fixes.

## Still open

E full-flow tracing/log/dashboard review, broader D/E fault/load acceptance,8GB
peak measurement, offline clean-clone packaging and final dossier remain separate.
A historical account verification, legacy eligibility/checkpoint/export/import,
event watermarks and coordinated old-data/caller/writer cutover remain open.
Source deployment flags stay false; this does not authorize activation against an
existing realm/database, claim whole Area A/E closure or add business extractions.
Inherited dependency advisories remain tracked in the Keycloak handoff.
