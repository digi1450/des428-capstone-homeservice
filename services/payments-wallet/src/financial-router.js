import express,{Router} from 'express';
import {HttpError} from './errors.js';
import {financialRequest,financialKey,financialResult,webhookRequest,webhookAck} from './financial-validation.js';
export function createFinancialRouter({authenticateService,financialOperations,authenticateWebhook,payments}){
 const router=Router(),json=express.json({limit:'16kb',strict:true,inflate:false});
 const authorize=(verifier,operation,service)=>async(req,_res,next)=>{
  if(typeof verifier!=='function')throw new HttpError(503,'financial authentication not configured');
  if(!/^Bearer [^\s]+$/i.test(req.get('authorization')??''))throw new HttpError(401,'missing financial bearer token');
  const who=await verifier(req,{operation});
  if(!who||typeof who.callerId!=='string'||! /^[\x21-\x7e]{1,256}$/.test(who.callerId))throw new HttpError(401,'invalid financial principal');
  if(who.service!==service)throw new HttpError(403,'financial principal forbidden');
  req.financialCallerId=who.callerId;next();
 };
 const parse=(req,res,next)=>{if(!req.is('application/json'))throw new HttpError(415,'application/json required');json(req,res,next);};
 const configured=name=>(_req,_res,next)=>{if(typeof financialOperations?.[name]!=='function')throw new HttpError(503,'financial participant not configured');next();};
 const metadata=req=>{const out={requestId:req.requestId};for(const k of ['traceparent','tracestate']){const v=req.get(k);if(typeof v==='string'&&/^[\x20-\x7e]{1,512}$/.test(v))out[k]=v;}return out;};
 for(const [path,kind,method] of [['booking-completions','completion','complete'],['booking-cancellations','cancellation','cancel']]){
  router.post('/internal/'+path,authorize(authenticateService,method+'_financial','booking'),configured(method),parse,async(req,res)=>{
   if(Object.keys(req.query).length)throw new HttpError(400,'unexpected financial query');
   const commandId=financialKey(req.get('Idempotency-Key')),request=financialRequest(kind,commandId,req.body);
   const out=await financialOperations[method]({callerId:req.financialCallerId,commandId,request:structuredClone(request),context:metadata(req)});
   if(!out||Object.keys(out).sort().join(',')!=='replayed,result'||typeof out.replayed!=='boolean')throw new HttpError(503,'financial wrapper not confirmed');
   const result=financialResult(kind,commandId,request,out.result);
   res.status(result.state==='ready'?200:result.state==='pending'?202:409).json(result);
  });
 }
 router.get('/internal/financial-operations/:command_id',authorize(authenticateService,'query_financial','booking'),configured('get'),async(req,res)=>{
  if(Object.keys(req.query).length)throw new HttpError(400,'unexpected financial query');
  const commandId=financialKey(req.params.command_id);
  const out=await financialOperations.get({callerId:req.financialCallerId,commandId,context:metadata(req)});
  if(out==null)throw new HttpError(404,'financial operation unknown');
  const kind=commandId.startsWith('complete:')?'completion':'cancellation';
  let expected;try{expected=financialRequest(kind,commandId,out.request);}catch{throw new HttpError(503,'financial lookup not confirmed');}
  res.json(financialResult(kind,commandId,expected,out));
 });
 router.post('/api/payments/webhook',authorize(authenticateWebhook,'settle_webhook','mock-gateway'),(req,_res,next)=>{
  if(typeof payments?.settleWebhook!=='function')throw new HttpError(503,'webhook business not configured');next();
 },parse,async(req,res)=>{
  if(Object.keys(req.query).length)throw new HttpError(400,'unexpected callback query');
  const input=webhookRequest(req.body),result=await payments.settleWebhook(input);
  res.json(webhookAck({received:true,...result}));
 });
 router.use((error,_req,res,next)=>{
  if(error.type==='entity.parse.failed'||error instanceof URIError)error=new HttpError(400,'invalid financial JSON or encoding');
  else if(error.type==='entity.too.large')error=new HttpError(413,'financial body too large');
  else if(['encoding.unsupported','charset.unsupported'].includes(error.type))error=new HttpError(415,'unsupported financial encoding');
  if(error instanceof HttpError&&error.statusCode===503)res.set('Retry-After','2');next(error);
 });return router;
}
