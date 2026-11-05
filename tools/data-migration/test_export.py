import hashlib
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
        (12,3000,'cod','completed','pending',450), (13,4000,'gateway','awaiting','pending',None)]:
        db.execute('''INSERT INTO orders (id,customer_id,provider_id,service_date,starting_time,ending_time,
          duration_min,subtotal_cents,tax_cents,total_cents,commission_pct,commission_cents,provider_earnings_cents,
          payment_method,payment_status,status,otp,created_at,updated_at)
          VALUES (?,5,7,'2026-11-10','10:00','10:30',30,?,0,?,15,?,?,?,?,?,123456,?,?)''',
          (order_id,total,total,commission,None if commission is None else total-commission,method,payment_status,status,timestamp,timestamp))
    for id,order_id,total,status in [(40,10,1000,'succeeded'),(42,11,2000,'succeeded'),(45,13,4000,'requires_payment')]:
        db.execute('INSERT INTO payment_intents VALUES (?,?,?,?,?,?)', (id,order_id,total,'SIM-'+str(order_id),status,timestamp))
    for id,order_id,kind,amount,method,ref,status in [
        (100,10,'charge',1000,'gateway','SIM-10','succeeded'),
        (110,10,'payout_credit',850,'gateway',None,'succeeded'),
        (120,11,'charge',2000,'gateway','SIM-11','succeeded'),
        (121,11,'refund',2000,'gateway',None,'refunded'),
        (130,12,'commission_owed',450,'cod',None,'succeeded')]:
        db.execute('INSERT INTO transactions VALUES (?,?,5,7,?,?,?,?,?,?)', (id,order_id,kind,amount,method,ref,status,timestamp))
    db.execute('INSERT INTO provider_wallets VALUES (7,850,450,?)', (timestamp,))
    for id,order_id in [(60,10),(62,11)]:
        payload = dict(gateway_event_id='EVENT-'+str(order_id),type='payment_intent.succeeded',gateway_ref='SIM-'+str(order_id))
        db.execute('INSERT INTO webhook_events VALUES (?,?,?,?,?,?)', (id,payload['gateway_event_id'],payload['type'],json.dumps(payload),timestamp,timestamp))
    db.execute("INSERT INTO notifications VALUES (70,'provider',7,'payment_received','ได้รับเงิน','Fixture Thai ไทย',10,NULL,?)", (timestamp,))
    db.execute("INSERT INTO notifications VALUES (75,'customer',5,'booking_update','Status','Read',11,?,?)", (timestamp,timestamp))
    db.execute("INSERT INTO events VALUES (80,'payment.succeeded','order',10,'{}',?,?)", (timestamp,timestamp))
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
