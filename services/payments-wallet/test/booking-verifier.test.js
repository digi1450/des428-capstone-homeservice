import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createBookingServiceVerifier } from "../src/security/booking-verifier.js";

const issuer = "https://keycloak.example.test/realms/homeservice";
const audience = "payments-wallet-service";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "key-1", alg: "RS256", use: "sig" };
const now = 1_800_000_000_000;
const base = {
  iss: issuer, aud: audience, azp: "booking-service", sub: "service-account-booking",
  exp: Math.floor(now / 1000) + 300,
  resource_access: { [audience]: { roles: ["booking:create", "booking:query", "booking:cancel", "booking:activate", "booking:complete_financial", "booking:cancel_financial", "booking:query_financial"] } }
};
function token(claims = {}, header = {}) {
  const h = Buffer.from(JSON.stringify({ alg: "RS256", kid: "key-1", ...header })).toString("base64url");
  const p = Buffer.from(JSON.stringify({ ...base, ...claims })).toString("base64url");
  const s = sign("RSA-SHA256", Buffer.from(h + "." + p), privateKey).toString("base64url");
  return h + "." + p + "." + s;
}
function verifier(options = {}) {
  return createBookingServiceVerifier({
    issuer, now: () => now,
    fetchImpl: async (_url, init) => {
      assert.equal(init.redirect, "error");
      return { ok: true, json: async () => ({ keys: [jwk] }) };
    },
    ...options
  });
}
const req = value => ({ get: name => name === "authorization" ? "Bearer " + value : undefined });
test("accepts verified Booking client and stable caller across fresh tokens", async () => {
  const authenticate = verifier();
  const first = await authenticate(req(token()), { operation: "create" });
  const second = await authenticate(req(token({ jti: "different-token" })), { operation: "create" });
  assert.deepEqual(first, second);
  assert.equal(first.service, "booking");
});
test("rejects wrong issuer, audience, client, expired, future and malformed tokens", async () => {
  const authenticate = verifier();
  for (const bad of [
    token({ iss: issuer + "-evil" }), token({ aud: "notifications-service" }),
    token({ azp: "other-service" }), token({ exp: Math.floor(now / 1000) - 1 }),
    token({ nbf: Math.floor(now / 1000) + 30 }), token({ iat: Math.floor(now / 1000) + 30 }),
    "bad.token.value", token({}, { alg: "HS256" }), token({}, { jku: "https://evil.test/jwks" })
  ]) await assert.rejects(authenticate(req(bad), { operation: "create" }), error => error.statusCode === 401);
});
test("rejects tampering, missing permission and unsupported operation", async () => {
  const authenticate = verifier();
  const valid = token();
  const parts = valid.split(".");
  const tampered = parts[0] + "." + Buffer.from(JSON.stringify({ ...base, sub: "attacker" })).toString("base64url") + "." + parts[2];
  await assert.rejects(authenticate(req(tampered), { operation: "create" }), error => error.statusCode === 401);
  await assert.rejects(authenticate(req(token({ resource_access: {} })), { operation: "create" }), error => error.statusCode === 403);
  await assert.rejects(authenticate(req(valid), { operation: "unknown" }), error => error.statusCode === 403);
});
test("unavailable trusted keys fail closed", async () => {
  const authenticate = verifier({ fetchImpl: async () => { throw new Error("offline"); } });
  await assert.rejects(authenticate(req(token()), { operation: "create" }), error => error.statusCode === 503);
});
test("new trusted signing kid refreshes JWKS", async () => {
  let calls = 0;
  const authenticate = verifier({ fetchImpl: async () => {
    calls++;
    return { ok: true, json: async () => ({ keys: calls === 1 ? [{ ...jwk, kid: "old-key" }] : [jwk] }) };
  } });
  const result = await authenticate(req(token()), { operation: "query" });
  assert.equal(result.service, "booking");
  assert.equal(calls, 2);
});
