import {getWebhookAccess} from './webhook-access.js';
import {getPaymentsAccess} from './access.js';
import {getBookingFinancialAccess} from '../booking/financial-state.js';
import * as bookingRepository from '../booking/repository.js';
export const financialModeEnabled=()=>!!getBookingFinancialAccess()||!!getPaymentsAccess()||!!getWebhookAccess();
export const usesRemotePayments=orderId=>financialModeEnabled()||!!bookingRepository.findSagaByOrderId(orderId);
