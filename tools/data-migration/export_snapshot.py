"""Offline, read-only export. Never imports or runs application bootstrap."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import uuid


class ExportError(Exception):
    pass


def require(condition, code):
    if not condition:
        raise ExportError(code)


def require_legacy_only_source(db):
    # This tool moves legacy financial rows, not a distributed checkpoint. Known C
    # state may point at effects held ONLY in Payments or a broker. Never discard it
    # or infer that a terminal saga means all owning databases are represented here.
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    for table in ('booking_sagas', 'booking_saga_transitions', 'booking_saga_activations', 'booking_financial_work', 'processed_events', 'booking_legacy_payment_bindings', 'booking_legacy_payment_checkpoints'):
        if table in tables:
            require(db.execute('SELECT 1 FROM '+table+' LIMIT 1').fetchone() is None,
                    'SOURCE_DISTRIBUTED_STATE_REQUIRES_REVIEW')
    if 'consistency_attention' in tables:
        require(db.execute('SELECT 1 FROM consistency_attention WHERE resolved_at IS NULL LIMIT 1').fetchone() is None,
                'SOURCE_UNRESOLVED_ATTENTION')
    columns = {row[1] for row in db.execute('PRAGMA table_info(events)')}
    conditions = [column+' IS NOT NULL' for column in
                  ('published_at', 'publish_locked_by', 'publish_locked_until', 'publish_last_error') if column in columns]
    if 'publish_attempts' in columns:
        conditions.append('publish_attempts > 0')
    if conditions:
        require(db.execute('SELECT 1 FROM events WHERE '+' OR '.join(conditions)+' LIMIT 1').fetchone() is None,
                'SOURCE_DISTRIBUTED_STATE_REQUIRES_REVIEW')


def canonical_bytes(value):
    # Manifest v1 fields are ASCII and safe integers; owner bundles remain UTF8.
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(',', ':'), allow_nan=False).encode('utf-8')


def legacy_bindings(orders, intents, transactions):
    bindings, counts = [], {}
    for order in sorted(orders.values(), key=lambda r: r['id']):
        owned = [r for r in intents if r['order_id'] == order['id']]
        ledger = [r for r in transactions if r['order_id'] == order['id']]
        require(order['payment_method'] in ('gateway', 'cod'), 'UNKNOWN_PAYMENT_METHOD')
        require(order['status'] in ('awaiting', 'confirmed', 'completed', 'cancelled'),
                'UNCLASSIFIED_LEGACY_ORDER')
        if order['payment_method'] == 'cod':
            require(not owned and order['payment_status'] == 'pending', 'INVALID_COD_HISTORY')
            require(not ledger if order['status'] != 'completed' else len(ledger) == 1 and
                    ledger[0]['kind'] == 'commission_owed' and ledger[0]['status'] == 'succeeded',
                    'INVALID_COD_HISTORY')
            cohort = 'cod_' + order['status']
        else:
            require(len(owned) == 1, 'LEGACY_INTENT_CARDINALITY')
            intent = owned[0]
            kinds = {r['kind']: r for r in ledger}
            paid = order['payment_status'] == 'paid'
            if order['status'] in ('awaiting', 'confirmed'):
                unpaid = (order['status'], order['payment_status'], intent['status']) == ('awaiting', 'pending', 'requires_payment')
                settled = (order['status'], order['payment_status'], intent['status']) == ('confirmed', 'paid', 'succeeded')
                require(unpaid or settled, 'UNCLASSIFIED_OPEN_GATEWAY_ORDER')
                require((not ledger if unpaid else set(kinds) == {'charge'} and
                         kinds['charge']['status'] == 'succeeded' and
                         kinds['charge']['gateway_ref'] == intent['gateway_ref']), 'LEGACY_OPEN_LEDGER_MISMATCH')
                row = dict(order_id=order['id'], intent_id=intent['id'], customer_id=order['customer_id'],
                           provider_id=order['provider_id'], amount_cents=order['total_cents'], currency='THB',
                           payment_method='gateway', eligibility='open_unpaid' if unpaid else 'open_paid',
                           order_status=order['status'], payment_status=order['payment_status'], intent_status=intent['status'])
                if settled: row['charge_transaction_id'] = kinds['charge']['id']
                require(all(type(row[k]) is int and 0 < row[k] <= 2147483646 for k in
                            ('order_id', 'intent_id', 'customer_id', 'provider_id')), 'MANIFEST_ID_RANGE')
                require(type(row['amount_cents']) is int and 0 <= row['amount_cents'] <= 2147483646,
                        'MANIFEST_AMOUNT_RANGE')
                if settled: require(0 < row['charge_transaction_id'] <= 2147483646, 'MANIFEST_ID_RANGE')
                bindings.append(row)
                cohort = row['eligibility']
            elif order['status'] == 'completed':
                require(paid and intent['status'] == 'succeeded' and set(kinds) == {'charge', 'payout_credit'},
                        'INVALID_TERMINAL_GATEWAY_HISTORY')
                require(kinds['charge']['status'] == 'succeeded' and kinds['charge']['gateway_ref'] == intent['gateway_ref']
                    and kinds['payout_credit']['status'] == 'succeeded', 'INVALID_TERMINAL_GATEWAY_HISTORY')
                cohort = 'gateway_completed'
            else:
                refunded = order['payment_status'] == 'refunded' and intent['status'] == 'succeeded' and set(kinds) == {'charge', 'refund'}
                voided = order['payment_status'] == 'pending' and intent['status'] == 'failed' and not ledger
                if refunded:
                    require(kinds['charge']['status'] == 'succeeded' and kinds['charge']['gateway_ref'] == intent['gateway_ref']
                            and kinds['refund']['status'] == 'refunded', 'INVALID_TERMINAL_GATEWAY_HISTORY')
                require(refunded or voided, 'INVALID_TERMINAL_GATEWAY_HISTORY')
                cohort = 'gateway_refunded' if refunded else 'gateway_voided'
        counts[cohort] = counts.get(cohort, 0) + 1
    return bindings, counts


def export_snapshot(source, destination, *, writers_stopped=False):
    require(writers_stopped, 'WRITERS_MUST_BE_STOPPED')
    source, destination = Path(source).resolve(strict=True), Path(destination)
    require(not destination.exists(), 'OUTPUT_ALREADY_EXISTS')
    db = sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    try:
        db.execute('PRAGMA query_only=ON')
        db.execute('BEGIN')
        require(db.execute('PRAGMA quick_check').fetchone()[0] == 'ok', 'SOURCE_INTEGRITY')
        require(not db.execute('PRAGMA foreign_key_check').fetchall(), 'SOURCE_FOREIGN_KEYS')
        require_legacy_only_source(db)
        require(db.execute('SELECT count(*) FROM events WHERE processed_at IS NULL').fetchone()[0] == 0,
                'PENDING_LEGACY_EVENTS')
        def rows(table):
            # Names are internal constants only, never command-line SQL.
            return [dict(row) for row in db.execute('SELECT * FROM ' + table)]
        orders = {row['id']: row for row in rows('orders')}
        identities = {role: {row['id'] for row in rows(table)} for role, table in
                      [('customer', 'customers'), ('provider', 'providers'), ('admin', 'admins')]}
        notifications = rows('notifications')
        for row in notifications:
            require(row['recipient_id'] in identities.get(row['recipient_role'], set()), 'UNKNOWN_RECIPIENT')
            require(row['order_id'] is None or row['order_id'] in orders, 'UNKNOWN_NOTIFICATION_ORDER')
        intents = rows('payment_intents')
        for row in intents:
            order = orders.get(row['order_id'])
            require(order is not None, 'UNKNOWN_INTENT_ORDER')
            require(order['payment_method'] == 'gateway' and row['amount_cents'] == order['total_cents'],
                    'INTENT_CONTEXT_MISMATCH')
            require(order['customer_id'] in identities['customer'] and order['provider_id'] in identities['provider'],
                    'UNKNOWN_INTENT_OWNER')
            row.update(customer_id=order['customer_id'], provider_id=order['provider_id'], currency='THB')
        transactions = rows('transactions')
        effects = set()
        for row in transactions:
            order = orders.get(row['order_id'])
            require(order is not None, 'UNKNOWN_LEDGER_ORDER')
            require(row['customer_id'] == order['customer_id'] and row['provider_id'] == order['provider_id']
                    and row['method'] == order['payment_method'], 'LEDGER_CONTEXT_MISMATCH')
            effect = (row['order_id'], row['kind'])
            require(effect not in effects, 'DUPLICATE_LEDGER_EFFECT')
            effects.add(effect)
            row['context_json'] = {}
            if row['kind'] in ('payout_credit', 'commission_owed'):
                commission = order['commission_cents']
                require(isinstance(commission, int) and 0 <= commission <= order['total_cents'],
                        'MISSING_COMPLETION_CONTEXT')
                require(order['status'] == 'completed', 'INVALID_COMPLETION_STATE')
                expected_kind = 'payout_credit' if row['method'] == 'gateway' else 'commission_owed'
                expected_amount = order['total_cents'] - commission if row['method'] == 'gateway' else commission
                require(row['kind'] == expected_kind and row['amount_cents'] == expected_amount,
                        'COMPLETION_AMOUNT_MISMATCH')
                row['context_json'] = dict(order_id=order['id'], customer_id=order['customer_id'],
                    provider_id=order['provider_id'], amount_cents=order['total_cents'],
                    commission_cents=commission, payment_method=order['payment_method'])
            else:
                require(row['method'] == 'gateway' and row['amount_cents'] == order['total_cents'],
                        'SETTLEMENT_AMOUNT_MISMATCH')
        wallets = rows('provider_wallets')
        require({row['provider_id'] for row in wallets} == identities['provider'], 'MISSING_PROVIDER_WALLET')
        for row in wallets:
            ledger = [t for t in transactions if t['provider_id'] == row['provider_id']]
            require(row['balance_cents'] == sum(t['amount_cents'] for t in ledger if t['kind'] == 'payout_credit')
                    and row['commission_owed_cents'] == sum(t['amount_cents'] for t in ledger if t['kind'] == 'commission_owed'),
                    'WALLET_LEDGER_MISMATCH')
        receipts = rows('webhook_events')
        for row in receipts:
            require(row['processed_at'] is not None, 'PENDING_WEBHOOK_RECEIPT')
            row['payload_json'] = json.loads(row['payload_json'])
        watermark = db.execute('SELECT coalesce(max(id),0) FROM events').fetchone()[0]
        require(type(watermark) is int and 0 <= watermark <= 9007199254740991, 'MANIFEST_WATERMARK_RANGE')
        bindings, cohorts = legacy_bindings(orders, intents, transactions)
        snapshot_id = str(uuid.uuid4())
        common = dict(format_version=1, snapshot_id=snapshot_id,
                      exported_at=dt.datetime.now(dt.timezone.utc).isoformat(timespec='milliseconds'),
                      legacy_event_watermark=watermark)
        bundles = [dict(common, service='notifications', tables=dict(notifications=notifications)),
                   dict(common, service='payments-wallet', tables=dict(payment_intents=intents,
                        transactions=transactions, provider_wallets=wallets, webhook_events=receipts))]
        # Atomic directory publication prevents partially written snapshots being used.
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(destination.name + '.tmp-' + snapshot_id)
        temporary.mkdir(mode=0o700)
        try:
            for bundle in bundles:
                path = temporary / (bundle['service'] + '.json')
                with path.open('x', encoding='utf-8') as handle:
                    os.chmod(path, 0o600)
                    json.dump(bundle, handle, ensure_ascii=False, allow_nan=False)
            backup = temporary / 'source.sqlite'
            with sqlite3.connect(backup) as target:
                db.backup(target)
            os.chmod(backup, 0o600)
            schema = [list(row) for row in db.execute(
                "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")]
            core = dict(format_version=1, snapshot_id=snapshot_id,
                        source=dict(sqlite_backup_sha256=hashlib.sha256(backup.read_bytes()).hexdigest(),
                                    schema_fingerprint=hashlib.sha256(canonical_bytes(schema)).hexdigest()),
                        legacy_event_watermark=watermark,
                        bundles=[dict(service=b['service'], file=b['service']+'.json',
                                      sha256=hashlib.sha256((temporary/(b['service']+'.json')).read_bytes()).hexdigest())
                                 for b in bundles], bindings=bindings)
            envelope = dict(manifest=core, manifest_sha256=hashlib.sha256(canonical_bytes(core)).hexdigest())
            with (temporary/'manifest.json').open('xb') as handle:
                os.chmod(handle.fileno(), 0o600)
                handle.write(canonical_bytes(envelope)+b'\n')
            temporary.rename(destination)
        except BaseException:
            for path in temporary.glob('*'):
                path.unlink()
            temporary.rmdir()
            raise
        return dict(snapshot_id=snapshot_id, legacy_event_watermark=watermark,
                    manifest_sha256=envelope['manifest_sha256'], classified_orders=cohorts,
                    counts={bundle['service']: {table: len(data) for table, data in bundle['tables'].items()}
                            for bundle in bundles})
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--output', required=True, help='New private directory, e.g. output/migration/snapshot-1')
    parser.add_argument('--writers-stopped', action='store_true', help='Operator attests ALL writers/relay/recovery are stopped')
    args = parser.parse_args()
    try:
        print(json.dumps(export_snapshot(args.source, args.output, writers_stopped=args.writers_stopped)))
    except Exception as error:
        # No SQL error text, source rows, paths or credentials in logs.
        print(json.dumps(dict(error=str(error) if isinstance(error, ExportError) else 'EXPORT_FAILED')), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
