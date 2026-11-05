import test from 'node:test';
import assert from 'node:assert/strict';
import { request, waitFor } from './helpers.mjs';
test('notification backend recovers without reloading nginx', async () => {
  await waitFor(async () => (await request('candidate', '/api/notifications')).data?.backend === 'notifications');
  assert.equal((await request('candidate', '/api/notifications')).status, 200);
});
