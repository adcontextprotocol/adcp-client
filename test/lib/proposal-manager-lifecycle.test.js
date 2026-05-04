const test = require('node:test');
const assert = require('node:assert');

const {
  detectFinalizeAction,
  enforceProposalExpiry,
  validateCapabilityOverlap,
  validateOverlapSubsetOfWire,
  maybeInterceptFinalize,
  maybePersistDraftAfterGetProducts,
  maybeReserveProposalForCreateMediaBuy,
  finalizeProposalConsumption,
  releaseProposalReservation,
  maybeHydrateRecipesForMediaBuyId,
  InMemoryProposalStore,
} = require('../../dist/lib/server/index.js');

// ---------------------------------------------------------------------------
// detectFinalizeAction
// ---------------------------------------------------------------------------

test('detectFinalizeAction', async t => {
  await t.test('returns null when no refine entries', () => {
    assert.strictEqual(detectFinalizeAction({ buying_mode: 'brief' }), null);
  });

  await t.test('returns null when no finalize action', () => {
    const req = {
      buying_mode: 'refine',
      refine: [{ scope: 'proposal', action: 'include', proposal_id: 'p1' }],
    };
    assert.strictEqual(detectFinalizeAction(req), null);
  });

  await t.test('returns the first finalize entry with index', () => {
    const req = {
      buying_mode: 'refine',
      refine: [
        { scope: 'product', action: 'omit', product_id: 'prod_a' },
        { scope: 'proposal', action: 'finalize', proposal_id: 'p1', ask: 'lock pricing' },
        { scope: 'proposal', action: 'finalize', proposal_id: 'p2' },
      ],
    };
    const found = detectFinalizeAction(req);
    assert.deepStrictEqual(found, { index: 1, proposalId: 'p1', ask: 'lock pricing' });
  });

  await t.test('omits ask when absent', () => {
    const req = {
      buying_mode: 'refine',
      refine: [{ scope: 'proposal', action: 'finalize', proposal_id: 'p3' }],
    };
    assert.deepStrictEqual(detectFinalizeAction(req), { index: 0, proposalId: 'p3' });
  });

  await t.test('skips finalize entries missing proposal_id', () => {
    const req = {
      buying_mode: 'refine',
      refine: [{ scope: 'proposal', action: 'finalize' }],
    };
    assert.strictEqual(detectFinalizeAction(req), null);
  });
});

// ---------------------------------------------------------------------------
// enforceProposalExpiry
// ---------------------------------------------------------------------------

test('enforceProposalExpiry', async t => {
  function buildStore() {
    return new InMemoryProposalStore();
  }

  await t.test('throws PROPOSAL_NOT_FOUND for unknown id', async () => {
    const store = buildStore();
    await assert.rejects(
      enforceProposalExpiry('p1', { proposalStore: store, expectedAccountId: 'acct_1' }),
      err => err.code === 'PROPOSAL_NOT_FOUND'
    );
  });

  await t.test('throws PROPOSAL_NOT_FOUND for cross-tenant probe', async () => {
    const store = buildStore();
    store.putDraft({ proposalId: 'p1', accountId: 'acct_1', recipes: new Map(), proposalPayload: {} });
    store.commit('p1', { expiresAt: new Date(Date.now() + 60_000), proposalPayload: {} });
    await assert.rejects(
      enforceProposalExpiry('p1', { proposalStore: store, expectedAccountId: 'attacker' }),
      err => err.code === 'PROPOSAL_NOT_FOUND'
    );
  });

  await t.test('throws PROPOSAL_NOT_COMMITTED when in DRAFT', async () => {
    const store = buildStore();
    store.putDraft({ proposalId: 'p1', accountId: 'acct_1', recipes: new Map(), proposalPayload: {} });
    await assert.rejects(
      enforceProposalExpiry('p1', { proposalStore: store, expectedAccountId: 'acct_1' }),
      err => err.code === 'PROPOSAL_NOT_COMMITTED'
    );
  });

  await t.test('throws PROPOSAL_EXPIRED past deadline + grace', async () => {
    // Pin a deterministic clock so the store's default 7-day post-expiry
    // eviction window doesn't interact with wall-clock drift.
    let now = new Date('2026-01-01T00:00:00Z');
    const store = new InMemoryProposalStore({ clock: () => now });
    store.putDraft({ proposalId: 'p1', accountId: 'acct_1', recipes: new Map(), proposalPayload: {} });
    store.commit('p1', { expiresAt: new Date('2026-01-01T00:00:00Z'), proposalPayload: {} });
    const checkNow = new Date('2026-01-01T01:00:00Z'); // 1h past
    await assert.rejects(
      enforceProposalExpiry('p1', {
        proposalStore: store,
        expectedAccountId: 'acct_1',
        graceSeconds: 60,
        now: checkNow,
      }),
      err => err.code === 'PROPOSAL_EXPIRED'
    );
  });

  await t.test('returns committed record within grace window', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const store = new InMemoryProposalStore({ clock: () => now });
    store.putDraft({ proposalId: 'p1', accountId: 'acct_1', recipes: new Map(), proposalPayload: {} });
    store.commit('p1', { expiresAt: new Date('2026-01-01T00:00:00Z'), proposalPayload: {} });
    const checkNow = new Date('2026-01-01T00:00:30Z'); // 30s past, within 60s grace
    const got = await enforceProposalExpiry('p1', {
      proposalStore: store,
      expectedAccountId: 'acct_1',
      graceSeconds: 60,
      now: checkNow,
    });
    assert.strictEqual(got.proposalId, 'p1');
    assert.strictEqual(got.state, 'committed');
  });
});

