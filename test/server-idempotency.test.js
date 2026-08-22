const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { createAdcpServer: _createAdcpServer } = require('../dist/lib/server/create-adcp-server');
const { createIdempotencyStore, memoryBackend } = require('../dist/lib/server/idempotency');
const { adcpError } = require('../dist/lib/server/errors');

// Idempotency tests use sparse handler fixtures; opt out of the strict
// response-validation default so we stay focused on replay/claim behavior.
// Shallow-merge `validation` so a per-test override on one key doesn't
// silently re-enable the other side.
function createAdcpServer(config) {
  return _createAdcpServer({
    ...config,
    validation: { requests: 'off', responses: 'off', ...(config?.validation ?? {}) },
  });
}

async function callTool(server, toolName, params) {
  const raw = await server.dispatchTestRequest({
    method: 'tools/call',
    params: { name: toolName, arguments: params ?? {} },
  });
  return raw.structuredContent;
}

function makeServer({ handler, resolveIdempotencyPrincipal } = {}) {
  const idempotency = createIdempotencyStore({
    backend: memoryBackend({ sweepIntervalMs: 0 }),
    ttlSeconds: 86400,
  });

  const calls = [];
  const wrapped = async (params, ctx) => {
    calls.push({ params, ctx });
    if (handler) return handler(params, ctx);
    return { media_buy_id: `mb_${calls.length}`, packages: [] };
  };

  const server = createAdcpServer({
    name: 'Test',
    version: '1.0.0',
    idempotency,
    resolveSessionKey: () => 'tenant_a',
    resolveIdempotencyPrincipal,
    mediaBuy: { createMediaBuy: wrapped },
  });

  return { server, idempotency, calls };
}

function makeSyncAccountsServer({ handler } = {}) {
  const idempotency = createIdempotencyStore({
    backend: memoryBackend({ sweepIntervalMs: 0 }),
    ttlSeconds: 86400,
  });
  const calls = [];
  const server = createAdcpServer({
    name: 'Test',
    version: '1.0.0',
    idempotency,
    resolveSessionKey: () => 'tenant_a',
    accounts: {
      syncAccounts: async (params, ctx) => {
        calls.push({ params, ctx });
        if (handler) return handler(params, ctx);
        return { accounts: [] };
      },
    },
  });

  return { server, idempotency, calls };
}

const basePayload = {
  account: { brand: { domain: 'acme.example' }, operator: 'op.example' },
  brand: { domain: 'acme.example' },
  start_time: '2026-05-01T00:00:00Z',
  end_time: '2026-05-31T23:59:59Z',
  packages: [{ product_id: 'test-product', budget: 5000, pricing_option_id: 'test-pricing' }],
};

