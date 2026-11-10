// Creates a NEW local integration environment; never rotates or overwrites one.
import {randomBytes} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync,chmodSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const local=resolve(root,'.local/authenticated');
const envPath=resolve(root,'.env.authenticated');
if(existsSync(local)||existsSync(envPath))throw Error('Local integration already exists. Preserve it; use a separate checkout for a new environment.');
const openssl=process.env.OPENSSL_BIN||'openssl';
execFileSync(openssl,['version'],{stdio:'ignore'});
mkdirSync(resolve(local,'tls'),{recursive:true,mode:0o700});
// Parent stays private on the host; the directly mounted child must be readable
// by Keycloak UID1000 on Linux (Compose file secrets preserve source ownership).
mkdirSync(resolve(local,'realm'),{mode:0o755});
const secret=()=>randomBytes(32).toString('hex');
const values={NOTIFICATIONS_DB_PASSWORD:secret(),PAYMENTS_DB_PASSWORD:secret(),RABBITMQ_PASSWORD:secret(),GRAFANA_ADMIN_PASSWORD:secret(),KEYCLOAK_DB_PASSWORD:secret(),KEYCLOAK_ADMIN_PASSWORD:secret(),BOOKING_SERVICE_CLIENT_SECRET:secret(),KEYCLOAK_GATEWAY_CLIENT_SECRET:secret(),OIDC_SESSION_SECRET:secret(),IDENTITY_RESOLVER_TOKEN:secret()};
const tls=resolve(local,'tls');
const run=args=>execFileSync(openssl,args,{cwd:tls,stdio:'ignore'});
run(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.pem','-days','30','-subj','/CN=Homeservice local integration CA','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign']);
run(['req','-newkey','rsa:2048','-nodes','-keyout','server.key','-out','server.csr','-subj','/CN=app.homeservice.test']);
writeFileSync(resolve(tls,'extensions.cnf'),'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:app.homeservice.test,DNS:id.homeservice.test,DNS:payments.homeservice.test,DNS:notifications.homeservice.test,DNS:identity.homeservice.test\n');
run(['x509','-req','-in','server.csr','-CA','ca.pem','-CAkey','ca.key','-CAcreateserial','-out','server.pem','-days','30','-extfile','extensions.cnf']);
chmodSync(resolve(tls,'server.key'),0o444);
const realm=JSON.parse(readFileSync(resolve(root,'infra/keycloak/homeservice-realm.json'),'utf8'));
const web=realm.clients.find(c=>c.clientId==='homeservice-web');
web.redirectUris=['https://app.homeservice.test:18444/api/auth/keycloak/callback'];
web.webOrigins=['https://app.homeservice.test:18444'];
// B's minimal realm defines custom scopes, so a fresh import may not contain
// Keycloak's built-in 'roles' scope. Explicit mappers emit only assigned API roles.
for(const client of realm.clients.filter(c=>['homeservice-web','booking-service','mock-gateway-service'].includes(c.clientId))){
 const audiences=client.clientId==='homeservice-web'?['notifications-service','payments-wallet-service']:['payments-wallet-service'];
 client.protocolMappers=[...(client.protocolMappers||[]),...audiences.map(audience=>({name:audience+'-assigned-roles',protocol:'openid-connect',protocolMapper:'oidc-usermodel-client-role-mapper',consentRequired:false,config:{'usermodel.clientRoleMapping.clientId':audience,'claim.name':'resource_access.'+audience+'.roles','jsonType.label':'String',multivalued:'true','access.token.claim':'true','id.token.claim':'false','userinfo.token.claim':'false'}}))];
}
for(const [id,key]of [['booking-service','BOOKING_SERVICE_CLIENT_SECRET'],['mock-gateway-service','KEYCLOAK_GATEWAY_CLIENT_SECRET']])realm.clients.find(c=>c.clientId===id).secret=values[key];
const allRoles=realm.roles.client['payments-wallet-service'].map(r=>r.name);
realm.users=[['booking-service',allRoles.filter(r=>r.startsWith('booking:'))],['mock-gateway-service',['mock-gateway:settle_webhook']]].map(([clientId,roles])=>({username:'service-account-'+clientId,enabled:true,serviceAccountClientId:clientId,clientRoles:{'payments-wallet-service':roles}}));
writeFileSync(resolve(local,'realm/homeservice-realm.json'),JSON.stringify(realm,null,2)+'\n',{mode:0o644,flag:'wx'});
// Flags remain disabled until explicit disposable-demo or real cutover review.
const config={...values,AUTHENTICATED_SERVICES_ENABLED:'false',AUTHENTICATED_CUTOVER_APPROVED:'false',OIDC_LOGIN_ENABLED:'false',OIDC_SELF_REGISTRATION_ENABLED:'false',AREA_B_AUTH_ENABLED:'false',AUTHENTICATED_AMQP_URL:'',GATEWAY_PORT:'18081',GRAFANA_PORT:'3304',PROMETHEUS_PORT:'9091',JAEGER_UI_PORT:'16687',RABBITMQ_UI_PORT:'15673'};
writeFileSync(envPath,Object.entries(config).map(([k,v])=>k+'='+v).join('\n')+'\n',{mode:0o600,flag:'wx'});
console.log('Prepared ignored .env.authenticated, local CA/certificate and realm. No deployment was started; activation flags remain false.');
