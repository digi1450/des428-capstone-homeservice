# A review of B/C integration — 7 November 2026

Reviewed B PR #26 at `fa162ec83bb4aa027672486af0599bb58499852b`, C PR #27 at `3efd566d386e1b54e6dc27d9e5339b67b450166c`, and the merged A/C interface from #25. C explicitly confirmed #25 in [this comment](https://github.com/digi1450/des428-capstone-homeservice/pull/25#issuecomment-6707477381). That confirms the interface; it does not activate the new runtime.

## C participant and importer review

C now provides actual create/get/cancel/activate command storage, absent-create fence, historical create replay and a settlement eligibility hook. The service startup remains unwired and activation HTTP is still reserved. Monolith activation migration/recovery and wallet delivery are separate pending C work.

A accepts the importer version/guard extension for the reviewed 004 business schema: no imported business columns changed; command/provisioning/Payments inbox tables must remain empty at initial import and at exact business replay. The importer acquires the table locks before its first snapshot read. Added tests explicitly seed each of those three tables and verify dry-run/apply rejection, unchanged business rows, retained participant state and unchanged identity counters. Legacy imported unpaid intents remain ineligible until a separate reviewed A/C cutover plan; this does not authorize replaying old bookings or enabling them all.

**The FK removal is not accepted as necessary.** The production importer does INSERT/verify/transaction rollback; the failing `TRUNCATE` is in A's disposable test cleanup. This follow-up restores `payment_provisioning.intent_id REFERENCES payment_intents(id)` while retaining UNIQUE, and explicitly includes the referencing table in the fixture-only TRUNCATE. No CASCADE or production reset is added. Real PostgreSQL tests verify that a missing intent reference and deletion of a referenced intent are rejected. A concurrent cross-provisioning reuse test verifies one cancel command commits exactly one fence and the losing transaction rolls back.

This corrects an **unmerged** migration. A fresh disposable test database is required to compare the revised checksum; never edit migration history or reset useful data if an earlier 004 has already been applied somewhere. Such an environment needs an explicitly reviewed forward migration.

The old `payments-boundary` test expected an unknown GET to reach an unmounted 404. Since #22, missing service auth/participant makes that registered route return 503. Update the assertion to require `PaymentOutcomeUnknownError` with the original command identity, `unexpected_status` and upstream 503. The existing injected command HTTP tests still cover a genuine authenticated missing-operation 404/`lookup_missing`; do not change the client to treat all failures as absence or as a fence.

## B delivery review and request to B

The five changed files in #26 add a client-credentials token provider, cache/refresh/single-flight behavior, an opt-in saga configuration wrapper, env placeholders and seven isolated tests. Those tests pass; they do not validate a live Keycloak token. No Payments verifier, checked-in realm/client export or standalone RabbitMQ secret-management plan is included in the PR diff. Any manually configured Keycloak client is not verified by this review. The wrapper is not called by startup; keep that opt-in behavior until integration passes.

B should deliver the **Payments-side** callback already accepted by the router:

```js
// Passed by A's composition root after real validation is implemented by B.
authenticateService(req, { operation })
// -> { service: "booking", callerId: "stable-verified-issuer|service-subject" }
// operation is create | query | cancel | activate.
```

Required behavior/evidence for that delivery:

- Verify the signature against trusted configured Keycloak keys/algorithm, exact expected issuer, audience `payments-wallet-service`, expiry and relevant time claims. Do not trust a token-provided key URL or decoded claims without signature verification.
- Authorize the Booking service identity/client (`booking-service`) and the permission for the requested operation. End-user/admin tokens or tokens for another client must not become service callers just because they have the right audience. B records the actual client/role/scope mapping and audience mapper; a client id alone does not establish audience.
- Return a stable verified issuer/subject-derived callerId across token refresh, never the raw token. Follow the existing seam's 401 invalid-token / 403 unauthorized-service-or-operation behavior; unavailable verification configuration/keys must fail closed without a fake fallback. Keep auth secrets/token bodies out of logs and commits.
- Include negative tests for bad signature, expired token, wrong issuer/audience/client, absent permission and unavailable keys; include valid token refresh/key-rotation behavior and a real Keycloak-to-Payments integration record when available. CI currently runs only the extracted-service suites, not B's new monolith tests.
- **Fix token-endpoint redirects before live use:** `service-token.js` currently omits `redirect: "error"`. A controlled loopback-only HTTP 307 rehearsal confirmed that fetch forwarded a dummy client secret to a second endpoint and accepted its token response. Set an explicit reject-redirect policy and add tests proving a redirect never forwards credentials or populates the cache. No real credentials or external destinations were used.
- Supply a reproducible redacted realm/client configuration or precise setup steps for the audience/permissions and applicable secret-management plan. The vulnerability count in B's message is a reported audit result, not reverified here; attach package/range/advisory evidence and reviewed fixes instead of applying `npm audit fix --force` without compatibility testing.

A has not sent this request to B through an external messaging service or posted a review on either teammate's PR. The team lead can send the link and the request above.

## Ownership and next integration order

1. C reviews/applies this FK/test correction to #27 (or coordinates its merge through this stacked PR). Recheck the updated #27 commit and CI before authorizing its merge. No PR was merged by this review task.
2. B implements the Payments verifier and token-redirect correction above. This is still B's code responsibility; A has not installed a substitute verifier or changed B's branch.
3. A prepares activation route/error-code serialization/client/OpenAPI fixtures and caller/UI integration against the confirmed interface. No duplicate participant store. C provides durable monolith activation migration/state/recovery and wallet delivery.
4. A composes the real B verifier, C participant and settlement/outbox hooks, then verifies actual auth plus create/replay/cancel/activate/races/restarts. Keep Booking's secure wrapper uncalled and server defaults fail-closed until the required pieces and tests are ready.
5. E then verifies the real boundaries with Pact/tracing and the final stack. Broker/IdP wiring, legacy-data eligibility/cutover and the full 8 GB evidence remain separate gates.

Validation details: [A B/C review checks](validation/a-b-c-review-2026-11-07.md).
