import {processState} from '../runtime/process-state.js';
// Explicit process-wide selection shared by route handlers and Server Components.
// Legacy JWT remains the default; selecting OIDC never falls back on auth failure.
const selection=processState('http/identity-access.js');
export function configureIdentityAccess({read,logout}={}){
 if(typeof read!=='function'||typeof logout!=='function')throw new TypeError('Synchronous verified identity reader required');
 if(selection.value)throw new Error('Request identity access already configured');
 selection.value=Object.freeze({read,logout});return selection.value;
}
export const getIdentityAccess=()=>selection.value;
export const resetIdentityAccess=()=>{selection.value=null;}; // drained teardown/tests only