describe('createAdcpServer with idempotency', () => {
  it('declares replay_ttl_seconds on get_adcp_capabilities', async () => {
    const { server } = makeServer();
    const result = await callTool(server, 'get_adcp_capabilities', {});
    assert.equal(result.adcp.idempotency.replay_ttl_seconds, 86400);
  });

  it('advertises the wired store TTL instead of a mismatched capability override', async () => {
    const server = createAdcpServer({
      name: 'T',
      version: '1.0.0',
      idempotency: createIdempotencyStore({
        backend: memoryBackend({ sweepIntervalMs: 0 }),
        ttlSeconds: 3600,
      }),
      capabilities: { idempotency: { replay_ttl_seconds: 86400 } },
      resolveSessionKey: () => 'tenant',
      mediaBuy: { createMediaBuy: async () => ({ media_buy_id: 'mb', packages: [] }) },
    });
    const result = await callTool(server, 'get_adcp_capabilities', {});
    assert.equal(result.adcp.idempotency.replay_ttl_seconds, 3600);
  });

  it('rejects mutating request without idempotency_key', async () => {
    const { server, calls } = makeServer();
    const result = await callTool(server, 'create_media_buy', basePayload);
    assert.equal(result.adcp_error?.code, 'INVALID_REQUEST');
    assert.equal(result.adcp_error?.field, 'idempotency_key');
    assert.equal(calls.length, 0, 'handler must not run on validation error');
  });

  it('first call executes handler and returns fresh response', async () => {
    const { server, calls } = makeServer();
    const key = 'replay_key_abcdefghij';
    const result = await callTool(server, 'create_media_buy', {
      ...basePayload,
      idempotency_key: key,
    });
    assert.equal(calls.length, 1);
    assert.equal(result.media_buy_id, 'mb_1');
    // Fresh exec must NOT carry `replayed: true`. `protocol-envelope.json`
    // permits the field to be "omitted when the request was executed
    // fresh", and the framework omits it on fresh so buyers treat
    // absence-or-false as "not a replay".
    assert.notEqual(result.replayed, true, 'fresh execution must not set replayed:true');
  });

  it('replay with same key + equivalent payload returns cached response with replayed:true', async () => {
    const { server, calls } = makeServer();
    const key = 'replay_key_abcdefghij';
    const req = { ...basePayload, idempotency_key: key };

    const first = await callTool(server, 'create_media_buy', req);
    const second = await callTool(server, 'create_media_buy', req);

    assert.equal(calls.length, 1, 'handler must not re-execute on replay');
    assert.equal(second.media_buy_id, first.media_buy_id, 'replay must return same id');
    assert.equal(second.replayed, true, 'replay must set replayed:true');
  });

  it("replay echoes the CURRENT retry context, not the first caller's", async () => {
    // Each buyer retry carries its own correlation_id; the envelope must
    // reflect the current retry, not a cached echo from the first caller.
    // Otherwise end-to-end tracing breaks — the replayed response would
    // surface a correlation_id the current caller never sent.
    const { server } = makeServer();
    const key = 'replay_key_abcdefghij';
    const req = { ...basePayload, idempotency_key: key };

    await callTool(server, 'create_media_buy', { ...req, context: { correlation_id: 'first-attempt' } });
    const replay = await callTool(server, 'create_media_buy', { ...req, context: { correlation_id: 'retry-attempt' } });

    assert.equal(replay.context?.correlation_id, 'retry-attempt');
    assert.equal(replay.replayed, true);
  });

  it('key-reordering in payload is treated as equivalent', async () => {
    const { server, calls } = makeServer();
    const key = 'replay_key_abcdefghij';
    const original = { ...basePayload, idempotency_key: key };
    const reordered = {
      idempotency_key: key,
      packages: basePayload.packages,
      end_time: basePayload.end_time,
      start_time: basePayload.start_time,
      brand: basePayload.brand,
      account: basePayload.account,
    };

    await callTool(server, 'create_media_buy', original);
    const second = await callTool(server, 'create_media_buy', reordered);

    assert.equal(calls.length, 1);
    assert.equal(second.replayed, true);
  });

  it('same key with different payload returns IDEMPOTENCY_CONFLICT', async () => {
    const { server, calls } = makeServer();
    const key = 'conflict_key_abcdefghij';
    await callTool(server, 'create_media_buy', { ...basePayload, idempotency_key: key });

    const conflicting = await callTool(server, 'create_media_buy', {
      ...basePayload,
      idempotency_key: key,
      packages: [{ ...basePayload.packages[0], budget: 99999 }],
    });

    assert.equal(calls.length, 1, 'handler must not run on conflict');
    assert.equal(conflicting.adcp_error?.code, 'IDEMPOTENCY_CONFLICT');
  });

  it('IDEMPOTENCY_CONFLICT error body has no payload/field/hash leak', async () => {
    const { server } = makeServer();
    const key = 'leak_key_abcdefghij12';
    await callTool(server, 'create_media_buy', { ...basePayload, idempotency_key: key });
    const result = await callTool(server, 'create_media_buy', {
      ...basePayload,
      idempotency_key: key,
      packages: [{ ...basePayload.packages[0], budget: 99999 }],
    });

    const err = result.adcp_error;
    assert.equal(err.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(err.field, undefined, 'no field json-pointer (schema-shape leak)');
    assert.equal(err.details, undefined, 'no details (payload leak)');
    // The cached payload must not leak into message text either.
    assert.ok(!err.message.includes('99999'));
  });

  it('fresh key with identical payload creates a new resource', async () => {
    const { server, calls } = makeServer();
    const first = await callTool(server, 'create_media_buy', {
      ...basePayload,
      idempotency_key: 'key_1_abcdefghij1234',
    });
    const second = await callTool(server, 'create_media_buy', {
      ...basePayload,
      idempotency_key: 'key_2_abcdefghij1234',
    });

    assert.equal(calls.length, 2);
    assert.notEqual(first.media_buy_id, second.media_buy_id);
    assert.notEqual(second.replayed, true);
  });

  it('different principals with same key do not cross-replay', async () => {
    const idempotency = createIdempotencyStore({
      backend: memoryBackend({ sweepIntervalMs: 0 }),
      ttlSeconds: 86400,
    });
    const calls = [];
    let principal = 'tenant_a';
    const server = createAdcpServer({
      name: 'T',
      version: '1.0.0',
      idempotency,
      resolveIdempotencyPrincipal: () => principal,
      mediaBuy: {
        createMediaBuy: async () => {
          calls.push('exec');
          return { media_buy_id: `mb_${calls.length}`, packages: [] };
        },
      },
    });

    const key = 'shared_key_abcdefghij';
    await callTool(server, 'create_media_buy', { ...basePayload, idempotency_key: key });

    principal = 'tenant_b';
    const result = await callTool(server, 'create_media_buy', { ...basePayload, idempotency_key: key });

    assert.equal(calls.length, 2, 'different principals should both execute');
    assert.notEqual(result.replayed, true);
  });

  it('same principal cannot replay proposal finalization across resolved accounts', async () => {
    const idempotency = createIdempotencyStore({ backend: memoryBackend({ sweepIntervalMs: 0 }) });
    let accountId = 'tenant_a';
    let calls = 0;
    const seenAccounts = [];
    const server = createAdcpServer({
      name: 'T',
      version: '1.0.0',
      idempotency,
      resolveAccountFromAuth: async () => ({ id: accountId }),
      resolveIdempotencyPrincipal: () => 'shared-client',
      mediaBuy: {
        getProducts: async (_params, ctx) => {
          calls += 1;
          seenAccounts.push(ctx.account.id);
          return { products: [], account_id: ctx.account.id, execution: calls };
        },
      },
    });
    const request = {
      buying_mode: 'refine',
      refine: [{ scope: 'proposal', action: 'finalize', proposal_id: 'proposal_1' }],
      idempotency_key: 'cross_tenant_finalize_0001',
    };

    const first = await callTool(server, 'get_products', request);
    accountId = 'tenant_b';
    const second = await callTool(server, 'get_products', request);

    assert.equal(calls, 2);
    assert.deepEqual(seenAccounts, ['tenant_a', 'tenant_b']);
    assert.notEqual(first.replayed, true);
    assert.notEqual(second.replayed, true);
  });

  it('same principal and key cannot replay a response across tools', async () => {
    const idempotency = createIdempotencyStore({ backend: memoryBackend({ sweepIntervalMs: 0 }) });
    let productCalls = 0;
    let buyCalls = 0;
    const server = createAdcpServer({
      name: 'T',
      version: '1.0.0',
      idempotency,
      resolveSessionKey: () => 'tenant',
      mediaBuy: {
        createMediaBuy: async () => ({ media_buy_id: 'mb_1', packages: [], source: 'buy', execution: ++buyCalls }),
        updateMediaBuy: async () => ({
          media_buy_id: 'mb_1',
          packages: [],
          source: 'update',
          execution: ++productCalls,
        }),
      },
    });
    const request = {
      ...basePayload,
      idempotency_key: 'cross_tool_replay_key_0001',
    };

    await callTool(server, 'create_media_buy', request);
    const update = await callTool(server, 'update_media_buy', request);

    assert.equal(buyCalls, 1);
    assert.equal(productCalls, 0);
    assert.equal(update.adcp_error?.code, 'IDEMPOTENCY_CONFLICT');
  });

  it('blocks rather than re-executes an SDK 13 replay entry after upgrade', async () => {
    const idempotency = createIdempotencyStore({ backend: memoryBackend({ sweepIntervalMs: 0 }) });
    const request = { ...basePayload, idempotency_key: 'legacy_upgrade_replay_0001' };
    const legacy = await idempotency.check({ principal: 'tenant', key: request.idempotency_key, payload: request });
    assert.equal(legacy.kind, 'miss');
    await idempotency.save({
      principal: 'tenant',
      key: request.idempotency_key,
      payloadHash: legacy.payloadHash,
      claimToken: legacy.claimToken,
      response: { media_buy_id: 'legacy_mb', packages: [] },
    });
    let calls = 0;
    const server = createAdcpServer({
      name: 'T',
      version: '1.0.0',
      idempotency,
      resolveSessionKey: () => 'tenant',
      mediaBuy: {
        createMediaBuy: async () => {
          calls += 1;
          return { media_buy_id: 'new_mb', packages: [] };
        },
      },
    });

    const result = await callTool(server, 'create_media_buy', request);

    assert.equal(result.adcp_error?.code, 'IDEMPOTENCY_CONFLICT');
    assert.match(result.adcp_error?.message, /reconcile.*natural key/i);
    assert.equal(calls, 0, 'an older cache record must prevent duplicate execution during upgrade');
  });

  it('cannot forge SDK 14 replay identity by planting internal-looking fields in an SDK 13 entry', async () => {
    const idempotency = createIdempotencyStore({ backend: memoryBackend({ sweepIntervalMs: 0 }) });
    const request = { ...basePayload, idempotency_key: 'legacy_forged_scope_0001' };
    // SDK 13 hashed the request object verbatim. These fields exactly mimic
    // the former object-shaped SDK 14 discriminators and would have replayed
    // without a structurally distinct tuple root.
    const forgedLegacyPayload = {
      ...request,
      __adcp_internal_tool: 'create_media_buy',
      __adcp_internal_trusted_scope: ['tenant', null, null],
    };
    const legacy = await idempotency.check({
      principal: 'tenant',
      key: request.idempotency_key,
      payload: forgedLegacyPayload,
    });
    assert.equal(legacy.kind, 'miss');
    await idempotency.save({
      principal: 'tenant',
      key: request.idempotency_key,
      payloadHash: legacy.payloadHash,
      claimToken: legacy.claimToken,
      response: { media_buy_id: 'attacker_seeded_mb', packages: [] },
    });
    let calls = 0;
    const server = createAdcpServer({
      name: 'T',
      version: '1.0.0',
      idempotency,
      resolveSessionKey: () => 'tenant',
      mediaBuy: {
        createMediaBuy: async () => {
          calls += 1;
          return { media_buy_id: 'new_mb', packages: [] };
        },
      },
    });

    const result = await callTool(server, 'create_media_buy', request);

    assert.equal(result.adcp_error?.code, 'IDEMPOTENCY_CONFLICT');
    assert.notEqual(result.media_buy_id, 'attacker_seeded_mb');
    assert.equal(calls, 0);
  });

  it('does not apply idempotency to read-only tools', async () => {
    const idempotency = createIdempotencyStore({
      backend: memoryBackend({ sweepIntervalMs: 0 }),
    });
    const server = createAdcpServer({
      name: 'T',
      version: '1.0.0',
      idempotency,
      resolveSessionKey: () => 'tenant',
      mediaBuy: {
        getProducts: async () => ({ products: [{ product_id: 'p1' }] }),
      },
    });

    // No idempotency_key — read-only tools should not require it.
    const result = await callTool(server, 'get_products', { brief: 'test' });
    assert.ok(result.products);
    assert.equal(result.adcp_error, undefined);
  });

  it('replays an ordinary get_products read when the optional key is supplied', async () => {
    const idempotency = createIdempotencyStore({ backend: memoryBackend({ sweepIntervalMs: 0 }) });
    let calls = 0;
    const server = createAdcpServer({
      name: 'T',
      version: '1.0.0',
      idempotency,
      resolveSessionKey: () => 'tenant',
      mediaBuy: {
        getProducts: async params => ({ products: [], brief: params.brief, execution: ++calls }),
      },
    });
    const request = { brief: 'find inventory', idempotency_key: 'keyed_discovery_read_0001' };

    const first = await callTool(server, 'get_products', request);
    const replay = await callTool(server, 'get_products', request);
    const conflict = await callTool(server, 'get_products', { ...request, brief: 'different inventory' });
    const invalid = await callTool(server, 'get_products', { brief: 'find inventory', idempotency_key: 123 });

    assert.equal(calls, 1);
    assert.equal(first.execution, 1);
    assert.equal(replay.execution, 1);
    assert.equal(replay.replayed, true);
    assert.equal(conflict.adcp_error?.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(invalid.adcp_error?.code, 'INVALID_REQUEST');
    assert.equal(invalid.adcp_error?.field, 'idempotency_key');
  });

  it('applies idempotency to the state-changing get_products proposal-finalize variant', async () => {
    const idempotency = createIdempotencyStore({
      backend: memoryBackend({ sweepIntervalMs: 0 }),
    });
    let calls = 0;
    const server = createAdcpServer({
      name: 'T',
      version: '1.0.0',
      idempotency,
      resolveSessionKey: () => 'tenant',
      mediaBuy: {
        getProducts: async () => {
          calls += 1;
          return { products: [], execution: calls };
        },
      },
    });
    const request = {
      buying_mode: 'refine',
      refine: [{ scope: 'proposal', action: 'finalize', proposal_id: 'proposal_1' }],
      idempotency_key: 'finalize_replay_key_0001',
    };

    const first = await callTool(server, 'get_products', request);
    const replay = await callTool(server, 'get_products', request);
    const conflict = await callTool(server, 'get_products', {
      ...request,
      refine: [{ ...request.refine[0], ask: 'change the committed hold' }],
    });
    const compatibilityRequest = {
      buying_mode: 'refine',
      refine: [{ scope: 'proposal', action: 'finalize', proposal_id: 'proposal_2' }],
      context: { correlation_id: 'first-attempt' },
      governance_context: 'governance-token-v1',
      push_notification_config: {
        url: 'https://buyer.example/callback',
        token: 'receipt-token',
        authentication: { schemes: ['HMAC-SHA256'], credentials: 'secret-v1' },
      },
    };
    const missingKey = await callTool(server, 'get_products', compatibilityRequest);
    const missingKeyReplay = await callTool(server, 'get_products', {
      ...compatibilityRequest,
      context: { correlation_id: 'retry-attempt' },
      governance_context: 'governance-token-v2',
      push_notification_config: {
        ...compatibilityRequest.push_notification_config,
        authentication: { schemes: ['HMAC-SHA256'], credentials: 'secret-v2' },
      },
    });
    const changedCallback = await callTool(server, 'get_products', {
      ...compatibilityRequest,
      push_notification_config: {
        ...compatibilityRequest.push_notification_config,
        url: 'https://buyer.example/different-callback',
      },
    });
    const numericKey = await callTool(server, 'get_products', {
      buying_mode: 'refine',
      refine: [{ scope: 'proposal', action: 'finalize', proposal_id: 'proposal_3' }],
      idempotency_key: 123,
    });

    assert.equal(calls, 3, 'retry-only changes replay, while a changed callback URL is a distinct finalize identity');
    assert.equal(first.execution, 1);
    assert.equal(replay.execution, 1);
    assert.equal(replay.replayed, true);
    assert.equal(conflict.adcp_error?.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(missingKey.execution, 2);
    assert.equal(missingKey.adcp_error, undefined);
    assert.equal(missingKey.replayed, undefined);
    assert.equal(missingKeyReplay.execution, 2);
    assert.equal(missingKeyReplay.replayed, true);
    assert.equal(changedCallback.execution, 3);
    assert.equal(numericKey.adcp_error?.code, 'INVALID_REQUEST');
    assert.equal(numericKey.adcp_error?.field, 'idempotency_key');
    assert.equal(calls, 3);
  });

  it('rejects malformed finalize intent before a validation-off handler can mutate', async () => {
    const idempotency = createIdempotencyStore({ backend: memoryBackend({ sweepIntervalMs: 0 }) });
    let calls = 0;
    const server = createAdcpServer({
      name: 'T',
      version: '1.0.0',
      idempotency,
      resolveSessionKey: () => 'tenant',
      mediaBuy: {
        getProducts: async () => {
          calls += 1;
          return { products: [] };
        },
      },
    });

    const result = await callTool(server, 'get_products', {
      refine: [{ action: 'finalize', proposal_id: 123 }],
    });

    assert.equal(result.adcp_error?.code, 'INVALID_REQUEST');
    assert.equal(result.adcp_error?.field, 'refine');
    assert.equal(calls, 0);

    const objectResult = await callTool(server, 'get_products', {
      refine: { scope: 'proposal', action: 'finalize', proposal_id: 'proposal_1' },
    });
    assert.equal(objectResult.adcp_error?.code, 'INVALID_REQUEST');
    assert.equal(objectResult.adcp_error?.field, 'refine');
    assert.equal(calls, 0);

    const wrongMode = await callTool(server, 'get_products', {
      buying_mode: 'brief',
      refine: [{ scope: 'proposal', action: 'finalize', proposal_id: 'proposal_1' }],
    });
    assert.equal(wrongMode.adcp_error?.code, 'INVALID_REQUEST');
    assert.equal(calls, 0);

    const mixed = await callTool(server, 'get_products', {
      buying_mode: 'refine',
      refine: [
        { scope: 'proposal', action: 'finalize', proposal_id: 'proposal_1' },
        { scope: 'product', action: 'omit', product_id: 'product_1' },
        'not-an-entry',
      ],
    });
    assert.equal(mixed.adcp_error?.code, 'INVALID_REQUEST');
    assert.equal(calls, 0);
  });

  it('fences an uncertain mutating handler exception instead of re-executing it', async () => {
    const idempotency = createIdempotencyStore({
      backend: memoryBackend({ sweepIntervalMs: 0 }),
    });
    let calls = 0;
    const server = createAdcpServer({
      name: 'T',
      version: '1.0.0',
      idempotency,
      resolveSessionKey: () => 'tenant',
      mediaBuy: {
        createMediaBuy: async () => {
          calls += 1;
          // A real handler may have committed an upstream side effect before
          // its transport/client throws. The framework cannot distinguish
          // that state from a genuinely pre-mutation failure.
          throw new Error('upstream response was lost after commit');
        },
      },
    });

    const key = 'retry_err_abcdefghij';
    const first = await callTool(server, 'create_media_buy', { ...basePayload, idempotency_key: key });
    assert.equal(first.adcp_error?.code, 'SERVICE_UNAVAILABLE');
    assert.match(first.adcp_error?.message, /Reconcile.*natural key/i);

    // Exact retry replays the ambiguity fence and never repeats the mutation.
    const second = await callTool(server, 'create_media_buy', { ...basePayload, idempotency_key: key });
    assert.equal(second.adcp_error?.code, 'SERVICE_UNAVAILABLE');
    assert.equal(calls, 1);
  });

  it('caches a non-transient typed error thrown by a mutating handler', async () => {
    const idempotency = createIdempotencyStore({
      backend: memoryBackend({ sweepIntervalMs: 0 }),
    });
    let calls = 0;
    const server = createAdcpServer({
      name: 'T',
      version: '1.0.0',
      idempotency,
      resolveSessionKey: () => 'tenant',
      mediaBuy: {
        createMediaBuy: async () => {
          calls += 1;
          throw adcpError('INVALID_REQUEST', { message: 'The supplied intent violates a durable seller rule.' });
        },
      },
    });
    const request = { ...basePayload, idempotency_key: 'typed_throw_fence_0001' };

    const first = await callTool(server, 'create_media_buy', request);
    const retry = await callTool(server, 'create_media_buy', request);

    assert.equal(first.adcp_error?.code, 'INVALID_REQUEST');
    assert.equal(retry.adcp_error?.code, 'INVALID_REQUEST');
    assert.equal(calls, 1);
  });

  it('turns a transient typed mutating exception into an ambiguity fence', async () => {
    const idempotency = createIdempotencyStore({
      backend: memoryBackend({ sweepIntervalMs: 0 }),
    });
    let calls = 0;
    const server = createAdcpServer({
      name: 'T',
      version: '1.0.0',
      idempotency,
      resolveSessionKey: () => 'tenant',
      mediaBuy: {
        createMediaBuy: async () => {
          calls += 1;
          throw adcpError('RATE_LIMITED', { message: 'upstream admission became uncertain', retry_after: 1 });
        },
      },
    });
    const request = { ...basePayload, idempotency_key: 'transient_throw_fence_0001' };

    const first = await callTool(server, 'create_media_buy', request);
    const retry = await callTool(server, 'create_media_buy', request);

    assert.equal(first.adcp_error?.code, 'SERVICE_UNAVAILABLE');
    assert.match(first.adcp_error?.message, /Reconcile.*natural key/i);
    assert.equal(retry.adcp_error?.code, 'SERVICE_UNAVAILABLE');
    assert.equal(calls, 1);
  });

  it('infers transient recovery when a thrown standard error omits recovery', async () => {
    const idempotency = createIdempotencyStore({
      backend: memoryBackend({ sweepIntervalMs: 0 }),
    });
    let calls = 0;
    const server = createAdcpServer({
      name: 'T',
      version: '1.0.0',
      idempotency,
      resolveSessionKey: () => 'tenant',
      mediaBuy: {
        createMediaBuy: async () => {
          calls += 1;
          const response = adcpError('RATE_LIMITED', {
            message: 'upstream admission became uncertain',
            retry_after: 1,
          });
          delete response.structuredContent.adcp_error.recovery;
          response.content = [{ type: 'text', text: JSON.stringify(response.structuredContent) }];
          throw response;
        },
      },
    });
    const request = { ...basePayload, idempotency_key: 'missing_recovery_fence_0001' };

    const first = await callTool(server, 'create_media_buy', request);
    const retry = await callTool(server, 'create_media_buy', request);

    assert.equal(first.adcp_error?.code, 'SERVICE_UNAVAILABLE');
    assert.equal(retry.adcp_error?.code, 'SERVICE_UNAVAILABLE');
    assert.match(first.adcp_error?.message, /Reconcile.*natural key/i);
    assert.equal(calls, 1);
  });

  it('fails closed when a completed handler loses its request claim before cache publication', async () => {
    const backend = memoryBackend({ sweepIntervalMs: 0 });
    const idempotency = createIdempotencyStore({ backend });
    const key = 'lost_claim_abcdefghij';
    const server = createAdcpServer({
      name: 'T',
      version: '1.0.0',
      idempotency,
      resolveSessionKey: () => 'tenant',
      mediaBuy: {
        createMediaBuy: async () => {
          await backend.put(`tenant\u001f${key}`, {
            payloadHash: 'successor-owner',
            response: null,
            expiresAt: Math.floor(Date.now() / 1000) + 120,
          });
          return { media_buy_id: 'must_not_publish', packages: [] };
        },
      },
    });

    const result = await callTool(server, 'create_media_buy', { ...basePayload, idempotency_key: key });
    assert.equal(result.adcp_error?.code, 'SERVICE_UNAVAILABLE');
    assert.equal(result.media_buy_id, undefined);
  });

  it('caches an ambiguity fence when post-handler processing throws a typed error', async () => {
    const idempotency = createIdempotencyStore({
      backend: memoryBackend({ sweepIntervalMs: 0 }),
      ttlSeconds: 3600,
    });
    let calls = 0;
    const server = createAdcpServer({
      name: 'T',
      version: '1.0.0',
      idempotency,
      resolveSessionKey: () => 'tenant',
      responseEnhancer: response => {
        if (response.structuredContent?.media_buy_id) {
          throw adcpError('RATE_LIMITED', { message: 'post-handler enhancer failed', retry_after: 1 });
        }
      },
      mediaBuy: {
        createMediaBuy: async () => {
          calls += 1;
          return { media_buy_id: `mb_${calls}`, packages: [] };
        },
      },
    });
    const request = { ...basePayload, idempotency_key: 'post_handler_failure_0001' };

    const first = await callTool(server, 'create_media_buy', request);
    const retry = await callTool(server, 'create_media_buy', request);

    assert.equal(first.adcp_error?.code, 'SERVICE_UNAVAILABLE');
    assert.equal(retry.adcp_error?.code, 'SERVICE_UNAVAILABLE');
    assert.match(retry.adcp_error?.message, /Reconcile.*natural key/i);
    assert.equal(calls, 1, 'exact retry must replay the ambiguity marker instead of re-running the mutation');
  });

  it('does not reapply a non-idempotent response enhancer on replay', async () => {
    let calls = 0;
    let enhancements = 0;
    const server = createAdcpServer({
      name: 'T',
      version: '1.0.0',
      idempotency: createIdempotencyStore({ backend: memoryBackend({ sweepIntervalMs: 0 }) }),
      resolveSessionKey: () => 'tenant',
      responseEnhancer: response => {
        if (response.structuredContent?.media_buy_id) {
          enhancements += 1;
          response.structuredContent.enhancement_seq = enhancements;
        }
      },
      mediaBuy: {
        createMediaBuy: async () => {
          calls += 1;
          return { media_buy_id: 'mb_enhanced', packages: [] };
        },
      },
    });
    const request = { ...basePayload, idempotency_key: 'enhancer_replay_abcdefgh' };

    const first = await callTool(server, 'create_media_buy', request);
    const replay = await callTool(server, 'create_media_buy', request);

    assert.equal(first.enhancement_seq, 1);
    assert.equal(replay.enhancement_seq, 1, 'replay must preserve the originally enhanced envelope');
    assert.equal(replay.replayed, true);
    assert.equal(enhancements, 1, 'response enhancer must only run for the original execution');
    assert.equal(calls, 1);
  });

  it('fails closed when the idempotency backend cannot publish a completed response', async () => {
    const backend = memoryBackend({ sweepIntervalMs: 0 });
    const replace = backend.replaceIfPayloadHash.bind(backend);
    let replacements = 0;
    backend.replaceIfPayloadHash = async (...args) => {
      replacements += 1;
      if (replacements === 1) return replace(...args); // pre-handler ownership probe
      throw new Error('backend unavailable');
    };
    const server = createAdcpServer({
      name: 'T',
      version: '1.0.0',
      idempotency: createIdempotencyStore({ backend }),
      resolveSessionKey: () => 'tenant',
      mediaBuy: {
        createMediaBuy: async () => ({ media_buy_id: 'must_not_publish', packages: [] }),
      },
    });

    const result = await callTool(server, 'create_media_buy', {
      ...basePayload,
      idempotency_key: 'publish_failure_abcdefgh',
    });
    assert.equal(result.adcp_error?.code, 'SERVICE_UNAVAILABLE');
    assert.equal(result.media_buy_id, undefined);
  });

  it('rejects keys that do not match the spec pattern', async () => {
    const { server, calls } = makeServer();

    const badShort = await callTool(server, 'create_media_buy', {
      ...basePayload,
      idempotency_key: 'too-short',
    });
    assert.equal(badShort.adcp_error?.code, 'INVALID_REQUEST');
    assert.equal(badShort.adcp_error?.field, 'idempotency_key');

    const badChars = await callTool(server, 'create_media_buy', {
      ...basePayload,
      idempotency_key: 'has spaces in it here',
    });
    assert.equal(badChars.adcp_error?.code, 'INVALID_REQUEST');

    // Handler must not run on validation rejection
    assert.equal(calls.length, 0);
  });

  it('does not leak first caller context into subsequent replays', async () => {
    const { server } = makeServer();
    const key = 'leak_test_abcdefghij12';
    const req = { ...basePayload, idempotency_key: key };

    await callTool(server, 'create_media_buy', { ...req, context: { correlation_id: 'first' } });
    const second = await callTool(server, 'create_media_buy', { ...req, context: { correlation_id: 'second' } });

    assert.equal(second.replayed, true);
    assert.equal(
      second.context?.correlation_id,
      'second',
      'replay must echo the current caller context, not the first caller'
    );
  });

  it('IDEMPOTENCY_CONFLICT does NOT fire when only context differs (context is excluded from hash)', async () => {
    const { server, calls } = makeServer();
    const key = 'context_test_abcdefghi';
    await callTool(server, 'create_media_buy', {
      ...basePayload,
      idempotency_key: key,
      context: { correlation_id: 'a' },
    });
    const second = await callTool(server, 'create_media_buy', {
      ...basePayload,
      idempotency_key: key,
      context: { correlation_id: 'b' },
    });
    assert.equal(calls.length, 1, 'different context → same canonical payload → replay');
    assert.equal(second.replayed, true);
  });

  it('concurrent mutations with same fresh key run the handler only once', async () => {
    const idempotency = createIdempotencyStore({
      backend: memoryBackend({ sweepIntervalMs: 0 }),
    });
    let calls = 0;
    const server = createAdcpServer({
      name: 'T',
      version: '1.0.0',
      idempotency,
      resolveSessionKey: () => 'tenant',
      mediaBuy: {
        createMediaBuy: async () => {
          calls++;
          // Give parallel callers a chance to race
          await new Promise(r => setTimeout(r, 10));
          return { media_buy_id: `mb_${calls}`, packages: [] };
        },
      },
    });

    const key = 'race_test_abcdefghij12';
    const req = { ...basePayload, idempotency_key: key };

    const results = await Promise.all(Array.from({ length: 5 }, () => callTool(server, 'create_media_buy', req)));

    assert.equal(calls, 1, 'handler must run exactly once under concurrent retry');
    // Winners: one got a fresh response, others got IDEMPOTENCY_IN_FLIGHT
    const winners = results.filter(r => r.media_buy_id);
    const inFlights = results.filter(r => r.adcp_error?.code === 'IDEMPOTENCY_IN_FLIGHT');
    assert.ok(winners.length >= 1, 'at least one call must return the fresh response');
    assert.equal(winners.length + inFlights.length, 5);
    for (const f of inFlights) {
      assert.equal(f.adcp_error.recovery, 'transient', 'in-flight branch must be transient');
      assert.ok(
        typeof f.adcp_error.retry_after === 'number' && f.adcp_error.retry_after >= 1,
        'in-flight branch must carry a retry_after hint'
      );
    }
  });

  it('fails closed when a thrown mutating handler outcome cannot be published', async () => {
    let releaseCalls = 0;
    const idempotency = {
      ttlSeconds: 3600,
      capability: () => ({ replay_ttl_seconds: 3600 }),
      check: async () => ({
        kind: 'miss',
        payloadHash: 'request-payload-hash',
        claimToken: '__adcp_in_flight__:request-payload-hash:owner',
      }),
      renew: async () => {},
      save: async () => {
        throw new Error('idempotency backend unavailable');
      },
      release: async () => {
        releaseCalls += 1;
      },
    };
    const server = createAdcpServer({
      name: 'Release failure seller',
      version: '1.0.0',
      idempotency,
      resolveSessionKey: () => 'tenant',
      mediaBuy: {
        createMediaBuy: async () => {
          throw adcpError('RATE_LIMITED', { message: 'retryable domain error', retry_after: 1 });
        },
      },
    });

    const result = await callTool(server, 'create_media_buy', {
      ...basePayload,
      idempotency_key: 'release_failure_abcdefgh',
    });

    assert.equal(result.adcp_error?.code, 'SERVICE_UNAVAILABLE');
    assert.notEqual(result.adcp_error?.code, 'RATE_LIMITED');
    assert.equal(releaseCalls, 0, 'a failed publish must retain the original mutation claim');
  });

  it('keeps a long-running handler fenced beyond the working-response timeout', async t => {
    t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 2_000_000_000_000 });
    let releaseHandler;
    let markHandlerEntered;
    const handlerEntered = new Promise(resolve => {
      markHandlerEntered = resolve;
    });
    const handlerGate = new Promise(resolve => {
      releaseHandler = resolve;
    });
    const { server, calls } = makeServer({
      handler: async () => {
        markHandlerEntered();
        await handlerGate;
        return { media_buy_id: 'mb_slow', packages: [] };
      },
    });
    const request = { ...basePayload, idempotency_key: 'slow_handler_abcdefghij' };

    const first = callTool(server, 'create_media_buy', request);
    await handlerEntered;
    t.mock.timers.tick(130_000);
    await Promise.resolve();
    await Promise.resolve();

    const retry = await callTool(server, 'create_media_buy', request);
    assert.equal(retry.adcp_error?.code, 'IDEMPOTENCY_IN_FLIGHT');
    assert.equal(calls.length, 1, 'retry after the original 120s lease must not enter the handler');

    releaseHandler();
    const completed = await first;
    assert.equal(completed.media_buy_id, 'mb_slow');
    assert.equal(calls.length, 1);
  });

  it('strict-mode mutation VALIDATION_ERROR remains fenced beyond the transient-error window', async t => {
    // Regression guard for issue #758: a drifted handler under strict
    // response validation used to release the idempotency claim and return
    // VALIDATION_ERROR — letting a retrying buyer re-execute the handler
    // indefinitely. Mutations now retain the validation failure for the
    // full replay TTL so expiration of the old 10-second transient window
    // cannot permit another side effect.
    t.mock.timers.enable({ apis: ['Date'], now: 2_000_000_000_000 });
    const idempotency = createIdempotencyStore({
      backend: memoryBackend({ sweepIntervalMs: 0 }),
    });
    let calls = 0;
    const server = _createAdcpServer({
      name: 'T',
      version: '1.0.0',
      idempotency,
      resolveSessionKey: () => 'tenant',
      validation: { responses: 'strict', requests: 'off' },
      mediaBuy: {
        // Drifted response — violates create-media-buy-response schema.
        createMediaBuy: async () => {
          calls++;
          return { media_buy_id: 'mb_1', packages: 'oops' };
        },
      },
    });

    const key = 'replay_storm_abcdefghij';
    const req = { ...basePayload, idempotency_key: key };

    const first = await callTool(server, 'create_media_buy', req);
    assert.equal(first.adcp_error?.code, 'VALIDATION_ERROR');
    assert.equal(calls, 1);

    const second = await callTool(server, 'create_media_buy', req);
    assert.equal(second.adcp_error?.code, 'VALIDATION_ERROR', 'retry must replay the cached error');
    assert.equal(calls, 1, 'handler must not re-execute on immediate retry');

    t.mock.timers.tick(11_000);
    const afterTransientWindow = await callTool(server, 'create_media_buy', req);
    assert.equal(
      afterTransientWindow.adcp_error?.code,
      'VALIDATION_ERROR',
      'mutation fence must outlive the former transient-error TTL'
    );
    assert.equal(calls, 1, 'handler must not re-execute after the former transient-error window');
  });

  it('strict-mode transient-error cache does not mask IDEMPOTENCY_CONFLICT on different payload', async () => {
    // Scope is (principal, key, payloadHash). A retry with a different
    // canonical payload still bypasses the cache and hits CONFLICT — the
    // retry-storm guard must not become a replay oracle for mismatched
    // payloads.
    const idempotency = createIdempotencyStore({
      backend: memoryBackend({ sweepIntervalMs: 0 }),
    });
    const server = _createAdcpServer({
      name: 'T',
      version: '1.0.0',
      idempotency,
      resolveSessionKey: () => 'tenant',
      validation: { responses: 'strict', requests: 'off' },
      mediaBuy: {
        createMediaBuy: async () => ({ media_buy_id: 'mb_1', packages: 'oops' }),
      },
    });

    const key = 'replay_conflict_abcdefgh';
    const first = await callTool(server, 'create_media_buy', { ...basePayload, idempotency_key: key });
    assert.equal(first.adcp_error?.code, 'VALIDATION_ERROR');

    const conflict = await callTool(server, 'create_media_buy', {
      ...basePayload,
      idempotency_key: key,
      start_time: '2026-06-01T00:00:00Z',
    });
    assert.equal(conflict.adcp_error?.code, 'IDEMPOTENCY_CONFLICT');
  });

  it('caches sync_accounts rejected rows that do not carry commercial bypass errors', async () => {
    const { server, calls } = makeSyncAccountsServer({
      handler: params => ({
        accounts: params.accounts.map(account => ({
          brand: account.brand,
          operator: account.operator,
          action: 'failed',
          status: 'rejected',
        })),
      }),
    });
    const req = {
      idempotency_key: 'sync_rejected_cache_01',
      accounts: [{ brand: { domain: 'acme.example' }, operator: 'op.example' }],
    };

    const first = await callTool(server, 'sync_accounts', req);
    const second = await callTool(server, 'sync_accounts', req);

    assert.equal(calls.length, 1, 'stable rejected rows without errors[] should be replay cached');
    assert.equal(first.accounts[0].status, 'rejected');
    assert.equal(second.replayed, true);
    assert.equal(second.accounts[0].status, 'rejected');
  });

  it('strict-mode parallel retries of a drifted handler see in-flight, not re-execution', async () => {
    // Concurrency guard: while call A is still inside the handler
    // producing the drifted response, a parallel call B with the same
    // key + payload must hit the IN_FLIGHT claim (IDEMPOTENCY_IN_FLIGHT)
    // rather than re-entering the handler. Once A completes and writes
    // the transient-error entry, a subsequent retry hits the cached
    // VALIDATION_ERROR — not the handler.
    const idempotency = createIdempotencyStore({
      backend: memoryBackend({ sweepIntervalMs: 0 }),
    });
    let calls = 0;
    let releaseHandler;
    const handlerGate = new Promise(resolve => {
      releaseHandler = resolve;
    });
    const server = _createAdcpServer({
      name: 'T',
      version: '1.0.0',
      idempotency,
      resolveSessionKey: () => 'tenant',
      validation: { responses: 'strict', requests: 'off' },
      mediaBuy: {
        createMediaBuy: async () => {
          calls++;
          await handlerGate;
          return { media_buy_id: 'mb_1', packages: 'oops' };
        },
      },
    });

    const key = 'replay_concurrent_abcde';
    const req = { ...basePayload, idempotency_key: key };

    const aPromise = callTool(server, 'create_media_buy', req);
    await new Promise(r => setImmediate(r));
    const b = await callTool(server, 'create_media_buy', req);

    assert.equal(b.adcp_error?.code, 'IDEMPOTENCY_IN_FLIGHT', 'parallel retry must see in-flight, not re-execute');
    assert.equal(calls, 1, 'handler must not re-execute for parallel retry');

    releaseHandler();
    const a = await aPromise;
    assert.equal(a.adcp_error?.code, 'VALIDATION_ERROR');
    assert.equal(calls, 1);

    const c = await callTool(server, 'create_media_buy', req);
    assert.equal(c.adcp_error?.code, 'VALIDATION_ERROR', 'post-completion retry replays cached error');
    assert.equal(calls, 1, 'handler still not re-executed after the in-flight window closes');
  });

  it('warn-mode response drift still releases the claim (no transient-error cache)', async () => {
    // Only strict mode can produce a VALIDATION_ERROR from response drift;
    // warn mode passes the response through and caches it as success.
    // Ensure we didn't accidentally populate the transient-error cache
    // on the warn path.
    const idempotency = createIdempotencyStore({
      backend: memoryBackend({ sweepIntervalMs: 0 }),
    });
    let calls = 0;
    const server = _createAdcpServer({
      name: 'T',
      version: '1.0.0',
      idempotency,
      resolveSessionKey: () => 'tenant',
      validation: { responses: 'warn', requests: 'off' },
      mediaBuy: {
        createMediaBuy: async () => {
          calls++;
          return { media_buy_id: `mb_${calls}`, packages: 'oops' };
        },
      },
    });

    const key = 'warn_mode_abcdefghijkl';
    const req = { ...basePayload, idempotency_key: key };

    const first = await callTool(server, 'create_media_buy', req);
    // Drifted response passes through in warn mode — cached as success.
    assert.ok(!first.adcp_error, 'warn mode must not turn drift into VALIDATION_ERROR');

    const second = await callTool(server, 'create_media_buy', req);
    assert.equal(calls, 1, 'warn mode caches the success response and replays it');
    assert.equal(second.replayed, true);
  });

  it('si_send_message is scoped by session_id — same key across sessions does not cross-replay', async () => {
    const idempotency = createIdempotencyStore({
      backend: memoryBackend({ sweepIntervalMs: 0 }),
    });
    let calls = 0;
    const server = createAdcpServer({
      name: 'T',
      version: '1.0.0',
      idempotency,
      resolveSessionKey: () => 'tenant',
      sponsoredIntelligence: {
        sendMessage: async params => {
          calls++;
          return {
            message_id: `msg_${calls}`,
            session_id: params.session_id,
            reply: `response to session ${params.session_id}`,
          };
        },
      },
    });

    const key = 'si_key_abcdefghij1234';
    const a1 = await callTool(server, 'si_send_message', {
      idempotency_key: key,
      session_id: 'session_A',
      message: 'hello',
    });
    // Same key, different session — must NOT replay session A's response
    const b1 = await callTool(server, 'si_send_message', {
      idempotency_key: key,
      session_id: 'session_B',
      message: 'hello',
    });

    assert.equal(calls, 2, 'each session must execute the handler');
    assert.notEqual(b1.message_id, a1.message_id);
    assert.notEqual(b1.replayed, true);

    // Same key, SAME session — must replay
    const a2 = await callTool(server, 'si_send_message', {
      idempotency_key: key,
      session_id: 'session_A',
      message: 'hello',
    });
    assert.equal(calls, 2, 'replay within same session must not re-execute');
    assert.equal(a2.message_id, a1.message_id);
    assert.equal(a2.replayed, true);
  });
});

describe('createAdcpServer config warnings', () => {
  it('logs an error and advertises unsupported when mutations have no idempotency store', async () => {
    const messages = [];
    const logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: msg => messages.push(msg),
    };
    const server = createAdcpServer({
      name: 'T',
      version: '1.0.0',
      logger,
      mediaBuy: {
        createMediaBuy: async () => ({ media_buy_id: 'mb', packages: [] }),
      },
    });
    assert.equal(messages.length, 1);
    assert.match(messages[0], /mutating tools registered.*without an idempotency store/i);
    const capabilities = await callTool(server, 'get_adcp_capabilities', {});
    assert.deepEqual(capabilities.adcp.idempotency, { supported: false });
  });

  it('does not let a capability override hide a missing runtime store', () => {
    const messages = [];
    const logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: msg => messages.push(msg),
    };
    createAdcpServer({
      name: 'T',
      version: '1.0.0',
      logger,
      capabilities: { idempotency: { replay_ttl_seconds: 3600 } },
      mediaBuy: {
        createMediaBuy: async () => ({ media_buy_id: 'mb', packages: [] }),
      },
    });
    assert.equal(messages.length, 1);
  });

  it('does not let a legacy capability override suppress the optional replay warning', async () => {
    const messages = [];
    const server = createAdcpServer({
      name: 'T',
      version: '1.0.0',
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: msg => messages.push(msg),
      },
      capabilities: { idempotency: { replay_ttl_seconds: 3600 } },
      mediaBuy: {
        getProducts: async () => ({ products: [] }),
      },
    });

    await callTool(server, 'get_products', {
      buying_mode: 'brief',
      brief: 'Find inventory',
      idempotency_key: 'optional_replay_abcdefgh',
    });

    assert.equal(messages.length, 1);
    assert.match(messages[0], /Replay protection is unavailable/);
  });

  it('rejects runtime-cast overrides of framework-owned idempotency capabilities', () => {
    assert.throws(
      () =>
        createAdcpServer({
          name: 'T',
          version: '1.0.0',
          capabilities: {
            overrides: { adcp: { idempotency: { supported: true, replay_ttl_seconds: 3600 } } },
          },
          mediaBuy: { getProducts: async () => ({ products: [] }) },
        }),
      /capabilities\.overrides\.adcp is not allowed/
    );
  });

  it('rejects a malformed custom idempotency store TTL instead of clamping its capability', () => {
    const customStore = {
      ttlSeconds: Infinity,
      check: async () => ({ kind: 'in-flight', retryAfterSeconds: 1 }),
      save: async () => {},
      saveTransientError: async () => {},
      release: async () => {},
      capability: () => ({ replay_ttl_seconds: Infinity }),
    };
    assert.throws(
      () =>
        createAdcpServer({
          name: 'T',
          version: '1.0.0',
          idempotency: customStore,
          mediaBuy: { getProducts: async () => ({ products: [] }) },
        }),
      /idempotency\.ttlSeconds must be a safe integer between 3600 and 604800/
    );
  });

  it('rejects a custom idempotency store that cannot renew long-running request claims', () => {
    const customStore = {
      ttlSeconds: 3600,
      check: async () => ({ kind: 'in-flight', retryAfterSeconds: 1 }),
      save: async () => {},
      release: async () => {},
      capability: () => ({ replay_ttl_seconds: 3600 }),
    };
    assert.throws(
      () =>
        createAdcpServer({
          name: 'T',
          version: '1.0.0',
          idempotency: customStore,
          mediaBuy: { getProducts: async () => ({ products: [] }) },
        }),
      /idempotency\.renew is required/
    );
  });

  it('refuses an implicit missing idempotency store outside development and test', () => {
    const prev = process.env.NODE_ENV;
    const prevStateAck = process.env.ADCP_DECISIONING_ALLOW_INMEMORY_STATE;
    try {
      process.env.ADCP_DECISIONING_ALLOW_INMEMORY_STATE = '1';
      for (const env of [undefined, 'staging', 'production']) {
        if (env === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = env;
        assert.throws(
          () =>
            createAdcpServer({
              name: 'T',
              version: '1.0.0',
              mediaBuy: {
                createMediaBuy: async () => ({ media_buy_id: 'mb', packages: [] }),
              },
            }),
          /mutating tools registered.*without an idempotency store/i
        );
      }
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
      if (prevStateAck === undefined) delete process.env.ADCP_DECISIONING_ALLOW_INMEMORY_STATE;
      else process.env.ADCP_DECISIONING_ALLOW_INMEMORY_STATE = prevStateAck;
    }
  });

  it('read-only servers do not trigger the warning', () => {
    const messages = [];
    const logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: msg => messages.push(msg),
    };
    createAdcpServer({
      name: 'T',
      version: '1.0.0',
      logger,
      mediaBuy: {
        getProducts: async () => ({ products: [] }),
      },
    });
    assert.equal(messages.length, 0);
  });

  it('fails closed when get_products reaches proposal finalization without a store', async () => {
    const messages = [];
    const logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: msg => messages.push(msg),
    };
    let calls = 0;
    const server = createAdcpServer({
      name: 'T',
      version: '1.0.0',
      logger,
      mediaBuy: {
        getProducts: async () => {
          calls += 1;
          return { products: [] };
        },
      },
    });
    const request = {
      buying_mode: 'refine',
      refine: [{ scope: 'proposal', action: 'finalize', proposal_id: 'proposal_1' }],
    };

    const first = await callTool(server, 'get_products', request);
    const second = await callTool(server, 'get_products', request);

    assert.equal(messages.length, 1);
    assert.match(messages[0], /proposal finalization.*refused.*no idempotency store/i);
    assert.equal(first.adcp_error?.code, 'SERVICE_UNAVAILABLE');
    assert.equal(second.adcp_error?.code, 'SERVICE_UNAVAILABLE');
    assert.equal(calls, 0);
  });

  it("idempotency: 'disabled' suppresses the missing-store error log", () => {
    const messages = [];
    const logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: msg => messages.push(msg),
    };
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      createAdcpServer({
        name: 'T',
        version: '1.0.0',
        logger,
        idempotency: 'disabled',
        mediaBuy: {
          createMediaBuy: async () => ({ media_buy_id: 'mb', packages: [] }),
        },
      });
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
    assert.equal(messages.length, 0);
  });

  it("idempotency: 'disabled' logs a warn at construction (visible operator signal)", () => {
    const warns = [];
    const logger = {
      debug: () => {},
      info: () => {},
      warn: msg => warns.push(msg),
      error: () => {},
    };
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      createAdcpServer({
        name: 'T',
        version: '1.0.0',
        logger,
        idempotency: 'disabled',
        mediaBuy: {
          createMediaBuy: async () => ({ media_buy_id: 'mb', packages: [] }),
        },
      });
    } finally {
      process.env.NODE_ENV = prev;
    }
    assert.ok(
      warns.some(m => /idempotency: 'disabled' is set/.test(m)),
      `expected disabled-mode warning, got: ${JSON.stringify(warns)}`
    );
  });

  // The production-gate tests below mutate process.env.NODE_ENV and
  // ADCP_IDEMPOTENCY_DISABLED_ACK. node:test runs files in parallel
  // by default but tests within a file serially, so the
  // save/restore-in-finally pattern is safe here. If --test-concurrency
  // is ever raised at the file level, move these to a child process.
  function withEnv(overrides, fn) {
    const prev = {};
    for (const k of Object.keys(overrides)) {
      prev[k] = process.env[k];
      if (overrides[k] === undefined) delete process.env[k];
      else process.env[k] = overrides[k];
    }
    try {
      return fn();
    } finally {
      for (const k of Object.keys(prev)) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  }

  function buildDisabled(extra) {
    return createAdcpServer({
      name: 'T',
      version: '1.0.0',
      idempotency: 'disabled',
      mediaBuy: { createMediaBuy: async () => ({ media_buy_id: 'mb', packages: [] }) },
      ...extra,
    });
  }

  it("idempotency: 'disabled' throws under NODE_ENV=production", () => {
    withEnv({ NODE_ENV: 'production', ADCP_IDEMPOTENCY_DISABLED_ACK: undefined }, () => {
      assert.throws(() => buildDisabled(), /refuses to start with NODE_ENV="production"/);
    });
  });

  it("idempotency: 'disabled' throws when NODE_ENV is unset (raw Lambda / K8s)", () => {
    // The earlier draft used `NODE_ENV === 'production'`, which silently
    // accepted unset. Inverted gate must reject the dangerous defaults.
    withEnv({ NODE_ENV: undefined, ADCP_IDEMPOTENCY_DISABLED_ACK: undefined }, () => {
      assert.throws(() => buildDisabled(), /refuses to start with NODE_ENV=<unset>/);
    });
  });

  it("idempotency: 'disabled' throws under NODE_ENV=staging (custom env names)", () => {
    withEnv({ NODE_ENV: 'staging', ADCP_IDEMPOTENCY_DISABLED_ACK: undefined }, () => {
      assert.throws(() => buildDisabled(), /refuses to start with NODE_ENV="staging"/);
    });
  });

  it("idempotency: 'disabled' allows ADCP_IDEMPOTENCY_DISABLED_ACK=1 escape hatch under any NODE_ENV", () => {
    const warns = [];
    const logger = { debug: () => {}, info: () => {}, warn: msg => warns.push(msg), error: () => {} };
    // 6.0.1 added a parallel state-store ack — the in-memory state store
    // refuses to construct outside test/dev unless ADCP_DECISIONING_ALLOW_INMEMORY_STATE=1.
    // This test exercises the idempotency-disabled escape hatch under
    // staging, which means we also need the state-store escape hatch
    // for the agent to start at all. Both gates are independent footguns.
    withEnv(
      {
        NODE_ENV: 'staging',
        ADCP_IDEMPOTENCY_DISABLED_ACK: '1',
        ADCP_DECISIONING_ALLOW_INMEMORY_STATE: '1',
      },
      () => {
        assert.doesNotThrow(() => buildDisabled({ logger }));
      }
    );
    assert.ok(warns.some(m => /idempotency: 'disabled' is set/.test(m)));
  });

  it("idempotency: 'disabled' rejects truthy-but-not-1 ack values", () => {
    // Be strict about the ack — only the literal '1' acknowledges. 'true',
    // 'yes', and other truthy strings should NOT pass; this prevents
    // operators from copying half-remembered env-var values.
    withEnv({ NODE_ENV: 'staging', ADCP_IDEMPOTENCY_DISABLED_ACK: 'true' }, () => {
      assert.throws(() => buildDisabled(), /refuses to start with NODE_ENV="staging"/);
    });
  });

  it('si_initiate_session: string request.context does not leak through replay', async () => {
    // si_initiate_session overrides `context` as a required string on the
    // request (natural-language handoff) while the response schema keeps the
    // core/context.json object. On replay, `finalize` must not copy the
    // string into the replayed envelope; and the string must stay in the
    // payload hash so a different handoff is flagged as IDEMPOTENCY_CONFLICT.
    const idempotency = createIdempotencyStore({
      backend: memoryBackend({ sweepIntervalMs: 0 }),
      ttlSeconds: 86400,
    });
    let calls = 0;
    const server = createAdcpServer({
      name: 'T',
      version: '1.0.0',
      idempotency,
      resolveSessionKey: () => 'tenant_si',
      sponsoredIntelligence: {
        initiateSession: async () => {
          calls++;
          return {
            session_id: `sess_${calls}`,
            session_status: 'active',
            session_ttl_seconds: 300,
          };
        },
      },
    });

    const identity = { consent_granted: true };
    const key = 'si_replay_abcdefghij12';
    const handoff = 'mens size 14 near Cincinnati';

    const first = await callTool(server, 'si_initiate_session', {
      idempotency_key: key,
      context: handoff,
      identity,
    });
    assert.equal(first.session_id, 'sess_1');
    assert.ok(!('context' in first), 'fresh response must not echo the string context');

    const replay = await callTool(server, 'si_initiate_session', {
      idempotency_key: key,
      context: handoff,
      identity,
    });
    assert.equal(calls, 1, 'handler must not re-execute on replay');
    assert.equal(replay.replayed, true);
    assert.ok(!('context' in replay), 'replay must not echo the string context');

    const conflict = await callTool(server, 'si_initiate_session', {
      idempotency_key: key,
      context: 'different intent',
      identity,
    });
    assert.equal(calls, 1);
    assert.equal(conflict.adcp_error?.code, 'IDEMPOTENCY_CONFLICT');
  });
});

