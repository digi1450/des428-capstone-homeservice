import { readFile } from 'node:fs/promises';
import { importSnapshot, importApprovedSnapshot } from './import-snapshot.mjs';

import { loadApprovedSnapshot } from './approved-snapshot.mjs';

let database;
try {
  const args = process.argv.slice(2);
  const [service, file, flag] = args;
  const approvedMode = file === '--approved-directory';
  let approved;
  if (approvedMode) {
    if (!['notifications','payments-wallet'].includes(service) || !args[2] || args[3] !== '--expected-manifest-sha256' || !args[4] || args.length > 6 || (args[5] && args[5] !== '--apply')) throw new Error('USAGE');
    approved = await loadApprovedSnapshot(args[2],args[4]);
  }
  if (!approvedMode && (!['notifications','payments-wallet'].includes(service) || !file || (flag && flag !== '--apply') || process.argv.length > 5)) {
    throw new Error('USAGE');
  }
  // Only load one owning service/credential. Never connect to the other database.
  const { createDatabase } = await import(`../../services/${service}/src/database.js`);
  const { readConfig } = await import(`../../services/${service}/src/config.js`);
  database = createDatabase(readConfig().databaseUrl);
  const result = approvedMode
    ? await importApprovedSnapshot(database,service,approved,{apply:args[5] === '--apply'})
    : await importSnapshot(database,service,JSON.parse(await readFile(file,'utf8')),{apply:flag === '--apply'});
  console.log(JSON.stringify(result));
} catch {
  // Snapshot contents and driver/URL details may contain private information.
  console.error(JSON.stringify({error:'IMPORT_REJECTED',hint:'Check snapshot, ownership, migrations and empty/identical offline target; no row/credential details logged.'}));
  process.exitCode = 1;
} finally {
  await database?.close();
}
