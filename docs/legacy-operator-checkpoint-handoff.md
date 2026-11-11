# Legacy cutover operator and checkpoint — 11 November 2026

> Current-status note — 12 November2026: [A–E status](current-area-status.md)
> and [actual local cutover](validation/a-local-cutover-2026-11-12.md) supersede
> earlier pending/unmounted/unwired/no-cutover labels in this historical handoff.
> PR73–78 are merged; auth/callers/owners and approved local deployment are integrated.
> Keep the contracts, safety requirements and original test limits below. Shared
> defaults remain gated; this local result does not approve another deployment
> or close D's broader races/browser/offline/submission work.

This implements the **pre-traffic** checkpoint for the step1 legacy v1.1 code
merged in PR73–75. It does not migrate useful data or enable deployment flags.
The selected eventual source is the project's local `bangkok-homeservice/data/edemand.db`.
Treat its WAL as part of the database. Its present contents are not asserted to
be identical to the instructor's original ZIP.

## Authority and owner boundaries

The offline CLI verifies a real Keycloak JWT with issuer/signature/expiry,
audience `homeservice-cutover`, authorized party `homeservice-cutover-operator`
and `cutover:approve_checkpoint` or `cutover:revoke_checkpoint`. Booking/user/
gateway tokens cannot approve migration. The confidential operator client is
separate from application clients; generated secrets remain ignored/private.
Existing realms require an explicit reviewed addition of this client/roles;
editing the import JSON does not update an already initialized realm.

Operator JWT authorization does **not** grant PostgreSQL administration access.
Use independently authorized offline owner connections for migrations/imports
and read-only inspection. Never give the application the operator client secret,
backup files or signing key. Both service databases retain separate credentials.

The CLI verifies the independently pinned manifest and captured owner bundles,
all retained Booking rows/bindings, exact owner migration checksums, all imported
business rows, empty command/recovery/dedupe/outbox work, and broker queues/DLQs
including management-verified unacknowledged counts and disconnected consumers.
One partially imported owner, unknown work or changed context blocks approval.
This is an offline coordinator; application processes do not query another
service's database.

The operator signs a canonical Ed25519 receipt containing snapshot/hash,
reconciled phase digest, backup/freeze digest, operator identity and timestamp.
Booking's local checkpoint is committed first. A missing/partial receipt after
interruption keeps runtime authorization closed; rerun reconciliation before
publishing it. Exact existing approval can be replayed. Runtime reads only the
signed receipt and trusted public key; `state=approved` SQL alone is insufficient.
Deployments trust a selected public key, not one supplied by HTTP callers.

## Freeze and backup are external operator responsibilities

Before using **approve**, close ingress, stop *all* writers/recovery loops,
drain broker queues and disconnect consumers. Inventory non-Compose processes,
sidecars, identity mappings and sessions too. Take a consistent SQLite backup
using the backup API (not the DB file alone while WAL is present), and custom
format PostgreSQL backups **before import**. Preserve identity/session sidecars
and the matching deployment configuration separately. Restore each backup into
a NEW isolated destination and inspect its data before asserting restore success.

The private attestation contains exactly:

```json
{
  "ingress_closed": true,
  "writers_stopped": true,
  "recovery_stopped": true,
  "consumers_disconnected": true,
  "restore_rehearsed": true,
  "backup_set_id": "11111111-1111-4111-8111-111111111111",
  "deployment_config_sha256": "<64 lowercase hex characters>"
}
```

The CLI hashes `source.sqlite`, `payments-before.dump`, and
`notifications-before.dump` from the supplied private backup directory. The
SQLite backup must match the manifest's source backup hash; owner backups must
have the PostgreSQL custom-format header. This records the selected backup set;
it **cannot** prove that arbitrary unknown writers stopped or that an arbitrary
dump restores correctly. Do not fabricate these attestations. There is no
atomic distributed lock spanning SQLite, PostgreSQL and RabbitMQ: the external
freeze is required throughout reconciliation, signing and deployment.

## Operator procedure after final go/no-go

Run with locked dependencies, Python3 and the local CA trusted by Node. Keep
artifact directories0700 and token, attestation, backups and signing key0600.
Use absolute paths outside Git; never upload artifacts as CI evidence.

1. Freeze and back up as above. Export and independently pin the source manifest
   using [export](legacy-manifest-export-handoff.md).
2. Follow [owner preflight/import](import-manifest-preflight-handoff.md) for both
   owners and [Booking binding CLI](legacy-booking-runtime-handoff.md). Dry-run
   first, then separately reviewed apply. CLI import leaves Booking **bound**.
3. Create one deployment key pair in a private directory:

```sh
node tools/cutover/init-key.mjs /absolute/private/signing.key /absolute/private/signing.pub
```

4. Acquire the operator token over trusted HTTPS using the operator client's
   own credentials. Save it privately, not in shell history or command arguments.
   Supply `CUTOVER_KEYCLOAK_ISSUER`, `CUTOVER_PAYMENTS_URL`,
   `CUTOVER_NOTIFICATIONS_URL`, `CUTOVER_AMQP_URL` and
   `CUTOVER_BROKER_MANAGEMENT_URL` through a private environment. The URL
   credentials belong to the offline phase; they are not application JWTs.

