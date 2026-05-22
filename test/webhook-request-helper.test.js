const { describe, it } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const { verifyWebhookRequest } = require('@adcp/sdk/webhooks');

const secret = 'test-secret-key-minimum-32-characters-long';
const now = 1_700_000_000;

function sign(rawBody, timestamp = now) {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(`${timestamp}.`, 'utf8');
  hmac.update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8'));
  return `sha256=${hmac.digest('hex')}`;
}

describe('verifyWebhookRequest', () => {
  it('verifies a legacy HMAC webhook over exact raw body bytes', () => {
    const rawBody = '{"key": "value",  "num": 1.0}';
    const result = verifyWebhookRequest({
      rawBody,
      secret,
      headers: {
        'X-ADCP-Signature': sign(rawBody),
        'X-ADCP-Timestamp': String(now),
      },
      now: () => now,
    });

    assert.deepStrictEqual(result, {
      ok: true,
      signature: sign(rawBody),
      timestamp: now,
      verifiedAt: now,
    });
  });

  it('accepts globalSecret alias and explicit header values', () => {
    const rawBody = Buffer.from('{"event":"done"}', 'utf8');
    const result = verifyWebhookRequest({
      rawBody,
      globalSecret: secret,
      signature: sign(rawBody),
      timestamp: now,
      now: () => now,
    });

    assert.strictEqual(result.ok, true);
  });

  it('returns missing_headers when signature or timestamp is absent', () => {
    const result = verifyWebhookRequest({
      rawBody: '{}',
      secret,
      headers: { 'x-adcp-signature': sign('{}') },
      now: () => now,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'missing_headers');
  });

  it('returns ambiguous_headers for multi-value signature headers', () => {
    const result = verifyWebhookRequest({
      rawBody: '{}',
      secret,
      signature: [sign('{}'), sign('{}')],
      timestamp: now,
      now: () => now,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'ambiguous_headers');
  });

  it('returns ambiguous_headers for comma-joined Headers values', () => {
    const headers = new Headers();
    headers.append('x-adcp-signature', sign('{}'));
    headers.append('x-adcp-signature', sign('{}'));
    headers.set('x-adcp-timestamp', String(now));

    const result = verifyWebhookRequest({
      rawBody: '{}',
      secret,
      headers,
      now: () => now,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'ambiguous_headers');
  });

  it('returns ambiguous_headers for comma-joined Node-style header values', () => {
    const result = verifyWebhookRequest({
      rawBody: '{}',
      secret,
      headers: {
        'x-adcp-signature': `${sign('{}')}, ${sign('{}')}`,
        'x-adcp-timestamp': String(now),
      },
      now: () => now,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'ambiguous_headers');
  });

  it('still rejects ambiguous header bags when explicit values are provided', () => {
    const headers = new Headers();
    headers.append('x-adcp-signature', sign('{}'));
    headers.append('x-adcp-signature', sign('{}'));
    headers.set('x-adcp-timestamp', String(now));

    const result = verifyWebhookRequest({
      rawBody: '{}',
      secret,
      headers,
      signature: sign('{}'),
      timestamp: now,
      now: () => now,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'ambiguous_headers');
  });

  it('rejects explicit values that disagree with the header bag', () => {
    const result = verifyWebhookRequest({
      rawBody: '{}',
      secret,
      headers: {
        'x-adcp-signature': sign('{}'),
        'x-adcp-timestamp': String(now),
      },
      signature: sign('{"changed":true}'),
      timestamp: now,
      now: () => now,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'ambiguous_headers');
  });

  it('returns invalid_timestamp for non-integer timestamps', () => {
    const result = verifyWebhookRequest({
      rawBody: '{}',
      secret,
      signature: sign('{}'),
      timestamp: '1700000000abc',
      now: () => now,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'invalid_timestamp');
  });

  it('returns stale_timestamp outside the replay window', () => {
    const oldTimestamp = now - 301;
    const result = verifyWebhookRequest({
      rawBody: '{}',
      secret,
      signature: sign('{}', oldTimestamp),
      timestamp: oldTimestamp,
      now: () => now,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'stale_timestamp');
  });

  it('returns malformed_signature before comparing malformed values', () => {
    const result = verifyWebhookRequest({
      rawBody: '{}',
      secret,
      signature: 'sha256=not-hex',
      timestamp: now,
      now: () => now,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'malformed_signature');
  });

  it('returns malformed_signature for uppercase hex to match handleWebhook behavior', () => {
    const result = verifyWebhookRequest({
      rawBody: '{}',
      secret,
      signature: sign('{}').toUpperCase().replace('SHA256=', 'sha256='),
      timestamp: now,
      now: () => now,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'malformed_signature');
  });

  it('returns bad_signature for well-formed signatures over different bytes', () => {
    const result = verifyWebhookRequest({
      rawBody: '{"different":true}',
      secret,
      signature: sign('{}'),
      timestamp: now,
      now: () => now,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'bad_signature');
  });
});