describe("createAdcpServer with idempotency: 'disabled'", () => {
  // The disabled-mode gate refuses to start unless NODE_ENV is in
  // {'test', 'development'} or ADCP_IDEMPOTENCY_DISABLED_ACK=1. The test
  // runner doesn't set NODE_ENV by default, so pin it for this suite and
  // restore on teardown.
  let _prevNodeEnv;
  before(() => {
    _prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
  });
  after(() => {
    if (_prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = _prevNodeEnv;
  });

  function makeDisabledServer({ validationOverride } = {}) {
    const calls = [];
    const handler = async (params, ctx) => {
      calls.push({ params, ctx });
      return { media_buy_id: `mb_${calls.length}`, packages: [] };
    };
    const server = _createAdcpServer({
      name: 'T',
      version: '1.0.0',
      idempotency: 'disabled',
      resolveSessionKey: () => 'tenant_a',
      validation: validationOverride ?? { requests: 'off', responses: 'off' },
      mediaBuy: { createMediaBuy: handler },
    });
    return { server, calls };
  }

  it('lets a mutating request through with no idempotency_key (middleware off)', async () => {
    const { server, calls } = makeDisabledServer();
    const result = await callTool(server, 'create_media_buy', basePayload);
    assert.equal(result.adcp_error, undefined, `unexpected error: ${JSON.stringify(result.adcp_error)}`);
    assert.equal(calls.length, 1, 'handler must run on disabled mode');
    assert.equal(result.media_buy_id, 'mb_1');
  });

  it('lets a mutating request through under strict request schema validation', async () => {
    // The actual unblock: tests that want strict schema enforcement on
    // every other field but don't want to UUID-inject every payload.
    const { server, calls } = makeDisabledServer({
      validationOverride: { requests: 'strict', responses: 'off' },
    });
    const result = await callTool(server, 'create_media_buy', basePayload);
    assert.equal(result.adcp_error, undefined, `unexpected error: ${JSON.stringify(result.adcp_error)}`);
    assert.equal(calls.length, 1);
  });

  it('strict schema validation still rejects OTHER required fields', async () => {
    // Filter must be surgical — only suppress the missing-idempotency_key
    // failure. A genuinely malformed payload still fails VALIDATION_ERROR.
    const { server, calls } = makeDisabledServer({
      validationOverride: { requests: 'strict', responses: 'off' },
    });
    const broken = { ...basePayload };
    delete broken.brand;
    const result = await callTool(server, 'create_media_buy', broken);
    assert.equal(result.adcp_error?.code, 'VALIDATION_ERROR');
    assert.equal(calls.length, 0);
  });

  it('does not replay — same key twice executes the handler twice', async () => {
    const { server, calls } = makeDisabledServer();
    const key = 'replay_key_abcdefghij';
    const first = await callTool(server, 'create_media_buy', { ...basePayload, idempotency_key: key });
    const second = await callTool(server, 'create_media_buy', { ...basePayload, idempotency_key: key });
    assert.equal(calls.length, 2, 'disabled mode must not replay');
    assert.notEqual(first.media_buy_id, second.media_buy_id);
    assert.notEqual(second.replayed, true);
  });

  it('get_adcp_capabilities advertises idempotency.supported: false (no replay_ttl_seconds)', async () => {
    // Wire-honesty: the spec discriminated union has IdempotencySupported
    // (`true` + replay_ttl_seconds) and IdempotencyUnsupported (`false`,
    // no TTL). Disabled mode MUST flip to the Unsupported branch so a
    // buyer reading caps falls back to natural-key dedup before retrying
    // a spend-committing op. Lying about this with `supported: true` is
    // a money-flow footgun.
    const { server } = makeDisabledServer();
    const caps = await callTool(server, 'get_adcp_capabilities', {});
    assert.equal(caps.adcp.idempotency.supported, false);
    assert.equal(
      caps.adcp.idempotency.replay_ttl_seconds,
      undefined,
      'replay_ttl_seconds MUST be absent on the IdempotencyUnsupported branch'
    );
  });

  it('rejects malformed idempotency_key even in disabled mode (shape gate runs regardless)', async () => {
    // Defense-in-depth: when a buyer DOES supply a key, the spec pattern
    // is enforced even in disabled mode so malformed strings never reach
    // handler logs. Missing-key tolerance is the disabled-mode contract;
    // malformed-key tolerance is not.
    const { server, calls } = makeDisabledServer();
    const result = await callTool(server, 'create_media_buy', {
      ...basePayload,
      idempotency_key: 'too short',
    });
    assert.equal(result.adcp_error?.code, 'INVALID_REQUEST');
    assert.equal(result.adcp_error?.field, 'idempotency_key');
    assert.equal(calls.length, 0, 'malformed key must not reach the handler');
  });
});
