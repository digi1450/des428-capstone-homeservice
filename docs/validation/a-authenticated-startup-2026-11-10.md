# A authenticated startup validation — 10 November 2026

Source based on main aef42c0 (PR52), task branch feat/a-authenticated-startup.

- Full monolith suite: **282 tests passed, 0 failed, 0 skipped**, including the
  unchanged inherited SQLite bootstrap/preservation tests and new boot/runtime-cell
  and cross-bundle typed-error tests.
- Production Next14.2.35 build passed using Node20 cached Linux native dependencies.
- Actual compiled `next start` smoke passed: valid legacy-cookie401, server-page
  login307, login-to-PKCE-start307, persisted fixture OIDC session API200/pending,
  actual provider wallet RSC200/pending with current-session bearer sent over
  trusted fixture HTTPS, Payments outage503 and removed-binding401.
- Separate actual Next process with acknowledgement=false exited nonzero and
  logged the generic refusal before serving. No shared deployment flag changed.

Commands were run inside disposable Docker containers based on cached image
`homeservice-pr47-48-integration`, with a task-only source snapshot and temporary
SQLite/session/mapping files. Full suite/build/compiled smoke final output:
`/tmp/homeservice-a-startup-final-clean.log`. No host native SQLite addon was loaded.

## Findings corrected during validation

- Module-local selections do not safely cross instrumentation/API/RSC bundles.
  Replaced nine runtime cells with process-owned Symbol registry cells. Duplicate
  module evaluations now observe the same selected instance and reset.
- With those cells shared, compiled Next reproduced a real typed-error defect:
  a Payments fixture503 became public500 because `instanceof AppError` used a
  different bundle's class. Shared the nominal base constructor; the same real
  request now returns503, removed mapping returns401, and forged statusCode-only
  Error objects still return500. Regression output before fix:
  `/tmp/homeservice-a-startup-next-errors.log`.
- Initial smoke's synthetic token lacked mandatory claims and correctly returned
  401; corrected the fixture to the existing session contract (not production auth).
- First test snapshot omitted root fixture contracts/realm files; corrected the
  snapshot layout rather than weakening tests. A reused build container later
  lost a traced dependency path; final suite/build/smoke used a fresh container.

## Evidence limits

The session/token/HTTPS service are explicit fixtures, not Keycloak issuance or
real downstream verification. Broker reconnect attempts target unavailable
loopback; no delivered business event or broker readiness is claimed. No final
8GB measurement, useful-data migration, auth/cutover activation or whole-project
completion is established. The independent existing real-PG/auth boundary remains
in CI; its fixture issuer limit still applies.
