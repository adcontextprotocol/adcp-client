const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createAdcpServer: _createAdcpServer } = require('../dist/lib/server/create-adcp-server');
const { createIdempotencyStore, memoryBackend } = require('../dist/lib/server/idempotency');

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

  it('handler errors are NOT cached (retry re-executes)', async () => {
    const idempotency = createIdempotencyStore({
      backend: memoryBackend({ sweepIntervalMs: 0 }),
    });
    let failNext = true;
    const server = createAdcpServer({
      name: 'T',
      version: '1.0.0',
      idempotency,
      resolveSessionKey: () => 'tenant',
      mediaBuy: {
        createMediaBuy: async () => {
          if (failNext) {
            failNext = false;
            throw new Error('transient fail');
          }
          return { media_buy_id: 'mb_success', packages: [] };
        },
      },
    });

    const key = 'retry_err_abcdefghij';
    const first = await callTool(server, 'create_media_buy', { ...basePayload, idempotency_key: key });
    assert.equal(first.adcp_error?.code, 'SERVICE_UNAVAILABLE');

    // Retry with SAME key should re-execute (error not cached, claim released)
    const second = await callTool(server, 'create_media_buy', { ...basePayload, idempotency_key: key });
    assert.equal(second.media_buy_id, 'mb_success');
    assert.notEqual(second.replayed, true);
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
    // Winners: one got a fresh response, others got SERVICE_UNAVAILABLE (in-flight)
    const winners = results.filter(r => r.media_buy_id);
    const inFlights = results.filter(r => r.adcp_error?.code === 'SERVICE_UNAVAILABLE');
    assert.ok(winners.length >= 1, 'at least one call must return the fresh response');
    assert.equal(winners.length + inFlights.length, 5);
  });

  it('strict-mode VALIDATION_ERROR short-circuits retry storm on same key + payload', async () => {
    // Regression guard for issue #758: a drifted handler under strict
    // response validation used to release the idempotency claim and return
    // VALIDATION_ERROR — letting a retrying buyer re-execute the handler
    // indefinitely. The transient-error cache holds the first error so
    // subsequent retries short-circuit instead of re-running side effects.
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
    assert.equal(calls, 1, 'handler must not re-execute on retry within the transient-error window');
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

  it('strict-mode parallel retries of a drifted handler see in-flight, not re-execution', async () => {
    // Concurrency guard: while call A is still inside the handler
    // producing the drifted response, a parallel call B with the same
    // key + payload must hit the IN_FLIGHT claim (SERVICE_UNAVAILABLE)
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

    assert.equal(b.adcp_error?.code, 'SERVICE_UNAVAILABLE', 'parallel retry must see in-flight, not re-execute');
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
  it('logs an error when mutating handlers are registered without an idempotency store', () => {
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
        createMediaBuy: async () => ({ media_buy_id: 'mb', packages: [] }),
      },
    });
    assert.equal(messages.length, 1);
    assert.match(messages[0], /mutating tools registered.*without an idempotency store/i);
  });

  it('suppresses the warning when capabilities.idempotency.replay_ttl_seconds is set', () => {
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
    assert.equal(messages.length, 0);
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

  it("idempotency: 'disabled' suppresses the missing-store error log", () => {
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
      idempotency: 'disabled',
      mediaBuy: {
        createMediaBuy: async () => ({ media_buy_id: 'mb', packages: [] }),
      },
    });
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

  it("idempotency: 'disabled' throws under NODE_ENV=production", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      assert.throws(
        () =>
          createAdcpServer({
            name: 'T',
            version: '1.0.0',
            idempotency: 'disabled',
            mediaBuy: {
              createMediaBuy: async () => ({ media_buy_id: 'mb', packages: [] }),
            },
          }),
        /refuses to start under NODE_ENV=production/
      );
    } finally {
      process.env.NODE_ENV = prev;
    }
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

  it("get_adcp_capabilities advertises idempotency.supported: false (no replay_ttl_seconds)", async () => {
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
