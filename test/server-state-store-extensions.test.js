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

  it('populates ctx.sessionKey before the handler runs', async () => {
    let seenSessionKey;
    const server = createAdcpServer({
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
    const server = createAdcpServer({
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
    const server = createAdcpServer({
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
    const server = createAdcpServer({
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
    const server = createAdcpServer({
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
    const server = createAdcpServer({
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
    const server = createAdcpServer({
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
