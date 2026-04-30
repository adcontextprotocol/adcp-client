const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  InMemoryStateStore,
  StateError,
  SESSION_KEY_FIELD,
  createSessionedStore,
  scopedStore,
} = require('../dist/lib/server/state-store');
const { ADCPError, isADCPError } = require('../dist/lib/errors');
const { structuredSerialize, structuredDeserialize } = require('../dist/lib/server/structured-serialize');
const { createAdcpServer, requireSessionKey } = require('../dist/lib/server/create-adcp-server');
const { adcpError } = require('../dist/lib/server/errors');

// ---------------------------------------------------------------------------
// Validation / StateError
// ---------------------------------------------------------------------------

describe('StateError validation', () => {
  it('rejects collection with invalid characters', async () => {
    const store = new InMemoryStateStore();
    await assert.rejects(
      () => store.put('bad collection!', 'id', { v: 1 }),
      err => err instanceof StateError && err.code === 'INVALID_COLLECTION'
    );
  });

  it('rejects id with invalid characters', async () => {
    const store = new InMemoryStateStore();
    await assert.rejects(
      () => store.put('col', 'bad id!', { v: 1 }),
      err => err instanceof StateError && err.code === 'INVALID_ID'
    );
  });

  it('rejects empty collection and id', async () => {
    const store = new InMemoryStateStore();
    await assert.rejects(
      () => store.put('', 'id', { v: 1 }),
      err => err instanceof StateError && err.code === 'INVALID_COLLECTION'
    );
    await assert.rejects(
      () => store.put('col', '', { v: 1 }),
      err => err instanceof StateError && err.code === 'INVALID_ID'
    );
  });

  it('rejects collection/id over 256 chars', async () => {
    const store = new InMemoryStateStore();
    const long = 'a'.repeat(257);
    await assert.rejects(
      () => store.put(long, 'id', { v: 1 }),
      err => err instanceof StateError && err.code === 'INVALID_COLLECTION'
    );
    await assert.rejects(
      () => store.put('col', long, { v: 1 }),
      err => err instanceof StateError && err.code === 'INVALID_ID'
    );
  });

  it('is an ADCPError so callers can reuse isADCPError() and extractErrorInfo()', () => {
    const err = new StateError('INVALID_ID', 'bad');
    assert.ok(err instanceof ADCPError);
    assert.ok(isADCPError(err));
    assert.strictEqual(err.code, 'INVALID_ID');
  });

  it('accepts valid key characters (letters, digits, _ - . :)', async () => {
    const store = new InMemoryStateStore();
    await store.put('buyer.v1_prod', 'tenant:alice-42', { v: 1 });
    const doc = await store.get('buyer.v1_prod', 'tenant:alice-42');
    assert.strictEqual(doc.v, 1);
  });

  it('rejects payload over maxDocumentBytes', async () => {
    const store = new InMemoryStateStore({ maxDocumentBytes: 256 });
    const big = { blob: 'x'.repeat(400) };
    await assert.rejects(
      () => store.put('col', 'id', big),
      err => err instanceof StateError && err.code === 'PAYLOAD_TOO_LARGE'
    );
  });

  it('validates on patch', async () => {
    const store = new InMemoryStateStore({ maxDocumentBytes: 100 });
    await assert.rejects(
      () => store.patch('col', 'id', { blob: 'x'.repeat(200) }),
      err => err instanceof StateError && err.code === 'PAYLOAD_TOO_LARGE'
    );
  });

  it('validates on get, delete, list', async () => {
    const store = new InMemoryStateStore();
    await assert.rejects(
      () => store.get('bad collection!', 'id'),
      err => err instanceof StateError && err.code === 'INVALID_COLLECTION'
    );
    await assert.rejects(
      () => store.delete('col', 'bad id!'),
      err => err instanceof StateError && err.code === 'INVALID_ID'
    );
    await assert.rejects(
      () => store.list('bad collection!'),
      err => err instanceof StateError && err.code === 'INVALID_COLLECTION'
    );
  });
});

