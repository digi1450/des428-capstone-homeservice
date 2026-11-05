import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { request, waitFor } from './helpers.mjs';
before(async () => {
  for (const host of ['baseline', 'candidate']) {
    await waitFor(async () => (await request(host, '/')).data?.backend === 'monolith');
  }
  await waitFor(async () => (await request('candidate', '/api/notifications')).data?.backend === 'notifications');
  await waitFor(async () => (await request('candidate', '/api/provider/wallet')).data?.backend === 'payments-wallet');
});
test('baseline keeps every migrated public path on the monolith', async () => {
  for (const path of ['/api/notifications', '/api/notifications/12/read', '/api/provider/wallet',
    '/api/customer/transactions', '/api/payments/simulate', '/api/payments/webhook']) {
    assert.equal((await request('baseline', path)).data?.backend, 'monolith', path);
  }
});
test('candidate sends notification and payment namespaces to their owners', async () => {
  for (const [path, backend] of [
    ['/api/notifications', 'notifications'], ['/api/notifications/', 'notifications'],
    ['/api/notifications/12/read', 'notifications'], ['/api/notifications/invalid/read', 'notifications'],
    ['/api/provider/wallet', 'payments-wallet'], ['/api/provider/wallet/', 'payments-wallet'],
    ['/api/customer/transactions', 'payments-wallet'], ['/api/customer/transactions/', 'payments-wallet'],
    ['/api/payments', 'payments-wallet'], ['/api/payments/simulate', 'payments-wallet'],
    ['/api/payments/webhook', 'payments-wallet']]) {
    assert.equal((await request('candidate', path)).data?.backend, backend, path);
  }
});
test('HTML, Next assets, Booking and similar prefixes stay monolith-owned', async () => {
  for (const path of ['/', '/notifications', '/provider/wallet', '/customer/transactions',
    '/_next/static/chunk.js', '/api/bookings/12', '/api/bids', '/api/health',
    '/api/notifications-extra', '/api/provider/wallet-extra', '/api/customer/transactions-extra', '/api/payments-extra']) {
    assert.equal((await request('candidate', path)).data?.backend, 'monolith', path);
  }
});
test('path/query, method, body, credentials and trace context pass through', async () => {
  const path = '/api/notifications/12/read?next=%2Ffoo&x=a+b';
  const body = JSON.stringify({ read: true });
  const response = await request('candidate', path, { method: 'POST', body, headers: {
    Host: 'homeservice.local:8080', 'Content-Type': 'application/json',
    Authorization: 'Bearer fixture-only', Cookie: 'fixture=session',
    traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
    tracestate: 'fixture=value', 'X-Request-Id': 'meeting-A:12',
    'X-Role': 'admin', 'X-User-Id': '1', 'X-Forwarded-For': 'spoofed',
    'X-Forwarded-Proto': 'https', 'Forwarded': 'for=spoofed;proto=https'
  }});
  assert.equal(response.status, 200);
  const echo = response.data;
  assert.equal(echo.url, path); assert.equal(echo.method, 'POST'); assert.equal(echo.body, body);
  assert.equal(echo.headers.authorization, 'Bearer fixture-only');
  assert.equal(echo.headers.cookie, 'fixture=session');
  assert.equal(echo.headers.host, 'homeservice.local:8080');
  assert.equal(echo.headers['x-forwarded-host'], 'homeservice.local:8080');
  assert.equal(echo.headers['x-forwarded-proto'], 'http');
  assert.notEqual(echo.headers['x-forwarded-for'], 'spoofed');
  assert.equal(echo.headers['x-forwarded-for'], echo.headers['x-real-ip']);
  for (const header of ['x-role', 'x-user-id', 'forwarded']) assert.equal(echo.headers[header], undefined);
  assert.equal(echo.headers.traceparent, '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01');
  assert.equal(echo.headers.tracestate, 'fixture=value');
  assert.equal(echo.headers['x-request-id'], 'meeting-A:12');
  assert.equal(response.headers['x-request-id'], 'meeting-A:12');
  assert.equal(response.rawHeaders.filter(value => value.toLowerCase() === 'x-request-id').length, 1);
});
test('invalid/missing correlation IDs become a single generated ID', async () => {
  for (const value of [undefined, 'bad id', 'x'.repeat(129)]) {
    const response = await request('candidate', '/api/provider/wallet', {
      headers: value ? { 'X-Request-Id': value } : {}
    });
    assert.match(response.headers['x-request-id'], /^[a-f0-9]{32}$/);
    assert.equal(response.data.headers['x-request-id'], response.headers['x-request-id']);
  }
});
test('upstream errors, redirect, cookie and retry metadata are retained', async () => {
  for (const status of [302, 400, 401, 403, 404, 409, 429, 500, 503]) {
    const response = await request('candidate', `/api/provider/wallet?status=${status}`);
    assert.equal(response.status, status);
    assert.equal(response.data.backend, 'payments-wallet');
    assert.equal(response.headers['retry-after'], '7');
    assert.deepEqual(response.headers['set-cookie'], ['fixture=session; HttpOnly; Path=/']);
    if (status === 302) assert.equal(response.headers.location, '/login?next=%2Fnotifications');
  }
});
test('internal commands are inaccessible through either public routing mode', async () => {
  for (const host of ['baseline', 'candidate']) {
    for (const path of ['/internal', '/internal/payment-intents', '/internal%2Fpayment-intents',
      '//internal/payment-intents', '/%69nternal/payment-intents']) {
      const response = await request(host, path, { method: 'POST', body: '{}' });
      assert.equal(response.status, 404, path);
    }
  }
});
test('gateway liveness is distinct from application readiness', async () => {
  for (const host of ['baseline', 'candidate']) {
    const response = await request(host, '/gateway/health');
    assert.equal(response.status, 200); assert.deepEqual(response.data, { status: 'alive' });
  }
});
test('gateway does not replay a POST when upstream closes before responding', async () => {
  const path = '/api/payments/fixture-drop';
  const response = await request('candidate', path + '?drop=1', { method: 'POST', body: '{}' });
  assert.equal(response.status, 502);
  assert.equal((await request('candidate', path + '?count=1')).data.count, 1);
});
