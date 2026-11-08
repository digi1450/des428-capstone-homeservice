// Explicit integration seam. No env auto-enable or fallback after remote ownership is selected.
import * as legacy from './service.js';
import {AppError,ForbiddenError} from '../../errors.js';
let runtime=null;
export function configurePaymentsAccess({paymentsClient,credentials,readSetup}={}) {
  if(!paymentsClient || ['getIntentForOrder','simulateSucceeded','getWallet','listCustomerTransactions'].some(name=>typeof paymentsClient[name]!=='function') || typeof credentials!=='function' || (readSetup!==undefined&&typeof readSetup!=='function')) throw new TypeError('Payments access requires a client and verified end-user credentials provider');
  runtime={paymentsClient,credentials,readSetup};return runtime;
}
export const getPaymentsAccess=()=>runtime;
export const resetPaymentsAccess=()=>{runtime=null;};
export async function getWalletView(auth,context) {
  if(auth.role!=='provider') throw new ForbiddenError('provider required');
  const access=runtime;
  if(!access) return legacy.getWallet(auth.sub);
  const wallet=await access.paymentsClient.getWallet(await access.credentials(auth,context));
  if(wallet.provider_id!==auth.sub) throw new AppError(503,'wallet owner not confirmed');
  return wallet;
}
export async function getTransactionView(auth,context) {
  if(auth.role!=='customer') throw new ForbiddenError('customer required');
  const access=runtime;
  if(!access) return legacy.listCustomerTransactions(auth.sub);
  return access.paymentsClient.listCustomerTransactions(await access.credentials(auth,context));
}