// ---------------------------------------------------------------------------
// validateCapabilityOverlap
// ---------------------------------------------------------------------------

test('validateCapabilityOverlap', async t => {
  function recipeWithOverlap(overlap) {
    return { recipe_kind: 'mock', capability_overlap: overlap };
  }

  await t.test('passes when overlap is undefined (open axis)', () => {
    const recipes = new Map([['prod_a', { recipe_kind: 'mock' }]]);
    validateCapabilityOverlap({
      packages: [{ product_id: 'prod_a', pricing_model: 'cpcv' }],
      recipes,
    });
  });

  await t.test('rejects pricing_model outside overlap', () => {
    const recipes = new Map([['prod_a', recipeWithOverlap({ pricingModels: new Set(['cpm']) })]]);
    assert.throws(
      () =>
        validateCapabilityOverlap({
          packages: [{ product_id: 'prod_a', pricing_model: 'cpcv' }],
          recipes,
        }),
      err =>
        err.code === 'INVALID_REQUEST' &&
        err.field === 'packages[0].pricing_option_id' &&
        /pricingModels/.test(err.message)
    );
  });

  await t.test('accepts pricing_model within overlap', () => {
    const recipes = new Map([['prod_a', recipeWithOverlap({ pricingModels: new Set(['cpm', 'cpcv']) })]]);
    validateCapabilityOverlap({
      packages: [{ product_id: 'prod_a', pricing_model: 'cpm' }],
      recipes,
    });
  });

  await t.test('rejects targeting dimensions outside overlap', () => {
    const recipes = new Map([['prod_a', recipeWithOverlap({ targetingDimensions: new Set(['geo']) })]]);
    assert.throws(
      () =>
        validateCapabilityOverlap({
          packages: [{ product_id: 'prod_a', targeting_overlay: { geo: ['us'], device_type: ['mobile'] } }],
          recipes,
        }),
      err => err.code === 'INVALID_REQUEST' && /device_type/.test(err.message)
    );
  });

  await t.test('respects custom field path prefix', () => {
    const recipes = new Map([['prod_a', recipeWithOverlap({ deliveryTypes: new Set(['guaranteed']) })]]);
    assert.throws(
      () =>
        validateCapabilityOverlap({
          packages: [{ product_id: 'prod_a', delivery_type: 'non_guaranteed' }],
          recipes,
          fieldPathPrefix: 'patches',
        }),
      err => err.field === 'patches[0].delivery_type'
    );
  });
});

// ---------------------------------------------------------------------------
// validateOverlapSubsetOfWire
// ---------------------------------------------------------------------------