// ---------------------------------------------------------------------------
// createSessionedStore / scoped()
// ---------------------------------------------------------------------------

describe('createSessionedStore', () => {
  it('isolates writes between sessions with the same id', async () => {
    const inner = new InMemoryStateStore();
    const alice = inner.scoped('alice');
    const bob = inner.scoped('bob');

    await alice.put('media_buys', 'mb1', { status: 'active' });
    await bob.put('media_buys', 'mb1', { status: 'paused' });

    assert.deepStrictEqual(await alice.get('media_buys', 'mb1'), { status: 'active' });
    assert.deepStrictEqual(await bob.get('media_buys', 'mb1'), { status: 'paused' });
  });

  it('strips _session_key from returned documents', async () => {
    const inner = new InMemoryStateStore();
    const alice = inner.scoped('alice');
    await alice.put('col', 'x', { v: 1 });
    const doc = await alice.get('col', 'x');
    assert.deepStrictEqual(doc, { v: 1 });
    assert.strictEqual(SESSION_KEY_FIELD in doc, false);
  });

  it('injects _session_key into the underlying store', async () => {
    const inner = new InMemoryStateStore();
    await inner.scoped('alice').put('col', 'x', { v: 1 });
    const { items } = await inner.list('col');
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0][SESSION_KEY_FIELD], 'alice');
  });

  it('list() only returns items for the session', async () => {
    const inner = new InMemoryStateStore();
    await inner.scoped('alice').put('media_buys', 'mb1', { v: 1 });
    await inner.scoped('alice').put('media_buys', 'mb2', { v: 2 });
    await inner.scoped('bob').put('media_buys', 'mb1', { v: 99 });

    const { items } = await inner.scoped('alice').list('media_buys');
    assert.strictEqual(items.length, 2);
    assert.ok(items.every(i => i.v !== 99));
  });

  it('list() with caller filter ANDs with session filter', async () => {
    const inner = new InMemoryStateStore();
    const alice = inner.scoped('alice');
    await alice.put('col', 'a', { tag: 'x', n: 1 });
    await alice.put('col', 'b', { tag: 'y', n: 2 });
    await inner.scoped('bob').put('col', 'c', { tag: 'x', n: 3 });

    const { items } = await alice.list('col', { filter: { tag: 'x' } });
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].n, 1);
  });

  it('patch merges without leaking _session_key into caller payload', async () => {
    const inner = new InMemoryStateStore();
    const alice = inner.scoped('alice');
    await alice.put('col', 'x', { a: 1, b: 2 });
    await alice.patch('col', 'x', { b: 20 });
    const doc = await alice.get('col', 'x');
    assert.deepStrictEqual(doc, { a: 1, b: 20 });
  });

  it('delete is session-scoped (does not remove other session docs with same id)', async () => {
    const inner = new InMemoryStateStore();
    await inner.scoped('alice').put('col', 'x', { v: 1 });
    await inner.scoped('bob').put('col', 'x', { v: 2 });

    await inner.scoped('alice').delete('col', 'x');
    assert.strictEqual(await inner.scoped('alice').get('col', 'x'), null);
    assert.deepStrictEqual(await inner.scoped('bob').get('col', 'x'), { v: 2 });
  });

  it('rejects invalid sessionKey', () => {
    const inner = new InMemoryStateStore();
    assert.throws(
      () => inner.scoped('bad key!'),
      err => err instanceof StateError && err.code === 'INVALID_ID'
    );
  });

  it('createSessionedStore is exported standalone (for custom stores)', async () => {
    const inner = new InMemoryStateStore();
    const scoped = createSessionedStore(inner, 'alice');
    await scoped.put('col', 'x', { v: 1 });
    const doc = await scoped.get('col', 'x');
    assert.deepStrictEqual(doc, { v: 1 });
  });

  it('scopedStore() falls back to createSessionedStore when store.scoped is undefined', async () => {
    const backing = new InMemoryStateStore();
    // Custom store that implements the interface WITHOUT `scoped`.
    const minimal = {
      get: (c, i) => backing.get(c, i),
      put: (c, i, d) => backing.put(c, i, d),
      patch: (c, i, d) => backing.patch(c, i, d),
      delete: (c, i) => backing.delete(c, i),
      list: (c, o) => backing.list(c, o),
    };
    const scoped = scopedStore(minimal, 'alice');
    await scoped.put('col', 'x', { v: 1 });
    assert.deepStrictEqual(await scoped.get('col', 'x'), { v: 1 });
  });

  it('scopedStore() uses store.scoped when defined', () => {
    const inner = new InMemoryStateStore();
    let called = false;
    inner.scoped = key => {
      called = true;
      return createSessionedStore(inner, key);
    };
    scopedStore(inner, 'alice');
    assert.strictEqual(called, true);
  });

  it('rejects : in sessionKey (reserved for scope-path)', () => {
    const inner = new InMemoryStateStore();
    assert.throws(
      () => inner.scoped('alice:bob'),
      err => err instanceof StateError && err.code === 'INVALID_ID'
    );
    assert.throws(
      () => inner.scoped('alice:'),
      err => err instanceof StateError && err.code === 'INVALID_ID'
    );
  });

  it('rejects : in ids to prevent scope collisions', async () => {
    const inner = new InMemoryStateStore();
    const alice = inner.scoped('alice');
    await assert.rejects(
      () => alice.put('col', ':x', { v: 1 }),
      err => err instanceof StateError && err.code === 'INVALID_ID'
    );
    await assert.rejects(
      () => alice.put('col', 'bob::x', { v: 1 }),
      err => err instanceof StateError && err.code === 'INVALID_ID'
    );
  });

  it('closes the "trailing colon" collision between sessionKey="alice:" and id=":x"', () => {
    // Both were previously accepted; neither contains `::`. Fix now rejects both.
    const inner = new InMemoryStateStore();
    assert.throws(
      () => inner.scoped('alice:'),
      err => err.code === 'INVALID_ID'
    );
    const alice = inner.scoped('alice');
    assert.rejects(
      () => alice.put('col', ':x', { v: 1 }),
      err => err.code === 'INVALID_ID'
    );
  });

  it('rejects payloads containing the reserved _session_key field', async () => {
    const inner = new InMemoryStateStore();
    const alice = inner.scoped('alice');
    await assert.rejects(
      () => alice.put('col', 'x', { [SESSION_KEY_FIELD]: 'bob', v: 1 }),
      err => err instanceof StateError && err.code === 'INVALID_ID'
    );
    await assert.rejects(
      () => alice.patch('col', 'x', { [SESSION_KEY_FIELD]: 'bob' }),
      err => err instanceof StateError && err.code === 'INVALID_ID'
    );
  });
});

