const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  createAdcpServer,
  verifyApiKey,
  anyOf,
  respondUnauthorized,
  requireSignatureWhenPresent,
  requireAuthenticatedOrSigned,
  signatureErrorCodeFromCause,
  createExpressAdapter,
  AuthError,
  createIdempotencyStore,
  memoryBackend,
  InMemoryStateStore,
} = require('../../dist/lib/server/index.js');

const {
  COMPLIANCE_FIXTURES,
  COMPLIANCE_COLLECTIONS,
  seedComplianceFixtures,
  getComplianceFixture,
} = require('../../dist/lib/compliance-fixtures/index.js');

const { TOOL_INPUT_SHAPES, customToolFor } = require('../../dist/lib/schemas/index.js');

const { RequestSignatureError } = require('../../dist/lib/signing/index.js');

// ---------------------------------------------------------------------------
// #665 — requireSignatureWhenPresent + requiredFor / requireAuthenticatedOrSigned
// ---------------------------------------------------------------------------

describe('#665 requireSignatureWhenPresent + requiredFor', () => {
  const fakeSig = () => null;
  const fakeBearer = keys => verifyApiKey({ keys });

  function unsignedReqWithBody(body) {
    return {
      method: 'POST',
      url: '/mcp',
      headers: { host: 'seller.example.com', 'content-type': 'application/json' },
      rawBody: body,
    };
  }

  it('throws AuthError with RequestSignatureError cause when op is in requiredFor and no creds present', async () => {
    const gate = requireSignatureWhenPresent(fakeSig, fakeBearer({}), {
      requiredFor: ['create_media_buy'],
      resolveOperation: req => {
        try {
          const body = JSON.parse(req.rawBody);
          if (body.method === 'tools/call') return body.params?.name;
        } catch {}
        return undefined;
      },
    });
    const req = unsignedReqWithBody(JSON.stringify({ method: 'tools/call', params: { name: 'create_media_buy' } }));
    await assert.rejects(
      () => gate(req),
      err =>
        err instanceof AuthError &&
        err.cause instanceof RequestSignatureError &&
        err.cause.code === 'request_signature_required'
    );
  });

  it('returns fallback principal when op IS in requiredFor but valid bearer is presented', async () => {
    const gate = requireSignatureWhenPresent(fakeSig, fakeBearer({ sk_live: { principal: 'acct_1' } }), {
      requiredFor: ['create_media_buy'],
      resolveOperation: () => 'create_media_buy',
    });
    const req = {
      method: 'POST',
      url: '/mcp',
      headers: { host: 'x', authorization: 'Bearer sk_live' },
      rawBody: '{}',
    };
    const result = await gate(req);
    assert.ok(result);
    assert.strictEqual(result.principal, 'acct_1');
  });

  it('returns null when op is NOT in requiredFor and no creds present (default 401 path)', async () => {
    const gate = requireSignatureWhenPresent(fakeSig, fakeBearer({}), {
      requiredFor: ['create_media_buy'],
      resolveOperation: () => 'get_products',
    });
    const req = unsignedReqWithBody('{}');
    const result = await gate(req);
    assert.strictEqual(result, null);
  });

  it('skips requiredFor pre-check when resolveOperation returns undefined', async () => {
    const gate = requireSignatureWhenPresent(fakeSig, fakeBearer({}), {
      requiredFor: ['create_media_buy'],
      resolveOperation: () => undefined,
    });
    const result = await gate(unsignedReqWithBody('{}'));
    assert.strictEqual(result, null);
  });

  it('requireAuthenticatedOrSigned bundles the same semantics', async () => {
    const gate = requireAuthenticatedOrSigned({
      signature: fakeSig,
      fallback: fakeBearer({}),
      requiredFor: ['create_media_buy'],
      resolveOperation: () => 'create_media_buy',
    });
    await assert.rejects(
      () => gate(unsignedReqWithBody('{}')),
      err => err.cause instanceof RequestSignatureError && err.cause.code === 'request_signature_required'
    );
  });
});

