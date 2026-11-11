import {parseArgs} from 'node:util';
import {createRequire} from 'node:module';
import {loadApprovedSnapshot} from '../data-migration/approved-snapshot.mjs';
import {privateFile} from '../../services/payments-wallet/src/legacy-checkpoint.js';
import {approveCheckpoint,revokeCheckpoint,inspectCheckpoint} from './checkpoint.mjs';
import {createCutoverOperatorVerifier} from './operator.mjs';
import {createDatabase as payments} from '../../services/payments-wallet/src/database.js';
import {createDatabase as notifications} from '../../services/notifications/src/database.js';
const Database=createRequire(new URL('../../bangkok-homeservice/package.json',import.meta.url))('better-sqlite3');
let db,p,n;
try{
 const {values:v}=parseArgs({options:Object.fromEntries(['operation','sqlite','directory','manifest-sha256','token-file','freeze-file','backup-directory','key-file','public-key-file','receipt-file'].map(k=>[k,{type:'string'}]))});
 if(!['inspect','approve','revoke'].includes(v.operation))throw Error('usage');
 const approved=await loadApprovedSnapshot(v.directory,v['manifest-sha256']);
 const verifyOperator=createCutoverOperatorVerifier({issuer:process.env.CUTOVER_KEYCLOAK_ISSUER});
 const token=privateFile(v['token-file']).toString('utf8').trim();
 await verifyOperator(token,v.operation==='revoke'?'revoke_checkpoint':'approve_checkpoint');
 db=new Database(v.sqlite,{fileMustExist:true});db.pragma('foreign_keys=ON');db.pragma('busy_timeout=3000');
 p=payments(process.env.CUTOVER_PAYMENTS_URL);n=notifications(process.env.CUTOVER_NOTIFICATIONS_URL);
 const options={approved,bookingDb:db,paymentsDatabase:p,notificationsDatabase:n,broker:{amqpUrl:process.env.CUTOVER_AMQP_URL,managementUrl:process.env.CUTOVER_BROKER_MANAGEMENT_URL},token,verifyOperator,keyFile:v['key-file'],publicKeyFile:v['public-key-file'],receiptFile:v['receipt-file']};
 let result;
 if(v.operation==='inspect'){const s=await inspectCheckpoint(options);result={state:'reconciled',manifest_sha256:s.manifest_sha256,snapshot_id:s.snapshot_id,phase_digest:s.phase_digest};}
 else if(v.operation==='approve')result=await approveCheckpoint({...options,freeze:JSON.parse(privateFile(v['freeze-file']).toString('utf8')),backupDirectory:v['backup-directory']});
 else result=await revokeCheckpoint({...options,freeze:JSON.parse(privateFile(v['freeze-file']).toString('utf8')),backupDirectory:v['backup-directory']});
 console.log(JSON.stringify(result));
}catch{console.error(JSON.stringify({error:'CUTOVER_CHECKPOINT_REJECTED',action:'Keep ingress and writers closed; inspect private operator evidence.'}));process.exitCode=1;}
finally{db?.close();await p?.close();await n?.close();}
