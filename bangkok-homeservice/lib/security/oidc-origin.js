// Canonical OIDC origin comes only from server configuration, never forwarded-host.
// Next14 reconstructs Request.url with its internal listener port behind TLS proxies.
export function oidcRequestUrl(request,{redirectUri=process.env.OIDC_REDIRECT_URI}={}){
 const actual=new URL(request.url);
 if(!redirectUri)return actual; // standalone logout/refresh tests and legacy non-integrated callers
 const callback=new URL(redirectUri);
 if(callback.username||callback.password||callback.search||callback.hash||callback.pathname!=='/api/auth/keycloak/callback'||
   (callback.protocol!=='https:'&&!(callback.protocol==='http:'&&['localhost','127.0.0.1'].includes(callback.hostname))))throw new Error('invalid configured callback');
 if(actual.origin!==callback.origin){
  // A trusted ingress must replace Host and X-Forwarded-Proto. Do not accept a
  // comma-separated chain, X-Forwarded-Host or a user-selected redirect target.
  if(request.headers.get('host')!==callback.host||request.headers.get('x-forwarded-proto')!==callback.protocol.slice(0,-1))throw new Error('origin mismatch');
 }
 actual.protocol=callback.protocol;actual.hostname=callback.hostname;actual.port=callback.port;return actual;
}
