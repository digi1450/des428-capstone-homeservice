/**
 * Trusted server-to-server identity lookup. The identity owner must enforce a
 * unique (issuer,sub) binding and authorize this endpoint using its own service
 * credential. The caller never sends user-supplied role/domainId.
 */
export function createIdentityResolver({ url, token, fetchImpl = fetch } = {}) {
  if (!url || !token) throw new TypeError("Identity resolver URL and credential required");
  const endpoint = new URL(url);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash || endpoint.search)
    throw new TypeError("Identity resolver must be a trusted HTTPS endpoint");
  return async ({ issuer, sub }) => {
    if (typeof issuer !== "string" || typeof sub !== "string" || !sub) throw Error("invalid identity");
    const response = await fetchImpl(endpoint, {
      method: "POST",
      redirect: "error",
      headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ issuer, sub }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      if (response.status === 404 || response.status === 409) return null;
      throw Error("identity resolution unavailable");
    }
    const body = await response.json();
    if (!body || Object.keys(body).sort().join(",") !== "domainId,role") throw Error("invalid identity response");
    return body;
  };
}
