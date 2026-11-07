"""Disposable standalone-image restart/recreation/mismatch rehearsal; publishes no ports.
Build the image as documented in docs/validation/sqlite-startup-2026-11-07.md first.
Resources must not already exist; only resources created by this script are removed.
"""
import subprocess,json,time
container='homeservice-startup-runtime-check'
volume='homeservice-startup-runtime-check-data'
def command(*args):
 return subprocess.check_output(args,text=True,stderr=subprocess.STDOUT).strip()
# Refuse to reuse someone else's test resources.
assert subprocess.run(['docker','container','inspect',container],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode != 0
assert subprocess.run(['docker','volume','inspect',volume],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode != 0
command('docker','volume','create',volume)
def create():
 command('docker','run','-d','--name',container,'--mount',f'type=volume,src={volume},dst=/app/data','-e','DB_PATH=/app/data/edemand.db','-e','BCRYPT_ROUNDS=4','homeservice-startup-runtime')
def ready():
 for _ in range(40):
  p=subprocess.run(['docker','exec',container,'node','-e',"require('http').get('http://127.0.0.1:3000/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  if p.returncode==0:return
  time.sleep(.5)
 raise RuntimeError('Runtime health failed: '+command('docker','logs',container))
snapshot="""const db=require('better-sqlite3')('/app/data/edemand.db');const rows=db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\").all().map(({name})=>[name,db.prepare('SELECT * FROM '+name+' ORDER BY rowid').all()]);console.log(require('crypto').createHash('sha256').update(JSON.stringify(rows)).digest('hex'));db.close();"""
try:
 create();ready()
 command('docker','exec',container,'node','-e',"const db=require('better-sqlite3')('/app/data/edemand.db');db.exec(\"UPDATE customers SET name='runtime persisted'; UPDATE sqlite_sequence SET seq=9123 WHERE name='orders'\");db.close()")
 before=command('docker','exec',container,'node','-e',snapshot)
 command('docker','restart',container);ready()
 after=command('docker','exec',container,'node','-e',snapshot)
 assert before==after,'Restart changed database rows'
 command('docker','rm','-f',container)
 create();ready()
 recreated=command('docker','exec',container,'node','-e',snapshot)
 assert before==recreated,'Container recreation changed database rows'
 command('docker','rm','-f',container)
 command('docker','run','--rm','--mount',f'type=volume,src={volume},dst=/app/data','--entrypoint','node','homeservice-startup-runtime','-e',"const db=require('better-sqlite3')('/app/data/edemand.db');db.exec(\"CREATE TABLE unexpected_state (value TEXT); INSERT INTO unexpected_state VALUES ('preserve')\");db.close()")
 def offline_snapshot():
  return command('docker','run','--rm','--mount',f'type=volume,src={volume},dst=/app/data','--entrypoint','node','homeservice-startup-runtime','-e',snapshot)
 incompatible_before=offline_snapshot()
 create()
 for _ in range(30):
  if command('docker','inspect','--format','{{.State.Status}}',container)=='exited':break
  time.sleep(.5)
 assert command('docker','inspect','--format','{{.State.Status}}',container)=='exited','Incompatible runtime did not exit'
 assert 'SQLITE_SCHEMA_MISMATCH' in command('docker','logs',container)
 assert incompatible_before==offline_snapshot(),'Incompatible startup changed data'
 print(json.dumps({'incompatible_runtime_exited_without_data_changes':True,'runtime_health':True,'restart_rows_identical':True,'recreate_same_volume_rows_identical':True,'snapshot_sha256':before}))
finally:
 subprocess.run(['docker','rm','-f',container],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 subprocess.run(['docker','volume','rm',volume],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
