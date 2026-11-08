import { createPaymentsRuntime } from "./runtime.js";
import { readConfig, serviceName } from "./config.js";
import { createDatabase } from "./database.js";

const config = readConfig();
const database = createDatabase(config.databaseUrl);
// C participant/eligibility/outbox are composed here. Real B verifier injection is
// still required: with no verifiers both protected boundaries return 503.
const {app} = createPaymentsRuntime({database});
const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(JSON.stringify({ event: "listening", service: serviceName, port: config.port }));
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 10000);
  deadline.unref();
  server.close(async () => {
    try { await database.close(); } finally { clearTimeout(deadline); }
  });
  server.closeIdleConnections();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
