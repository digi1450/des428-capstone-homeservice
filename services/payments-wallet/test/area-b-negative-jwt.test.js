import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createBookingServiceVerifier, createGatewayWebhookVerifier } from "../src/security/booking-verifier.js";

const issuer = "https://keycloak.example.test/realms/homeservice";
const audience = "payments-wallet-service";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "area-b-negative-key", use: "sig", alg: "RS256" };
const now = 1_800_000_000_000;
const seconds = Math.floor(now / 1000);
const bookingRoles = ["create", "query", "cancel", "activate", "complete_financial", "cancel_financial", "query_financial"].map(operation => "booking:" + operation);
const gatewayRole = "mock-gateway:settle_webhook";

function token(overrides = {}, headerOverrides = {}) {
  const header = { alg: "RS256", kid: jwk.kid, ...headerOverrides };
  const payload = {
    iss: issuer, aud: audience, azp: "booking-service", sub: "service-account-booking",
    iat: seconds - 10, exp: seconds + 300,
    resource_access: { [audience]: { roles: bookingRoles } },
    ...overrides
  };
  const signingInput = [header, payload].map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
  return signingInput + "." + sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url");
}
const request = value => ({ get: name => name === "authorization" && value ? "Bearer " + value : undefined });
const options = {
  issuer, now: () => now,
  fetchImpl: async (_url, init) => {
    assert.equal(init.redirect, "error");
    return { ok: true, json: async () => ({ keys: [jwk] }) };
  }
};
const booking = createBookingServiceVerifier(options);
const gateway = createGatewayWebhookVerifier(options);
const rejected = (fn, status) => assert.rejects(fn, error => error.statusCode === status);

test("rejects missing, malformed, tampered, wrong-issuer, wrong-audience and expired JWTs", async () => {
  const valid = token();
  const parts = valid.split(".");
  const forgedPayload = Buffer.from(JSON.stringify({ sub: "attacker" })).toString("base64url");
  const invalidCases = [
    undefined, "not-a-jwt", parts[0] + "." + forgedPayload + "." + parts[2],
    token({ iss: issuer + "/wrong" }), token({ aud: "notifications-service" }),
    token({ exp: seconds - 1 }), token({ nbf: seconds + 30 }),
    token({ iat: seconds + 30 }), token({ sub: "" }),
    token({ azp: "mock-gateway-service" }),
    token({}, { alg: "HS256" }), token({}, { jku: "https://attacker.example/jwks" })
  ];
  for (const value of invalidCases) await rejected(booking(request(value), { operation: "create" }), 401);
});

test("rejects missing roles and cross-client impersonation", async () => {
  await rejected(booking(request(token({ resource_access: {} })), { operation: "create" }), 403);
  await rejected(booking(request(token({ resource_access: { [audience]: { roles: [gatewayRole] } } })), { operation: "create" }), 403);
  const gatewayToken = token({
    azp: "mock-gateway-service", sub: "service-account-gateway",
    resource_access: { [audience]: { roles: [gatewayRole] } }
  });
  await rejected(booking(request(gatewayToken), { operation: "create" }), 401);
  await rejected(gateway(request(token()), { operation: "settle_webhook" }), 401);
  await rejected(gateway(request(gatewayToken), { operation: "create" }), 403);
  await rejected(booking(request(token()), { operation: "settle_webhook" }), 403);
  assert.equal((await gateway(request(gatewayToken), { operation: "settle_webhook" })).service, "mock-gateway");
});

test("fails closed when trusted JWKS is unavailable", async () => {
  const offline = createBookingServiceVerifier({ ...options, fetchImpl: async () => { throw new Error("unavailable"); } });
  await rejected(offline(request(token()), { operation: "create" }), 503);
});
