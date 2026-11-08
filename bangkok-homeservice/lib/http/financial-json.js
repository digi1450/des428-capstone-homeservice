import {AppError,BadRequestError} from '../errors.js';
export async function readFinancialJson(req){
 if(!req.body)return {};
 if(req.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json'||!['identity',null].includes(req.headers.get('content-encoding')))throw new AppError(415,'application/json required');
 const reader=req.body.getReader(),chunks=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>16384)throw new AppError(413,'financial body too large');chunks.push(value);}}
 finally{try{await reader.cancel();}catch{}}
 try{return size?JSON.parse(Buffer.concat(chunks).toString('utf8')):{};}catch{throw new BadRequestError('invalid financial JSON');}
}
