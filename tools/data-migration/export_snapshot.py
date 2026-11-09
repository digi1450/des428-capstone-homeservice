"""Offline, read-only export. Never imports or runs application bootstrap."""
import argparse
import datetime as dt
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
    for table in ('booking_sagas', 'booking_saga_transitions', 'booking_saga_activations', 'booking_financial_work', 'processed_events'):
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
            temporary.rename(destination)
        except BaseException:
            for path in temporary.glob('*'):
                path.unlink()
            temporary.rmdir()
            raise
        return dict(snapshot_id=snapshot_id, legacy_event_watermark=watermark,
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
