import { readFile } from 'node:fs/promises';
import { importSnapshot } from './import-snapshot.mjs';

let database;
try {
  const [service, file, flag] = process.argv.slice(2);
  if (!['notifications','payments-wallet'].includes(service) || !file || (flag && flag !== '--apply') || process.argv.length > 5) {
    throw new Error('USAGE');
  }
  // Only load one owning service/credential. Never connect to the other database.
  const { createDatabase } = await import(`../../services/${service}/src/database.js`);
  const { readConfig } = await import(`../../services/${service}/src/config.js`);
  database = createDatabase(readConfig().databaseUrl);
  const bundle = JSON.parse(await readFile(file,'utf8'));
  console.log(JSON.stringify(await importSnapshot(database,service,bundle,{apply:flag === '--apply'})));
} catch {
  // Snapshot contents and driver/URL details may contain private information.
  console.error(JSON.stringify({error:'IMPORT_REJECTED',hint:'Check snapshot, ownership, migrations and empty/identical offline target; no row/credential details logged.'}));
  process.exitCode = 1;
} finally {
  await database?.close();
}
