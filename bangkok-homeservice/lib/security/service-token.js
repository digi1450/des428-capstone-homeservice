const REFRESH_BUFFER_MS = 30_000;

export function createServiceTokenProvider({
  tokenUrl,
  clientId,
  clientSecret,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  if (!tokenUrl || !clientId || !clientSecret) {
    throw new Error("Missing service token configuration");
  }

  const url = new URL(tokenUrl);

  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("Invalid token URL");
  }

  let cachedToken = null;
  let expiresAt = 0;
  let pendingRequest = null;

  async function requestToken() {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    });

    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error("Service token request failed");
    }

    const data = await response.json();

    if (
      typeof data.access_token !== "string" ||
      !data.access_token.trim() ||
      typeof data.token_type !== "string" ||
      data.token_type.toLowerCase() !== "bearer" ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0
    ) {
      throw new Error("Invalid service token response");
    }

    cachedToken = data.access_token;
    expiresAt = now() + data.expires_in * 1000;

    return cachedToken;
  }

  return async function credentials() {
    if (
      cachedToken &&
      now() < expiresAt - REFRESH_BUFFER_MS
    ) {
      return { token: cachedToken };
    }

    if (!pendingRequest) {
      pendingRequest = requestToken().finally(() => {
        pendingRequest = null;
      });
    }

    return { token: await pendingRequest };
  };
}