// ---------------------------------------------------------------------------
// #665 — respondUnauthorized signature challenge + signatureErrorCodeFromCause
// ---------------------------------------------------------------------------

describe('#665 respondUnauthorized signature challenge', () => {
  function fakeRes() {
    const state = { status: 0, headers: {}, body: '' };
    return {
      state,
      writeHead(status, headers) {
        state.status = status;
        Object.assign(state.headers, headers);
      },
      end(body) {
        state.body = body;
      },
    };
  }

  it('emits `WWW-Authenticate: Signature ...` when signatureError is set', () => {
    const res = fakeRes();
    respondUnauthorized({}, res, {
      signatureError: 'request_signature_invalid',
      errorDescription: 'Bad sig.',
    });
    assert.strictEqual(res.state.status, 401);
    const challenge = res.state.headers['WWW-Authenticate'];
    assert.match(challenge, /^Signature /);
    assert.match(challenge, /error="request_signature_invalid"/);
    const body = JSON.parse(res.state.body);
    assert.strictEqual(body.error, 'request_signature_invalid');
  });

  it('emits Bearer challenge when no signatureError is set (default path)', () => {
    const res = fakeRes();
    respondUnauthorized({}, res, { error: 'invalid_token' });
    assert.match(res.state.headers['WWW-Authenticate'], /^Bearer /);
  });

  it('signatureErrorCodeFromCause unwraps AuthError → RequestSignatureError cause chain', () => {
    const inner = new RequestSignatureError('request_signature_replayed', 13, 'replay');
    const wrapped = new AuthError('rejected', { cause: inner });
    assert.strictEqual(signatureErrorCodeFromCause(wrapped), 'request_signature_replayed');
  });

  it('signatureErrorCodeFromCause returns null for non-signature errors', () => {
    const e = new Error('x');
    assert.strictEqual(signatureErrorCodeFromCause(e), null);
  });

  it('signatureErrorCodeFromCause breaks on self-referential cause cycle', () => {
    const a = new Error('a');
    a.cause = a;
    assert.strictEqual(signatureErrorCodeFromCause(a), null);
  });

  it('signatureErrorCodeFromCause breaks on 2-cycle cause chains', () => {
    const a = new Error('a');
    const b = new Error('b');
    a.cause = b;
    b.cause = a;
    assert.strictEqual(signatureErrorCodeFromCause(a), null);
  });
});

describe('#666 compliance.reset() guardrails', () => {
  it('refuses to run in NODE_ENV=production without allowProduction', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const server = createAdcpServer({
        name: 'x',
        version: '0.0.1',
        stateStore: new InMemoryStateStore(),
        mediaBuy: { getProducts: async () => ({ products: [] }) },
      });
      await assert.rejects(() => server.compliance.reset(), /NODE_ENV=production/);
      // Opt-out works:
      await server.compliance.reset({ allowProduction: true });
    } finally {
      if (originalEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalEnv;
    }
  });

  it('refuses to run when stateStore is not InMemoryStateStore without force', async () => {
    // Fake a non-InMemoryStateStore — fulfills the AdcpStateStore shape but isn't the sentinel.
    const fakeStore = {
      get: async () => null,
      getWithVersion: async () => null,
      put: async () => {},
      putIfMatch: async () => ({ ok: true, version: 1 }),
      patch: async () => {},
      delete: async () => true,
      list: async () => ({ items: [], nextCursor: undefined }),
      clear: () => {},
    };
    const server = createAdcpServer({
      name: 'x',
      version: '0.0.1',
      stateStore: fakeStore,
      mediaBuy: { getProducts: async () => ({ products: [] }) },
    });
    await assert.rejects(() => server.compliance.reset(), /is not InMemoryStateStore/);
    // Opt-out works:
    await server.compliance.reset({ force: true });
  });
});

