// High-level canonical reference resolver for AdCP 3.1
// `format_schema` and `platform_extensions` URI+digest refs.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createHash } = require('node:crypto');

process.env.ADCP_ALLOW_INTERNAL_PROBES = '1';

const {
  createCanonicalReferenceResolver,
  resolveFormatSchema,
  resolvePlatformExtension,
  fetchFormatSchema,
  _resetFormatSchemaCache,
} = require('../../dist/lib/v2/format-schema/index.js');

function digest(buf) {
  return `sha256:${createHash('sha256').update(buf).digest('hex')}`;
}

function jsonBody(value) {
  return Buffer.from(JSON.stringify(value));
}

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
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

function serve(path, body, headers = { 'content-type': 'application/json' }) {
  const buf = Buffer.isBuffer(body) ? body : jsonBody(body);
  routes.set(path, (_req, res) => {
    res.writeHead(200, headers);
    res.end(buf);
  });
  return { uri: `${baseUrl}${path}`, digest: digest(buf), body: buf };
}

describe('createCanonicalReferenceResolver', () => {
  test('resolves and caches Draft 2019-09 format_schema results per resolver instance', async () => {
    let hits = 0;
    const schema = {
      $schema: 'https://json-schema.org/draft/2019-09/schema',
      type: 'object',
      properties: { headline: { type: 'string' } },
    };
    const buf = jsonBody(schema);
    routes.set('/format-schema.json', (_req, res) => {
      hits += 1;
      res.writeHead(200, { 'content-type': 'application/schema+json' });
      res.end(buf);
    });
    const ref = { uri: `${baseUrl}/format-schema.json`, digest: digest(buf) };

    const resolver = createCanonicalReferenceResolver();
    const first = await resolver.resolveFormatSchema(ref);
    const second = await resolver.resolveFormatSchema(ref);
    const otherResolver = createCanonicalReferenceResolver();
    const third = await otherResolver.resolveFormatSchema(ref);

    assert.strictEqual(first.status, 'resolved');
    assert.strictEqual(first.ok, true);
    assert.deepStrictEqual(first.document, schema);
    assert.strictEqual(first.fromCache, false);
    assert.strictEqual(second.status, 'resolved');
    assert.strictEqual(second.fromCache, true);
    assert.strictEqual(third.status, 'resolved');
    assert.strictEqual(third.fromCache, false, 'cache is resolver-scoped, not process-global');
    assert.strictEqual(hits, 2);
  });

  test('resolves Draft-07 format_schema with same-origin refs before compiling', async () => {
    const defs = serve('/defs.json', {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'string',
      minLength: 1,
    });
    void defs;
    const parent = serve('/parent.json', {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { title: { $ref: `${baseUrl}/defs.json` } },
    });

    const result = await resolveFormatSchema({ uri: parent.uri, digest: parent.digest });
    assert.strictEqual(result.status, 'resolved');
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.document.properties.title, {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'string',
      minLength: 1,
    });
    assert.strictEqual(result.refCount, 1);
  });

  test('accepts common Draft-07 and Draft 2019-09 $schema URI variants', async () => {
    const draft7 = serve('/draft7-https.json', {
      $schema: 'https://json-schema.org/draft-07/schema#',
      type: 'object',
    });
    const draft2019 = serve('/draft2019-fragment.json', {
      $schema: 'https://json-schema.org/draft/2019-09/schema#',
      type: 'object',
    });

    const a = await resolveFormatSchema({ uri: draft7.uri, digest: draft7.digest }, { allowInternalReferences: true });
    const b = await resolveFormatSchema(
      { uri: draft2019.uri, digest: draft2019.digest },
      { allowInternalReferences: true }
    );

    assert.strictEqual(a.status, 'resolved');
    assert.strictEqual(b.status, 'resolved');
  });

  test('resolves relative same-origin refs against the current document URI', async () => {
    serve('/defs/relative.json', {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'number',
    });
    const parent = serve('/schemas/parent-relative.json', {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { price: { $ref: '../defs/relative.json' } },
    });

    const result = await resolveFormatSchema({ uri: parent.uri, digest: parent.digest });
    assert.strictEqual(result.status, 'resolved');
    assert.deepStrictEqual(result.document.properties.price, {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'number',
    });
  });

  test('returns blocked_unsafe_url for nested same-origin redirects', async () => {
    routes.set('/defs/redirect.json', (_req, res) => {
      res.writeHead(302, { location: '/defs/relative.json' });
      res.end();
    });
    const parent = serve('/parent-redirect-ref.json', {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { x: { $ref: `${baseUrl}/defs/redirect.json` } },
    });

    const result = await resolveFormatSchema({ uri: parent.uri, digest: parent.digest });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 'blocked_unsafe_url');
    assert.strictEqual(result.code, 'fetch_failed');
    assert.strictEqual(result.retryable, false);
  });

  test('returns unresolvable for nested same-origin 404 refs', async () => {
    const parent = serve('/parent-missing-ref.json', {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { x: { $ref: `${baseUrl}/defs/missing.json` } },
    });

    const result = await resolveFormatSchema({ uri: parent.uri, digest: parent.digest });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 'unresolvable');
    assert.strictEqual(result.code, 'fetch_failed');
    assert.strictEqual(result.retryable, true);
  });

  test('resolves platform_extensions through the same transport and cache path without schema compilation', async () => {
    const extension = serve('/extension.json', {
      extends: 'tracking',
      version: '1.0.0',
      fields: { pixel_id: { type: 'string' } },
    });
    const resolver = createCanonicalReferenceResolver();

    const first = await resolver.resolvePlatformExtension({ uri: extension.uri, digest: extension.digest });
    const second = await resolver.resolvePlatformExtension({ uri: extension.uri, digest: extension.digest });

    assert.strictEqual(first.status, 'resolved');
    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.kind, 'platform_extensions');
    assert.deepStrictEqual(first.document.extends, 'tracking');
    assert.strictEqual(second.status, 'resolved');
    assert.strictEqual(second.fromCache, true);
  });

  test('returns digest_mismatch instead of throwing on substitution failure', async () => {
    const ref = serve('/mismatch.json', { type: 'object' });
    const result = await resolvePlatformExtension({
      uri: ref.uri,
      digest: `sha256:${'0'.repeat(64)}`,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 'digest_mismatch');
    assert.strictEqual(result.code, 'digest_mismatch');
    assert.strictEqual(result.reason, 'digest_mismatch');
    assert.strictEqual(result.retryable, false);
  });

  test('returns invalid_schema for malformed JSON Schema documents', async () => {
    const bad = serve('/bad-schema.json', {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'definitely-not-a-json-schema-type',
    });

    const result = await resolveFormatSchema({ uri: bad.uri, digest: bad.digest });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 'invalid_schema');
    assert.strictEqual(result.code, 'schema_compile_failed');
  });

  test('returns invalid_schema budget_exceeded for catastrophic format_schema regexes', async () => {
    const bad = serve('/bad-regex.json', {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        input: {
          type: 'string',
          pattern: '^(a+)+$',
        },
      },
    });

    const result = await resolveFormatSchema({ uri: bad.uri, digest: bad.digest });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 'invalid_schema');
    assert.strictEqual(result.code, 'budget_exceeded');
    assert.strictEqual(result.retryable, false);
    assert.strictEqual(result.details.pattern, '^(a+)+$');
    assert.strictEqual(result.details.location, '/properties/input/pattern');
  });

  test('returns blocked_unsafe_url for unsafe format_schema refs', async () => {
    const schema = serve('/file-ref.json', {
      $schema: 'http://json-schema.org/draft-07/schema#',
      $ref: 'file:///etc/passwd',
    });

    const result = await resolveFormatSchema({ uri: schema.uri, digest: schema.digest });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 'blocked_unsafe_url');
    assert.strictEqual(result.code, 'file_scheme_rejected');
  });

  test('returns blocked_unsafe_url for metadata-service fetch targets', async () => {
    const result = await resolvePlatformExtension({
      uri: 'http://169.254.169.254/latest/meta-data/',
      digest: `sha256:${'0'.repeat(64)}`,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 'blocked_unsafe_url');
    assert.ok(['ssrf_refused', 'invalid_ref'].includes(result.code));
  });

  test('returns unresolvable for body-size cap failures', async () => {
    const big = Buffer.alloc(2048, 'x');
    routes.set('/too-big.json', (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(big);
    });

    const result = await resolvePlatformExtension(
      { uri: `${baseUrl}/too-big.json`, digest: digest(big) },
      { maxBodyBytes: 64 }
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 'unresolvable');
    assert.strictEqual(result.code, 'body_too_large');
    assert.strictEqual(result.retryable, true);
  });

  test('returns unresolvable for DNS failures', async () => {
    const result = await resolvePlatformExtension({
      uri: 'https://does-not-resolve.example.invalid/schema.json',
      digest: `sha256:${'0'.repeat(64)}`,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 'unresolvable');
    assert.strictEqual(result.retryable, true);
  });

  test('returns unresolvable for timeout failures', async () => {
    const body = jsonBody({ type: 'object' });
    routes.set('/slow.json', (_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(body);
      }, 100);
    });

    const result = await resolvePlatformExtension(
      { uri: `${baseUrl}/slow.json`, digest: digest(body) },
      { timeoutMs: 10 }
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 'unresolvable');
    assert.strictEqual(result.retryable, true);
  });

  test('returns unresolvable for transient nested same-origin ref failures', async () => {
    routes.set('/defs/flaky.json', (_req, res) => {
      res.writeHead(500).end('retry later');
    });
    const parent = serve('/parent-flaky-ref.json', {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { x: { $ref: `${baseUrl}/defs/flaky.json` } },
    });

    const result = await resolveFormatSchema({ uri: parent.uri, digest: parent.digest });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 'unresolvable');
    assert.strictEqual(result.code, 'fetch_failed');
    assert.strictEqual(result.retryable, true);
  });

  test('returns unresolvable for nested same-origin ref timeout failures', async () => {
    const nestedBody = jsonBody({ type: 'string' });
    routes.set('/defs/slow-nested.json', (_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(nestedBody);
      }, 100);
    });
    const parent = serve('/parent-slow-ref.json', {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { x: { $ref: `${baseUrl}/defs/slow-nested.json` } },
    });

    const result = await resolveFormatSchema({ uri: parent.uri, digest: parent.digest }, { timeoutMs: 10 });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 'unresolvable');
    assert.strictEqual(result.code, 'fetch_failed');
    assert.strictEqual(result.retryable, true);
  });

  test('returns unresolvable when a custom nested ref fetcher throws', async () => {
    const parent = serve('/parent-custom-fetcher-throws.json', {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { x: { $ref: `${baseUrl}/defs/custom.json` } },
    });

    const result = await resolveFormatSchema(
      { uri: parent.uri, digest: parent.digest },
      {
        fetchExternal: async () => {
          throw new Error('registry temporarily unavailable');
        },
      }
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 'unresolvable');
    assert.strictEqual(result.code, 'fetch_failed');
    assert.strictEqual(result.retryable, true);
  });

  test('cached resolver results are immutable snapshots', async () => {
    const schema = serve('/immutable.json', {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { original: { type: 'string' } },
    });
    const resolver = createCanonicalReferenceResolver();
    const first = await resolver.resolveFormatSchema({ uri: schema.uri, digest: schema.digest });
    assert.strictEqual(first.status, 'resolved');
    first.document.properties.original.type = 'number';
    first.ref.uri = 'https://mutated.example/schema.json';

    const second = await resolver.resolveFormatSchema({ uri: schema.uri, digest: schema.digest });
    assert.strictEqual(second.status, 'resolved');
    assert.strictEqual(second.fromCache, true);
    assert.strictEqual(second.ref.uri, schema.uri);
    assert.strictEqual(second.document.properties.original.type, 'string');
  });

  test('low-level fetch cache can be reset and returns immutable snapshots', async () => {
    _resetFormatSchemaCache();
    let hits = 0;
    const body = jsonBody({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'object' });
    routes.set('/fetch-cache.json', (_req, res) => {
      hits += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    });
    const ref = { uri: `${baseUrl}/fetch-cache.json`, digest: digest(body) };

    const first = await fetchFormatSchema(ref);
    first.schema.type = 'array';
    const second = await fetchFormatSchema(ref);
    _resetFormatSchemaCache();
    const third = await fetchFormatSchema(ref);

    assert.strictEqual(second.fromCache, true);
    assert.strictEqual(second.schema.type, 'object');
    assert.strictEqual(third.fromCache, false);
    assert.strictEqual(hits, 2);
  });
});