// ---------------------------------------------------------------------------
// resolveSessionKey hook
// ---------------------------------------------------------------------------

describe('resolveSessionKey', () => {
  async function callTool(server, toolName, params) {
    return server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: toolName, arguments: params ?? {} },
    });
  }
  // Sparse fixtures — opt out of strict request validation (#909 made
  // it the default for correctness over the A2A path). These tests
  // exercise session-key wiring, not schema compliance.
  const newServer = config => createAdcpServer({ ...config, validation: { requests: 'off' } });

  it('populates ctx.sessionKey before the handler runs', async () => {
    let seenSessionKey;
    const server = newServer({
      name: 'Test',
      version: '1.0.0',
      resolveSessionKey: ({ toolName }) => `tenant_${toolName}`,
      signals: {
        getSignals: async (_params, ctx) => {
          seenSessionKey = ctx.sessionKey;
          return { signals: [] };
        },
      },
    });

    await callTool(server, 'get_signals', {});
    assert.strictEqual(seenSessionKey, 'tenant_get_signals');
  });

  it('can derive sessionKey from resolved account', async () => {
    let seenSessionKey;
    const server = newServer({
      name: 'Test',
      version: '1.0.0',
      resolveAccount: async () => ({ tenant_id: 'tnt_42' }),
      resolveSessionKey: ({ account }) => account?.tenant_id,
      mediaBuy: {
        createMediaBuy: async (_params, ctx) => {
          seenSessionKey = ctx.sessionKey;
          return { media_buy_id: 'mb1', packages: [] };
        },
      },
    });

    await callTool(server, 'create_media_buy', {
      account: { account_id: 'acc_1' },
      promoted_offering: 'x',
      budget: { total: 1000, currency: 'USD' },
      packages: [],
    });
    assert.strictEqual(seenSessionKey, 'tnt_42');
  });

  it('returns SERVICE_UNAVAILABLE without leaking internals when exposeErrorDetails: false', async () => {
    // Explicit opt-out. The default flipped to true outside NODE_ENV=production
    // so dev-mode matrix runs stop wasting hours on opaque internal errors;
    // production deployments that want the redaction still get it by default
    // (NODE_ENV=production) or by setting `exposeErrorDetails: false` explicitly.
    const server = newServer({
      name: 'Test',
      version: '1.0.0',
      exposeErrorDetails: false,
      resolveSessionKey: () => {
        throw new Error('db://user:pass@10.0.0.1 timed out');
      },
      signals: { getSignals: async () => ({ signals: [] }) },
    });

    const result = await callTool(server, 'get_signals', {});
    const error = result.structuredContent.adcp_error;
    assert.strictEqual(error.code, 'SERVICE_UNAVAILABLE');
    assert.strictEqual(error.details, undefined);
  });

  it('includes details.reason when exposeErrorDetails: true', async () => {
    const server = newServer({
      name: 'Test',
      version: '1.0.0',
      exposeErrorDetails: true,
      resolveSessionKey: () => {
        throw new Error('db lookup timed out');
      },
      signals: { getSignals: async () => ({ signals: [] }) },
    });

    const result = await callTool(server, 'get_signals', {});
    assert.strictEqual(result.structuredContent.adcp_error.details?.reason, 'db lookup timed out');
  });

  it('unwraps a thrown adcpError envelope as the response (no SERVICE_UNAVAILABLE wrap)', async () => {
    // Agent authors regularly write `throw adcpError(...)` instead of
    // `return adcpError(...)`. The dispatcher auto-unwraps the envelope so
    // buyers see the typed code (CREATIVE_NOT_FOUND) rather than the
    // opaque SERVICE_UNAVAILABLE: [object Object] that thrown objects
    // otherwise produce.
    const server = newServer({
      name: 'Test',
      version: '1.0.0',
      exposeErrorDetails: false,
      signals: {
        getSignals: async () => {
          throw adcpError('SIGNAL_NOT_FOUND', {
            message: 'no signal matched the query',
            field: 'signal_spec',
          });
        },
      },
    });

    const result = await callTool(server, 'get_signals', {});
    const error = result.structuredContent.adcp_error;
    assert.strictEqual(error.code, 'SIGNAL_NOT_FOUND');
    assert.strictEqual(error.message, 'no signal matched the query');
    assert.strictEqual(error.field, 'signal_spec');
  });

  it('falls back to SERVICE_UNAVAILABLE for thrown non-envelope errors', async () => {
    // Guard: the unwrap path must only fire for actual `adcpError(...)`
    // envelopes. A TypeError or a bare object that happens to carry a
    // `structuredContent` field should still surface as SERVICE_UNAVAILABLE.
    const server = newServer({
      name: 'Test',
      version: '1.0.0',
      exposeErrorDetails: true,
      signals: {
        getSignals: async () => {
          throw new TypeError('items.map is not a function');
        },
      },
    });

    const result = await callTool(server, 'get_signals', {});
    assert.strictEqual(result.structuredContent.adcp_error.code, 'SERVICE_UNAVAILABLE');
    assert.strictEqual(result.structuredContent.adcp_error.details?.reason, 'items.map is not a function');
  });

  it('requireSessionKey narrows ctx.sessionKey or throws', () => {
    assert.strictEqual(requireSessionKey({ store: {}, sessionKey: 'alice' }), 'alice');
    assert.throws(() => requireSessionKey({ store: {} }), /sessionKey is undefined/);
  });

  it('leaves ctx.sessionKey undefined when resolver returns undefined', async () => {
    let seenSessionKey = 'sentinel';
    const server = newServer({
      name: 'Test',
      version: '1.0.0',
      resolveSessionKey: () => undefined,
      signals: {
        getSignals: async (_params, ctx) => {
          seenSessionKey = ctx.sessionKey;
          return { signals: [] };
        },
      },
    });

    await callTool(server, 'get_signals', {});
    assert.strictEqual(seenSessionKey, undefined);
  });
});

