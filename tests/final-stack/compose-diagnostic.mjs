// Public CI emits only these fixed labels, never Docker output/URLs/env values.
export function composeFailureDiagnostic(result) {
 const text=String(result.stdout ?? '')+'\n'+String(result.stderr ?? '');
 const categories=[];
 const rules=[
  ['registry-rate-limit',/toomanyrequests|too many requests|pull rate limit|429 Too Many/i],
  ['registry-auth',/pull access denied|unauthorized:|authentication required/i],
  ['registry-network',/TLS handshake timeout|i\/o timeout|dial tcp|network is unreachable|unexpected EOF|connection reset by peer/i],
  ['image-missing',/manifest unknown|manifest.*not found|no matching manifest/i],
  ['disk-full',/no space left on device/i],
  ['port-conflict',/port is already allocated|address already in use/i],
  ['container-unhealthy',/is unhealthy|unhealthy container/i],
  ['resource-exhaustion',/cannot allocate memory|resource temporarily unavailable|failed to create.*thread/i],
 ];
 for(const [label,pattern] of rules)if(pattern.test(text))categories.push(label);
 if(result.error?.code==='ENOBUFS')categories.push('capture-buffer-exceeded');
 if(result.error?.code==='ETIMEDOUT')categories.push('command-timeout');
 if(!categories.length)categories.push('unclassified');
 return {exitStatus:Number.isInteger(result.status)?result.status:null,
   signal:['SIGTERM','SIGKILL','SIGABRT'].includes(result.signal)?result.signal:null,
   categories};
}
