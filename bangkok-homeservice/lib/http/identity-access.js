// Explicit process-wide selection shared by route handlers and Server Components.
// Legacy JWT remains the default; selecting OIDC never falls back on auth failure.
let runtime=null;
export function configureIdentityAccess({read,logout}={}){
 if(typeof read!=='function'||typeof logout!=='function')throw new TypeError('Synchronous verified identity reader required');
 if(runtime)throw new Error('Request identity access already configured');
 runtime=Object.freeze({read,logout});return runtime;
}
export const getIdentityAccess=()=>runtime;
export const resetIdentityAccess=()=>{runtime=null;}; // drained teardown/tests only
