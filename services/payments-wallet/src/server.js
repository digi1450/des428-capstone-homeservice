import {deploymentLegacyApproval} from './legacy-checkpoint.js';
import { createUserVerifier } from "./security/user-verifier.js";
import { createIdentityResolver } from "./security/identity-resolver.js";
import { createBookingServiceVerifier, createGatewayWebhookVerifier } from "./security/booking-verifier.js";
import { createPaymentsRuntime } from "./runtime.js";
import { createFinancialOperations } from "./financial/index.js";
import { readConfig, serviceName } from "./config.js";
import { createDatabase } from "./database.js";

const securityEnabled = process.env.AREA_B_AUTH_ENABLED === "true";
if (process.env.AREA_B_AUTH_ENABLED && !["true","false"].includes(process.env.AREA_B_AUTH_ENABLED))
  throw new Error("Invalid AREA_B_AUTH_ENABLED");
const security = securityEnabled ? {
  authenticate: createUserVerifier({
    issuer: process.env.KEYCLOAK_ISSUER,
    audience: "payments-wallet-service",
    resolveIdentity: createIdentityResolver({
      url: process.env.IDENTITY_RESOLVER_URL,
      token: process.env.IDENTITY_RESOLVER_TOKEN,
    }),
  }),
  authenticateService: createBookingServiceVerifier({ issuer: process.env.KEYCLOAK_ISSUER }),
  authenticateWebhook: createGatewayWebhookVerifier({ issuer: process.env.KEYCLOAK_ISSUER }),
} : {};

const config = readConfig();
const database = createDatabase(config.databaseUrl);
// C participant/eligibility/outbox are composed here. Real B verifier injection is
// still required: with no verifiers both protected boundaries return 503.
const legacyManifestSha256=deploymentLegacyApproval();
if(legacyManifestSha256&&!securityEnabled)throw Error('legacy approval requires real service authentication');
const {app} = createPaymentsRuntime({database, ...security, createFinancialOperations,legacyManifestSha256});
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
