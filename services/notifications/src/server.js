import { createUserVerifier } from "./security/user-verifier.js";
import { createIdentityResolver } from "./security/identity-resolver.js";
import { createApp } from "./app.js";
import { readConfig, serviceName } from "./config.js";
import { createDatabase } from "./database.js";

const securityEnabled = process.env.AREA_B_AUTH_ENABLED === "true";
if (process.env.AREA_B_AUTH_ENABLED && !["true","false"].includes(process.env.AREA_B_AUTH_ENABLED))
  throw new Error("Invalid AREA_B_AUTH_ENABLED");
const authenticate = securityEnabled ? createUserVerifier({
  issuer: process.env.KEYCLOAK_ISSUER,
  audience: "notifications-service",
  resolveIdentity: createIdentityResolver({
    url: process.env.IDENTITY_RESOLVER_URL,
    token: process.env.IDENTITY_RESOLVER_TOKEN,
  }),
}) : undefined;

const config = readConfig();
const database = createDatabase(config.databaseUrl);
const server = createApp({ database, authenticate }).listen(config.port, "0.0.0.0", () => {
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