test('validateOverlapSubsetOfWire', async t => {
  await t.test('rejects pricingModels overlap that exceeds wire', () => {
    const recipes = new Map([
      [
        'prod_a',
        {
          recipe_kind: 'mock',
          capability_overlap: { pricingModels: new Set(['cpm', 'cpcv']) },
        },
      ],
    ]);
    const products = [
      {
        product_id: 'prod_a',
        pricing_options: [{ pricing_model: 'cpm' }],
      },
    ];
    assert.throws(
      () => validateOverlapSubsetOfWire({ recipes, products }),
      err => err.code === 'INTERNAL_ERROR' && /cpcv/.test(err.message)
    );
  });

  await t.test('passes when overlap is subset of wire', () => {
    const recipes = new Map([
      [
        'prod_a',
        {
          recipe_kind: 'mock',
          capability_overlap: { pricingModels: new Set(['cpm']) },
        },
      ],
    ]);
    const products = [
      {
        product_id: 'prod_a',
        pricing_options: [{ pricing_model: 'cpm' }, { pricing_model: 'cpcv' }],
      },
    ];
    validateOverlapSubsetOfWire({ recipes, products });
  });

  await t.test('skips products not present in response', () => {
    const recipes = new Map([
      ['prod_missing', { recipe_kind: 'mock', capability_overlap: { pricingModels: new Set(['cpm']) } }],
    ]);
    validateOverlapSubsetOfWire({ recipes, products: [] });
  });
});

// ---------------------------------------------------------------------------
// maybeInterceptFinalize
// ---------------------------------------------------------------------------

test('maybeInterceptFinalize', async t => {
  function manager(finalizeFn) {
    return {
      capabilities: { salesSpecialism: 'sales-guaranteed', finalize: true },
      getProducts: async () => ({ products: [] }),
      finalizeProposal: finalizeFn,
    };
  }

  await t.test('passes when no finalize entry', async () => {
    const result = await maybeInterceptFinalize({
      request: { buying_mode: 'brief' },
      manager: manager(async () => ({})),
      store: new InMemoryProposalStore(),
      ctx: { account: { id: 'acct_1' } },
    });
    assert.strictEqual(result.kind, 'pass');
  });

  await t.test('passes when manager lacks finalize capability', async () => {
    const m = {
      capabilities: { salesSpecialism: 'sales-guaranteed', finalize: false },
      getProducts: async () => ({ products: [] }),
    };
    const result = await maybeInterceptFinalize({
      request: {
        buying_mode: 'refine',
        refine: [{ scope: 'proposal', action: 'finalize', proposal_id: 'p1' }],
      },
      manager: m,
      store: new InMemoryProposalStore(),
      ctx: { account: { id: 'acct_1' } },
    });
    assert.strictEqual(result.kind, 'pass');
  });

  await t.test('PROPOSAL_NOT_FOUND for unknown proposal_id', async () => {
    await assert.rejects(
      maybeInterceptFinalize({
        request: {
          buying_mode: 'refine',
          refine: [{ scope: 'proposal', action: 'finalize', proposal_id: 'p_unknown' }],
        },
        manager: manager(async () => ({})),
        store: new InMemoryProposalStore(),
        ctx: { account: { id: 'acct_1' } },
      }),
      err => err.code === 'PROPOSAL_NOT_FOUND' && err.field === 'refine[0].proposal_id'
    );
  });

  await t.test('intercepts + commits + projects wire response', async () => {
    const store = new InMemoryProposalStore();
    store.putDraft({
      proposalId: 'p1',
      accountId: 'acct_1',
      recipes: new Map([['prod_a', { recipe_kind: 'mock' }]]),
      proposalPayload: { proposal_id: 'p1', name: 'draft v1' },
    });
    const finalizeCalls = [];
    const expires = new Date(Date.now() + 60 * 60_000); // 1h from now
    const m = manager(async req => {
      finalizeCalls.push(req);
      return {
        proposal: {
          proposal_id: 'p1',
          name: 'final v1',
          proposal_status: 'committed',
          expires_at: expires.toISOString(),
        },
        expiresAt: expires,
      };
    });
    const result = await maybeInterceptFinalize({
      request: {
        buying_mode: 'refine',
        refine: [{ scope: 'proposal', action: 'finalize', proposal_id: 'p1', ask: 'lock' }],
      },
      manager: m,
      store,
      ctx: { account: { id: 'acct_1' } },
    });
    assert.strictEqual(result.kind, 'intercepted');
    assert.strictEqual(result.response.proposals[0].proposal_status, 'committed');
    assert.strictEqual(result.response.refinement_applied[0].status, 'applied');
    // Store now committed
    const committed = store.get('p1');
    assert.strictEqual(committed.state, 'committed');
    // Manager called with hydrated draft
    assert.strictEqual(finalizeCalls.length, 1);
    assert.strictEqual(finalizeCalls[0].proposalId, 'p1');
    assert.strictEqual(finalizeCalls[0].ask, 'lock');
    assert.strictEqual(finalizeCalls[0].recipes.get('prod_a').recipe_kind, 'mock');
  });

  await t.test('rejects when manager returns wrong shape', async () => {
    const store = new InMemoryProposalStore();
    store.putDraft({
      proposalId: 'p1',
      accountId: 'acct_1',
      recipes: new Map(),
      proposalPayload: { proposal_id: 'p1' },
    });
    await assert.rejects(
      maybeInterceptFinalize({
        request: {
          buying_mode: 'refine',
          refine: [{ scope: 'proposal', action: 'finalize', proposal_id: 'p1' }],
        },
        manager: manager(async () => ({ wrong: 'shape' })),
        store,
        ctx: { account: { id: 'acct_1' } },
      }),
      err => err.code === 'INTERNAL_ERROR' && /FinalizeProposalSuccess/.test(err.message)
    );
  });
});

