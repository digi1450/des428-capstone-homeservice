import test from 'node:test';
import assert from 'node:assert/strict';
import { request, waitFor } from './helpers.mjs';
test('notification outage fails visibly without monolith fallback', async () => {
  await waitFor(async () => (await request('candidate', '/gateway/health')).status === 200);
  const response = await request('candidate', '/api/notifications');
  assert.equal(response.status, 502); assert.equal(response.data, undefined);
  assert.ok(response.headers['x-request-id']);
});
test('other routes and liveness survive the notification outage', async () => {
  assert.equal((await request('candidate', '/api/provider/wallet')).data.backend, 'payments-wallet');
  assert.equal((await request('candidate', '/')).data.backend, 'monolith');
  assert.equal((await request('baseline', '/api/notifications')).data.backend, 'monolith');
  assert.equal((await request('candidate', '/gateway/health')).status, 200);
});