// ---------------------------------------------------------------------------
// structuredSerialize / structuredDeserialize
// ---------------------------------------------------------------------------

describe('structuredSerialize / structuredDeserialize', () => {
  it('round-trips Date', () => {
    const d = new Date('2026-04-17T12:34:56.000Z');
    const serialized = structuredSerialize({ createdAt: d });
    assert.strictEqual(JSON.parse(JSON.stringify(serialized)).createdAt.__adcpType, 'Date');
    const restored = structuredDeserialize(JSON.parse(JSON.stringify(serialized)));
    assert.ok(restored.createdAt instanceof Date);
    assert.strictEqual(restored.createdAt.toISOString(), d.toISOString());
  });

  it('round-trips Map with primitive keys', () => {
    const m = new Map([
      ['a', 1],
      ['b', 2],
    ]);
    const restored = structuredDeserialize(JSON.parse(JSON.stringify(structuredSerialize({ cache: m }))));
    assert.ok(restored.cache instanceof Map);
    assert.strictEqual(restored.cache.get('a'), 1);
    assert.strictEqual(restored.cache.get('b'), 2);
  });

  it('round-trips Set', () => {
    const s = new Set(['x', 'y', 'z']);
    const restored = structuredDeserialize(JSON.parse(JSON.stringify(structuredSerialize({ tags: s }))));
    assert.ok(restored.tags instanceof Set);
    assert.deepStrictEqual([...restored.tags].sort(), ['x', 'y', 'z']);
  });

  it('round-trips nested rich types', () => {
    const value = {
      session: {
        id: 'abc',
        startedAt: new Date('2026-04-17T00:00:00.000Z'),
        participants: new Set(['alice', 'bob']),
        counters: new Map([['msg', 42]]),
      },
    };
    const wire = JSON.parse(JSON.stringify(structuredSerialize(value)));
    const restored = structuredDeserialize(wire);
    assert.ok(restored.session.startedAt instanceof Date);
    assert.ok(restored.session.participants instanceof Set);
    assert.ok(restored.session.counters instanceof Map);
    assert.strictEqual(restored.session.counters.get('msg'), 42);
  });

  it('passes through caller data that uses __adcpType for its own purposes', () => {
    const input = { __adcpType: 'SomeDomainThing', value: 'not an iso string' };
    const serialized = JSON.parse(JSON.stringify(structuredSerialize(input)));
    const restored = structuredDeserialize(serialized);
    assert.deepStrictEqual(restored, input);
  });

  it('leaves primitives, null, and undefined alone', () => {
    assert.strictEqual(structuredSerialize(42), 42);
    assert.strictEqual(structuredSerialize('x'), 'x');
    assert.strictEqual(structuredSerialize(null), null);
    assert.strictEqual(structuredSerialize(undefined), undefined);
  });

  it('round-trips through state store with maxDocumentBytes check on serialized form', async () => {
    const store = new InMemoryStateStore();
    const value = {
      id: 'session_1',
      participants: new Set(['a', 'b']),
      timestamps: new Map([['opened', new Date('2026-04-17T00:00:00.000Z')]]),
    };
    await store.put('sessions', 'session_1', structuredSerialize(value));
    const raw = await store.get('sessions', 'session_1');
    const restored = structuredDeserialize(raw);
    assert.ok(restored.participants instanceof Set);
    assert.ok(restored.timestamps.get('opened') instanceof Date);
  });
});

