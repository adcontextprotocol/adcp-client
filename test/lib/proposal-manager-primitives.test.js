const test = require('node:test');
const assert = require('node:assert');

const {
  InMemoryProposalStore,
  MockProposalManager,
  validateProposalCapabilities,
} = require('../../dist/lib/server/index.js');

// ---------------------------------------------------------------------------
// validateProposalCapabilities
// ---------------------------------------------------------------------------

test('validateProposalCapabilities', async t => {
  await t.test('accepts the two valid sales specialisms', () => {
    validateProposalCapabilities({ salesSpecialism: 'sales-guaranteed' });
    validateProposalCapabilities({ salesSpecialism: 'sales-non-guaranteed' });
  });

  await t.test('rejects unknown sales specialism', () => {
    assert.throws(() => validateProposalCapabilities({ salesSpecialism: 'sales-broadcast-tv' }), /salesSpecialism/);
  });

  await t.test('rejects negative grace window', () => {
    assert.throws(
      () => validateProposalCapabilities({ salesSpecialism: 'sales-guaranteed', expiresAtGraceSeconds: -1 }),
      /expiresAtGraceSeconds/
    );
  });
});

// ---------------------------------------------------------------------------
// InMemoryProposalStore — state machine
// ---------------------------------------------------------------------------

function recipe(kind, fields = {}) {
  return { recipe_kind: kind, ...fields };
}

test('InMemoryProposalStore — putDraft + get + cross-tenant', async t => {
  const store = new InMemoryProposalStore();
  const recipes = new Map([['prod_a', recipe('mock', { sku: 'a' })]]);
  store.putDraft({
    proposalId: 'p1',
    accountId: 'acct_1',
    recipes,
    proposalPayload: { proposal_id: 'p1', name: 'p1' },
  });

  await t.test('get returns the record for the owning tenant', () => {
    const got = store.get('p1', { expectedAccountId: 'acct_1' });
    assert.strictEqual(got.proposalId, 'p1');
    assert.strictEqual(got.state, 'draft');
    assert.strictEqual(got.recipes.get('prod_a').sku, 'a');
  });

  await t.test('get returns null for cross-tenant probe', () => {
    assert.strictEqual(store.get('p1', { expectedAccountId: 'attacker' }), null);
  });

  await t.test('get rejects calls without expectedAccountId at runtime', () => {
    // The interface is { expectedAccountId: string } (required). JS callers
    // who omit it get a TypeError at runtime — failing closed loudly is the
    // point of tightening the API. TS callers are caught at compile time.
    assert.throws(() => store.get('p1'));
  });

  await t.test('get returns null for unknown proposal_id', () => {
    assert.strictEqual(store.get('p_unknown', { expectedAccountId: 'acct_1' }), null);
  });
});

test('InMemoryProposalStore — putDraft overwrites in DRAFT state', () => {
  const store = new InMemoryProposalStore();
  store.putDraft({
    proposalId: 'p1',
    accountId: 'acct_1',
    recipes: new Map([['prod_a', recipe('mock', { v: 1 })]]),
    proposalPayload: { v: 1 },
  });
  store.putDraft({
    proposalId: 'p1',
    accountId: 'acct_1',
    recipes: new Map([['prod_a', recipe('mock', { v: 2 })]]),
    proposalPayload: { v: 2 },
  });
  const got = store.get('p1', { expectedAccountId: 'acct_1' });
  assert.strictEqual(got.recipes.get('prod_a').v, 2);
  assert.strictEqual(got.proposalPayload.v, 2);
});

test('InMemoryProposalStore — putDraft rejected on COMMITTED', () => {
  const store = new InMemoryProposalStore();
  store.putDraft({
    proposalId: 'p1',
    accountId: 'acct_1',
    recipes: new Map(),
    proposalPayload: {},
  });
  store.commit('p1', { expiresAt: new Date(Date.now() + 60_000), proposalPayload: {} });
  assert.throws(
    () =>
      store.putDraft({
        proposalId: 'p1',
        accountId: 'acct_1',
        recipes: new Map(),
        proposalPayload: {},
      }),
    err => err.code === 'INTERNAL_ERROR' && /committed/.test(err.message)
  );
});

