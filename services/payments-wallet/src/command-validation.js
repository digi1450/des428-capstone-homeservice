import { HttpError } from './errors.js';
import { id, cents } from './validation.js';

const keyPattern = /^(?!\.{1,2}$)[A-Za-z0-9._:-]{1,128}$/;
export function commandKey(value) {
  if (typeof value !== 'string' || !keyPattern.test(value)) throw new HttpError(400,'invalid command identity');
  return value;
}
function object(value, fields) {
  if (!value || Array.isArray(value) || typeof value !== 'object' ||
      Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value,key))) {
    throw new HttpError(400,'invalid payment command fields');
  }
  return value;
}
export function createCommand(value) {
  const body = object(value,['order_id','customer_id','provider_id','amount_cents','currency','saga_id']);
  id(body.order_id); id(body.customer_id); id(body.provider_id); cents(body.amount_cents);
  if (body.currency !== 'THB') throw new HttpError(400,'unsupported currency');
  commandKey(body.saga_id);
  return {...body};
}
export function cancelCommand(value, commandId) {
  const body = object(value,['create_command_id','saga_id','reason']);
  commandKey(body.create_command_id); commandKey(body.saga_id);
  if (!['booking_setup_failed','booking_finalization_failed'].includes(body.reason)) throw new HttpError(400,'invalid cancellation reason');
  if (body.create_command_id === commandId) throw new HttpError(400,'create and cancel identities must differ');
  return {...body};
}
function intent(value) {
  const row = object(value,['id','order_id','amount_cents','gateway_ref','status']);
  id(row.id);id(row.order_id);cents(row.amount_cents);
  if (typeof row.gateway_ref !== 'string' || !row.gateway_ref || !['requires_payment','succeeded','failed'].includes(row.status)) {
    throw new HttpError(400,'invalid payment intent');
  }
  return {...row};
}
// Validate the seam's result before publishing any successful HTTP response.
export function commandOutcome(value, {createCommandId,sagaId,orderId,amountCents,expectedOutcome} = {}) {
  try {
    if (!['created','cancelled'].includes(value?.outcome)) throw new Error('outcome');
    object(value,value.outcome === 'created' ? ['create_command_id','saga_id','outcome','payment_intent'] : ['create_command_id','saga_id','outcome']);
    commandKey(value.create_command_id);commandKey(value.saga_id);
    if (value.create_command_id !== createCommandId || (sagaId !== undefined && value.saga_id !== sagaId) ||
        (expectedOutcome && value.outcome !== expectedOutcome)) throw new Error('identity');
    if (value.outcome === 'created') {
      const payment = intent(value.payment_intent);
      if (payment.status === 'failed' || (orderId !== undefined && payment.order_id !== orderId) ||
          (amountCents !== undefined && payment.amount_cents !== amountCents)) throw new Error('context');
      return {...value,payment_intent:payment};
    }
    return {...value};
  } catch { throw new HttpError(503,'payment command result not confirmed'); }
}
