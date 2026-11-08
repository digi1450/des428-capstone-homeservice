import hashlib
import shutil
from contextlib import closing
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

BASE = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('snapshot_export', BASE/'tools/data-migration/export_snapshot.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def make_source(path):
    db = sqlite3.connect(path)
    schema = (BASE/'bangkok-homeservice/lib/db/schema.js').read_text().split('export const SCHEMA_SQL = `', 1)[1].split('`;', 1)[0]
    db.executescript(schema)
    db.execute("INSERT INTO customers (id,email,password_hash,name) VALUES (5,'fixture@local','fixture-only','Fixture')")
    db.execute("INSERT INTO providers (id,email,password_hash,name) VALUES (7,'provider@local','fixture-only','Fixture')")
    db.execute("INSERT INTO admins (id,email,password_hash,name) VALUES (1,'admin@local','fixture-only','Fixture')")
    timestamp = '2026-11-06T00:00:00.000Z'
    for order_id,total,method,status,payment_status,commission in [
        (10,1000,'gateway','completed','paid',150), (11,2000,'gateway','cancelled','refunded',None),
        (12,3000,'cod','completed','pending',450), (13,4000,'gateway','awaiting','pending',None),
        (14,5000,'gateway','confirmed','paid',None), (15,1000,'cod','confirmed','pending',None),
        (16,6000,'gateway','cancelled','pending',None), (17,1000,'cod','cancelled','pending',None)]:
        db.execute('''INSERT INTO orders (id,customer_id,provider_id,service_date,starting_time,ending_time,
          duration_min,subtotal_cents,tax_cents,total_cents,commission_pct,commission_cents,provider_earnings_cents,
          payment_method,payment_status,status,otp,created_at,updated_at)
          VALUES (?,5,7,'2026-11-10','10:00','10:30',30,?,0,?,15,?,?,?,?,?,123456,?,?)''',
          (order_id,total,total,commission,None if commission is None else total-commission,method,payment_status,status,timestamp,timestamp))
    for id,order_id,total,status in [(40,10,1000,'succeeded'),(42,11,2000,'succeeded'),(45,13,4000,'requires_payment'),(46,14,5000,'succeeded'),(47,16,6000,'failed')]:
        db.execute('INSERT INTO payment_intents VALUES (?,?,?,?,?,?)', (id,order_id,total,'SIM-'+str(order_id),status,timestamp))
    for id,order_id,kind,amount,method,ref,status in [
        (100,10,'charge',1000,'gateway','SIM-10','succeeded'),
        (110,10,'payout_credit',850,'gateway',None,'succeeded'),
        (120,11,'charge',2000,'gateway','SIM-11','succeeded'),
        (121,11,'refund',2000,'gateway',None,'refunded'),
        (130,12,'commission_owed',450,'cod',None,'succeeded'),
        (140,14,'charge',5000,'gateway','SIM-14','succeeded')]:
        db.execute('INSERT INTO transactions VALUES (?,?,5,7,?,?,?,?,?,?)', (id,order_id,kind,amount,method,ref,status,timestamp))
    db.execute('INSERT INTO provider_wallets VALUES (7,850,450,?)', (timestamp,))
    for id,order_id in [(60,10),(62,11),(64,14)]:
        payload = dict(gateway_event_id='EVENT-'+str(order_id),type='payment_intent.succeeded',gateway_ref='SIM-'+str(order_id))
        db.execute('INSERT INTO webhook_events VALUES (?,?,?,?,?,?)', (id,payload['gateway_event_id'],payload['type'],json.dumps(payload),timestamp,timestamp))
    db.execute("INSERT INTO notifications VALUES (70,'provider',7,'payment_received','ได้รับเงิน','Fixture Thai ไทย',10,NULL,?)", (timestamp,))
    db.execute("INSERT INTO notifications VALUES (75,'customer',5,'booking_update','Status','Read',11,?,?)", (timestamp,timestamp))
    db.execute("INSERT INTO events (id,type,aggregate_type,aggregate_id,payload_json,created_at,processed_at,event_uuid) VALUES (80,'payment.succeeded','order',10,'{}',?,?,'00000000-0000-4000-8000-000000000080')", (timestamp,timestamp))
    db.commit()
    db.close()


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root/'source.sqlite'
        make_source(self.source)
    def export(self):
        return module.export_snapshot(self.source,self.root/'snapshot',writers_stopped=True)
    def change(self, sql):
        with closing(sqlite3.connect(self.source)) as db:
            db.execute(sql)
            db.commit()
    def test_consistent_private_export_preserves_source_and_minimizes_data(self):
        before = hashlib.sha256(self.source.read_bytes()).hexdigest()
        report = self.export()
        self.assertEqual(before,hashlib.sha256(self.source.read_bytes()).hexdigest())
        n = json.loads((self.root/'snapshot/notifications.json').read_text())
        p = json.loads((self.root/'snapshot/payments-wallet.json').read_text())
        self.assertEqual(n['snapshot_id'],p['snapshot_id'])
        self.assertEqual(report['legacy_event_watermark'],80)
        self.assertEqual(p['tables']['payment_intents'][0]['customer_id'],5)
        self.assertEqual(p['tables']['transactions'][1]['context_json']['commission_cents'],150)
        self.assertEqual(p['tables']['provider_wallets'][0]['balance_cents'],850)
        self.assertIsNone(n['tables']['notifications'][0]['read_at'])
        self.assertNotIn('password_hash',json.dumps([n,p]))
        self.assertEqual((self.root/'snapshot').stat().st_mode & 0o777,0o700)
        self.assertEqual((self.root/'snapshot/payments-wallet.json').stat().st_mode & 0o777,0o600)
    def test_legacy_cohorts_preserve_paid_open_unpaid_failed_and_cod_history(self):
        self.export()
        bundle = json.loads((self.root/'snapshot/payments-wallet.json').read_text())
        intents = {r['order_id']: r for r in bundle['tables']['payment_intents']}
        self.assertEqual({i: r['status'] for i, r in intents.items()},
                         {10:'succeeded',11:'succeeded',13:'requires_payment',14:'succeeded',16:'failed'})
        self.assertNotIn(15, intents)
        self.assertNotIn(17, intents)
        self.assertNotIn('payment_provisioning', bundle['tables'])
        self.assertEqual(bundle['tables']['provider_wallets'][0]['balance_cents'], 850)
        self.assertEqual(len(bundle['tables']['transactions']), 6)
        self.assertEqual(len(bundle['tables']['webhook_events']), 3)

    def assert_source_rejected_without_changes(self, code):
        before = hashlib.sha256(self.source.read_bytes()).hexdigest()
        with self.assertRaisesRegex(module.ExportError, code): self.export()
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(), before)
        self.assertFalse((self.root/'snapshot').exists())

    def test_any_saga_history_requires_distributed_source_review(self):
        for state in ['INTENT_CREATE_PENDING','COMPLETED','COMPENSATION_PENDING','CANCELLED','RECOVERY_PENDING']:
            with self.subTest(state=state):
                if (self.root/'snapshot').exists(): shutil.rmtree(self.root/'snapshot')
                self.change("DELETE FROM booking_sagas")
                self.change("INSERT INTO booking_sagas (saga_id,order_id,customer_id,request_key,request_digest,state,create_command_id,cancel_command_id,snapshot_json) VALUES ('fixture-saga',13,5,'fixture-key','fixture-digest','"+state+"','fixture-create','fixture-cancel','{}')")
                self.assert_source_rejected_without_changes('SOURCE_DISTRIBUTED_STATE_REQUIRES_REVIEW')

    def test_broker_delivery_history_cannot_be_treated_as_legacy_only(self):
        self.change("UPDATE events SET published_at='2026-11-06T00:00:00.000Z'")
        self.assert_source_rejected_without_changes('SOURCE_DISTRIBUTED_STATE_REQUIRES_REVIEW')

    def test_publish_attempt_with_unknown_broker_outcome_also_requires_review(self):
        self.change("UPDATE events SET publish_attempts=1,published_at=NULL")
        self.assert_source_rejected_without_changes('SOURCE_DISTRIBUTED_STATE_REQUIRES_REVIEW')

    def test_consumer_inbox_history_is_not_discarded_by_source_export(self):
        self.change("INSERT INTO processed_events (consumer_name,event_id,event_type,producer,outcome) VALUES ('fixture','fixture-event','payment.succeeded','payments-wallet','applied')")
        self.assert_source_rejected_without_changes('SOURCE_DISTRIBUTED_STATE_REQUIRES_REVIEW')

    def test_unresolved_attention_requires_review_but_resolved_record_is_preserved(self):
        self.change("INSERT INTO consistency_attention (consumer_name,event_id,event_type,aggregate_id,reason) VALUES ('fixture','fixture-event','payment.succeeded','13','fixture')")
        self.assert_source_rejected_without_changes('SOURCE_UNRESOLVED_ATTENTION')
        self.change("UPDATE consistency_attention SET resolved_at='2026-11-06T00:00:00.000Z'")
        before = hashlib.sha256(self.source.read_bytes()).hexdigest()
        self.export()
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(), before)

    def test_pre_broker_source_with_no_c_tables_or_published_column_still_exports(self):
        with closing(sqlite3.connect(self.source)) as db:
            for table in ['booking_saga_activations','booking_saga_transitions','booking_sagas','processed_events','consistency_attention']:
                db.execute('DROP TABLE '+table)
            db.execute('DROP INDEX idx_events_unpublished')
            db.execute('ALTER TABLE events DROP COLUMN published_at')
            db.commit()
        self.export()

    def test_sqlite_backup_keeps_committed_wal_rows_that_a_main_file_copy_misses(self):
        with closing(sqlite3.connect(self.source)) as writer:
            self.assertEqual(writer.execute('PRAGMA journal_mode=WAL').fetchone()[0], 'wal')
            writer.execute("INSERT INTO notifications VALUES (76,'customer',5,'booking_update','WAL fixture','Committed only in WAL',13,NULL,'2026-11-06T00:00:00.000Z')")
            writer.commit()
            self.assertGreater(Path(str(self.source)+'-wal').stat().st_size, 0)
            raw = self.root/'incorrect-main-file-only.sqlite'
            shutil.copyfile(self.source, raw)
            with closing(sqlite3.connect(raw)) as db:
                self.assertEqual(db.execute('SELECT count(*) FROM notifications WHERE id=76').fetchone()[0], 0)
            frozen = self.root/'consistent-backup.sqlite'
            with closing(sqlite3.connect(frozen)) as target:
                writer.backup(target)
            before = hashlib.sha256(frozen.read_bytes()).hexdigest()
            report = module.export_snapshot(frozen, self.root/'wal-snapshot', writers_stopped=True)
            self.assertEqual(report['counts']['notifications']['notifications'], 3)
            exported = json.loads((self.root/'wal-snapshot/notifications.json').read_text())
            self.assertIn(76, [row['id'] for row in exported['tables']['notifications']])
            self.assertEqual(hashlib.sha256(frozen.read_bytes()).hexdigest(), before)

    def test_requires_writer_stop_and_refuses_replacement(self):
        with self.assertRaisesRegex(module.ExportError,'WRITERS'):
            module.export_snapshot(self.source,self.root/'snapshot')
        self.export()
        with self.assertRaisesRegex(module.ExportError,'OUTPUT_ALREADY_EXISTS'):
            self.export()
    def test_pending_events_block_without_marking_them(self):
        self.change('UPDATE events SET processed_at=NULL')
        with self.assertRaisesRegex(module.ExportError,'PENDING_LEGACY_EVENTS'): self.export()
        with closing(sqlite3.connect(self.source)) as db:
            self.assertIsNone(db.execute('SELECT processed_at FROM events').fetchone()[0])
        self.assertFalse((self.root/'snapshot').exists())
    def test_duplicates_fail_instead_of_deleting_financial_history(self):
        self.change('INSERT INTO transactions SELECT 200,order_id,customer_id,provider_id,kind,amount_cents,method,gateway_ref,status,created_at FROM transactions WHERE id=100')
        with self.assertRaisesRegex(module.ExportError,'DUPLICATE_LEDGER_EFFECT'): self.export()
    def test_wallet_mismatch_fails_instead_of_recomputing_balance(self):
        self.change('UPDATE provider_wallets SET balance_cents=851')
        with self.assertRaisesRegex(module.ExportError,'WALLET_LEDGER_MISMATCH'): self.export()
    def test_unprocessed_webhook_is_not_discarded(self):
        self.change('UPDATE webhook_events SET processed_at=NULL WHERE id=60')
        with self.assertRaisesRegex(module.ExportError,'PENDING_WEBHOOK_RECEIPT'): self.export()
    def test_missing_recipient_blocks_export(self):
        self.change('UPDATE notifications SET recipient_id=999')
        with self.assertRaisesRegex(module.ExportError,'UNKNOWN_RECIPIENT'): self.export()
    def test_completion_snapshot_must_match_ledger(self):
        self.change('UPDATE orders SET commission_cents=200 WHERE id=10')
        with self.assertRaisesRegex(module.ExportError,'COMPLETION_AMOUNT_MISMATCH'): self.export()


if __name__ == '__main__':
    unittest.main()