// ---------------------------------------------------------------------------
// maybePersistDraftAfterGetProducts
// ---------------------------------------------------------------------------

test('maybePersistDraftAfterGetProducts', async t => {
  await t.test('no-op when no store wired', async () => {
    await maybePersistDraftAfterGetProducts({
      response: { proposals: [{ proposal_id: 'p1' }] },
      store: undefined,
      ctx: { account: { id: 'acct_1' } },
    });
  });

  await t.test('persists drafts with recipes from referenced products', async () => {
    const store = new InMemoryProposalStore();
    const response = {
      products: [
        {
          product_id: 'prod_a',
          implementation_config: { recipe_kind: 'mock', sku: 'a' },
          pricing_options: [{ pricing_model: 'cpm' }],
        },
        {
          product_id: 'prod_unrelated',
          implementation_config: { recipe_kind: 'mock', sku: 'x' },
        },
      ],
      proposals: [
        {
          proposal_id: 'p1',
          name: 'draft',
          allocations: [{ product_id: 'prod_a', allocation_percentage: 100 }],
        },
      ],
    };
    await maybePersistDraftAfterGetProducts({
      response,
      store,
      ctx: { account: { id: 'acct_1' } },
    });
    const record = store.get('p1');
    assert.strictEqual(record.state, 'draft');
    assert.strictEqual(record.recipes.size, 1); // only the referenced product
    assert.strictEqual(record.recipes.get('prod_a').sku, 'a');
  });

  await t.test('validates overlap ⊆ wire on persist (INTERNAL_ERROR)', async () => {
    const store = new InMemoryProposalStore();
    const response = {
      products: [
        {
          product_id: 'prod_a',
          implementation_config: {
            recipe_kind: 'mock',
            capability_overlap: { pricingModels: new Set(['cpcv']) },
          },
          pricing_options: [{ pricing_model: 'cpm' }],
        },
      ],
      proposals: [
        {
          proposal_id: 'p1',
          allocations: [{ product_id: 'prod_a' }],
        },
      ],
    };
    await assert.rejects(
      maybePersistDraftAfterGetProducts({
        response,
        store,
        ctx: { account: { id: 'acct_1' } },
      }),
      err => err.code === 'INTERNAL_ERROR'
    );
  });

  await t.test('skips when response carries no proposals[]', async () => {
    const store = new InMemoryProposalStore();
    await maybePersistDraftAfterGetProducts({
      response: { products: [] },
      store,
      ctx: { account: { id: 'acct_1' } },
    });
    // No records stored
    assert.strictEqual(store.get('any'), null);
  });
});

// ---------------------------------------------------------------------------
// Reserve / finalize / release flow
// ---------------------------------------------------------------------------

