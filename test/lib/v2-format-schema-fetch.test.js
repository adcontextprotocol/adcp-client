// fetchFormatSchema — exercise the spec's normative fetch contract
// (`product-format-declaration.json#format_schema`) against a local
// HTTPS-mocked server.
//
// We use a plain HTTP server on 127.0.0.1 and pass the matching opt-in
// (`ADCP_ALLOW_INTERNAL_PROBES=1`) so ssrfSafeFetch will allow it.
// In production, ssrfSafeFetch enforces HTTPS-only + non-private targets.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createHash } = require('node:crypto');

process.env.ADCP_ALLOW_INTERNAL_PROBES = '1';

const { fetchFormatSchema, FormatSchemaFetchError } = require('../../dist/lib/v2/format-schema/index.js');

function digest(buf) {
  return `sha256:${createHash('sha256').update(buf).digest('hex')}`;
}

const VALID_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    width: { type: 'integer' },
    height: { type: 'integer' },
  },
};
const VALID_BODY = Buffer.from(JSON.stringify(VALID_SCHEMA));
const VALID_DIGEST = digest(VALID_BODY);

let server;
let baseUrl;
const routes = new Map();

before(async () => {
  server = http.createServer((req, res) => {
    const handler = routes.get(req.url);
    if (!handler) {
      res.writeHead(404).end();
      return;
    }
    handler(req, res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  routes.set('/valid.json', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/schema+json' });
    res.end(VALID_BODY);
  });
  routes.set('/wrong-digest.json', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(Buffer.from(JSON.stringify({ different: 'body' })));
  });
  routes.set('/not-json.json', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('not valid json {');
  });
  routes.set('/array-body.json', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([1, 2, 3]));
  });
  routes.set('/redirect.json', (_req, res) => {
    res.writeHead(302, { location: '/valid.json' });
    res.end();
  });
  routes.set('/server-error.json', (_req, res) => {
    res.writeHead(500).end('boom');
  });
});

after(() => server.close());

describe('fetchFormatSchema — happy path', () => {
  test('fetches + verifies digest + returns parsed schema', async () => {
    const result = await fetchFormatSchema({
      uri: `${baseUrl}/valid.json`,
      digest: VALID_DIGEST,
    });
    assert.deepStrictEqual(result.schema, VALID_SCHEMA);
    assert.strictEqual(result.fromCache, false);
  });

  test('second fetch with same digest hits the cache', async () => {
    const a = await fetchFormatSchema({
      uri: `${baseUrl}/valid.json`,
      digest: VALID_DIGEST,
    });
    const b = await fetchFormatSchema({
      uri: `${baseUrl}/valid.json`,
      digest: VALID_DIGEST,
    });
    assert.deepStrictEqual(b.schema, a.schema);
    assert.strictEqual(b.fromCache, true);
  });
});

describe('fetchFormatSchema — ref validation', () => {
  test('rejects unsupported scheme (file://, data:)', async () => {
    // Under ADCP_ALLOW_INTERNAL_PROBES=1 the fetcher allows http:// for
    // loopback tests (same opt-in as discovery), but file:// and other
    // non-http(s) schemes are always rejected.
    await assert.rejects(
      () => fetchFormatSchema({ uri: 'file:///etc/passwd', digest: VALID_DIGEST }),
      err => err instanceof FormatSchemaFetchError && err.code === 'invalid_ref'
    );
    await assert.rejects(
      () => fetchFormatSchema({ uri: 'data:application/json,{}', digest: VALID_DIGEST }),
      err => err instanceof FormatSchemaFetchError && err.code === 'invalid_ref'
    );
  });

  test('rejects malformed digest', async () => {
    await assert.rejects(
      () => fetchFormatSchema({ uri: 'https://example.com/x.json', digest: 'sha256:notgood' }),
      err => err instanceof FormatSchemaFetchError && err.code === 'invalid_ref'
    );
  });

  test('rejects missing fields', async () => {
    await assert.rejects(
      () => fetchFormatSchema({}),
      err => err instanceof FormatSchemaFetchError && err.code === 'invalid_ref'
    );
  });
});

describe('fetchFormatSchema — digest verification', () => {
  test('mismatch is a hard fail', async () => {
    await assert.rejects(
      () => fetchFormatSchema({ uri: `${baseUrl}/wrong-digest.json`, digest: VALID_DIGEST }),
      err => err instanceof FormatSchemaFetchError && err.code === 'digest_mismatch'
    );
  });
});

describe('fetchFormatSchema — body parsing', () => {
  test('invalid JSON', async () => {
    const body = Buffer.from('not valid json {');
    const d = digest(body);
    await assert.rejects(
      () => fetchFormatSchema({ uri: `${baseUrl}/not-json.json`, digest: d }),
      err => err instanceof FormatSchemaFetchError && err.code === 'invalid_json'
    );
  });

  test('non-object JSON body (array) rejected', async () => {
    const body = Buffer.from(JSON.stringify([1, 2, 3]));
    const d = digest(body);
    await assert.rejects(
      () => fetchFormatSchema({ uri: `${baseUrl}/array-body.json`, digest: d }),
      err => err instanceof FormatSchemaFetchError && err.code === 'invalid_json'
    );
  });
});

describe('fetchFormatSchema — HTTP-level failure modes', () => {
  test('redirect is blocked (auto-follow disabled per spec)', async () => {
    await assert.rejects(
      () => fetchFormatSchema({ uri: `${baseUrl}/redirect.json`, digest: VALID_DIGEST }),
      err => err instanceof FormatSchemaFetchError && err.code === 'redirect_blocked' && err.httpStatus === 302
    );
  });

  test('5xx surfaces as http_error', async () => {
    await assert.rejects(
      () => fetchFormatSchema({ uri: `${baseUrl}/server-error.json`, digest: VALID_DIGEST }),
      err => err instanceof FormatSchemaFetchError && err.code === 'http_error' && err.httpStatus === 500
    );
  });
});
