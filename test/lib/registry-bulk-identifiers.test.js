const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { RegistryClient, RegistryRequestError, IdentifierValidationError } = require('../../dist/lib/registry');
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const provenance = { type: 'agency_allowlist', context: 'campaign' };
const identifier = value => ({ type: 'domain', value });
function resolved(identifiers) {
  return {
    resolved: identifiers.map(id => ({
      identifier: id,
      property_rid: `rid:${id.value}`,
      classification: 'property',
      status: 'existing',
      source: null,
    })),
    summary: { total: identifiers.length, resolved: identifiers.length, created: 0, excluded: 0, not_found: 0 },
    server_timestamp: '2026-10-17T00:00:00Z',
  };
}

test('bulk lookup splits by count and UTF-8 bytes, bounds concurrency, and restores input order', async () => {
  let active = 0,
    maximum = 0;
  const calls = [];
  const maxRequestBytes = 250;
  globalThis.fetch = async (_url, init) => {
    active++;
    maximum = Math.max(maximum, active);
    const body = JSON.parse(init.body);
    calls.push(body);
    assert.ok(Buffer.byteLength(init.body) <= maxRequestBytes);
    assert.ok(body.identifiers.length <= 3);
    assert.equal(body.mode, 'lookup');
    assert.deepEqual(body.provenance, provenance);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return Response.json(resolved([...body.identifiers].reverse()));
  };
  const identifiers = Array.from({ length: 10 }, (_, i) => identifier(`site-${i}-ééé.example`));
  identifiers.push(identifiers[0]);
  const results = await new RegistryClient().resolveIdentifiersAll(
    { identifiers, provenance, mode: 'lookup' },
    { batchSize: 3, maxRequestBytes, concurrency: 2 }
  );
  assert.ok(calls.length > 3);
  assert.equal(maximum, 2);
  assert.deepEqual(
    results.map(result => result.result.identifier),
    identifiers
  );
  assert.deepEqual(
    results.map(result => result.index),
    identifiers.map((_, index) => index)
  );
});

test('bulk resolver retries rate limits with Retry-After and returns failed batches per identifier', async () => {
  let attempts = 0;
  const attemptTimes = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    attemptTimes.push(Date.now());
    attempts++;
    if (attempts === 1) return Response.json({ error: 'rate limited', retryAfterMs: 25 }, { status: 429 });
    if (body.identifiers[0].value === 'bad.example') return Response.json({ error: 'unavailable' }, { status: 503 });
    return Response.json(resolved(body.identifiers));
  };
  const results = await new RegistryClient({ apiKey: 'test-key' }).resolveIdentifiersAll(
    { identifiers: [identifier('good.example'), identifier('bad.example')], provenance },
    { batchSize: 1, concurrency: 1 }
  );
  assert.equal(attempts, 3);
  assert.ok(attemptTimes[1] - attemptTimes[0] >= 24);
  assert.equal(results[0].success, true);
  assert.equal(results[1].success, false);
  assert.ok(results[1].error instanceof RegistryRequestError);
  assert.equal(results[1].error.status, 503);
});

test('oversize items and omitted results are reported without losing other inputs', async () => {
  globalThis.fetch = async () => Response.json(resolved([]));
  const results = await new RegistryClient().resolveIdentifiersAll(
    { identifiers: [identifier('a'.repeat(500)), identifier('ok.example')], provenance, mode: 'lookup' },
    { maxRequestBytes: 180 }
  );
  assert.equal(results.length, 2);
  assert.match(results[0].error.message, /maxRequestBytes/);
  assert.match(results[1].error.message, /omitted identifier/);
});

test('malformed successful batch responses preserve successful neighboring outcomes', async () => {
  globalThis.fetch = async (_url, init) => {
    const identifiers = JSON.parse(init.body).identifiers;
    return Response.json(identifiers[0].value === 'bad.example' ? { resolved: [null] } : resolved(identifiers));
  };
  const result = await new RegistryClient().resolveIdentifiersAll(
    { identifiers: [identifier('good.example'), identifier('bad.example')], provenance, mode: 'lookup' },
    { batchSize: 1 }
  );
  assert.equal(result[0].success, true);
  assert.equal(result[1].success, false);
  assert.match(result[1].error.message, /invalid identifier resolution/);
});

