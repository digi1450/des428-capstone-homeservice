import {generateKeyPairSync} from 'node:crypto';
import {writeFileSync,lstatSync,existsSync} from 'node:fs';
import {dirname} from 'node:path';
try{const [file,pub]=process.argv.slice(2);if(process.argv.length!==4||existsSync(file)||existsSync(pub)||!lstatSync(dirname(file)).isDirectory()||(lstatSync(dirname(file)).mode&0o077))throw Error('private directory required');const pair=generateKeyPairSync('ed25519');writeFileSync(file,pair.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600,flag:'wx'});writeFileSync(pub,pair.publicKey.export({type:'spki',format:'pem'}),{mode:0o644,flag:'wx'});console.log('{"created":true}');}catch{console.error('{"error":"CHECKPOINT_KEYS_NOT_CREATED"}');process.exitCode=1;}
