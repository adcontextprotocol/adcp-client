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
    // `#/definitions/a` → `#/definitions/b` → `#/definitions/a` … should
    // hit maxDepth before infinite recursion. (Keep the $refs inside
    // `definitions` so they don't sit alongside constraint keywords at
    // the schema root — the sibling allowlist rejects that shape.)
    const schema = {
      definitions: {
        a: { $ref: '#/definitions/b' },
        b: { $ref: '#/definitions/a' },
      },
      properties: { entry: { $ref: '#/definitions/a' } },
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

  test('mirror-host ref allowed when target hostname matches mirrorHost option (custom fetcher)', async () => {
    // The default fetcher requires https; for a loopback test we inject
    // a custom fetcher and exercise the host-allowlist branch.
    const fetchExternal = async () => ({ type: 'boolean' });
    const schema = { $ref: 'https://test.mirror.example/from-mirror.json' };
    const { schema: resolved } = await resolveSchemaRefs(schema, 'https://publisher.example/parent.json', {
      mirrorHosts: ['test.mirror.example'],
      fetchExternal,
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

describe('resolveSchemaRefs — security hardening (post-review)', () => {
  test('sibling constraint keywords on $ref rejected (cannot defang referent)', async () => {
    // The referent says `additionalProperties: false`; the sibling tries
    // to override with `additionalProperties: true`. The implementation
    // must refuse the constraint sibling so an attacker can't flip
    // referent constraints and smuggle unvalidated fields.
    const schema = {
      definitions: { strict: { type: 'object', additionalProperties: false, required: ['x'] } },
      properties: {
        defang: { $ref: '#/definitions/strict', additionalProperties: true, required: [] },
      },
    };
    await assert.rejects(
      () => resolveSchemaRefs(schema, 'https://publisher.example/x.json'),
      err =>
        err instanceof SchemaRefSandboxError && err.code === 'invalid_ref' && /additionalProperties/.test(err.message)
    );
  });

  test('annotation siblings (description, title, $comment) allowed alongside $ref', async () => {
    const schema = {
      definitions: { inner: { type: 'string' } },
      props: {
        wrapped: {
          $ref: '#/definitions/inner',
          description: 'human note',
          title: 'Inner thing',
          $comment: 'TODO inline',
        },
      },
    };
    const { schema: resolved } = await resolveSchemaRefs(schema, 'https://publisher.example/x.json');
    assert.strictEqual(resolved.props.wrapped.type, 'string');
    assert.strictEqual(resolved.props.wrapped.description, 'human note');
    assert.strictEqual(resolved.props.wrapped.title, 'Inner thing');
  });

  test('annotation sibling cannot override a referent constraint (referent wins)', async () => {
    // Even if a key landed in the allowlist by mistake, the spread order
    // is defensive: referent wins on collision.
    const schema = {
      definitions: { x: { type: 'string', description: 'referent says' } },
      props: { y: { $ref: '#/definitions/x', description: 'sibling says' } },
    };
    const { schema: resolved } = await resolveSchemaRefs(schema, 'https://publisher.example/x.json');
    assert.strictEqual(resolved.props.y.description, 'referent says');
  });

  test('mirror-host check rejects http:// even when host matches', async () => {
    // Spec is https-only for the mirror branch; the previous accept of
    // `http://mirror.adcontextprotocol.org/...` was a security hole.
    const schema = { $ref: 'http://test.mirror.example/x.json' };
    await assert.rejects(
      () =>
        resolveSchemaRefs(schema, 'https://publisher.example/x.json', {
          mirrorHosts: ['test.mirror.example'],
        }),
      err => err instanceof SchemaRefSandboxError && err.code === 'cross_origin_rejected'
    );
  });

  test('JSON Pointer with __proto__ segment rejected (prototype-pollution defense)', async () => {
    // JSON.parse can produce objects with own __proto__ properties; the
    // sandboxer rejects __proto__/constructor/prototype segments outright.
    const schema = {
      $ref: '#/__proto__/polluted',
      __proto__: { polluted: { type: 'string' } },
    };
    await assert.rejects(
      () => resolveSchemaRefs(schema, 'https://publisher.example/x.json'),
      err => err instanceof SchemaRefSandboxError && err.code === 'pointer_unresolved'
    );
  });

  test('JSON Pointer with constructor segment rejected', async () => {
    const schema = { $ref: '#/constructor/anything' };
    await assert.rejects(
      () => resolveSchemaRefs(schema, 'https://publisher.example/x.json'),
      err => err instanceof SchemaRefSandboxError && err.code === 'pointer_unresolved'
    );
  });

  test('both default mirror hosts accepted during transitional period', async () => {
    // Spec migration: mirror.adcontextprotocol.org → creative.adcontextprotocol.org.
    // The default mirrorHosts list contains both; either resolves.
    const fetchExternal = async () => ({ type: 'string' });
    const schema1 = { $ref: 'https://mirror.adcontextprotocol.org/x.json' };
    const schema2 = { $ref: 'https://creative.adcontextprotocol.org/x.json' };
    const r1 = await resolveSchemaRefs(schema1, 'https://publisher.example/p.json', { fetchExternal });
    const r2 = await resolveSchemaRefs(schema2, 'https://publisher.example/p.json', { fetchExternal });
    assert.strictEqual(r1.schema.type, 'string');
    assert.strictEqual(r2.schema.type, 'string');
  });

  test('subdomain-spoofed mirror host rejected (strict equality, not suffix)', async () => {
    // `evil.mirror.adcontextprotocol.org` is NOT the mirror; only the
    // exact configured host matches.
    const schema = { $ref: 'https://evil.mirror.adcontextprotocol.org/x.json' };
    await assert.rejects(
      () => resolveSchemaRefs(schema, 'https://publisher.example/p.json'),
      err => err instanceof SchemaRefSandboxError && err.code === 'cross_origin_rejected'
    );
  });

  test('external fetch body containing intra-doc #/ resolves against the FETCHED doc', async () => {
    // The walker's `parentRoot: body` swap is load-bearing: nested
    // intra-doc pointers must resolve against the fetched body, not the
    // original parent. Keep the $ref inside `properties` (an allowed
    // non-sibling context) rather than at the root next to `definitions`.
    let fetched = 0;
    const fetchExternal = async () => {
      fetched += 1;
      return {
        definitions: { inner: { type: 'integer', from: 'fetched-doc' } },
        properties: { entry: { $ref: '#/definitions/inner' } },
      };
    };
    const schema = { props: { x: { $ref: 'https://publisher.example/sub.json' } } };
    const { schema: resolved } = await resolveSchemaRefs(schema, 'https://publisher.example/parent.json', {
      fetchExternal,
    });
    // After resolve: x is the fetched body with #/definitions/inner
    // inlined at properties.entry.
    assert.strictEqual(resolved.props.x.properties.entry.type, 'integer');
    assert.strictEqual(resolved.props.x.properties.entry.from, 'fetched-doc');
    assert.strictEqual(fetched, 1);
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
