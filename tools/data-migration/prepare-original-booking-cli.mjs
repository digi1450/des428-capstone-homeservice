import {parseArgs} from 'node:util';
import {createRequire} from 'node:module';
import {realpathSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {loadApprovedSnapshot} from './approved-snapshot.mjs';
import {prepareOriginalBooking} from './original-booking-schema.mjs';
const Database=createRequire(new URL('../../bangkok-homeservice/package.json',import.meta.url))('better-sqlite3');
let db;
try{
 const {values:v,positionals}=parseArgs({allowPositionals:true,options:{directory:{type:'string'},'approved-manifest-sha256':{type:'string'},apply:{type:'boolean',default:false}}});
 if(positionals.length!==1)throw Error('one existing prepared copy required');
 const artifact=join(v.directory,'source.sqlite'),targetStat=statSync(positionals[0]),sourceStat=statSync(artifact);
 if(realpathSync(positionals[0])===realpathSync(artifact)||(targetStat.dev===sourceStat.dev&&targetStat.ino===sourceStat.ino))throw Error('separate existing prepared copy required');
 const approved=await loadApprovedSnapshot(v.directory,v['approved-manifest-sha256']);
 db=new Database(positionals[0],{fileMustExist:true});db.pragma('foreign_keys=ON');db.pragma('busy_timeout=3000');
 console.log(JSON.stringify(prepareOriginalBooking(db,approved,{apply:v.apply})));
}catch{console.error(JSON.stringify({error:'ORIGINAL_BOOKING_PREPARATION_REJECTED',action:'Keep useful source unchanged; inspect the reviewed source/schema and private evidence.'}));process.exitCode=1;}
finally{db?.close();}
