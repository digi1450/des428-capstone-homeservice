import {processState} from '../../runtime/process-state.js';
import {getPaymentsAccess} from './access.js';
import {getBookingFinancialAccess} from '../booking/financial-state.js';
import {webhookInput,webhookResult} from './financial-validation.js';
import {AppError,BadRequestError} from '../../errors.js';
const selection=processState('modules/payments/webhook-access.js');
export function configureWebhookAccess({financialClient,credentials}={}){
 if(typeof financialClient?.settleWebhook!=='function'||typeof credentials!=='function')throw new TypeError('Webhook client and verified gateway credentials required');
 if(selection.value)throw new Error('Webhook access already configured');selection.value=Object.freeze({financialClient,credentials});return selection.value;
}
export const getWebhookAccess=()=>selection.value;
export const resetWebhookAccess=()=>{selection.value=null;};
export const remoteWebhookSelected=()=>!!selection.value||!!getPaymentsAccess()||!!getBookingFinancialAccess();
export async function forwardFinancialWebhook(req,input){
 const value=webhookInput.safeParse(input);if(!value.success)throw new BadRequestError('invalid webhook');
 const access=selection.value;if(!access)throw new AppError(503,'remote webhook unavailable');
 const result=webhookResult.safeParse(await access.financialClient.settleWebhook(value.data,await access.credentials(req)));
 if(!result.success)throw new AppError(503,'webhook result not confirmed');return result.data;
}