// ---------------------------------------------------------------------------
// #666 — AdcpServer.compliance.reset()
// ---------------------------------------------------------------------------

describe('#666 AdcpServer.compliance.reset()', () => {
  it('clears the state store on reset', async () => {
    const stateStore = new InMemoryStateStore();
    await stateStore.put('campaigns', 'c1', { name: 'one' });
    const server = createAdcpServer({
      name: 'x',
      version: '0.0.1',
      stateStore,
      mediaBuy: { getProducts: async () => ({ products: [] }) },
    });
    assert.ok(await stateStore.get('campaigns', 'c1'), 'seeded');
    await server.compliance.reset();
    assert.strictEqual(await stateStore.get('campaigns', 'c1'), null);
  });

  it('clears the idempotency cache on reset', async () => {
    const stateStore = new InMemoryStateStore();
    const idempotency = createIdempotencyStore({ backend: memoryBackend(), ttlSeconds: 3600 });
    await idempotency.save({
      principal: 'p',
      key: 'aaaaaaaaaaaaaaaa',
      payloadHash: 'h',
      response: { ok: true },
    });
    const check1 = await idempotency.check({
      principal: 'p',
      key: 'aaaaaaaaaaaaaaaa',
      payload: {},
    });
    assert.notStrictEqual(check1.kind, 'miss', 'pre-reset: cached');

    const server = createAdcpServer({
      name: 'x',
      version: '0.0.1',
      stateStore,
      idempotency,
      mediaBuy: { getProducts: async () => ({ products: [] }) },
    });
    await server.compliance.reset();
    const check2 = await idempotency.check({
      principal: 'p',
      key: 'aaaaaaaaaaaaaaaa',
      payload: {},
    });
    assert.strictEqual(check2.kind, 'miss', 'post-reset: miss');
  });
});

// ---------------------------------------------------------------------------
// #663 — compliance-fixtures
// ---------------------------------------------------------------------------

describe('#663 compliance-fixtures', () => {
  it('exposes canonical fixture IDs required by storyboards', () => {
    assert.ok(COMPLIANCE_FIXTURES.products['test-product']);
    assert.ok(COMPLIANCE_FIXTURES.products['sports_ctv_q2']);
    assert.ok(COMPLIANCE_FIXTURES.formats['video_30s']);
    assert.ok(COMPLIANCE_FIXTURES.formats['native_post']);
    assert.ok(COMPLIANCE_FIXTURES.formats['native_content']);
    assert.ok(COMPLIANCE_FIXTURES.pricing_options['test-pricing']);
    assert.ok(COMPLIANCE_FIXTURES.pricing_options['cpm_guaranteed']);
    assert.ok(COMPLIANCE_FIXTURES.creatives['campaign_hero_video']);
    assert.strictEqual(COMPLIANCE_FIXTURES.creatives['campaign_hero_video'].status, 'approved');
    assert.ok(COMPLIANCE_FIXTURES.plans['gov_acme_q2_2027']);
    assert.ok(COMPLIANCE_FIXTURES.media_buys['mb_acme_q2_2026_auction']);
  });

  it('seedComplianceFixtures writes all six collections to the state store', async () => {
    const stateStore = new InMemoryStateStore();
    const server = createAdcpServer({
      name: 'x',
      version: '0.0.1',
      stateStore,
      mediaBuy: { getProducts: async () => ({ products: [] }) },
    });
    await seedComplianceFixtures(server);
    const testProduct = await stateStore.get(COMPLIANCE_COLLECTIONS.products, 'test-product');
    assert.ok(testProduct, 'test-product seeded');
    assert.strictEqual(testProduct.product_id, 'test-product');
    assert.ok(await stateStore.get(COMPLIANCE_COLLECTIONS.products, 'sports_ctv_q2'));

    const seeded = await stateStore.get(COMPLIANCE_COLLECTIONS.creatives, 'campaign_hero_video');
    assert.ok(seeded);
    assert.strictEqual(seeded.status, 'approved');
    assert.ok(await stateStore.get(COMPLIANCE_COLLECTIONS.plans, 'gov_acme_q2_2027'));
    assert.ok(await stateStore.get(COMPLIANCE_COLLECTIONS.media_buys, 'mb_acme_q2_2026_auction'));
  });

  it('seedComplianceFixtures honors category filter and override:null', async () => {
    const stateStore = new InMemoryStateStore();
    const server = createAdcpServer({
      name: 'x',
      version: '0.0.1',
      stateStore,
      mediaBuy: { getProducts: async () => ({ products: [] }) },
    });
    await seedComplianceFixtures(server, {
      categories: ['products'],
      overrides: { products: { sports_ctv_q2: null } },
    });
    assert.ok(await stateStore.get(COMPLIANCE_COLLECTIONS.products, 'test-product'));
    assert.strictEqual(
      await stateStore.get(COMPLIANCE_COLLECTIONS.products, 'sports_ctv_q2'),
      null,
      'override:null deletes'
    );
    const formats = await stateStore.list(COMPLIANCE_COLLECTIONS.formats);
    assert.strictEqual(formats.items.length, 0, 'formats NOT seeded when not in categories');
  });

  it('getComplianceFixture looks up a fixture by category + id', () => {
    const fx = getComplianceFixture('products', 'test-product');
    assert.ok(fx);
    assert.strictEqual(fx.product_id, 'test-product');
    assert.strictEqual(getComplianceFixture('products', 'missing'), undefined);
  });

  it('seedComplianceFixtures rejects non-AdcpServer', async () => {
    await assert.rejects(() => seedComplianceFixtures({}), /is not an AdcpServer/);
  });
});