test('InMemoryProposalStore — commit + idempotency', async t => {
  const store = new InMemoryProposalStore();
  const expires = new Date(Date.now() + 60_000);
  store.putDraft({
    proposalId: 'p1',
    accountId: 'acct_1',
    recipes: new Map(),
    proposalPayload: { a: 1 },
  });

  await t.test('DRAFT → COMMITTED', () => {
    store.commit('p1', { expiresAt: expires, proposalPayload: { a: 1, locked: true } });
    const got = store.get('p1', { expectedAccountId: 'acct_1' });
    assert.strictEqual(got.state, 'committed');
    assert.strictEqual(got.expiresAt.getTime(), expires.getTime());
    assert.strictEqual(got.proposalPayload.locked, true);
  });

  await t.test('idempotent on identical re-commit', () => {
    store.commit('p1', { expiresAt: expires, proposalPayload: { a: 1, locked: true } });
    assert.strictEqual(store.get('p1', { expectedAccountId: 'acct_1' }).state, 'committed');
  });

  await t.test('mismatched re-commit raises INTERNAL_ERROR', () => {
    assert.throws(
      () => store.commit('p1', { expiresAt: new Date(0), proposalPayload: { a: 2 } }),
      err => err.code === 'INTERNAL_ERROR'
    );
  });

  await t.test('commit on missing record raises INTERNAL_ERROR', () => {
    assert.throws(
      () => store.commit('p_nope', { expiresAt: expires, proposalPayload: {} }),
      err => err.code === 'INTERNAL_ERROR'
    );
  });
});

test('InMemoryProposalStore — two-phase consume', async t => {
  const store = new InMemoryProposalStore();
  const expires = new Date(Date.now() + 60_000);
  store.putDraft({
    proposalId: 'p1',
    accountId: 'acct_1',
    recipes: new Map([['prod_a', recipe('mock')]]),
    proposalPayload: {},
  });
  store.commit('p1', { expiresAt: expires, proposalPayload: {} });

  await t.test('tryReserveConsumption: COMMITTED → CONSUMING', () => {
    const reserved = store.tryReserveConsumption('p1', { expectedAccountId: 'acct_1' });
    assert.strictEqual(reserved.state, 'consuming');
    assert.strictEqual(store.get('p1', { expectedAccountId: 'acct_1' }).state, 'consuming');
  });

  await t.test('parallel reserve loses with PROPOSAL_NOT_COMMITTED', () => {
    assert.throws(
      () => store.tryReserveConsumption('p1', { expectedAccountId: 'acct_1' }),
      err => err.code === 'PROPOSAL_NOT_COMMITTED'
    );
  });

  await t.test('cross-tenant reserve collapses to PROPOSAL_NOT_FOUND', () => {
    assert.throws(
      () => store.tryReserveConsumption('p1', { expectedAccountId: 'attacker' }),
      err => err.code === 'PROPOSAL_NOT_FOUND'
    );
  });

  await t.test('finalizeConsumption: CONSUMING → CONSUMED + reverse-index', () => {
    store.finalizeConsumption('p1', { mediaBuyId: 'mb_1', expectedAccountId: 'acct_1' });
    assert.strictEqual(store.get('p1', { expectedAccountId: 'acct_1' }).state, 'consumed');
    const found = store.getByMediaBuyId('mb_1', { expectedAccountId: 'acct_1' });
    assert.strictEqual(found.proposalId, 'p1');
  });

  await t.test('reverse-index is tenant-scoped', () => {
    assert.strictEqual(store.getByMediaBuyId('mb_1', { expectedAccountId: 'attacker' }), null);
  });

  await t.test('finalizeConsumption idempotent on identical replay', () => {
    store.finalizeConsumption('p1', { mediaBuyId: 'mb_1', expectedAccountId: 'acct_1' });
  });

  await t.test('finalizeConsumption with different media_buy_id raises INTERNAL_ERROR', () => {
    assert.throws(
      () => store.finalizeConsumption('p1', { mediaBuyId: 'mb_2', expectedAccountId: 'acct_1' }),
      err => err.code === 'INTERNAL_ERROR'
    );
  });
});

