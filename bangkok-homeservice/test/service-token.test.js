import test from "node:test";
import assert from "node:assert/strict";
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