test('maybeReserveProposalForCreateMediaBuy + finalize + release', async t => {
  await t.test('no-op when proposal_id missing', async () => {
    const store = new InMemoryProposalStore();
    const result = await maybeReserveProposalForCreateMediaBuy({
      request: { packages: [] },
      manager: undefined,
      store,
      ctx: { account: { id: 'acct_1' } },
    });
    assert.strictEqual(result, null);
  });

  await t.test('reserves committed proposal + hydrates recipes', async () => {
    const store = new InMemoryProposalStore();
    store.putDraft({
      proposalId: 'p1',
      accountId: 'acct_1',
      recipes: new Map([['prod_a', { recipe_kind: 'mock', sku: 'a' }]]),
      proposalPayload: {},
    });
    const expires = new Date(Date.now() + 60_000);
    store.commit('p1', { expiresAt: expires, proposalPayload: {} });

    const reserved = await maybeReserveProposalForCreateMediaBuy({
      request: { proposal_id: 'p1', packages: [] },
      manager: undefined,
      store,
      ctx: { account: { id: 'acct_1' } },
    });
    assert.strictEqual(reserved.state, 'consuming');
    assert.strictEqual(reserved.recipes.get('prod_a').sku, 'a');
  });

  await t.test('rejects expired proposal without flipping state', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const store = new InMemoryProposalStore({ clock: () => now });
    store.putDraft({ proposalId: 'p1', accountId: 'acct_1', recipes: new Map(), proposalPayload: {} });
    store.commit('p1', { expiresAt: new Date('2026-01-01T00:00:00Z'), proposalPayload: {} });

    await assert.rejects(
      maybeReserveProposalForCreateMediaBuy({
        request: { proposal_id: 'p1', packages: [] },
        manager: undefined,
        store,
        ctx: { account: { id: 'acct_1' } },
        now: new Date('2026-01-02T00:00:00Z'),
      }),
      err => err.code === 'PROPOSAL_EXPIRED'
    );
    assert.strictEqual(store.get('p1').state, 'committed');
  });

  await t.test('parallel reserves: second loses with PROPOSAL_NOT_COMMITTED', async () => {
    const store = new InMemoryProposalStore();
    store.putDraft({ proposalId: 'p1', accountId: 'acct_1', recipes: new Map(), proposalPayload: {} });
    store.commit('p1', { expiresAt: new Date(Date.now() + 60_000), proposalPayload: {} });

    await maybeReserveProposalForCreateMediaBuy({
      request: { proposal_id: 'p1', packages: [] },
      manager: undefined,
      store,
      ctx: { account: { id: 'acct_1' } },
    });
    await assert.rejects(
      maybeReserveProposalForCreateMediaBuy({
        request: { proposal_id: 'p1', packages: [] },
        manager: undefined,
        store,
        ctx: { account: { id: 'acct_1' } },
      }),
      err => err.code === 'PROPOSAL_NOT_COMMITTED'
    );
  });

  await t.test('full success flow: reserve → finalize → CONSUMED', async () => {
    const store = new InMemoryProposalStore();
    store.putDraft({
      proposalId: 'p1',
      accountId: 'acct_1',
      recipes: new Map([['prod_a', { recipe_kind: 'mock' }]]),
      proposalPayload: {},
    });
    store.commit('p1', { expiresAt: new Date(Date.now() + 60_000), proposalPayload: {} });

    const reserved = await maybeReserveProposalForCreateMediaBuy({
      request: { proposal_id: 'p1' },
      manager: undefined,
      store,
      ctx: { account: { id: 'acct_1' } },
    });
    await finalizeProposalConsumption({ store, record: reserved, mediaBuyId: 'mb_1' });
    assert.strictEqual(store.get('p1').state, 'consumed');
    assert.strictEqual(store.getByMediaBuyId('mb_1', { expectedAccountId: 'acct_1' }).proposalId, 'p1');
  });

  await t.test('failure rollback: reserve → release → COMMITTED', async () => {
    const store = new InMemoryProposalStore();
    store.putDraft({ proposalId: 'p1', accountId: 'acct_1', recipes: new Map(), proposalPayload: {} });
    store.commit('p1', { expiresAt: new Date(Date.now() + 60_000), proposalPayload: {} });

    const reserved = await maybeReserveProposalForCreateMediaBuy({
      request: { proposal_id: 'p1' },
      manager: undefined,
      store,
      ctx: { account: { id: 'acct_1' } },
    });
    await releaseProposalReservation({ store, record: reserved });
    assert.strictEqual(store.get('p1').state, 'committed');
    // Buyer can retry
    const retry = await maybeReserveProposalForCreateMediaBuy({
      request: { proposal_id: 'p1' },
      manager: undefined,
      store,
      ctx: { account: { id: 'acct_1' } },
    });
    assert.strictEqual(retry.state, 'consuming');
  });

  await t.test('reserve enforces capability overlap on packages', async () => {
    const store = new InMemoryProposalStore();
    store.putDraft({
      proposalId: 'p1',
      accountId: 'acct_1',
      recipes: new Map([
        [
          'prod_a',
          {
            recipe_kind: 'mock',
            capability_overlap: { pricingModels: new Set(['cpm']) },
          },
        ],
      ]),
      proposalPayload: {},
    });
    store.commit('p1', { expiresAt: new Date(Date.now() + 60_000), proposalPayload: {} });

    await assert.rejects(
      maybeReserveProposalForCreateMediaBuy({
        request: {
          proposal_id: 'p1',
          packages: [{ product_id: 'prod_a', pricing_model: 'cpcv' }],
        },
        manager: undefined,
        store,
        ctx: { account: { id: 'acct_1' } },
      }),
      err => err.code === 'INVALID_REQUEST'
    );
  });
});

