import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOidcSessionStore} from '../lib/security/oidc-session-store.js';
export function oidcSessionFixture(t,{secret,now=Date.now}={}){
 const directory=mkdtempSync(join(tmpdir(),'homeservice-oidc-session-'));
 const path=join(directory,'sessions.sqlite');
 t.after(()=>rmSync(directory,{recursive:true,force:true}));
 return {path,issue(value){const store=createOidcSessionStore({path,secret,now});try{return store.create(value);}finally{store.close();}}};
}
