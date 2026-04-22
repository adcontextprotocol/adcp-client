const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  createDefaultTestControllerStore,
  createDefaultSession,
  TestControllerError,
  CONTROLLER_SCENARIOS,
} = require('../../dist/lib/testing');
const { handleTestControllerRequest } = require('../../dist/lib/server/test-controller');

// ────────────────────────────────────────────────────────────
// createDefaultSession
// ────────────────────────────────────────────────────────────

describe('createDefaultSession', () => {
  it('returns empty Maps for every field', () => {
    const session = createDefaultSession();
    const expectedMaps = [
      'accountStatuses',
      'creativeStatuses',
      'creativeRejectionReasons',
      'mediaBuyStatuses',
      'mediaBuyRejectionReasons',
      'sessionStatuses',
      'sessionTerminationReasons',
      'simulatedDeliveries',
      'cumulativeDeliveries',
      'simulatedBudgetSpends',
      'seededProducts',
      'seededPricingOptions',
      'seededCreatives',
      'seededPlans',
      'seededMediaBuys',
    ];
    for (const key of expectedMaps) {
      assert.ok(session[key] instanceof Map, `session.${key} should be a Map`);
      assert.strictEqual(session[key].size, 0, `session.${key} should be empty`);
    }
  });

  it('returns independent sessions on each call', () => {
    const a = createDefaultSession();
    const b = createDefaultSession();
    a.accountStatuses.set('acct-1', 'active');
    assert.strictEqual(b.accountStatuses.size, 0);
  });
});

// ────────────────────────────────────────────────────────────
// Factory shape
// ────────────────────────────────────────────────────────────

describe('createDefaultTestControllerStore — factory shape', () => {
  it('returns a factory with scenarios populated before loadSession runs', async () => {
    let loadSessionCalled = 0;
    const factory = createDefaultTestControllerStore({
      async loadSession() {
        loadSessionCalled++;
        return createDefaultSession();
      },
    });
    assert.ok(Array.isArray(factory.scenarios));
    assert.strictEqual(loadSessionCalled, 0);
  });

  it('scenarios array matches CONTROLLER_SCENARIOS length (6 advertised)', async () => {
    const factory = createDefaultTestControllerStore({
      async loadSession() {
        return createDefaultSession();
      },
    });
    const advertised = Object.values(CONTROLLER_SCENARIOS);
    assert.strictEqual(factory.scenarios.length, advertised.length);
    assert.deepStrictEqual([...factory.scenarios].sort(), [...advertised].sort());
  });

  it('list_scenarios answers without invoking loadSession', async () => {
    let loadSessionCalled = 0;
    const factory = createDefaultTestControllerStore({
      async loadSession() {
        loadSessionCalled++;
        return createDefaultSession();
      },
    });
    const result = await handleTestControllerRequest(factory, { scenario: 'list_scenarios' });
    assert.strictEqual(result.success, true);
    assert.strictEqual(loadSessionCalled, 0);
    assert.strictEqual(result.scenarios.length, 6);
  });
});

// ────────────────────────────────────────────────────────────
// Force scenarios
// ────────────────────────────────────────────────────────────

