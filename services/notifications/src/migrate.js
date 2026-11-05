import { readConfig, serviceName } from "./config.js";
import { createDatabase } from "./database.js";
import { migrate } from "./migrations.js";

const database = createDatabase(readConfig().databaseUrl);
try {
  const applied = await migrate(database);
  console.log(JSON.stringify({ event: "migrations_complete", service: serviceName, applied }));
} catch {
  console.error(JSON.stringify({ event: "migration_failed", service: serviceName }));
  process.exitCode = 1;
} finally {
  await database.close();
}
