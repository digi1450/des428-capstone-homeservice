import test from "node:test";
import assert from "node:assert/strict";

import { configureSecureBookingPayments } from "../lib/security/booking-payments.js";

test("rejects missing Payments service URL", () => {
  assert.throws(
    () =>
      configureSecureBookingPayments({
        tokenUrl: "http://localhost:8080/realms/homeservice/protocol/openid-connect/token",
        clientId: "booking-service",
        clientSecret: "test-secret",
        paymentsUrl: "",
      }),
    /Missing Payments service URL/
  );
});

test("rejects missing Keycloak client secret", () => {
  assert.throws(
    () =>
      configureSecureBookingPayments({
        tokenUrl: "http://localhost:8080/realms/homeservice/protocol/openid-connect/token",
        clientId: "booking-service",
        clientSecret: "",
        paymentsUrl: "http://localhost:3002",
      }),
    /Missing service token configuration/
  );
});

test("configures Booking Saga with service credentials", () => {
  const runtime = configureSecureBookingPayments({
    tokenUrl: "http://localhost:8080/realms/homeservice/protocol/openid-connect/token",
    clientId: "booking-service",
    clientSecret: "test-secret",
    paymentsUrl: "http://localhost:3002",
  });

  assert.equal(typeof runtime.credentials, "function");
  assert.equal(typeof runtime.payments.prepare, "function");
  assert.equal(typeof runtime.payments.cancel, "function");
});