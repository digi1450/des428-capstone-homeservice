import {getPaymentsAccess} from './access.js';
import {getBookingFinancialAccess} from '../booking/financial-state.js';
import {webhookInput,webhookResult} from './financial-validation.js';
import {AppError,BadRequestError} from '../../errors.js';
let runtime=null;
export function configureWebhookAccess({financialClient,credentials}={}){
 if(typeof financialClient?.settleWebhook!=='function'||typeof credentials!=='function')throw new TypeError('Webhook client and verified gateway credentials required');
 if(runtime)throw new Error('Webhook access already configured');runtime=Object.freeze({financialClient,credentials});return runtime;
}
export const getWebhookAccess=()=>runtime;
export const resetWebhookAccess=()=>{runtime=null;};
export const remoteWebhookSelected=()=>!!runtime||!!getPaymentsAccess()||!!getBookingFinancialAccess();
export async function forwardFinancialWebhook(req,input){
 const value=webhookInput.safeParse(input);if(!value.success)throw new BadRequestError('invalid webhook');
 const access=runtime;if(!access)throw new AppError(503,'remote webhook unavailable');
 const result=webhookResult.safeParse(await access.financialClient.settleWebhook(value.data,await access.credentials(req)));
 if(!result.success)throw new AppError(503,'webhook result not confirmed');return result.data;
}
