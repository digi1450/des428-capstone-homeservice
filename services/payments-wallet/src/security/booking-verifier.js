import { HttpError } from "../errors.js";
import { createPublicKey, verify as verifySignature } from "node:crypto";

const allowedOperations = new Set(["create", "query", "cancel", "activate", "complete_financial", "cancel_financial", "query_financial"]);
const base64url = value => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid JWT encoding");
  return Buffer.from(value, "base64url");
};
const decode = value => JSON.parse(base64url(value).toString("utf8"));
const unauthorized = () => new HttpError(401, "invalid token");
const forbidden = () => new HttpError(403, "forbidden");
const unavailable = () => new HttpError(503, "authentication unavailable");

/**
 * Keycloak RS256 verifier for Booking's machine-to-machine Payments calls.
 * JWKS location is derived exclusively from a trusted configured issuer.
 * Permissions use explicit Keycloak client roles, not arbitrary caller headers.
 * Does not enable production startup until wired and tested with the actual realm.
 */
export function createServiceVerifier({ issuer, audience = "payments-wallet-service", clientId, service, operations, fetchImpl = fetch, now = () => Date.now(), cacheMs = 60_000 } = {}) {
  if (typeof issuer !== "string" || !/^https:\/\//.test(issuer) || issuer.endsWith("/") || !audience || !clientId || !service || !Array.isArray(operations) || !operations.length) throw new TypeError("trusted HTTPS Keycloak issuer, audience and client ID required");
  const jwksUrl = new URL(issuer + "/protocol/openid-connect/certs");
  let keys = null;
  let updatedAt = 0;
  let pending = null;
  async function getKeys(refresh = false) {
    if (!refresh && keys && now() - updatedAt < cacheMs) return keys;
    if (!pending) pending = (async () => {
      const response = await fetchImpl(jwksUrl, { redirect: "error", signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw unavailable();
      const body = await response.json();
      if (!Array.isArray(body.keys)) throw unavailable();
      const next = new Map();
      for (const jwk of body.keys) {
        if (jwk && jwk.kty === "RSA" && jwk.use !== "enc" && (!jwk.alg || jwk.alg === "RS256") && typeof jwk.kid === "string" && jwk.kid && typeof jwk.n === "string" && typeof jwk.e === "string") { try { next.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" })); } catch { /* ignore invalid trusted-key entries */ } }
      }
      if (!next.size) throw unavailable();
      keys = next;
      updatedAt = now();
      return keys;
    })().catch(() => { throw unavailable(); }).finally(() => { pending = null; });
    return pending;
  }
  return async function authenticateService(req, { operation } = {}) {
    if (!operations.includes(operation)) throw forbidden();
    const authorization = req.get("authorization") ?? "";
    if (!/^Bearer [A-Za-z0-9._-]+$/.test(authorization)) throw unauthorized();
    const token = authorization.slice(7);
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some(x => !x)) throw unauthorized();
    let header, claims, signature;
    try { header = decode(parts[0]); claims = decode(parts[1]); signature = base64url(parts[2]); } catch { throw unauthorized(); }
    if (!header || typeof header !== "object" || !claims || typeof claims !== "object" || header.alg !== "RS256" || typeof header.kid !== "string" || header.jku || header.jwk || header.x5u || header.crit) throw unauthorized();
    let key = (await getKeys()).get(header.kid);
    if (!key) key = (await getKeys(true)).get(header.kid);
    if (!key || !verifySignature("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), key, signature)) throw unauthorized();
    const seconds = Math.floor(now() / 1000);
    if (claims.iss !== issuer || !(claims.aud === audience || (Array.isArray(claims.aud) && claims.aud.includes(audience))) ||
        typeof claims.exp !== "number" || !Number.isSafeInteger(claims.exp) || claims.exp <= seconds ||
        (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > seconds)) ||
        (claims.iat !== undefined && (!Number.isSafeInteger(claims.iat) || claims.iat > seconds)) ||
        typeof claims.sub !== "string" || !claims.sub || claims.azp !== clientId) throw unauthorized();
    const roles = claims.resource_access?.[audience]?.roles;
    if (!Array.isArray(roles) || !roles.includes(service + ":" + operation)) throw forbidden();
    const callerId = issuer + "|" + claims.sub;
    if (!/^[\x21-\x7e]{1,256}$/.test(callerId)) throw unauthorized();
    return { service, callerId };
  };
}

export function createBookingServiceVerifier(options = {}) {
  return createServiceVerifier({ ...options, clientId: options.clientId ?? "booking-service", service: "booking", operations: [...allowedOperations] });
}

export function createGatewayWebhookVerifier(options = {}) {
  return createServiceVerifier({ ...options, clientId: options.clientId ?? "mock-gateway-service", service: "mock-gateway", operations: ["settle_webhook"] });
}