test('valid entries in a partially malformed batch survive, and invalid inputs get individual outcomes', async () => {
  globalThis.fetch = async () =>
    Response.json({ resolved: [...resolved([identifier('good.example')]).resolved, null] });
  const results = await new RegistryClient().resolveIdentifiersAll({
    identifiers: [identifier('good.example'), identifier('bad.example'), undefined],
    provenance,
    mode: 'lookup',
  });
  assert.equal(results[0].success, true);
  assert.equal(results[1].success, false);
  assert.equal(results[2].success, false);
});

test('excessive retry delays return typed rate limits for pending inputs without retrying early', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ retryAfterMs: 86_400_000 }, { status: 429 });
  };
  const results = await new RegistryClient().resolveIdentifiersAll(
    { identifiers: [identifier('one.example'), identifier('two.example')], provenance, mode: 'lookup' },
    { batchSize: 1, concurrency: 1, maxRetryDelayMs: 100 }
  );
  assert.equal(calls, 1);
  assert.ok(
    results.every(result => !result.success && result.error.status === 429 && result.error.retryAfterMs === 86_400_000)
  );
});

test('an over-limit rate delay suppresses another worker already waiting to retry', async () => {
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const second = JSON.parse(init.body).identifiers[0].value === 'two.example';
    if (second) await new Promise(resolve => setTimeout(resolve, 2));
    return Response.json({ retryAfterMs: second ? 1000 : 20 }, { status: 429 });
  };
  const results = await new RegistryClient().resolveIdentifiersAll(
    { identifiers: [identifier('one.example'), identifier('two.example')], provenance, mode: 'lookup' },
    { batchSize: 1, concurrency: 2, maxRetryDelayMs: 100 }
  );
  assert.equal(calls, 2);
  assert.ok(results.every(result => !result.success && result.error.status === 429));
});

test('single calls guard the 10k limit and resolve responses exceed the old 256KiB limit', async () => {
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const response = resolved(JSON.parse(init.body).identifiers);
    response.padding = 'x'.repeat(300_000);
    return Response.json(response);
  };
  const client = new RegistryClient();
  await assert.rejects(
    client.resolveIdentifiers({ identifiers: Array(10_001).fill(identifier('a.example')), provenance, mode: 'lookup' }),
    /resolveIdentifiersAll/
  );
  assert.equal(calls, 0);
  assert.equal(
    (await client.resolveIdentifiers({ identifiers: [identifier('a.example')], provenance, mode: 'lookup' })).resolved
      .length,
    1
  );
  await assert.rejects(
    new RegistryClient({ maxBodyBytes: 100 }).resolveIdentifiers({
      identifiers: [identifier('a.example')],
      provenance,
      mode: 'lookup',
    }),
    /exceeded 100 bytes/
  );
});

test('publisher validation runs before HTTP for single and bulk saves, with finite concurrency checks', async () => {
  const domains = [];
  globalThis.fetch = async (_url, init) => {
    domains.push(JSON.parse(init.body).publisher_domain);
    return Response.json({ success: true });
  };
  const client = new RegistryClient({ apiKey: 'test-key' });
  await assert.rejects(client.saveProperty({ publisher_domain: '*.example.com' }), IdentifierValidationError);
  const result = await client.saveProperties([
    { publisher_domain: 'https://example.com/path' },
    { publisher_domain: 'good.example' },
  ]);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.deepEqual(domains, ['good.example']);
  assert.match(result['https://example.com/path'].error, /publisher_domain/);
  for (const concurrency of [0, -1, NaN, Infinity, 1.5]) {
    await assert.rejects(client.saveProperties([], { concurrency }), RangeError);
    await assert.rejects(client.resolveIdentifiersAll({ identifiers: [], provenance }, { concurrency }), RangeError);
  }
});
