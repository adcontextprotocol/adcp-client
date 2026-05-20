// $ref sandboxing for format_schema bodies — exercises the spec's
// normative rules from product-format-declaration.json#format_schema:
//
//   - Intra-document `#/...` pointers resolve against the parent doc.
//   - Cross-origin refs rejected unless under the AAO mirror host.
//   - `file://` refs rejected unconditionally.
//   - Depth ≤ 8, count ≤ 256 (spec ceilings).
//   - External fetches go through ssrfSafeFetch with HTTPS-only + body cap.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

process.env.ADCP_ALLOW_INTERNAL_PROBES = '1';

const {
  resolveSchemaRefs,
  SchemaRefSandboxError,
  DEFAULT_MAX_REF_DEPTH,
  DEFAULT_MAX_REF_COUNT,
} = require('../../dist/lib/v2/format-schema/index.js');

let server;
let baseUrl;
let mirrorBaseUrl; // simulates the AAO mirror host
const routes = new Map();

before(async () => {
  server = http.createServer((req, res) => {
    const handler = routes.get(req.headers.host + req.url);
    if (!handler) {
      res.writeHead(404).end();
      return;
    }
    handler(req, res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
  // For tests, the "mirror" is the same loopback server with a custom
  // host header. We exercise the mirror-host allowlist by overriding
  // `mirrorHost` on the resolve call to '127.0.0.1' (the test rig's
  // hostname). Production mirrorHost is `mirror.adcontextprotocol.org`.
  mirrorBaseUrl = baseUrl;
});

after(() => server.close());

function serveJson(path, body) {
  const host = `127.0.0.1:${server.address().port}`;
  routes.set(host + path, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/schema+json' });
    res.end(JSON.stringify(body));
  });
}

describe('resolveSchemaRefs — intra-document pointers', () => {
  test('resolves a `#/definitions/foo` pointer inline', async () => {
    const schema = {
      type: 'object',
      properties: { wrapped: { $ref: '#/definitions/inner' } },
      definitions: { inner: { type: 'string', description: 'inner' } },
    };
    const { schema: resolved, refCount } = await resolveSchemaRefs(schema, 'https://publisher.example/x.json');
    assert.deepStrictEqual(resolved.properties.wrapped, { type: 'string', description: 'inner' });
    assert.strictEqual(refCount, 1);
  });

  test('preserves $ref siblings (description) when inlining', async () => {
    const schema = {
      properties: { wrapped: { $ref: '#/definitions/inner', description: 'sibling note' } },
      definitions: { inner: { type: 'number' } },
    };
    const { schema: resolved } = await resolveSchemaRefs(schema, 'https://publisher.example/x.json');
    assert.deepStrictEqual(resolved.properties.wrapped, { type: 'number', description: 'sibling note' });
  });

  test('unresolved pointer surfaces pointer_unresolved', async () => {
    const schema = { $ref: '#/definitions/missing' };
    await assert.rejects(
      () => resolveSchemaRefs(schema, 'https://publisher.example/x.json'),
      err => err instanceof SchemaRefSandboxError && err.code === 'pointer_unresolved'
    );
  });

  test('cyclic intra-doc pointers trip the depth limit', async () => {
    // `#/a` → `#/b` → `#/a` … should hit maxDepth before infinite recursion.
    const schema = {
      a: { $ref: '#/b' },
      b: { $ref: '#/a' },
      $ref: '#/a',
    };
    await assert.rejects(
      () => resolveSchemaRefs(schema, 'https://publisher.example/x.json', { maxDepth: 4 }),
      err => err instanceof SchemaRefSandboxError && err.code === 'depth_exceeded'
    );
  });
});

describe('resolveSchemaRefs — external ref sandboxing', () => {
  test('file:// scheme rejected unconditionally', async () => {
    const schema = { $ref: 'file:///etc/passwd' };
    await assert.rejects(
      () => resolveSchemaRefs(schema, 'https://publisher.example/x.json'),
      err => err instanceof SchemaRefSandboxError && err.code === 'file_scheme_rejected'
    );
  });

  test('cross-origin (not same-origin, not mirror) rejected', async () => {
    const schema = { $ref: 'https://attacker.example/evil.json' };
    await assert.rejects(
      () => resolveSchemaRefs(schema, 'https://publisher.example/x.json'),
      err => err instanceof SchemaRefSandboxError && err.code === 'cross_origin_rejected'
    );
  });

  test('same-origin ref is fetched and inlined', async () => {
    serveJson('/sibling.json', { type: 'string', description: 'sibling body' });
    const schema = { properties: { x: { $ref: `${baseUrl}/sibling.json` } } };
    const { schema: resolved, refCount } = await resolveSchemaRefs(schema, `${baseUrl}/parent.json`);
    assert.deepStrictEqual(resolved.properties.x, { type: 'string', description: 'sibling body' });
    assert.strictEqual(refCount, 1);
  });

  test('mirror-host ref is allowed when target hostname matches mirrorHost option', async () => {
    serveJson('/from-mirror.json', { type: 'boolean' });
    const schema = { $ref: `${mirrorBaseUrl}/from-mirror.json` };
    // Use the loopback host as the "mirror" for this test rig.
    const { schema: resolved } = await resolveSchemaRefs(schema, 'https://publisher.example/parent.json', {
      mirrorHost: '127.0.0.1',
    });
    assert.deepStrictEqual(resolved, { type: 'boolean' });
  });

  test('cross-origin diagnostic carries the offending ref and origins', async () => {
    const schema = { $ref: 'https://attacker.example/evil.json' };
    try {
      await resolveSchemaRefs(schema, 'https://publisher.example/x.json');
      assert.fail('expected throw');
    } catch (err) {
      assert.ok(err instanceof SchemaRefSandboxError);
      assert.strictEqual(err.code, 'cross_origin_rejected');
      assert.strictEqual(err.ref, 'https://attacker.example/evil.json');
      assert.match(err.message, /attacker\.example/);
      assert.match(err.message, /publisher\.example/);
    }
  });
});

describe('resolveSchemaRefs — bounds', () => {
  test('depth limit enforced across external chains', async () => {
    // Chain: parent → a → b → c → d → e. Each external hop adds one depth step.
    serveJson('/a.json', { $ref: `${baseUrl}/b.json` });
    serveJson('/b.json', { $ref: `${baseUrl}/c.json` });
    serveJson('/c.json', { $ref: `${baseUrl}/d.json` });
    serveJson('/d.json', { type: 'string', terminal: true });
    const schema = { $ref: `${baseUrl}/a.json` };
    // Depth 3 is enough to reach d.json (parent→a is depth 1, a→b is 2, b→c is 3, c→d is 4).
    await assert.rejects(
      () => resolveSchemaRefs(schema, `${baseUrl}/parent.json`, { maxDepth: 2 }),
      err => err instanceof SchemaRefSandboxError && err.code === 'depth_exceeded'
    );
  });

  test('count limit enforced across the whole tree', async () => {
    // 5 sibling refs, all to the same intra-doc target.
    const schema = {
      definitions: { x: { type: 'string' } },
      props: {
        a: { $ref: '#/definitions/x' },
        b: { $ref: '#/definitions/x' },
        c: { $ref: '#/definitions/x' },
        d: { $ref: '#/definitions/x' },
        e: { $ref: '#/definitions/x' },
      },
    };
    await assert.rejects(
      () => resolveSchemaRefs(schema, 'https://publisher.example/x.json', { maxRefCount: 3 }),
      err => err instanceof SchemaRefSandboxError && err.code === 'count_exceeded'
    );
  });

  test('default bounds are the spec ceilings (8 / 256)', () => {
    assert.strictEqual(DEFAULT_MAX_REF_DEPTH, 8);
    assert.strictEqual(DEFAULT_MAX_REF_COUNT, 256);
  });
});

describe('resolveSchemaRefs — custom fetcher injection', () => {
  test('callers can swap fetchExternal for a digest-enforcing variant', async () => {
    const seen = [];
    const fetchExternal = async uri => {
      seen.push(uri);
      // Pretend caller verified a digest out-of-band.
      return { type: 'integer', from: 'custom-fetcher' };
    };
    const schema = { $ref: 'https://publisher.example/sub.json' };
    const { schema: resolved } = await resolveSchemaRefs(schema, 'https://publisher.example/parent.json', {
      fetchExternal,
    });
    assert.deepStrictEqual(resolved, { type: 'integer', from: 'custom-fetcher' });
    assert.deepStrictEqual(seen, ['https://publisher.example/sub.json']);
  });

  test('repeat refs hit the per-call cache (one fetch, multiple resolutions)', async () => {
    let fetchCount = 0;
    const fetchExternal = async () => {
      fetchCount += 1;
      return { type: 'string' };
    };
    const schema = {
      props: {
        a: { $ref: 'https://publisher.example/shared.json' },
        b: { $ref: 'https://publisher.example/shared.json' },
        c: { $ref: 'https://publisher.example/shared.json' },
      },
    };
    const { refCount } = await resolveSchemaRefs(schema, 'https://publisher.example/parent.json', { fetchExternal });
    assert.strictEqual(refCount, 3, 'all 3 refs counted');
    assert.strictEqual(fetchCount, 1, 'shared body fetched exactly once');
  });
});
