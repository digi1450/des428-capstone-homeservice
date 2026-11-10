// Read-only, no-network helper. Receives ONLY explicitly selected container IDs.
import {readFileSync,existsSync} from 'node:fs';import {createInterface} from 'node:readline';
for await(const line of createInterface({input:process.stdin})){
 try{
  const ids=JSON.parse(line);if(!Array.isArray(ids)||ids.some(id=>!/^[a-f0-9]{64}$/.test(id)))throw Error('invalid IDs');
  const rows=ids.map(id=>{
   const path=['/host-cgroup/docker/'+id,'/host-cgroup/system.slice/docker-'+id+'.scope'].find(existsSync);
   if(!path)return{id,missing:true};
   try{
    const integer=file=>{const value=Number(readFileSync(path+'/'+file,'utf8').trim());if(!Number.isSafeInteger(value)||value<0)throw Error('invalid counter');return value;};
    const events=Object.fromEntries(readFileSync(path+'/memory.events','utf8').trim().split('\n').map(l=>{const [k,v]=l.split(' ');return[k,Number(v)];}));
    return{id,current:integer('memory.current'),peak:integer('memory.peak'),swap:integer('memory.swap.current'),oom:events.oom??0,oomKill:events.oom_kill??0};
   }catch{return{id,missing:true};}
  });console.log(JSON.stringify({rows}));
 }catch{console.log(JSON.stringify({error:'cgroup read failed'}));}
}