describe('createDefaultTestControllerStore — force_account_status', () => {
  it('upserts an account status and returns previous/current', async () => {
    const session = createDefaultSession();
    const factory = createDefaultTestControllerStore({
      async loadSession() {
        return session;
      },
    });
    const result = await handleTestControllerRequest(factory, {
      scenario: 'force_account_status',
      params: { account_id: 'acct-1', status: 'suspended' },
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.previous_state, 'active');
    assert.strictEqual(result.current_state, 'suspended');
    assert.strictEqual(session.accountStatuses.get('acct-1'), 'suspended');
  });

  it('second call reports the actual previous state', async () => {
    const session = createDefaultSession();
    const factory = createDefaultTestControllerStore({
      async loadSession() {
        return session;
      },
    });
    await handleTestControllerRequest(factory, {
      scenario: 'force_account_status',
      params: { account_id: 'acct-1', status: 'suspended' },
    });
    const second = await handleTestControllerRequest(factory, {
      scenario: 'force_account_status',
      params: { account_id: 'acct-1', status: 'active' },
    });
    assert.strictEqual(second.previous_state, 'suspended');
    assert.strictEqual(second.current_state, 'active');
  });
});

describe('createDefaultTestControllerStore — force_creative_status', () => {
  it('throws NOT_FOUND when creative has never been seeded or forced', async () => {
    const session = createDefaultSession();
    const factory = createDefaultTestControllerStore({
      async loadSession() {
        return session;
      },
    });
    const result = await handleTestControllerRequest(factory, {
      scenario: 'force_creative_status',
      params: { creative_id: 'cr-ghost', status: 'approved' },
    });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, 'NOT_FOUND');
  });

  it('succeeds after seed_creative has been called', async () => {
    const session = createDefaultSession();
    const factory = createDefaultTestControllerStore({
      async loadSession() {
        return session;
      },
    });
    await handleTestControllerRequest(factory, {
      scenario: 'seed_creative',
      params: { creative_id: 'cr-1', fixture: { status: 'pending_review' } },
    });
    const result = await handleTestControllerRequest(factory, {
      scenario: 'force_creative_status',
      params: { creative_id: 'cr-1', status: 'approved' },
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.previous_state, 'pending_review');
    assert.strictEqual(result.current_state, 'approved');
  });

  it('stores rejection_reason only when transitioning to rejected', async () => {
    const session = createDefaultSession();
    const factory = createDefaultTestControllerStore({
      async loadSession() {
        return session;
      },
    });
    await handleTestControllerRequest(factory, {
      scenario: 'seed_creative',
      params: { creative_id: 'cr-1', fixture: {} },
    });
    await handleTestControllerRequest(factory, {
      scenario: 'force_creative_status',
      params: { creative_id: 'cr-1', status: 'rejected', rejection_reason: 'Brand safety' },
    });
    assert.strictEqual(session.creativeRejectionReasons.get('cr-1'), 'Brand safety');
    // Transitioning away from rejected clears the reason.
    await handleTestControllerRequest(factory, {
      scenario: 'force_creative_status',
      params: { creative_id: 'cr-1', status: 'approved' },
    });
    assert.strictEqual(session.creativeRejectionReasons.has('cr-1'), false);
  });
});

describe('createDefaultTestControllerStore — force_media_buy_status', () => {
  it('throws NOT_FOUND for unseeded media_buy', async () => {
    const session = createDefaultSession();
    const factory = createDefaultTestControllerStore({
      async loadSession() {
        return session;
      },
    });
    const result = await handleTestControllerRequest(factory, {
      scenario: 'force_media_buy_status',
      params: { media_buy_id: 'mb-ghost', status: 'active' },
    });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, 'NOT_FOUND');
  });

  it('succeeds after seed_media_buy', async () => {
    const session = createDefaultSession();
    const factory = createDefaultTestControllerStore({
      async loadSession() {
        return session;
      },
    });
    await handleTestControllerRequest(factory, {
      scenario: 'seed_media_buy',
      params: { media_buy_id: 'mb-1', fixture: { status: 'pending_start' } },
    });
    const result = await handleTestControllerRequest(factory, {
      scenario: 'force_media_buy_status',
      params: { media_buy_id: 'mb-1', status: 'active' },
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.previous_state, 'pending_start');
    assert.strictEqual(result.current_state, 'active');
  });
});

describe('createDefaultTestControllerStore — force_session_status', () => {
  it('upserts session status with active as default previous', async () => {
    const session = createDefaultSession();
    const factory = createDefaultTestControllerStore({
      async loadSession() {
        return session;
      },
    });
    const result = await handleTestControllerRequest(factory, {
      scenario: 'force_session_status',
      params: { session_id: 'sess-1', status: 'complete' },
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.previous_state, 'active');
    assert.strictEqual(result.current_state, 'complete');
  });

  it('records termination_reason when provided', async () => {
    const session = createDefaultSession();
    const factory = createDefaultTestControllerStore({
      async loadSession() {
        return session;
      },
    });
    await handleTestControllerRequest(factory, {
      scenario: 'force_session_status',
      params: { session_id: 'sess-1', status: 'terminated', termination_reason: 'timeout' },
    });
    assert.strictEqual(session.sessionTerminationReasons.get('sess-1'), 'timeout');
  });
});

// ────────────────────────────────────────────────────────────
// Simulate scenarios
// ────────────────────────────────────────────────────────────

describe('createDefaultTestControllerStore — simulate_delivery', () => {
  it('stores delta and builds cumulative totals', async () => {
    const session = createDefaultSession();
    const factory = createDefaultTestControllerStore({
      async loadSession() {
        return session;
      },
    });
    const first = await handleTestControllerRequest(factory, {
      scenario: 'simulate_delivery',
      params: {
        media_buy_id: 'mb-1',
        impressions: 100,
        clicks: 5,
        reported_spend: { amount: 10, currency: 'USD' },
      },
    });
    assert.strictEqual(first.success, true);
    assert.strictEqual(first.cumulative.impressions, 100);
    assert.strictEqual(first.cumulative.reported_spend.amount, 10);

    const second = await handleTestControllerRequest(factory, {
      scenario: 'simulate_delivery',
      params: {
        media_buy_id: 'mb-1',
        impressions: 50,
        reported_spend: { amount: 3, currency: 'USD' },
      },
    });
    assert.strictEqual(second.cumulative.impressions, 150);
    assert.strictEqual(second.cumulative.clicks, 5);
    assert.strictEqual(second.cumulative.reported_spend.amount, 13);
  });
});

describe('createDefaultTestControllerStore — simulate_budget_spend', () => {
  it('stores the latest record keyed by media_buy_id', async () => {
    const session = createDefaultSession();
    const factory = createDefaultTestControllerStore({
      async loadSession() {
        return session;
      },
    });
    const result = await handleTestControllerRequest(factory, {
      scenario: 'simulate_budget_spend',
      params: { media_buy_id: 'mb-1', spend_percentage: 85 },
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.simulated.spend_percentage, 85);
    assert.strictEqual(session.simulatedBudgetSpends.get('media_buy:mb-1').spend_percentage, 85);
  });
});

// ────────────────────────────────────────────────────────────
// Seed scenarios
// ────────────────────────────────────────────────────────────

describe('createDefaultTestControllerStore — seed scenarios', () => {
  it('stores seeded products, pricing options, creatives, plans, media_buys', async () => {
    const session = createDefaultSession();
    const factory = createDefaultTestControllerStore({
      async loadSession() {
        return session;
      },
    });
    await handleTestControllerRequest(factory, {
      scenario: 'seed_product',
      params: { product_id: 'p-1', fixture: { delivery_type: 'non_guaranteed' } },
    });
    await handleTestControllerRequest(factory, {
      scenario: 'seed_pricing_option',
      params: { product_id: 'p-1', pricing_option_id: 'po-1', fixture: { cpm: 5 } },
    });
    await handleTestControllerRequest(factory, {
      scenario: 'seed_creative',
      params: { creative_id: 'cr-1', fixture: { type: 'banner' } },
    });
    await handleTestControllerRequest(factory, {
      scenario: 'seed_plan',
      params: { plan_id: 'plan-1', fixture: { budget: 1000 } },
    });
    await handleTestControllerRequest(factory, {
      scenario: 'seed_media_buy',
      params: { media_buy_id: 'mb-1', fixture: { status: 'pending_start' } },
    });
    assert.deepStrictEqual(session.seededProducts.get('p-1'), { delivery_type: 'non_guaranteed' });
    assert.deepStrictEqual(session.seededPricingOptions.get('p-1:po-1'), { cpm: 5 });
    assert.deepStrictEqual(session.seededCreatives.get('cr-1'), { type: 'banner' });
    assert.deepStrictEqual(session.seededPlans.get('plan-1'), { budget: 1000 });
    assert.deepStrictEqual(session.seededMediaBuys.get('mb-1'), { status: 'pending_start' });
  });
});

// ────────────────────────────────────────────────────────────
// saveSession / loadSession
// ────────────────────────────────────────────────────────────

describe('createDefaultTestControllerStore — saveSession', () => {
  it('is called after each mutation', async () => {
    const session = createDefaultSession();
    const saveCalls = [];
    const factory = createDefaultTestControllerStore({
      async loadSession() {
        return session;
      },
      async saveSession(s) {
        saveCalls.push(s.accountStatuses.get('acct-1'));
      },
    });
    await handleTestControllerRequest(factory, {
      scenario: 'force_account_status',
      params: { account_id: 'acct-1', status: 'suspended' },
    });
    assert.strictEqual(saveCalls.length, 1);
    assert.strictEqual(saveCalls[0], 'suspended');
  });

  it('is called after seed mutations', async () => {
    let saveCalls = 0;
    const session = createDefaultSession();
    const factory = createDefaultTestControllerStore({
      async loadSession() {
        return session;
      },
      async saveSession() {
        saveCalls++;
      },
    });
    await handleTestControllerRequest(factory, {
      scenario: 'seed_product',
      params: { product_id: 'p-1', fixture: {} },
    });
    assert.ok(saveCalls >= 1);
  });
});

describe('createDefaultTestControllerStore — loadSession input', () => {
  it('receives the request context unchanged', async () => {
    let capturedContext;
    const factory = createDefaultTestControllerStore({
      async loadSession({ context }) {
        capturedContext = context;
        return createDefaultSession();
      },
    });
    await handleTestControllerRequest(factory, {
      scenario: 'force_account_status',
      params: { account_id: 'a', status: 'active' },
      context: { session_id: 'abc' },
    });
    assert.deepStrictEqual(capturedContext, { session_id: 'abc' });
  });
});

// ────────────────────────────────────────────────────────────
// Overrides
// ────────────────────────────────────────────────────────────

describe('createDefaultTestControllerStore — overrides', () => {
  it('replace the default handler for the overridden scenario', async () => {
    const session = createDefaultSession();
    let called = false;
    const factory = createDefaultTestControllerStore({
      async loadSession() {
        return session;
      },
      overrides: {
        async forceAccountStatus(accountId, status) {
          called = true;
          return {
            success: true,
            previous_state: 'custom_previous',
            current_state: status,
            message: `override handled ${accountId}`,
          };
        },
      },
    });
    const result = await handleTestControllerRequest(factory, {
      scenario: 'force_account_status',
      params: { account_id: 'acct-1', status: 'suspended' },
    });
    assert.strictEqual(called, true);
    assert.strictEqual(result.previous_state, 'custom_previous');
    // Default path did not run — no session update.
    assert.strictEqual(session.accountStatuses.has('acct-1'), false);
  });

  it('leaves non-overridden defaults intact', async () => {
    const session = createDefaultSession();
    const factory = createDefaultTestControllerStore({
      async loadSession() {
        return session;
      },
      overrides: {
        async forceAccountStatus() {
          return { success: true, previous_state: 'x', current_state: 'y' };
        },
      },
    });
    // seed_product should still work via the default handler.
    const seedResult = await handleTestControllerRequest(factory, {
      scenario: 'seed_product',
      params: { product_id: 'p-1', fixture: { channels: ['web'] } },
    });
    assert.strictEqual(seedResult.success, true);
    assert.deepStrictEqual(session.seededProducts.get('p-1'), { channels: ['web'] });
  });
});

// ────────────────────────────────────────────────────────────
// Cap enforcement
// ────────────────────────────────────────────────────────────

describe('createDefaultTestControllerStore — mapCap', () => {
  it('rejects net-new keys past the cap', async () => {
    const session = createDefaultSession();
    const factory = createDefaultTestControllerStore({
      async loadSession() {
        return session;
      },
      mapCap: 2,
    });
    await handleTestControllerRequest(factory, {
      scenario: 'force_account_status',
      params: { account_id: 'a1', status: 'active' },
    });
    await handleTestControllerRequest(factory, {
      scenario: 'force_account_status',
      params: { account_id: 'a2', status: 'active' },
    });
    const overflow = await handleTestControllerRequest(factory, {
      scenario: 'force_account_status',
      params: { account_id: 'a3', status: 'active' },
    });
    assert.strictEqual(overflow.success, false);
    assert.strictEqual(overflow.error, 'INVALID_STATE');
  });

  it('allows overwriting existing keys at the cap', async () => {
    const session = createDefaultSession();
    const factory = createDefaultTestControllerStore({
      async loadSession() {
        return session;
      },
      mapCap: 1,
    });
    await handleTestControllerRequest(factory, {
      scenario: 'force_account_status',
      params: { account_id: 'a1', status: 'active' },
    });
    const overwrite = await handleTestControllerRequest(factory, {
      scenario: 'force_account_status',
      params: { account_id: 'a1', status: 'suspended' },
    });
    assert.strictEqual(overwrite.success, true);
  });
});

// ────────────────────────────────────────────────────────────
// TestControllerError propagation
// ────────────────────────────────────────────────────────────

describe('createDefaultTestControllerStore — overrides can throw', () => {
  it('surfaces TestControllerError from override as typed response', async () => {
    const factory = createDefaultTestControllerStore({
      async loadSession() {
        return createDefaultSession();
      },
      overrides: {
        async forceAccountStatus() {
          throw new TestControllerError('FORBIDDEN', 'sandbox only');
        },
      },
    });
    const result = await handleTestControllerRequest(factory, {
      scenario: 'force_account_status',
      params: { account_id: 'a', status: 'active' },
    });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, 'FORBIDDEN');
  });
});
