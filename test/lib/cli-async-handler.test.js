const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const http = require('node:http');

const { AsyncWebhookHandler } = require('../../bin/adcp-async-handler.js');

function signedHeaders(secret, body, timestamp = Math.floor(Date.now() / 1000).toString()) {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
  return {
    'content-type': 'application/json',
    'x-adcp-timestamp': timestamp,
    'x-adcp-signature': `sha256=${digest}`,
  };
}

test('CLI async webhook accepts only the correlated, authenticated response', async t => {
  const secret = 'test-secret-with-at-least-thirty-two-bytes';
  const handler = new AsyncWebhookHandler({ webhookSecret: secret, timeout: 5_000 });
  const webhookUrl = await handler.start(false);
  t.after(() => handler.cleanup());

  const health = await fetch(new URL('/', webhookUrl));
  assert.deepEqual(await health.json(), { status: 'ready' });

  const body = JSON.stringify({ status: 'completed', result: { ok: true } });
  const wrongOperation = new URL(webhookUrl);
  wrongOperation.searchParams.set('op', 'attacker-controlled');
  const wrongOperationResponse = await fetch(wrongOperation, {
    method: 'POST',
    headers: signedHeaders(secret, body),
    body,
  });
  assert.equal(wrongOperationResponse.status, 404);

  const unsignedResponse = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  assert.equal(unsignedResponse.status, 401);

  const accepted = await fetch(webhookUrl, {
    method: 'POST',
    headers: signedHeaders(secret, body),
    body,
  });
  assert.equal(accepted.status, 202);
  assert.deepEqual(await handler.waitForResponse(), JSON.parse(body));
});

test('CLI async webhook rejects declared oversized bodies before buffering', async t => {
  const handler = new AsyncWebhookHandler({ webhookSecret: 'x'.repeat(32), timeout: 5_000 });
  const webhookUrl = await handler.start(false);
  t.after(() => handler.cleanup());

  const status = await new Promise((resolve, reject) => {
    const req = http.request(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(1024 * 1024 + 1) },
    });
    req.on('response', response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    req.on('error', reject);
    req.flushHeaders();
  });
  assert.equal(status, 413);
});