// ---------------------------------------------------------------------------
// #664 — createExpressAdapter
// ---------------------------------------------------------------------------

describe('#664 createExpressAdapter', () => {
  it('rawBodyVerify attaches rawBody to the request', () => {
    const adapter = createExpressAdapter({ mountPath: '/api/x' });
    const req = {};
    adapter.rawBodyVerify(req, null, Buffer.from('{"hi":1}', 'utf8'));
    assert.strictEqual(req.rawBody, '{"hi":1}');
  });

  it('getUrl uses publicUrl origin and ignores x-forwarded-host (closes audience-confusion)', () => {
    const adapter = createExpressAdapter({
      mountPath: '/api/agent',
      publicUrl: 'https://agent.example.com/api/agent/mcp',
    });
    const url = adapter.getUrl({
      url: '/mcp',
      originalUrl: '/api/agent/mcp',
      headers: {
        host: 'evil.example.com',
        'x-forwarded-host': 'also-evil.example.com',
        'x-forwarded-proto': 'http',
      },
      socket: { encrypted: false },
    });
    assert.strictEqual(url, 'https://agent.example.com/api/agent/mcp');
  });

  it('getUrl throws when neither publicUrl nor trustForwardedHost is set', () => {
    const adapter = createExpressAdapter({ mountPath: '/api/agent' });
    assert.throws(
      () =>
        adapter.getUrl({
          url: '/mcp',
          originalUrl: '/api/agent/mcp',
          headers: { host: 'agent.example.com' },
          socket: { encrypted: true },
        }),
      /neither `publicUrl` nor `trustForwardedHost/
    );
  });

  it('getUrl falls back to header reconstruction under trustForwardedHost opt-in', () => {
    const adapter = createExpressAdapter({ mountPath: '/api/agent', trustForwardedHost: true });
    const url = adapter.getUrl({
      url: '/mcp',
      originalUrl: '/api/agent/mcp',
      headers: { host: 'agent.example.com' },
      socket: { encrypted: true },
    });
    assert.strictEqual(url, 'https://agent.example.com/api/agent/mcp');
  });

  it('getUrl composes mountPath + req.url when originalUrl is absent (via publicUrl)', () => {
    const adapter = createExpressAdapter({
      mountPath: '/api/agent',
      publicUrl: 'https://agent.example.com/api/agent/mcp',
    });
    const url = adapter.getUrl({
      url: '/mcp',
      headers: { host: 'agent.example.com' },
      socket: { encrypted: true },
    });
    assert.strictEqual(url, 'https://agent.example.com/api/agent/mcp');
  });

  it('protectedResourceMiddleware responds for /.well-known/oauth-protected-resource/*', () => {
    const adapter = createExpressAdapter({
      mountPath: '/api/agent',
      publicUrl: 'https://agent.example.com/api/agent/mcp',
      prm: { authorization_servers: ['https://auth.example.com'] },
    });
    const res = {
      state: { status: 0, body: '' },
      writeHead(status) {
        this.state.status = status;
      },
      end(body) {
        this.state.body = body;
      },
    };
    let nextCalled = false;
    adapter.protectedResourceMiddleware(
      { url: '/.well-known/oauth-protected-resource/api/agent/mcp', headers: { host: 'agent.example.com' } },
      res,
      () => {
        nextCalled = true;
      }
    );
    assert.strictEqual(res.state.status, 200);
    assert.strictEqual(nextCalled, false, 'should not call next when handling PRM');
    const body = JSON.parse(res.state.body);
    assert.strictEqual(body.resource, 'https://agent.example.com/api/agent/mcp');
    assert.deepStrictEqual(body.authorization_servers, ['https://auth.example.com']);
    assert.deepStrictEqual(body.bearer_methods_supported, ['header']);
  });

  it('createExpressAdapter refuses prm without publicUrl or trustForwardedHost', () => {
    assert.throws(
      () =>
        createExpressAdapter({
          mountPath: '/api/agent',
          prm: { authorization_servers: ['https://auth.example.com'] },
        }),
      /`prm` requires either `publicUrl`/
    );
  });

  it('protectedResourceMiddleware calls next() for unrelated paths', () => {
    const adapter = createExpressAdapter({
      mountPath: '/api/agent',
      publicUrl: 'https://agent.example.com/api/agent/mcp',
      prm: { authorization_servers: ['https://auth.example.com'] },
    });
    let nextCalled = false;
    adapter.protectedResourceMiddleware(
      { url: '/api/agent/mcp', headers: { host: 'x' } },
      { writeHead() {}, end() {} },
      () => {
        nextCalled = true;
      }
    );
    assert.ok(nextCalled);
  });

  it('resetHook delegates to server.compliance.reset when server is set', async () => {
    const stateStore = new InMemoryStateStore();
    await stateStore.put('c', 'k', { v: 1 });
    const server = createAdcpServer({
      name: 'x',
      version: '0.0.1',
      stateStore,
      mediaBuy: { getProducts: async () => ({ products: [] }) },
    });
    const adapter = createExpressAdapter({
      mountPath: '/api/x',
      publicUrl: 'https://x.example.com/api/x/mcp',
      server,
    });
    await adapter.resetHook();
    assert.strictEqual(await stateStore.get('c', 'k'), null);
  });
});

// ---------------------------------------------------------------------------
// #667 — TOOL_INPUT_SHAPES + customToolFor
// ---------------------------------------------------------------------------

describe('#667 TOOL_INPUT_SHAPES', () => {
  it('includes both framework tools and custom-only tools', () => {
    // Framework tool
    assert.ok(TOOL_INPUT_SHAPES.get_products);
    assert.ok(TOOL_INPUT_SHAPES.create_media_buy);
    // Non-framework custom tools the issue enumerates:
    assert.ok(TOOL_INPUT_SHAPES.creative_approval);
    assert.ok(TOOL_INPUT_SHAPES.update_rights);
    assert.ok(TOOL_INPUT_SHAPES.comply_test_controller);
    assert.ok(TOOL_INPUT_SHAPES.check_governance);
    assert.ok(TOOL_INPUT_SHAPES.acquire_rights);
  });

  it('each entry is a raw shape object (Record<string, ZodType>)', () => {
    const shape = TOOL_INPUT_SHAPES.creative_approval;
    assert.strictEqual(typeof shape, 'object');
    // rights_id is a required string in creative_approval
    assert.ok(shape.rights_id);
    // idempotency_key is required on mutating tools
    assert.ok(shape.idempotency_key);
  });

  it('customToolFor returns an MCP-compatible registration object', () => {
    const shape = TOOL_INPUT_SHAPES.creative_approval;
    const reg = customToolFor('creative_approval', 'Submit creative for approval', shape, async args => ({
      status: 'approved',
      rights_id: args.rights_id,
    }));
    assert.strictEqual(reg.description, 'Submit creative for approval');
    assert.strictEqual(reg.inputSchema, shape);
    assert.strictEqual(typeof reg.handler, 'function');
  });
});

// ---------------------------------------------------------------------------
// #668 — grader capability-profile mismatch auto-skip
// ---------------------------------------------------------------------------

describe('#668 grader capability-profile mismatch skip', () => {
  const {
    gradeOneVector,
    loadRequestSigningVectors,
  } = require('../../dist/lib/testing/storyboard/request-signing/index.js');

  it('auto-skips vectors whose covers_content_digest demands conflict with agentCapability', async () => {
    // Vector 007 ships `covers_content_digest: 'required'`; an agent that
    // declares `'forbidden'` can never grade this vector truthfully.
    const { negative } = loadRequestSigningVectors();
    const v007 = negative.find(v => v.id.includes('007'));
    assert.ok(v007, 'vector 007 should exist');
    assert.strictEqual(v007.verifier_capability.covers_content_digest, 'required');

    const result = await gradeOneVector(v007.id, 'negative', 'http://127.0.0.1:1', {
      agentCapability: {
        supported: true,
        covers_content_digest: 'forbidden',
        required_for: [],
      },
    });
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.skip_reason, 'capability_profile_mismatch');
    assert.match(result.diagnostic, /covers_content_digest/);
  });

  it('runs vectors whose verifier_capability is permissive under the agent profile', async () => {
    // Vector 001 ships `covers_content_digest: 'either'` — ANY agent
    // profile should grade against it (no auto-skip).
    const { positive } = loadRequestSigningVectors();
    const v001 = positive.find(v => v.id.includes('001'));
    assert.ok(v001);
    // We need the probe to short-circuit without hitting a network. Use an
    // unreachable address — the grader returns a failed result (probe error),
    // NOT a skipped one. That's what we're asserting here: not skipped.
    const result = await gradeOneVector(v001.id, 'positive', 'http://127.0.0.1:1', {
      agentCapability: {
        supported: true,
        covers_content_digest: 'either',
        // Superset of the vector's required_for — agents that require MORE
        // than the vector asserts are still conformant against that vector.
        required_for: [...(v001.verifier_capability.required_for ?? []), 'update_media_buy'],
      },
      timeoutMs: 500,
    });
    assert.notStrictEqual(result.skip_reason, 'capability_profile_mismatch');
  });

  it('auto-skips when vector asserts required_for includes an op the agent does not require', async () => {
    // Vectors with `required_for: ['create_media_buy']` in their capability
    // fixture shouldn't grade against an agent whose required_for is empty.
    const { negative } = loadRequestSigningVectors();
    const vecWithRequiredFor = negative.find(v => v.verifier_capability.required_for?.length);
    if (!vecWithRequiredFor) {
      // If no shipped vector asserts a non-empty required_for, skip — the
      // mismatch path still has unit coverage via the capabilityMismatch helper.
      return;
    }
    const result = await gradeOneVector(vecWithRequiredFor.id, 'negative', 'http://127.0.0.1:1', {
      agentCapability: {
        supported: true,
        covers_content_digest: 'either',
        required_for: [],
      },
    });
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.skip_reason, 'capability_profile_mismatch');
    assert.match(result.diagnostic, /required_for/);
  });
});
