#!/usr/bin/env node
// Offline, administrator-only provisioning. Do not expose as a public HTTP route.
import { createIdentityMappingStore } from "../lib/security/identity-mapping.js";
import { migrate } from "../lib/db/migrate.js";
import { getDb } from "../lib/db/index.js";

const [issuer,sub,role,rawId]=process.argv.slice(2);
const domainId=Number(rawId);
if (!process.env.IDENTITY_MAPPING_DB_PATH || !issuer || !sub || !role || !Number.isInteger(domainId)) {
 console.error("Usage: IDENTITY_MAPPING_DB_PATH=... node scripts/provision-keycloak-identity.js <issuer> <subject> <customer|provider|admin> <legacy-integer-id>");
 process.exit(2);
}
let store;
try {
 migrate(getDb());
 store=createIdentityMappingStore({path:process.env.IDENTITY_MAPPING_DB_PATH});
 const mapped=store.provision({issuer,sub,role,domainId});
 console.log(JSON.stringify({status:"provisioned",...mapped}));
} catch (error) {
 console.error("Provisioning refused: "+error.message);
 process.exitCode=1;
} finally {store?.close();}
