import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

test('metrics and JSON logs retain correlation without bypassing business auth', async () => {
  const records = [];
  const original = console.log;
  const app = createApp({database:{checkReady:async () => {}}});
  const server = app.listen(0,'127.0.0.1');
  await new Promise(resolve => server.once('listening',resolve));
  console.log = value => { records.push(JSON.parse(value)); };
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(base + '/api/provider/wallet?private=fixture-only', {
      headers:{'X-Request-Id':'observability-fixture',Authorization:'Bearer fixture-only'}
    });
    assert.equal(response.status,503);
    assert.equal(response.headers.get('x-request-id'),'observability-fixture');
    const metrics = await fetch(base + '/metrics');
    assert.equal(metrics.status,200);
    const text = await metrics.text();
    assert.match(text,/http_requests_total/);
    assert.match(text,/http_request_duration_seconds_bucket/);
    const record = records.find(row => row.requestId === 'observability-fixture');
    assert.equal(record.event,'http_request');
    assert.equal(record.statusCode,503);
    assert.equal(record.service,'payments-wallet');
    assert.equal(typeof record.durationMs,'number');
    assert.ok(record.traceId === null || /^[a-f0-9]{32}$/.test(record.traceId));
    assert.ok(!JSON.stringify(records).includes('fixture-only'));
  } finally {
    console.log = original;
    await new Promise(resolve => server.close(resolve));
  }
});
