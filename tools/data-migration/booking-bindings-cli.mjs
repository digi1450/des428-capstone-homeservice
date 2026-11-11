import {createRequire} from 'node:module';
const require=createRequire(new URL('../../bangkok-homeservice/package.json',import.meta.url));
const Database=require('better-sqlite3');
import {loadApprovedSnapshot} from './approved-snapshot.mjs';
import {importBookingBindings} from './booking-bindings.mjs';
let db;
try{
 const [target,directory,flag,digest,apply,...extra]=process.argv.slice(2);
 if(!target||!directory||flag!=='--expected-manifest-sha256'||!digest||(apply&&apply!=='--apply')||extra.length)throw Error('USAGE');
 const approved=await loadApprovedSnapshot(directory,digest);
 db=new Database(target,{fileMustExist:true});
 db.pragma('foreign_keys=ON');db.pragma('busy_timeout=3000');
 console.log(JSON.stringify(importBookingBindings(db,approved,{apply:apply==='--apply'})));
}catch{console.error(JSON.stringify({error:'BOOKING_BINDING_IMPORT_REJECTED'}));process.exitCode=1;}
finally{db?.close();}
