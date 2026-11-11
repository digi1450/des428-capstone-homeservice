import {createServiceVerifier} from '../../services/payments-wallet/src/security/booking-verifier.js';
export function createCutoverOperatorVerifier({issuer,fetchImpl=fetch,now}={}){
 const verify=createServiceVerifier({issuer,audience:'homeservice-cutover',clientId:'homeservice-cutover-operator',service:'cutover',operations:['approve_checkpoint','revoke_checkpoint'],fetchImpl,now});
 return (token,operation)=>verify({get:name=>name.toLowerCase()==='authorization'?'Bearer '+token:undefined},{operation});
}