```sh
node tools/cutover/cli.mjs --operation inspect \
  --sqlite /absolute/prepared-booking/edemand.db \
  --directory /absolute/private/snapshot --manifest-sha256 "$PINNED_MANIFEST_SHA256" \
  --token-file /absolute/private/operator.jwt

node tools/cutover/cli.mjs --operation approve \
  --sqlite /absolute/prepared-booking/edemand.db \
  --directory /absolute/private/snapshot --manifest-sha256 "$PINNED_MANIFEST_SHA256" \
  --token-file /absolute/private/operator.jwt --freeze-file /absolute/private/freeze.json \
  --backup-directory /absolute/private/backups --key-file /absolute/private/signing.key \
  --public-key-file /absolute/private/signing.pub --receipt-file /absolute/private/checkpoint.json
```

5. While still frozen run the existing read-only checker with **all** sources,
   `--mode quiescent` and all four additional options:
   `--legacy-directory`, `--manifest-sha256`, `--checkpoint-file`,
   `--checkpoint-public-key-file`. Partial options or missing owner/broker
   sources fail. Only a matching signed complete reconciliation clears the
   legacy-bindings pending-checkpoint attention. This exact baseline check is
   not a live post-write reconciliation report.
6. Review source/identity ownership, DB roles, schema versions, configuration,
   routing and restore evidence together. Only then explicitly enable the
   existing authenticated flags. Add `docker-compose.legacy-checkpoint.yml` to
   the authenticated Compose files using `LEGACY_CHECKPOINT_HOST_FILE` and
   `LEGACY_CHECKPOINT_HOST_PUBLIC_KEY_FILE`. Keep the operator originals private;
   make read-only0444 deployment copies of the signed receipt/public key so the
   non-root application UID can read file-based Compose secrets. The signing
   private key and operator JWT stay0600 and are never deployed.
   `LEGACY_BOOKING_HOST_DIRECTORY` must be the reviewed prepared directory with
   `edemand.db` and the reviewed identity/session sidecars. The bind replaces the
   baseline named monolith volume; a missing host directory is rejected. Never
   enable this against an empty/newly seeded or different Booking database.
   Startup also rejects a receipt whose digest has no local approved checkpoint.
   Runtime flags remain false in tracked defaults. Existing Next routes remain
   authenticated BFF callers: the browser's session must be exchanged for the
   appropriate service bearer token. Do not blindly replace those paths with
   direct service proxy routes that would lose the session-to-token bridge.
7. Start owners and authenticated application/worker composition, verify schema,
   readiness, identity ownership and approved legacy reads before reopening
   ingress. Capture sanitized acceptance and owner reconciliation evidence.
   An outage must remain pending/recoverable, never switch back to old SQL.

## Abort and rollback limits

Before any new business effects, stop/drain all application processes again.
Use `--operation revoke` with the same source, attestation, backups, token,
receipt/public key options (no private signing key needed). It rechecks the
original owner/broker phase before marking local state bound and removing the
receipt. Receipt authority is cached at startup: file removal alone does not
stop an already running process. Keep ingress closed until every process stops.

After any money effect/new work/changed data, revoke is rejected. **Do not**
restore old SQLite or old owner dumps over those writes. Roll forward/recover,
or prepare a separately reviewed data-aware reconciliation procedure. An
emergency ingress stop remains available even when logical rollback is refused.

## Evidence and remaining gates

The portable disposable rehearsal is `sh tools/cutover/run-rehearsal.sh` after
locked service dependency installation. It builds a Node22 image from only
monolith package/lock files, uses two tmpfs PG owners and an isolated RabbitMQ,
and restores real custom-format dumps into NEW targets. No user DB is mounted.
It covers partial owner apply, denied operator, actual unacked delivery,
context tampering, interrupted receipt publication, replay, new-process reads,
full-source checker, pre-write revoke and post-write rollback refusal.

Real16-service acceptance also obtains tokens from actual Keycloak and verifies
operator/Booking token separation. Synthetic signed-JWT tests remain separate
from that actual issuer evidence. See [validation](validation/a-cutover-checkpoint-2026-11-11.md).

The selected source's private-copy export and both PG import phases passed after
recognizing the historical processed gateway receipt type `payment.succeeded`
with matching settled intent/charge. It is preserved verbatim; the public callback
API still accepts only its current type. Unprocessed historical receipts fail.

**Blocker recorded during checkpoint preparation:** the retained local file uses
36 original schema objects. Current Booking adds14 objects and broker columns
on `events`; the current strict migration correctly refuses this old baseline.
Do not bypass the fingerprint or seed/reset it. A separate exact-schema offline
upgrade must preserve the9 processed legacy events as historical audit, retain
its watermark and prevent replay as fresh broker effects, then reconcile again.
This source-copy finding is not a reason to relax runtime schema acceptance. Subsequent
[original-schema offline preparation](original-booking-upgrade-handoff.md) resolves
this on a separate copy; follow that procedure BEFORE the Booking binding CLI.
Its successful rehearsal is still not actual source cutover approval.

The private-copy preflight does not prove
its final frozen migration or that all historical identities have Keycloak
bindings. Useful-source owner import, identity/session backup and mapping,
final deployment/routing verification, source-specific smoke/recovery checks
and the user's final go/no-go are still required before real cutover. Preserve
those gates even if the preparation PR's CI is green.
