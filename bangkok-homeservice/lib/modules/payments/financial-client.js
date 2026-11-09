import {AppError,BadRequestError,UnauthorizedError} from '../../errors.js';
import {financialInput,financialOutput,webhookInput,webhookResult} from './financial-validation.js';
export class FinancialOutcomeUnknownError extends AppError{constructor(reason){super(503,'financial outcome unknown');this.name='FinancialOutcomeUnknownError';this.reason=reason;}}
export class FinancialReconciliationError extends AppError{constructor(code){super(409,'financial reconciliation required');this.name='FinancialReconciliationError';this.code=code;}}
const codes=new Set(['FINANCIAL_COMMAND_CONFLICT','FINANCIAL_CONTEXT_MISMATCH','FINANCIAL_OPERATION_BLOCKED','FINANCIAL_LEGACY_RECONCILIATION_REQUIRED']);
export function createFinancialClient({baseUrl,timeoutMs=2000,fetchImpl=fetch}){
 const base=new URL(baseUrl);if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.pathname!=='/'||base.search||base.hash)throw new TypeError('Invalid financial origin');
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw new TypeError('Invalid financial deadline');
 async function request(path,method,body,credentials,expected){
  if(typeof credentials?.token!=='string'||! /^[^\s]+$/.test(credentials.token))throw new UnauthorizedError('missing financial bearer token');
  const headers={Authorization:'Bearer '+credentials.token};
  for(const [key,header] of [['requestId','X-Request-Id'],['traceparent','traceparent'],['tracestate','tracestate']])if(credentials[key]!==undefined){
   if(typeof credentials[key]!=='string'||!(key==='requestId'?/^[A-Za-z0-9._:-]{1,128}$/:/^[\x20-\x7e]{1,512}$/).test(credentials[key]))throw new BadRequestError('invalid financial metadata');headers[header]=credentials[key];
  }
  if(expected&&method==='POST')headers['Idempotency-Key']=expected.commandId;
  if(body!==undefined)headers['Content-Type']='application/json';
  let response,value;
  try{
   response=await fetchImpl(new URL(path,base),{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
   const type=response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
   if(type!=='application/json')throw Error('media');
   const reader=response.body?.getReader();if(!reader)throw Error('body');
   const parts=[];let size=0;
   try{for(;;){const {done,value:chunk}=await reader.read();if(done)break;size+=chunk.length;if(size>16384)throw Error('size');parts.push(chunk);}}
   finally{try{await reader.cancel();}catch{}}
   value=JSON.parse(Buffer.concat(parts).toString('utf8'));
  }catch{if([401,403].includes(response?.status))throw new AppError(response.status,'financial credentials rejected');if(response?.status===409)throw new FinancialReconciliationError();throw new FinancialOutcomeUnknownError('transport_or_invalid_body');}
  if([401,403].includes(response.status))throw new AppError(response.status,'financial credentials rejected');
  if([400,413,415].includes(response.status))throw new FinancialReconciliationError('INVALID_FINANCIAL_REQUEST');
  if(response.status===404)throw new FinancialOutcomeUnknownError('not_found');
  if(response.status===409&&(!expected||value?.state!=='attention'))throw new FinancialReconciliationError(codes.has(value?.code)?value.code:undefined);
  if(![200,202,409].includes(response.status))throw new FinancialOutcomeUnknownError('unexpected_status');
  if(!expected){
   if(response.status!==200)throw new FinancialOutcomeUnknownError('unexpected_callback_status');
   const ack=webhookResult.safeParse(value);if(!ack.success)throw new FinancialOutcomeUnknownError('invalid_callback');return ack.data;
  }
  let out;try{out=financialOutput(expected,value);}catch{if(response.status===409)throw new FinancialReconciliationError();throw new FinancialOutcomeUnknownError('mismatched_result');}
  if(method==='POST'&&response.status!==(out.state==='ready'?200:out.state==='pending'?202:409))throw new FinancialOutcomeUnknownError('mismatched_status');
  if(method==='GET'&&response.status!==200)throw new FinancialReconciliationError();
  return out;
 }
 return {
  complete(work,credentials){const expected=financialInput('completion',work);return request('/internal/booking-completions','POST',expected.request,credentials,expected);},
  cancel(work,credentials){const expected=financialInput('cancellation',work);return request('/internal/booking-cancellations','POST',expected.request,credentials,expected);},
  getOperation(work,credentials){const expected=financialInput(work?.kind,work);return request('/internal/financial-operations/'+encodeURIComponent(expected.commandId),'GET',undefined,credentials,expected);},
  settleWebhook(input,credentials){const value=webhookInput.safeParse(input);if(!value.success)throw new BadRequestError('invalid webhook');return request('/api/payments/webhook','POST',value.data,credentials);},
 };
}