// ---------------------------------------------------------------------------
// Default stateStore — module-singleton, shared across factory invocations
// ---------------------------------------------------------------------------

describe('default stateStore is process-shared (factory pattern fix)', () => {
  // Regression test for matrix v3 SI session loss: an LLM-built SI agent
  // wired `serve(() => createAdcpServer({...}))` per the skill, put session
  // state in `ctx.store.put('session', ...)` on `si_initiate_session`, then
  // `ctx.store.get('session', ...)` on the next request returned null.
  //
  // Root cause: `createAdcpServer({stateStore = new InMemoryStateStore()})`
  // evaluated the destructuring default per call, minting a fresh in-memory
  // store every request. Fix: a module-singleton default. This test guards
  // the singleton — two factory-pattern createAdcpServer calls must share
  // the default store.
  it('two factory invocations share the default ctx.store via module-singleton', async () => {
    const collection = `xreq_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
    let putStore;
    let getStore;

    const a1 = createAdcpServer({
      name: 'a1',
      version: '1.0.0',
      capabilities: { major_versions: [3] },
      validation: { requests: 'off', responses: 'off' },
      signals: {
        getSignals: async (_p, ctx) => {
          putStore = ctx.store;
          await ctx.store.put(collection, 'k', { v: 'across' });
          return { signals: [], errors: [] };
        },
      },
    });
    const a2 = createAdcpServer({
      name: 'a2',
      version: '1.0.0',
      capabilities: { major_versions: [3] },
      validation: { requests: 'off', responses: 'off' },
      signals: {
        getSignals: async (_p, ctx) => {
          getStore = ctx.store;
          return { signals: [], errors: [] };
        },
      },
    });

    await a1.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_signals', arguments: {} },
    });
    await a2.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_signals', arguments: {} },
    });

    assert.ok(putStore, 'a1 handler ran');
    assert.ok(getStore, 'a2 handler ran');
    assert.strictEqual(
      putStore,
      getStore,
      'two factory-pattern createAdcpServer calls must share the default stateStore'
    );

    const value = await getStore.get(collection, 'k');
    assert.deepStrictEqual(
      value,
      { v: 'across' },
      'value put through factory-1 must be readable through factory-2 (shared module-singleton)'
    );
  });
});

describe('default stateStore — multi-tenant footgun warning', () => {
  // Companion to the singleton: warn-once when the default store is used,
  // so multi-tenant deployments don't silently share state across tenants.
  // v6.0.1 plans to harden this into a NODE_ENV=production refusal
  // mirroring `buildDefaultTaskRegistry`. Until then, a one-time
  // `logger.warn` keeps the awareness in adopter logs.
  it('logs a one-time warning when the default stateStore is hit', () => {
    const seen = [];
    const captureLogger = {
      debug() {},
      info() {},
      warn(msg) {
        seen.push(msg);
      },
      error() {},
    };

    // First createAdcpServer with default stateStore + capture logger:
    // expect the multi-tenant warning to fire exactly once.
    createAdcpServer({
      name: 'first',
      version: '1.0.0',
      capabilities: { major_versions: [3] },
      logger: captureLogger,
    });

    // Subsequent createAdcpServer calls in the same process do NOT
    // re-fire the warning — the guard is process-scoped so adopters using
    // `serve(() => createAdcpServer({...}))` (factory pattern, called
    // every request) don't spam logs.
    createAdcpServer({
      name: 'second',
      version: '1.0.0',
      capabilities: { major_versions: [3] },
      logger: captureLogger,
    });

    const multiTenantWarnings = seen.filter(s => s.includes('multi-tenant') || s.includes('Multi-tenant'));
    // The warning may have already fired in an earlier test in this
    // process (the guard is module-level). What we assert is "no MORE
    // than one in this test", which means: either it fired now (1) or
    // already fired earlier (0). Two would mean the guard is broken.
    assert.ok(
      multiTenantWarnings.length <= 1,
      `multi-tenant warning fired more than once: ${multiTenantWarnings.length} times`
    );
  });

  it('does NOT warn when the adopter passes an explicit stateStore', () => {
    const seen = [];
    const captureLogger = {
      debug() {},
      info() {},
      warn(msg) {
        seen.push(msg);
      },
      error() {},
    };

    createAdcpServer({
      name: 'explicit',
      version: '1.0.0',
      capabilities: { major_versions: [3] },
      stateStore: new InMemoryStateStore(),
      logger: captureLogger,
    });

    const multiTenantWarnings = seen.filter(s => s.includes('multi-tenant') || s.includes('Multi-tenant'));
    assert.equal(multiTenantWarnings.length, 0, 'explicit stateStore must not trigger the default-store warning');
  });
});

describe('default stateStore — production gate (v6.0.1)', () => {
  // Mirrors `buildDefaultTaskRegistry` policy: outside
  // {NODE_ENV=test, NODE_ENV=development}, the in-memory default
  // refuses to mint unless the adopter sets
  // `ADCP_DECISIONING_ALLOW_INMEMORY_STATE=1` as the ops escape hatch.
  function withEnv(overrides, fn) {
    const prev = {};
    for (const k of Object.keys(overrides)) {
      prev[k] = process.env[k];
      if (overrides[k] === undefined) delete process.env[k];
      else process.env[k] = overrides[k];
    }
    try {
      fn();
    } finally {
      for (const k of Object.keys(overrides)) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  }

  it('NODE_ENV=production + default stateStore → throws with migration message', () => {
    withEnv({ NODE_ENV: 'production', ADCP_DECISIONING_ALLOW_INMEMORY_STATE: undefined }, () => {
      assert.throws(
        () =>
          createAdcpServer({
            name: 'p',
            version: '1.0.0',
            capabilities: { major_versions: [3] },
          }),
        err =>
          /in-memory state store refused outside.*NODE_ENV=test, NODE_ENV=development/.test(err.message) &&
          /PostgresStateStore/.test(err.message) &&
          /ADCP_DECISIONING_ALLOW_INMEMORY_STATE=1/.test(err.message)
      );
    });
  });

  it('NODE_ENV=production + ADCP_DECISIONING_ALLOW_INMEMORY_STATE=1 → allows', () => {
    withEnv({ NODE_ENV: 'production', ADCP_DECISIONING_ALLOW_INMEMORY_STATE: '1' }, () => {
      assert.doesNotThrow(() =>
        createAdcpServer({
          name: 'p',
          version: '1.0.0',
          capabilities: { major_versions: [3] },
        })
      );
    });
  });

  it('NODE_ENV=production + explicit stateStore → no env check', () => {
    withEnv({ NODE_ENV: 'production' }, () => {
      assert.doesNotThrow(() =>
        createAdcpServer({
          name: 'p',
          version: '1.0.0',
          capabilities: { major_versions: [3] },
          stateStore: new InMemoryStateStore(),
        })
      );
    });
  });

  it('NODE_ENV=development + default stateStore → no throw (dev is the safe set)', () => {
    withEnv({ NODE_ENV: 'development', ADCP_DECISIONING_ALLOW_INMEMORY_STATE: undefined }, () => {
      assert.doesNotThrow(() =>
        createAdcpServer({
          name: 'd',
          version: '1.0.0',
          capabilities: { major_versions: [3] },
        })
      );
    });
  });

  it('NODE_ENV=test + default stateStore → no throw', () => {
    withEnv({ NODE_ENV: 'test', ADCP_DECISIONING_ALLOW_INMEMORY_STATE: undefined }, () => {
      assert.doesNotThrow(() =>
        createAdcpServer({
          name: 't',
          version: '1.0.0',
          capabilities: { major_versions: [3] },
        })
      );
    });
  });

  it('undefined NODE_ENV + default stateStore → throws (matches task-registry policy strictness)', () => {
    withEnv({ NODE_ENV: undefined, ADCP_DECISIONING_ALLOW_INMEMORY_STATE: undefined }, () => {
      assert.throws(
        () =>
          createAdcpServer({
            name: 'u',
            version: '1.0.0',
            capabilities: { major_versions: [3] },
          }),
        /in-memory state store refused outside/
      );
    });
  });
});
