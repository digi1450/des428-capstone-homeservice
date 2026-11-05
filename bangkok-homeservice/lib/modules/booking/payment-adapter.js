// Prepared for C's durable Booking saga. Unused by the active Booking service.
// Input must be a trusted persisted Booking/pricing snapshot, never raw browser data.
// No transaction/slot mutation, SQL fallback, command ID generation or retries here.
import { z } from "zod";
import { BadRequestError } from "../../errors.js";
const id=z.number().int().positive().max(2147483647);
const key=z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const booking=z.object({id,customer_id:id,provider_id:id,total_cents:z.number().int().nonnegative().max(2147483647),payment_method:z.enum(["gateway","cod"])});
const flow=z.object({createCommandId:key,sagaId:key});
const cancellation=flow.extend({cancelCommandId:key,reason:z.enum(["booking_setup_failed","booking_finalization_failed"])});
function parse(schema,value,label) {
  const result=schema.safeParse(value);
  if (!result.success) throw new BadRequestError(`invalid booking payment ${label}`);
  return result.data;
}
function credentialsFor(credentials,commandId) {
  if (credentials?.commandId!==undefined && credentials.commandId!==commandId) throw new BadRequestError("conflicting payment command ID");
  return {...credentials,commandId};
}
export function createBookingPaymentsAdapter({paymentsClient}) {
  return {
    async prepare(order,workflow,credentials) {
      const snapshot=parse(booking,order,"snapshot");
      // Preserve original COD behavior: no intent, payment_intent omitted in JSON.
      if (snapshot.payment_method==="cod") return undefined;
      const operation=parse(flow,workflow,"workflow");
      return paymentsClient.createIntent({order_id:snapshot.id,customer_id:snapshot.customer_id,
        provider_id:snapshot.provider_id,amount_cents:snapshot.total_cents,currency:"THB",saga_id:operation.sagaId},
      credentialsFor(credentials,operation.createCommandId));
    },
    inspect(order,workflow,credentials) {
      const snapshot=parse(booking,order,"snapshot");
      if (snapshot.payment_method!=="gateway") throw new BadRequestError("COD booking has no payment operation");
      const operation=parse(flow,workflow,"workflow");
      return paymentsClient.getOperation({create_command_id:operation.createCommandId,saga_id:operation.sagaId,order_id:snapshot.id,amount_cents:snapshot.total_cents},credentials);
    },
    cancel(workflow,credentials) {
      const operation=parse(cancellation,workflow,"cancellation");
      if (operation.createCommandId===operation.cancelCommandId) throw new BadRequestError("create and cancel command IDs must differ");
      return paymentsClient.cancelIntent({create_command_id:operation.createCommandId,saga_id:operation.sagaId,reason:operation.reason},
        credentialsFor(credentials,operation.cancelCommandId));
    },
  };
}