// ---------------------------------------------------------------------------
// maybeHydrateRecipesForMediaBuyId
// ---------------------------------------------------------------------------

test('maybeHydrateRecipesForMediaBuyId', async t => {
  function setupConsumed() {
    const store = new InMemoryProposalStore();
    store.putDraft({
      proposalId: 'p1',
      accountId: 'acct_1',
      recipes: new Map([['prod_a', { recipe_kind: 'mock', sku: 'a' }]]),
      proposalPayload: {},
    });
    store.commit('p1', { expiresAt: new Date(Date.now() + 60_000), proposalPayload: {} });
    store.markConsumed('p1', { mediaBuyId: 'mb_1' });
    return store;
  }

  await t.test('returns null when no media_buy_id', async () => {
    const store = setupConsumed();
    const got = await maybeHydrateRecipesForMediaBuyId({
      mediaBuyId: undefined,
      store,
      ctx: { account: { id: 'acct_1' } },
    });
    assert.strictEqual(got, null);
  });

  await t.test('returns null when no proposal backs the media buy', async () => {
    const store = new InMemoryProposalStore();
    const got = await maybeHydrateRecipesForMediaBuyId({
      mediaBuyId: 'mb_orphan',
      store,
      ctx: { account: { id: 'acct_1' } },
    });
    assert.strictEqual(got, null);
  });

  await t.test('hydrates recipes for known media buy', async () => {
    const store = setupConsumed();
    const got = await maybeHydrateRecipesForMediaBuyId({
      mediaBuyId: 'mb_1',
      store,
      ctx: { account: { id: 'acct_1' } },
    });
    assert.strictEqual(got.proposalId, 'p1');
    assert.strictEqual(got.recipes.get('prod_a').sku, 'a');
  });

  await t.test('cross-tenant probe returns null', async () => {
    const store = setupConsumed();
    const got = await maybeHydrateRecipesForMediaBuyId({
      mediaBuyId: 'mb_1',
      store,
      ctx: { account: { id: 'attacker' } },
    });
    assert.strictEqual(got, null);
  });

  await t.test('re-validates capability overlap on packages-shaped patch', async () => {
    const store = new InMemoryProposalStore();
    store.putDraft({
      proposalId: 'p1',
      accountId: 'acct_1',
      recipes: new Map([
        [
          'prod_a',
          {
            recipe_kind: 'mock',
            capability_overlap: { targetingDimensions: new Set(['geo']) },
          },
        ],
      ]),
      proposalPayload: {},
    });
    store.commit('p1', { expiresAt: new Date(Date.now() + 60_000), proposalPayload: {} });
    store.markConsumed('p1', { mediaBuyId: 'mb_1' });

    await assert.rejects(
      maybeHydrateRecipesForMediaBuyId({
        mediaBuyId: 'mb_1',
        store,
        ctx: { account: { id: 'acct_1' } },
        packages: [{ product_id: 'prod_a', targeting_overlay: { geo: ['us'], device_type: ['mobile'] } }],
      }),
      err => err.code === 'INVALID_REQUEST'
    );
  });
});
