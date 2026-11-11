# A original-schema follow-up validation — 11 November2026

Branch `feat/a-original-booking-upgrade` follows checkpoint PR76.
All results below are observed local tests; hosted CI/review remain separate.

| Check | Result | Boundary |
| --- | --- | --- |
| Original-schema + checkpoint/CLI rehearsal |13 passed|Node22, isolated PG16 owners and RabbitMQ4.1; exact source/target rejection, changed rows, transactional dry-run/interrupted DDL, archive/counter preservation, replay, CLI source/hardlink refusal and new event watermark|
| Monolith |304 passed|Includes independently pinned PR75 fingerprint and preservation of existing active C events on ordinary additive upgrade|
| Migration |29 Python +44 PG passed|Captured source schema, archive re-export refusal, existing owner data/idempotency checks|
| Standalone consistency checker |11 passed|Actual SQLite/PG/RabbitMQ, existing CLI behavior|
| Legacy HTTP/new-process recovery |1 passed|Actual HTTP/PG financial boundary with fixture authorization|
| Authenticated full stack |passed,16 services|Fresh project `homeservice-e-auth-original-upgrade`, actual Keycloak/roles, selected traces, SIGKILL/redelivery, pending cancellation/recovery, broker recovery and full-stack restart|
| Selected local-source PRIVATE COPY |passed|Both owner dry-run/apply/replay, exact original Booking copy dry-run/upgrade/replay, binding apply/replay, complete owner/broker reconciliation and integrity checks|
| Backup restore |passed|Actual custom-format PostgreSQL backups restored into NEW test targets; no overwrite of post-write owners|

The actual old-main fingerprint `4240ccb2bfcd0dad91265725876872b73250012b59081523e94c6db301654cc0`
was independently recomputed using `schema.js` and `migrate.js` from actual merged
main commit `a1fa7d5`, not inferred only from the new implementation.

The selected-source copy kept all9 processed historical events verbatim in audit,
retained source domain rows/counters and reconciled both owner datasets. It
remained `bound`; no useful-source signing/activation/traffic approval occurred.
No original profile, notification or financial payload is attached here. Source
and owner artifacts stayed private and disposable rehearsal targets were removed.

The16-service run used `FINAL_STACK_TELEMETRY=true` and `FINAL_STACK_FAULTS=true`.
It used fresh fixture accounts/data, not the useful local database. It does not
prove historical Keycloak identity mapping, actual receipt-overlay mounting with
useful data, graphical browser acceptance or8GB peak/load behavior. Recheck the
final frozen source, identities/session sidecars, prepared directory UID/access,
backup/restore and signed operator checkpoint before actual cutover.

The first new-schema regression exposed stale historical test fixtures that left
an added archive object in purported old schemas. Those fixtures were corrected
to reproduce the exact historical schema; the runtime fingerprint guard was not
relaxed. A large binary SQLite assertion was replaced by schema/row/sequence
comparison so rollback failures remain inspectable without oversized binary diffs.