test('InMemoryProposalStore — releaseConsumption rolls back', async t => {
  const store = new InMemoryProposalStore();
  store.putDraft({
    proposalId: 'p1',
    accountId: 'acct_1',
    recipes: new Map(),
    proposalPayload: {},
  });
  store.commit('p1', { expiresAt: new Date(Date.now() + 60_000), proposalPayload: {} });
  store.tryReserveConsumption('p1', { expectedAccountId: 'acct_1' });

  await t.test('CONSUMING → COMMITTED', () => {
    store.releaseConsumption('p1', { expectedAccountId: 'acct_1' });
    assert.strictEqual(store.get('p1', { expectedAccountId: 'acct_1' }).state, 'committed');
  });

  await t.test('releasing already-COMMITTED is a no-op', () => {
    store.releaseConsumption('p1', { expectedAccountId: 'acct_1' });
    assert.strictEqual(store.get('p1', { expectedAccountId: 'acct_1' }).state, 'committed');
  });

  await t.test('releasing unknown id is a no-op', () => {
    store.releaseConsumption('p_unknown', { expectedAccountId: 'acct_1' });
  });

  await t.test('post-rollback the buyer can retry tryReserve', () => {
    const reserved = store.tryReserveConsumption('p1', { expectedAccountId: 'acct_1' });
    assert.strictEqual(reserved.state, 'consuming');
  });
});

test('InMemoryProposalStore — eviction respects TTL with injected clock', async t => {
  let now = new Date('2026-01-01T00:00:00Z').getTime();
  const store = new InMemoryProposalStore({
    draftTtlMs: 1000,
    committedGraceMs: 1000,
    clock: () => new Date(now),
  });
  store.putDraft({
    proposalId: 'p1',
    accountId: 'acct_1',
    recipes: new Map(),
    proposalPayload: {},
  });

  await t.test('draft survives within TTL', () => {
    now += 500;
    assert.strictEqual(store.get('p1', { expectedAccountId: 'acct_1' }).state, 'draft');
  });

  await t.test('draft evicted past TTL', () => {
    now += 1_000_000;
    assert.strictEqual(store.get('p1', { expectedAccountId: 'acct_1' }), null);
  });
});

// ---------------------------------------------------------------------------
// MockProposalManager — fetch forwarding
// ---------------------------------------------------------------------------

test('MockProposalManager — getProducts forwards to mock-server', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ products: [], proposals: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const manager = new MockProposalManager({
    mockUpstreamUrl: 'http://localhost:4500/',
    fetch: fakeFetch,
    defaultHeaders: { 'X-Tenant-Id': 'acct_1' },
  });
  const ctx = { account: { id: 'acct_1' } };
  const response = await manager.getProducts({ buying_mode: 'brief' }, ctx);
  assert.deepStrictEqual(response, { products: [], proposals: [] });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, 'http://localhost:4500/get_products');
  assert.strictEqual(calls[0].init.method, 'POST');
  assert.strictEqual(calls[0].init.headers['X-Tenant-Id'], 'acct_1');
  const sent = JSON.parse(calls[0].init.body);
  assert.deepStrictEqual(sent, { buying_mode: 'brief' });
});

test('MockProposalManager — refineProducts gated on capabilities.refine', async t => {
  await t.test('refine: false rejects with descriptive error', async () => {
    const manager = new MockProposalManager({
      mockUpstreamUrl: 'http://localhost:4500',
      fetch: async () => new Response('{}', { status: 200 }),
    });
    await assert.rejects(manager.refineProducts({}, { account: { id: 'a' } }), /capabilities\.refine is false/);
  });

  await t.test('refine: true forwards to /refine_products', async () => {
    const calls = [];
    const manager = new MockProposalManager({
      mockUpstreamUrl: 'http://localhost:4500',
      refine: true,
      fetch: async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ products: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    await manager.refineProducts({ buying_mode: 'refine' }, { account: { id: 'a' } });
    assert.strictEqual(calls[0].url, 'http://localhost:4500/refine_products');
  });
});

test('MockProposalManager — non-2xx surfaces structured error', async () => {
  const manager = new MockProposalManager({
    mockUpstreamUrl: 'http://localhost:4500',
    fetch: async () => new Response('catalog unavailable', { status: 503 }),
  });
  await assert.rejects(manager.getProducts({}, { account: { id: 'a' } }), /503/);
});

test('MockProposalManager — empty mockUpstreamUrl throws', () => {
  assert.throws(() => new MockProposalManager({ mockUpstreamUrl: '' }), /mockUpstreamUrl/);
});

test('MockProposalManager — capabilities reflect constructor', () => {
  const m = new MockProposalManager({
    mockUpstreamUrl: 'http://localhost:4500',
    salesSpecialism: 'sales-guaranteed',
    refine: true,
  });
  assert.strictEqual(m.capabilities.salesSpecialism, 'sales-guaranteed');
  assert.strictEqual(m.capabilities.refine, true);
  assert.strictEqual(m.mockUpstreamUrl, 'http://localhost:4500');
});
