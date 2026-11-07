import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createServiceTokenProvider } from "../lib/security/service-token.js";

const config = {
  tokenUrl: "http://localhost:8080/realms/homeservice/protocol/openid-connect/token",
  clientId: "booking-service",
  clientSecret: "test-secret",
};

function mockResponse(token, expiresIn = 300) {
  return {
    ok: true,
    async json() {
      return {
        access_token: token,
        token_type: "Bearer",
        expires_in: expiresIn,
      };
    },
  };
}

test("requests a service token using client credentials", async () => {
  let requests = 0;

  const credentials = createServiceTokenProvider({
    ...config,
    fetchImpl: async (_url, options) => {
      requests++;
      assert.equal(options.method, "POST");
      assert.equal(options.body.get("grant_type"), "client_credentials");
      assert.equal(options.body.get("client_id"), "booking-service");
      assert.equal(options.body.get("client_secret"), "test-secret");
      return mockResponse("token-1");
    },
  });

  assert.deepEqual(await credentials(), { token: "token-1" });
  assert.equal(requests, 1);
});

test("reuses cached token", async () => {
  let requests = 0;

  const credentials = createServiceTokenProvider({
    ...config,
    fetchImpl: async () => {
      requests++;
      return mockResponse("cached-token");
    },
  });

  await credentials();
  await credentials();

  assert.equal(requests, 1);
});

test("refreshes token before expiration", async () => {
  let currentTime = 0;
  let requests = 0;

  const credentials = createServiceTokenProvider({
    ...config,
    now: () => currentTime,
    fetchImpl: async () => {
      requests++;
      return mockResponse(`token-${requests}`, 300);
    },
  });

  assert.equal((await credentials()).token, "token-1");

  currentTime = 260_000;
  assert.equal((await credentials()).token, "token-1");

  currentTime = 271_000;
  assert.equal((await credentials()).token, "token-2");

  assert.equal(requests, 2);
});

test("shares one request between concurrent callers", async () => {
  let requests = 0;

  const credentials = createServiceTokenProvider({
    ...config,
    fetchImpl: async () => {
      requests++;
      await Promise.resolve();
      return mockResponse("shared-token");
    },
  });

  const results = await Promise.all([
    credentials(),
    credentials(),
    credentials(),
  ]);

  assert.equal(requests, 1);
  assert.deepEqual(results, [
    { token: "shared-token" },
    { token: "shared-token" },
    { token: "shared-token" },
  ]);
});

// Real fetch boundary checks. All credentials/tokens are synthetic and all listeners use loopback.
async function tokenServers(t) {
  const received = { original: 0, destination: 0 };
  const settings = { status: 200, location: null };
  const server = (destination) => http.createServer(async (request, response) => {
    // Drain bodies without recording/logging credentials.
    for await (const _chunk of request) { /* drain */ }
    if (destination || request.url === "/redirected") received.destination += 1;
    else received.original += 1;
    if (!destination && request.url === "/token" && settings.location) {
      response.writeHead(settings.status, { Location: settings.location });
      response.end();
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ access_token: destination || request.url === "/redirected" ? "redirected-dummy-token" : "direct-dummy-token", token_type: "Bearer", expires_in: 300 }));
  });
  const issuer = server(false), destination = server(true);
  t.after(async () => {
    issuer.closeAllConnections();
    destination.closeAllConnections();
    await Promise.all([issuer,destination].map(instance => new Promise(resolve => instance.close(resolve))));
  });
  await Promise.all([issuer,destination].map(instance => new Promise(resolve => instance.listen(0,"127.0.0.1",resolve))));
  return { received, settings, tokenUrl: `http://127.0.0.1:${issuer.address().port}/token`, destinationUrl: `http://127.0.0.1:${destination.address().port}/redirected` };
}

test("token endpoint redirects never contact another path/origin or cache its token", async t => {
  for (const status of [301,302,303,307,308]) {
    for (const relative of [true,false]) {
      await t.test(`${status}: ${relative ? "same-origin relative path" : "different origin"}`, async t => {
        const servers = await tokenServers(t);
        servers.settings.status = status;
        servers.settings.location = relative ? "/redirected" : servers.destinationUrl;
        const credentials = createServiceTokenProvider({ ...config, tokenUrl: servers.tokenUrl });
        await assert.rejects(credentials());
        await assert.rejects(credentials());
        assert.equal(servers.received.original, 2, "failed token requests must not populate cache or strand pendingRequest");
        assert.equal(servers.received.destination, 0, "no redirected request may reach the alternate path/origin");
        servers.settings.location = null;
        assert.deepEqual(await credentials(), { token: "direct-dummy-token" });
        assert.deepEqual(await credentials(), { token: "direct-dummy-token" });
        assert.equal(servers.received.original, 3, "a valid direct response recovers and is cached");
        assert.equal(servers.received.destination, 0);
      });
    }
  }
});

test("a redirected refresh fails shared callers and later recovers without reusing unsafe state", async t => {
  const servers = await tokenServers(t);
  let now = 0;
  const credentials = createServiceTokenProvider({ ...config, tokenUrl: servers.tokenUrl, now: () => now });
  assert.deepEqual(await credentials(), { token: "direct-dummy-token" });
  now = 271_000;
  servers.settings.status = 307;
  servers.settings.location = servers.destinationUrl;
  const outcomes = await Promise.allSettled([credentials(),credentials(),credentials()]);
  assert.ok(outcomes.every(result => result.status === "rejected"), "refresh failure must not return the old token or a redirected token");
  assert.equal(servers.received.original, 2, "concurrent refresh callers share one failed request");
  assert.equal(servers.received.destination, 0);
  servers.settings.location = null;
  assert.deepEqual(await credentials(), { token: "direct-dummy-token" });
  assert.deepEqual(await credentials(), { token: "direct-dummy-token" });
  assert.equal(servers.received.original, 3, "pending refresh is cleared after rejection and direct recovery caches normally");
});
