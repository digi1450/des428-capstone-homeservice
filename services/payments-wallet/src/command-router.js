import express, { Router } from 'express';
import { HttpError } from './errors.js';
import { commandKey, createCommand, cancelCommand, activateCommand, activationOutcome, commandOutcome } from './command-validation.js';

// B/C integration seam. Production runtime composes C; B verification remains required.
// No direct call to prepareIntent/voidUnpaidIntent can substitute for C's durable store/fence.
export function createPaymentCommandRouter({ authenticateService, paymentCommands }) {
  const router = Router();
  const json = express.json({limit:'16kb',strict:true,inflate:false});
  const authorize = operation => async (req,_res,next) => {
    if (typeof authenticateService !== 'function') throw new HttpError(503,'service authentication not configured');
    if (!/^Bearer [^\s]+$/i.test(req.get('authorization') ?? '')) throw new HttpError(401,'missing service bearer token');
    const who = await authenticateService(req,{operation});
    if (!who || typeof who.callerId !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(who.callerId)) throw new HttpError(401,'invalid service principal');
    if (who.service !== 'booking') throw new HttpError(403,'booking service required');
    req.commandCallerId = who.callerId;
    next();
  };
  const configured = method => (_req,_res,next) => {
    if (typeof paymentCommands?.[method] !== 'function') throw new HttpError(503,'payment participant not configured');
    next();
  };
  const metadata = req => {
    const output = {requestId:req.requestId};
    for (const key of ['traceparent','tracestate']) {
      const value=req.get(key);
      if (typeof value === 'string' && /^[\x20-\x7e]{1,512}$/.test(value)) output[key]=value;
    }
    return output;
  };
  const parseJson = (req,res,next) => {
    if (!req.is('application/json')) throw new HttpError(415,'application/json required');
    json(req,res,next);
  };
  router.post('/payment-intents',authorize('create'),configured('create'),parseJson,async (req,res) => {
    const commandId=commandKey(req.get('Idempotency-Key'));
    const request=createCommand(req.body);
    const output=await paymentCommands.create({callerId:req.commandCallerId,commandId,request,context:metadata(req)});
    if (!output || typeof output.replayed !== 'boolean' || Object.keys(output).sort().join(',') !== 'replayed,result') throw new HttpError(503,'invalid participant response');
    const result=commandOutcome(output.result,{createCommandId:commandId,sagaId:request.saga_id,orderId:request.order_id,amountCents:request.amount_cents,expectedOutcome:'created'});
    res.status(output.replayed ? 200 : 201).json(result);
  });
  router.get('/payment-operations/:create_command_id',authorize('query'),configured('get'),async (req,res) => {
    const createCommandId=commandKey(req.params.create_command_id);
    if (Object.keys(req.query).length) throw new HttpError(400,'unexpected query fields');
    const output=await paymentCommands.get({callerId:req.commandCallerId,createCommandId,context:metadata(req)});
    if (output == null) throw new HttpError(404,'payment operation not found');
    res.json(commandOutcome(output,{createCommandId}));
  });
  router.post('/payment-intents/cancel-by-command',authorize('cancel'),configured('cancel'),parseJson,async (req,res) => {
    const commandId=commandKey(req.get('Idempotency-Key'));
    const request=cancelCommand(req.body,commandId);
    const output=await paymentCommands.cancel({callerId:req.commandCallerId,commandId,request,context:metadata(req)});
    res.json(commandOutcome(output,{createCommandId:request.create_command_id,sagaId:request.saga_id,expectedOutcome:'cancelled'}));
  });
  // C checks effective eligibility/fences even on replay; no historical activation shortcut here.
  router.post('/payment-intents/activate-by-command',authorize('activate'),configured('activate'),parseJson,async (req,res) => {
    const commandId=commandKey(req.get('Idempotency-Key'));
    const request=activateCommand(req.body,commandId);
    const output=await paymentCommands.activate({callerId:req.commandCallerId,commandId,request,context:metadata(req)});
    res.json(activationOutcome(output,{createCommandId:request.create_command_id,sagaId:request.saga_id}));
  });
  router.use((error,_req,res,next) => {
    if (error.type === 'entity.parse.failed' || error instanceof URIError) error=new HttpError(400,'invalid JSON or route encoding');
    else if (error.type === 'entity.too.large') error=new HttpError(413,'command body too large');
    else if (error.type === 'encoding.unsupported' || error.type === 'charset.unsupported') error=new HttpError(415,'unsupported command encoding');
    if (error instanceof HttpError && error.statusCode === 503) res.set('Retry-After','2');
    next(error);
  });
  return router;
}
