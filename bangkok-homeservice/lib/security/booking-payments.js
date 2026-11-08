import { createServiceTokenProvider } from "./service-token.js";
import { createPaymentsClient } from "../modules/payments/client.js";
import { createBookingPaymentsAdapter } from "../modules/booking/payment-adapter.js";
import {configureBookingPaymentsRuntime} from "../modules/booking/payment-runtime.js";
import { configureBookingSaga } from "../modules/booking/saga.js";

export function configureSecureBookingPayments({
  tokenUrl = process.env.BOOKING_SERVICE_TOKEN_URL,
  clientId = process.env.BOOKING_SERVICE_CLIENT_ID,
  clientSecret = process.env.BOOKING_SERVICE_CLIENT_SECRET,
  paymentsUrl = process.env.PAYMENTS_SERVICE_URL,
  userCredentials,
  sagaOptions,
  recoveryIntervalMs,
} = {}) {
  if (!paymentsUrl) {
    throw new Error("Missing Payments service URL");
  }

  const credentials = createServiceTokenProvider({
    tokenUrl,
    clientId,
    clientSecret,
  });

  const paymentsClient = createPaymentsClient({
    baseUrl: paymentsUrl,
  });

  if(userCredentials!==undefined){
    return configureBookingPaymentsRuntime({paymentsClient,serviceCredentials:credentials,userCredentials,sagaOptions,recoveryIntervalMs});
  }

  const payments = createBookingPaymentsAdapter({
    paymentsClient,
  });

  return configureBookingSaga({
    payments,
    credentials,
  });
}