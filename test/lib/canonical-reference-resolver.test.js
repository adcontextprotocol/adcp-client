const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  createCanonicalReferenceResolver,
  resolveFormatSchemaReference,
  resolvePlatformExtensionsReference,
} = require('@adcp/sdk/canonical-references');

const pkg = require('../../package.json');

function digest(body) {
  return `sha256:${createHash('sha256').update(body).digest('hex')}`;
}

function jsonBody(value) {
  return Buffer.from(JSON.stringify(value));
}

function ref(baseUrl, route, body) {
  return { uri: `${baseUrl}${route}`, digest: digest(body) };
}

let server;
let baseUrl;
let requestCounts;
const routes = new Map();

before(async () => {
  requestCounts = new Map();
  server = http.createServer((req, res) => {
    requestCounts.set(req.url, (requestCounts.get(req.url) ?? 0) + 1);
    const handler = routes.get(req.url);
    if (!handler) {
      res.writeHead(404).end();
      return;
    }
    handler(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  routes.set('/platform.json', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(jsonBody({ vendor: 'example', feature: true }));
  });
  routes.set('/draft-07.json', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/schema+json' });
    res.end(
      jsonBody({
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: { width: { type: 'integer' } },
      })
    );
  });
  routes.set('/draft-2020.json', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/schema+json' });
    res.end(
      jsonBody({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: { height: { type: 'integer' } },
      })
    );
  });
  routes.set('/missing-schema.json', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/schema+json' });
    res.end(jsonBody({ type: 'object' }));
  });
  routes.set('/invalid-schema.json', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/schema+json' });
    res.end(jsonBody({ $schema: 'http://json-schema.org/draft-07/schema#', type: 123 }));
  });
  routes.set('/off-origin-ref.json', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/schema+json' });
    res.end(
      jsonBody({
        $schema: 'http://json-schema.org/draft-07/schema#',
        properties: { x: { $ref: 'https://attacker.example/schema.json' } },
      })
    );
  });
  routes.set('/file-ref.json', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/schema+json' });
    res.end(
      jsonBody({
        $schema: 'http://json-schema.org/draft-07/schema#',
        properties: { x: { $ref: 'file:///etc/passwd' } },
      })
    );
  });
  routes.set('/external-ref-parent.json', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/schema+json' });
    res.end(
      jsonBody({
        $schema: 'http://json-schema.org/draft-07/schema#',
        properties: { x: { $ref: `${baseUrl}/external-ref-child.json` } },
      })
    );
  });
  routes.set('/external-ref-child.json', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/schema+json' });
    res.end(jsonBody({ type: 'string', from: 'child' }));
  });
  routes.set('/external-ref-cache-parent.json', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/schema+json' });
    res.end(
      jsonBody({
        $schema: 'http://json-schema.org/draft-07/schema#',
        properties: { x: { $ref: `${baseUrl}/external-ref-cache-child.json` } },
      })
    );
  });
  routes.set('/external-ref-cache-child.json', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/schema+json' });
    res.end(jsonBody({ type: 'string', from: 'cached-child' }));
  });
  routes.set('/external-ref-503.json', (_req, res) => {
    res.writeHead(503).end('temporary');
  });
  routes.set('/same-id-a.json', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/schema+json' });
    res.end(
      jsonBody({
        $id: 'https://publisher.example-ad.com/shared-id',
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: { a: { type: 'string' } },
      })
    );
  });
  routes.set('/same-id-b.json', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/schema+json' });
    res.end(
      jsonBody({
        $id: 'https://publisher.example-ad.com/shared-id',
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: { b: { type: 'integer' } },
      })
    );
  });
  routes.set('/redirect.json', (_req, res) => {
    res.writeHead(302, { location: '/platform.json' }).end();
  });
  routes.set('/big.json', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(Buffer.alloc(4096, 0x41));
  });
  routes.set('/large-json.json', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(jsonBody({ payload: 'x'.repeat(512) }));
  });
  routes.set('/hang.json', () => {
    // Keep the socket open until the client-side timeout fires.
  });
});

after(() => server.close());

const unsafeLocal = { allowUnsafeHttp: true, allowPrivateNetwork: true };

