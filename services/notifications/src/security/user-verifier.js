import { createPublicKey, verify } from "node:crypto";
import { HttpError } from "../errors.js";

const fail = status => new HttpError(status, status === 401 ? "invalid token" : status === 403 ? "forbidden" : "authentication unavailable");
const parse = value => JSON.parse(Buffer.from(value, "base64url").toString("utf8"));

/**
 * A trusted identity resolver is mandatory: it owns the (issuer, sub) -> (role, domainId)
 * binding. Do not derive a domain ID from Keycloak sub, client-controlled claims or headers.
 * Resolver must fail closed on missing, duplicate or conflicting identities.
 */
export function createUserVerifier({ issuer, audience, resolveIdentity, fetchImpl = fetch, now = () => Date.now() } = {}) {
  if (typeof issuer !== "string" || !issuer.startsWith("https://") || issuer.endsWith("/") ||
      !/^[a-z0-9-]+-service$/.test(audience ?? "") || typeof resolveIdentity !== "function")
    throw new TypeError("trusted issuer, service audience and identity resolver required");
  const url = issuer + "/protocol/openid-connect/certs";
  let cache, expires = 0;
  let loading;
  async function keys(force = false) {
    if (!force && cache && now() < expires) return cache;
    if (!loading) loading = (async () => {
      const response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw Error("jwks unavailable");
      const json = await response.json();
      if (!Array.isArray(json.keys)) throw Error("invalid jwks");
      const next = new Map();
      for (const k of json.keys) {
        if (k?.kty === "RSA" && k.use !== "enc" && (!k.alg || k.alg === "RS256") &&
            typeof k.kid === "string" && k.kid && typeof k.n === "string" && typeof k.e === "string")
          next.set(k.kid, createPublicKey({ key: k, format: "jwk" }));
      }
      if (!next.size) throw Error("empty jwks");
      cache = next;
      expires = now() + 60_000;
      return cache;
    })().catch(() => { throw fail(503); }).finally(() => { loading = null; });
    return loading;
  }
  return async function authenticate(req) {
    const bearer = req.get("authorization") ?? "";
    if (!/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(bearer)) throw fail(401);
    const raw = bearer.slice(7);
    const [a,b,c] = raw.split(".");
    let header, claims, signature;
    try {
      header = parse(a); claims = parse(b); signature = Buffer.from(c, "base64url");
    } catch { throw fail(401); }
    if (header?.alg !== "RS256" || typeof header.kid !== "string" ||
        header.jku || header.jwk || header.x5u || header.crit) throw fail(401);
    let key = (await keys()).get(header.kid);
    if (!key) key = (await keys(true)).get(header.kid);
    if (!key || !verify("RSA-SHA256", Buffer.from(a + "." + b), key, signature)) throw fail(401);
    const seconds = Math.floor(now()/1000);
    if (claims?.iss !== issuer ||
        !(claims.aud === audience || (Array.isArray(claims.aud) && claims.aud.includes(audience))) ||
        !Number.isSafeInteger(claims.exp) || claims.exp <= seconds ||
        (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > seconds)) ||
        (claims.iat !== undefined && (!Number.isSafeInteger(claims.iat) || claims.iat > seconds)) ||
        typeof claims.sub !== "string" || !claims.sub) throw fail(401);
    // Require a verified user-facing client and a service-specific audience.
    if (claims.azp !== "homeservice-web") throw fail(403);
    const roles = claims.resource_access?.[audience]?.roles;
    if (!Array.isArray(roles) || !roles.includes("user:read")) throw fail(403);
    let identity;
    try { identity = await resolveIdentity({ issuer, sub: claims.sub }); }
    catch { throw fail(503); }
    if (!identity || !["customer","provider","admin"].includes(identity.role) ||
        !Number.isInteger(identity.domainId) || identity.domainId < 1 || identity.domainId > 2147483647)
      throw fail(401);
    return { role: identity.role, domainId: identity.domainId };
  };
}
