import {fork} from 'node:child_process';import {writeFileSync} from 'node:fs';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
export async function startResourceMonitor({project,directory}){
 const child=fork(fileURLToPath(new URL('./sampler.mjs',import.meta.url)),[project,directory],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
 let next=0;const waiting=new Map();
 child.on('message',message=>{const pending=waiting.get(message.id);if(pending){clearTimeout(pending.timer);waiting.delete(message.id);message.error?pending.reject(Error(message.error)):pending.resolve(message);}});
 child.on('exit',code=>{for(const pending of waiting.values()){clearTimeout(pending.timer);pending.reject(Error('Resource sampler exited '+code));}waiting.clear();});
 const request=type=>new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{waiting.delete(id);reject(Error('Resource sampler deadline'));},60000);waiting.set(id,{resolve,reject,timer});child.send({id,type});});
 await request('start');
 return {phase(name){writeFileSync(join(directory,'task6-phase.json'),JSON.stringify({phase:name}));},checkpoint:()=>request('checkpoint'),stop:async()=>{const r=await request('stop');child.disconnect();return r.summary;}};
}