describe('canonical reference resolver', () => {
  test('resolves platform_extensions and caches by policy-scoped uri@digest without a singleton cache', async () => {
    const body = jsonBody({ vendor: 'example', feature: true });
    const resolver = createCanonicalReferenceResolver(unsafeLocal);
    const reference = ref(baseUrl, '/platform.json', body);

    const first = await resolver.resolvePlatformExtensions(reference);
    const second = await resolver.resolvePlatformExtensions(reference);

    assert.strictEqual(first.status, 'resolved');
    assert.strictEqual(first.fromCache, false);
    assert.deepStrictEqual(first.document, { vendor: 'example', feature: true });
    assert.strictEqual(second.status, 'resolved');
    assert.strictEqual(second.fromCache, true);
    assert.strictEqual(requestCounts.get('/platform.json'), 1);
  });

  test('cache hits clone resolved bodies and documents', async () => {
    const body = jsonBody({ vendor: 'example', feature: true });
    const resolver = createCanonicalReferenceResolver(unsafeLocal);
    const reference = ref(baseUrl, '/platform.json', body);

    const first = await resolver.resolvePlatformExtensions(reference);
    assert.strictEqual(first.status, 'resolved');
    first.document.vendor = 'mutated';
    first.body[0] = 0x00;

    const second = await resolver.resolvePlatformExtensions(reference);
    assert.strictEqual(second.status, 'resolved');
    assert.deepStrictEqual(second.document, { vendor: 'example', feature: true });
    assert.strictEqual(Buffer.from(second.body).toString('utf8'), body.toString('utf8'));
  });

  test('cache scope includes body caps so permissive calls do not relax later strict calls', async () => {
    const resolver = createCanonicalReferenceResolver(unsafeLocal);
    const body = jsonBody({ payload: 'x'.repeat(512) });
    const reference = {
      uri: `${baseUrl}/large-json.json`,
      digest: digest(body),
    };

    const permissive = await resolver.resolvePlatformExtensions(reference, { maxBodyBytes: body.byteLength });
    const strict = await resolver.resolvePlatformExtensions(reference, { maxBodyBytes: 128 });

    assert.strictEqual(permissive.status, 'resolved');
    assert.strictEqual(strict.status, 'unresolvable');
    assert.strictEqual(strict.error.code, 'body_too_large');
  });

  test('validates Draft-07 and Draft 2020-12 format_schema documents', async () => {
    const draft07Body = jsonBody({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { width: { type: 'integer' } },
    });
    const draft2020Body = jsonBody({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { height: { type: 'integer' } },
    });

    const draft07 = await resolveFormatSchemaReference(ref(baseUrl, '/draft-07.json', draft07Body), unsafeLocal);
    const draft2020 = await resolveFormatSchemaReference(ref(baseUrl, '/draft-2020.json', draft2020Body), unsafeLocal);

    assert.strictEqual(draft07.status, 'resolved');
    assert.strictEqual(draft07.schemaMeta.draft, 'draft-07');
    assert.strictEqual(draft2020.status, 'resolved');
    assert.strictEqual(draft2020.schemaMeta.draft, '2020-12');
  });

  test('rejects format_schema documents without an explicit $schema draft URI', async () => {
    const body = jsonBody({ type: 'object' });
    const result = await resolveFormatSchemaReference(ref(baseUrl, '/missing-schema.json', body), unsafeLocal);

    assert.strictEqual(result.status, 'invalid_schema');
    assert.strictEqual(result.error.code, 'unsupported_schema_draft');
  });

  test('digest mismatch is a substitution-attack signal', async () => {
    const result = await resolvePlatformExtensionsReference(
      { uri: `${baseUrl}/platform.json`, digest: digest(Buffer.from('wrong body')) },
      unsafeLocal
    );

    assert.strictEqual(result.status, 'digest_mismatch');
    assert.strictEqual(result.error.code, 'digest_mismatch');
    assert.strictEqual(result.error.securitySignal, 'substitution_attack');
    assert.strictEqual(result.error.retryable, false);
  });

  test('invalid JSON Schema returns invalid_schema', async () => {
    const body = jsonBody({ $schema: 'http://json-schema.org/draft-07/schema#', type: 123 });
    const result = await resolveFormatSchemaReference(ref(baseUrl, '/invalid-schema.json', body), unsafeLocal);

    assert.strictEqual(result.status, 'invalid_schema');
    assert.strictEqual(result.error.code, 'invalid_json_schema');
  });

  test('rejects the catastrophic-regex fetch-contract fixture as budget_exceeded', async () => {
    const fixture = {
      test_id: 'fetch-contract-neg-09-catastrophic-regex',
      category: 'compile_budget',
      expected_outcome: 'fail:budget_exceeded',
      setup: {
        response_body: {
          $schema: 'http://json-schema.org/draft-07/schema#',
          $id: '/schemas/test/bad-regex.json',
          type: 'object',
          properties: {
            input: {
              type: 'string',
              pattern: '^(a+)+$',
            },
          },
        },
      },
    };
    const body = jsonBody(fixture.setup.response_body);
    routes.set('/catastrophic-regex.json', (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/schema+json' });
      res.end(body);
    });

    const result = await resolveFormatSchemaReference(ref(baseUrl, '/catastrophic-regex.json', body), unsafeLocal);

    assert.strictEqual(fixture.expected_outcome, 'fail:budget_exceeded');
    assert.strictEqual(result.status, 'invalid_schema');
    assert.strictEqual(result.error.code, 'budget_exceeded');
    assert.strictEqual(result.error.retryable, false);
    assert.strictEqual(result.error.details.location, '/properties/input/pattern');
    assert.strictEqual(result.error.details.reason, 'nested_unbounded_quantifier');
    assert.strictEqual(result.error.details.patternPreview, '^(a+)+$');
    assert.strictEqual(result.error.details.patternLength, '^(a+)+$'.length);
    assert.strictEqual(result.error.details.patternSha256, createHash('sha256').update('^(a+)+$').digest('hex'));
    assert.strictEqual(result.error.details.pattern, undefined);
  });

  test('rejects ambiguous repeated character-class and bounded-repeat regexes', async () => {
    const cases = [
      { route: '/ambiguous-alternation-regex.json', pattern: '^(?:[0-9]|[0-9][0-9])+$' },
      { route: '/bounded-repeat-regex.json', pattern: '^(?:[0-9]{1,2})+$' },
    ];

    for (const item of cases) {
      const body = jsonBody({
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {
          input: {
            type: 'string',
            pattern: item.pattern,
          },
        },
      });
      routes.set(item.route, (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/schema+json' });
        res.end(body);
      });

      const result = await resolveFormatSchemaReference(ref(baseUrl, item.route, body), unsafeLocal);

      assert.strictEqual(result.status, 'invalid_schema');
      assert.strictEqual(result.error.code, 'budget_exceeded');
      assert.strictEqual(result.error.details.location, '/properties/input/pattern');
      assert.strictEqual(result.error.details.patternPreview, item.pattern);
      assert.strictEqual(result.error.details.pattern, undefined);
    }
  });

  test('ignores annotation examples and accepts delimiter-separated regex patterns', async () => {
    const body = jsonBody({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      examples: [{ pattern: '^(a+)+$' }],
      default: { pattern: '^(a+)+$' },
      properties: {
        csv: {
          type: 'string',
          pattern: '^(?:[^,]+,)*[^,]+$',
        },
      },
    });
    routes.set('/safe-regex.json', (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/schema+json' });
      res.end(body);
    });

    const result = await resolveFormatSchemaReference(ref(baseUrl, '/safe-regex.json', body), unsafeLocal);

    assert.strictEqual(result.status, 'resolved');
  });

  test('off-origin and file:// $refs are rejected by the format_schema sandbox', async () => {
    const offOriginBody = jsonBody({
      $schema: 'http://json-schema.org/draft-07/schema#',
      properties: { x: { $ref: 'https://attacker.example/schema.json' } },
    });
    const fileBody = jsonBody({
      $schema: 'http://json-schema.org/draft-07/schema#',
      properties: { x: { $ref: 'file:///etc/passwd' } },
    });

    const offOrigin = await resolveFormatSchemaReference(
      ref(baseUrl, '/off-origin-ref.json', offOriginBody),
      unsafeLocal
    );
    const file = await resolveFormatSchemaReference(ref(baseUrl, '/file-ref.json', fileBody), unsafeLocal);

    assert.strictEqual(offOrigin.status, 'invalid_schema');
    assert.strictEqual(offOrigin.error.code, 'ref_sandbox_violation');
    assert.strictEqual(offOrigin.error.details.sandboxCode, 'cross_origin_rejected');
    assert.strictEqual(file.status, 'invalid_schema');
    assert.strictEqual(file.error.details.sandboxCode, 'file_scheme_rejected');
  });

  test('external format_schema $refs require pinned digests and verify them', async () => {
    const childBody = jsonBody({ type: 'string', from: 'child' });
    const parentBody = jsonBody({
      $schema: 'http://json-schema.org/draft-07/schema#',
      properties: { x: { $ref: `${baseUrl}/external-ref-child.json` } },
    });
    const reference = ref(baseUrl, '/external-ref-parent.json', parentBody);

    const missing = await resolveFormatSchemaReference(reference, unsafeLocal);
    const resolved = await resolveFormatSchemaReference(reference, {
      ...unsafeLocal,
      externalRefDigests: { [`${baseUrl}/external-ref-child.json`]: digest(childBody) },
    });
    const mismatch = await resolveFormatSchemaReference(reference, {
      ...unsafeLocal,
      externalRefDigests: { [`${baseUrl}/external-ref-child.json`]: digest(Buffer.from('wrong')) },
    });

    assert.strictEqual(missing.status, 'invalid_schema');
    assert.strictEqual(missing.error.code, 'external_ref_unpinned');
    assert.strictEqual(resolved.status, 'resolved');
    assert.strictEqual(resolved.document.properties.x.from, 'child');
    assert.strictEqual(mismatch.status, 'digest_mismatch');
    assert.strictEqual(mismatch.error.securitySignal, 'substitution_attack');
  });

  test('external format_schema $refs are cached by pinned uri@digest', async () => {
    const childBody = jsonBody({ type: 'string', from: 'cached-child' });
    const parentBody = jsonBody({
      $schema: 'http://json-schema.org/draft-07/schema#',
      properties: { x: { $ref: `${baseUrl}/external-ref-cache-child.json` } },
    });
    const resolver = createCanonicalReferenceResolver(unsafeLocal);
    const reference = ref(baseUrl, '/external-ref-cache-parent.json', parentBody);
    const options = {
      externalRefDigests: { [`${baseUrl}/external-ref-cache-child.json`]: digest(childBody) },
    };

    const first = await resolver.resolveFormatSchema(reference, options);
    routes.set('/external-ref-cache-child.json', (_req, res) => {
      res.writeHead(503).end('temporary');
    });
    const second = await resolver.resolveFormatSchema(reference, options);

    assert.strictEqual(first.status, 'resolved');
    assert.strictEqual(second.status, 'resolved');
    assert.strictEqual(second.document.properties.x.from, 'cached-child');
    assert.strictEqual(requestCounts.get('/external-ref-cache-child.json'), 1);
  });

  test('external $ref transport failures stay retryable unresolvable failures', async () => {
    const parentBody = jsonBody({
      $schema: 'http://json-schema.org/draft-07/schema#',
      properties: { x: { $ref: `${baseUrl}/external-ref-503.json` } },
    });
    routes.set('/external-ref-503-parent.json', (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/schema+json' });
      res.end(parentBody);
    });

    const result = await resolveFormatSchemaReference(ref(baseUrl, '/external-ref-503-parent.json', parentBody), {
      ...unsafeLocal,
      externalRefDigests: { [`${baseUrl}/external-ref-503.json`]: digest(jsonBody({ type: 'string' })) },
    });

    assert.strictEqual(result.status, 'unresolvable');
    assert.strictEqual(result.error.code, 'http_error');
    assert.strictEqual(result.error.retryable, true);
  });

  test('same $id schemas do not collide across validations', async () => {
    const bodyA = jsonBody({
      $id: 'https://publisher.example-ad.com/shared-id',
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { a: { type: 'string' } },
    });
    const bodyB = jsonBody({
      $id: 'https://publisher.example-ad.com/shared-id',
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { b: { type: 'integer' } },
    });

    const first = await resolveFormatSchemaReference(ref(baseUrl, '/same-id-a.json', bodyA), unsafeLocal);
    const second = await resolveFormatSchemaReference(ref(baseUrl, '/same-id-b.json', bodyB), unsafeLocal);

    assert.strictEqual(first.status, 'resolved');
    assert.strictEqual(second.status, 'resolved');
  });

  test('rejects http:// references unless the caller opts into unsafe local testing', async () => {
    const result = await resolvePlatformExtensionsReference({
      uri: `${baseUrl}/platform.json`,
      digest: digest(jsonBody({ vendor: 'example', feature: true })),
    });

    assert.strictEqual(result.status, 'blocked_unsafe_url');
    assert.strictEqual(result.error.code, 'non_https_url');
  });

  test('rejects private and metadata URL targets through the SSRF guard', async () => {
    const body = jsonBody({});

    const privateResult = await resolvePlatformExtensionsReference(
      { uri: 'https://127.0.0.1:1/private.json', digest: digest(body) },
      { allowPrivateNetwork: false }
    );
    const metadataResult = await resolvePlatformExtensionsReference(
      { uri: 'http://169.254.169.254/latest/meta-data/', digest: digest(body) },
      unsafeLocal
    );

    assert.strictEqual(privateResult.status, 'blocked_unsafe_url');
    assert.strictEqual(privateResult.error.code, 'unsafe_url');
    assert.strictEqual(privateResult.error.details.ssrfCode, 'private_address');
    assert.strictEqual(metadataResult.status, 'blocked_unsafe_url');
    assert.strictEqual(metadataResult.error.details.ssrfCode, 'always_blocked_address');
  });

  test('rejects RFC 6761 and special-use hostnames before DNS', async () => {
    const result = await resolvePlatformExtensionsReference({
      uri: 'https://schema.test/platform.json',
      digest: digest(jsonBody({})),
    });
    const local = await resolvePlatformExtensionsReference({
      uri: 'https://printer.home.arpa/platform.json',
      digest: digest(jsonBody({})),
    });
    const example = await resolvePlatformExtensionsReference({
      uri: 'https://thing.example/platform.json',
      digest: digest(jsonBody({})),
    });

    assert.strictEqual(result.status, 'blocked_unsafe_url');
    assert.strictEqual(result.error.code, 'unsafe_url');
    assert.strictEqual(result.error.details.hostname, 'schema.test');
    assert.strictEqual(local.status, 'blocked_unsafe_url');
    assert.strictEqual(local.error.details.hostname, 'printer.home.arpa');
    assert.strictEqual(example.status, 'blocked_unsafe_url');
    assert.strictEqual(example.error.details.hostname, 'thing.example');
  });

  test('redirects, timeouts, and body caps return structured failures', async () => {
    const redirect = await resolvePlatformExtensionsReference(
      { uri: `${baseUrl}/redirect.json`, digest: digest(Buffer.from('unused')) },
      unsafeLocal
    );
    const timeout = await resolvePlatformExtensionsReference(
      { uri: `${baseUrl}/hang.json`, digest: digest(Buffer.from('unused')) },
      { ...unsafeLocal, timeoutMs: 25 }
    );
    const tooLarge = await resolvePlatformExtensionsReference(
      { uri: `${baseUrl}/big.json`, digest: digest(Buffer.alloc(4096, 0x41)) },
      { ...unsafeLocal, maxBodyBytes: 128 }
    );

    assert.strictEqual(redirect.status, 'blocked_unsafe_url');
    assert.strictEqual(redirect.error.code, 'redirect_blocked');
    assert.strictEqual(timeout.status, 'unresolvable');
    assert.strictEqual(timeout.error.retryable, true);
    assert.strictEqual(tooLarge.status, 'unresolvable');
    assert.strictEqual(tooLarge.error.code, 'body_too_large');
  });

  test('publishes root and @adcp/sdk/canonical-references exports', () => {
    const sdk = require('@adcp/sdk');
    const canonical = require('@adcp/sdk/canonical-references');

    assert.strictEqual(typeof sdk.createCanonicalReferenceResolver, 'function');
    assert.strictEqual(typeof canonical.createCanonicalReferenceResolver, 'function');
    assert.strictEqual(sdk.createCanonicalReferenceResolver, canonical.createCanonicalReferenceResolver);
    assert.deepStrictEqual(pkg.exports['./canonical-references'], {
      import: {
        types: './dist/lib/canonical-references/index.d.mts',
        default: './dist/lib/canonical-references/index.mjs',
      },
      require: {
        types: './dist/lib/canonical-references/index.d.ts',
        default: './dist/lib/canonical-references/index.js',
      },
    });
    assert.deepStrictEqual(pkg.typesVersions['*']['canonical-references'], [
      'dist/lib/canonical-references/index.d.ts',
    ]);

    const distRoot = path.join(__dirname, '..', '..', 'dist', 'lib', 'canonical-references');
    assert.ok(fs.existsSync(path.join(distRoot, 'index.js')), 'dist/lib/canonical-references/index.js must exist');
    assert.ok(fs.existsSync(path.join(distRoot, 'index.d.ts')), 'dist/lib/canonical-references/index.d.ts must exist');
  });
});
