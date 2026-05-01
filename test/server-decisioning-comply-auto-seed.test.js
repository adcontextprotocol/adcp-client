// Integration tests for catalog-backed auto-seed: when a platform wires
// `getProducts` and provides `complyTest` without explicit `seed.product` /
// `seed_pricing_option` adapters, the framework auto-derives those adapters
// and wires a `testController` bridge so seeded products appear in
// `get_products` without any adapter code from the adopter.
//
// Acceptance criteria (issue #1091):
//   - seed_product succeeds for sandbox requests when getProducts is wired
//   - seed_pricing_option succeeds (merges into the product fixture)
//   - seeded product is visible in get_products (via bridge) on sandbox requests
//   - non-sandbox request is rejected by the sandboxGate (FORBIDDEN)
//   - explicit seed.product adapter takes priority — auto-derive does not override
//   - auto-seed is NOT applied when opts.testController is already set
//   - auto-seed is NOT applied when getProducts is not wired

process.env.NODE_ENV = 'test';
process.env.ADCP_SANDBOX = '1'; // suppress ungated-warning

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');

function basePlatform({ getProducts } = {}) {
  return {
    capabilities: {
      specialisms: ['sales-non-guaranteed'],
      compliance_testing: {},
      creative_agents: [],
      channels: ['display'],
      pricingModels: ['cpm'],
      config: {},
    },
    statusMappers: {},
    accounts: {
      // Propagate sandbox flag from AccountReference so the bridge's belt-and-
      // suspenders check (ctx.account.sandbox === true) passes for sandbox requests.
      resolve: async ref => ({
        id: ref?.account_id ?? 'auto_seed_acc',
        operator: 'test.example.com',
        ctx_metadata: {},
        authInfo: { kind: 'api_key' },
        ...(ref?.sandbox === true && { sandbox: true }),
      }),
    },
    sales: {
      getProducts: getProducts ?? (async () => ({ products: [] })),
      createMediaBuy: async () => ({
        media_buy_id: 'mb_1',
        status: 'pending_creatives',
        confirmed_at: '2026-04-28T00:00:00Z',
        packages: [],
      }),
      updateMediaBuy: async () => ({ media_buy_id: 'mb_1', status: 'active' }),
      syncCreatives: async () => [],
      getMediaBuyDelivery: async () => ({
        currency: 'USD',
        reporting_period: { start: '2026-04-01', end: '2026-04-30' },
        media_buy_deliveries: [],
      }),
    },
  };
}

const SANDBOX_GATE = input => input.account?.sandbox === true;
const BASE_OPTS = {
  name: 'auto-seed-host',
  version: '0.0.1',
  validation: { requests: 'off', responses: 'off' },
};

async function callComply(server, args) {
  return server.dispatchTestRequest({
    method: 'tools/call',
    params: { name: 'comply_test_controller', arguments: args },
  });
}

async function callGetProducts(server, args) {
  return server.dispatchTestRequest({
    method: 'tools/call',
    params: { name: 'get_products', arguments: args },
  });
}

describe('createAdcpServerFromPlatform — catalog-backed auto-seed (issue #1091)', () => {
  it('seed_product succeeds for a sandbox account when no explicit adapter is wired', async () => {
    const server = createAdcpServerFromPlatform(basePlatform(), {
      ...BASE_OPTS,
      complyTest: { sandboxGate: SANDBOX_GATE },
    });

    const result = await callComply(server, {
      scenario: 'seed_product',
      account: { account_id: 'acc_1', sandbox: true },
      params: {
        product_id: 'sports_display_auction',
        fixture: { delivery_type: 'non_guaranteed', channels: ['display'] },
      },
    });

    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.strictEqual(result.structuredContent.success, true);
  });

  it('seeded product is visible in get_products after seed_product', async () => {
    const server = createAdcpServerFromPlatform(basePlatform(), {
      ...BASE_OPTS,
      complyTest: { sandboxGate: SANDBOX_GATE },
    });

    await callComply(server, {
      scenario: 'seed_product',
      account: { account_id: 'acc_1', sandbox: true },
      params: {
        product_id: 'sports_display_auction',
        fixture: {
          delivery_type: 'non_guaranteed',
          channels: ['display'],
          pricing_options: [{ pricing_option_id: 'cpm_1', model: 'cpm', floor: { amount: 5, currency: 'USD' } }],
        },
      },
    });

    const result = await callGetProducts(server, {
      account: { account_id: 'acc_1', sandbox: true },
    });

    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    const products = result.structuredContent.products;
    assert.ok(Array.isArray(products), 'products should be an array');
    const seeded = products.find(p => p.product_id === 'sports_display_auction');
    assert.ok(seeded, 'seeded product should appear in get_products for sandbox request');
    assert.strictEqual(seeded.delivery_type, 'non_guaranteed');
  });

  it('seed_pricing_option auto-derive merges pricing option into the seeded product', async () => {
    const server = createAdcpServerFromPlatform(basePlatform(), {
      ...BASE_OPTS,
      complyTest: { sandboxGate: SANDBOX_GATE },
    });

    // Seed the parent product first
    await callComply(server, {
      scenario: 'seed_product',
      account: { account_id: 'acc_1', sandbox: true },
      params: {
        product_id: 'sports_display_auction',
        fixture: { delivery_type: 'non_guaranteed', channels: ['display'] },
      },
    });

    // Now seed a pricing option on that product
    const poResult = await callComply(server, {
      scenario: 'seed_pricing_option',
      account: { account_id: 'acc_1', sandbox: true },
      params: {
        product_id: 'sports_display_auction',
        pricing_option_id: 'cpm_floor_5',
        fixture: { model: 'cpm', floor: { amount: 5, currency: 'USD' } },
      },
    });

    assert.notStrictEqual(poResult.isError, true, JSON.stringify(poResult.structuredContent));
    assert.strictEqual(poResult.structuredContent.success, true);

    // Verify the pricing option merged into the product in get_products
    const gpResult = await callGetProducts(server, {
      account: { account_id: 'acc_1', sandbox: true },
    });
    const products = gpResult.structuredContent.products;
    const seeded = products.find(p => p.product_id === 'sports_display_auction');
    assert.ok(seeded, 'seeded product should appear');
    const po = (seeded.pricing_options ?? []).find(p => p.pricing_option_id === 'cpm_floor_5');
    assert.ok(po, 'seeded pricing option should be present in the product');
  });

  it('non-sandbox request is rejected with FORBIDDEN when sandboxGate is wired', async () => {
    const server = createAdcpServerFromPlatform(basePlatform(), {
      ...BASE_OPTS,
      complyTest: { sandboxGate: SANDBOX_GATE },
    });

    const result = await callComply(server, {
      scenario: 'seed_product',
      account: { account_id: 'acc_prod', sandbox: false },
      params: {
        product_id: 'some_product',
        fixture: {},
      },
    });

    assert.strictEqual(result.structuredContent?.success, false);
    assert.strictEqual(result.structuredContent?.error, 'FORBIDDEN');
  });

  it('explicit seed.product adapter takes priority over auto-derive', async () => {
    let explicitCalled = false;
    const server = createAdcpServerFromPlatform(basePlatform(), {
      ...BASE_OPTS,
      complyTest: {
        sandboxGate: SANDBOX_GATE,
        seed: {
          product: async params => {
            explicitCalled = true;
            // explicit adapter stores nothing — just marks it was called
          },
        },
      },
    });

    await callComply(server, {
      scenario: 'seed_product',
      account: { account_id: 'acc_1', sandbox: true },
      params: {
        product_id: 'explicit_product',
        fixture: { delivery_type: 'non_guaranteed' },
      },
    });

    assert.ok(explicitCalled, 'explicit seed.product adapter should be called');

    // The auto-bridge is NOT wired when explicit adapter is present (or at least
    // the product is not in the auto-seed store, so get_products returns empty)
    const gpResult = await callGetProducts(server, {
      account: { account_id: 'acc_1', sandbox: true },
    });
    const products = gpResult.structuredContent.products ?? [];
    const found = products.find(p => p.product_id === 'explicit_product');
    // Explicit adapters own their storage — the framework's auto-bridge is not wired
    assert.ok(!found, 'auto-bridge should NOT be wired when explicit seed.product is provided');
  });

  it('auto-seed is not applied when getProducts is not wired (no sales catalog)', async () => {
    const platformNoSales = {
      ...basePlatform(),
      sales: undefined,
      capabilities: {
        ...basePlatform().capabilities,
        specialisms: [], // no sales specialisms
      },
    };

    // Supply complyTest with only a force adapter (no sales); platform has no getProducts
    let callCount = 0;
    const server = createAdcpServerFromPlatform(
      { ...platformNoSales, sales: null },
      {
        ...BASE_OPTS,
        complyTest: {
          sandboxGate: SANDBOX_GATE,
          force: {
            creative_status: async () => {
              callCount++;
              return {
                success: true,
                transition: 'forced',
                resource_type: 'creative',
                resource_id: 'x',
                previous_state: 'pending_review',
                current_state: 'approved',
              };
            },
          },
        },
      }
    );

    // seed_product should return UNKNOWN_SCENARIO (no auto-seed, no explicit adapter)
    const result = await callComply(server, {
      scenario: 'seed_product',
      account: { account_id: 'acc_1', sandbox: true },
      params: { product_id: 'no_catalog_product', fixture: {} },
    });

    assert.strictEqual(result.structuredContent?.error, 'UNKNOWN_SCENARIO');
  });

  it('multi-tenant: two sandbox accounts on one server do NOT share the auto-seed namespace', async () => {
    // Realistic multi-tenant pattern: each tenant has its own catalog with
    // distinct product_ids. Tenant A's seeded products must not appear in
    // tenant B's `get_products`, and vice versa.
    //
    // Note on cross-tenant *same-id divergent-fixture* collisions: the SDK's
    // process-wide `SeedFixtureCache` keys by `seed_product:${product_id}`
    // (test-controller.ts:~563) and rejects divergent fixtures with
    // INVALID_PARAMS. That's a pre-existing SDK limitation tracked
    // separately — auto-seed's per-account store can't paper over it.
    // True per-account seedCache scoping is a follow-up; for now,
    // multi-tenant correctness is "different products don't leak."
    const server = createAdcpServerFromPlatform(basePlatform(), {
      ...BASE_OPTS,
      complyTest: { sandboxGate: SANDBOX_GATE },
    });

    await callComply(server, {
      scenario: 'seed_product',
      account: { account_id: 'tenant_a', sandbox: true },
      params: {
        product_id: 'tenant_a_display',
        fixture: { delivery_type: 'non_guaranteed', channels: ['display'] },
      },
    });

    await callComply(server, {
      scenario: 'seed_product',
      account: { account_id: 'tenant_b', sandbox: true },
      params: {
        product_id: 'tenant_b_video',
        fixture: { delivery_type: 'guaranteed', channels: ['video'] },
      },
    });

    const aProducts = (await callGetProducts(server, { account: { account_id: 'tenant_a', sandbox: true } }))
      .structuredContent.products;
    const bProducts = (await callGetProducts(server, { account: { account_id: 'tenant_b', sandbox: true } }))
      .structuredContent.products;

    assert.ok(
      aProducts.some(p => p.product_id === 'tenant_a_display'),
      'tenant_a should see its own product'
    );
    assert.ok(
      !aProducts.some(p => p.product_id === 'tenant_b_video'),
      "tenant_a must NOT see tenant_b's product (cross-tenant leak)"
    );
    assert.ok(
      bProducts.some(p => p.product_id === 'tenant_b_video'),
      'tenant_b should see its own product'
    );
    assert.ok(
      !bProducts.some(p => p.product_id === 'tenant_a_display'),
      "tenant_b must NOT see tenant_a's product (cross-tenant leak)"
    );
  });

  it('security: caller spoofing account.account_id only writes to its own claimed namespace (no resolver call)', async () => {
    // Pin: the auto-seed adapter MUST NOT call platform.accounts.resolve
    // with attacker-supplied account_id and no authInfo. If it did, a
    // caller could spoof account.account_id: 'victim' and a non-validating
    // resolver would map it to the victim's resolved namespace.
    //
    // This test pins the contract: even when the resolver maps
    // 'attacker' → 'tenant_victim' (simulating a misconfigured resolver
    // that returns based on raw id alone), the adapter writes ONLY under
    // the raw 'attacker' namespace. The victim's bridge (reading
    // ctx.account.id = 'tenant_victim_real') never sees the attacker's
    // fixtures.
    const platform = basePlatform();
    platform.accounts.resolve = async ref => {
      // Deliberately bad resolver: maps any account_id to a "victim"
      // namespace (simulating a resolver that doesn't validate authInfo).
      if (ref?.account_id === 'tenant_victim') {
        return {
          id: 'tenant_victim_real',
          operator: 'test.example.com',
          ctx_metadata: {},
          authInfo: { kind: 'api_key' },
          ...(ref?.sandbox === true && { sandbox: true }),
        };
      }
      return {
        id: ref?.account_id ?? 'unknown',
        operator: 'test.example.com',
        ctx_metadata: {},
        authInfo: { kind: 'api_key' },
        ...(ref?.sandbox === true && { sandbox: true }),
      };
    };

    const server = createAdcpServerFromPlatform(platform, {
      ...BASE_OPTS,
      complyTest: { sandboxGate: SANDBOX_GATE },
    });

    // Attacker spoofs account_id: 'tenant_victim' on a seed.
    await callComply(server, {
      scenario: 'seed_product',
      account: { account_id: 'tenant_victim', sandbox: true },
      params: {
        product_id: 'attacker_product',
        fixture: { delivery_type: 'guaranteed' },
      },
    });

    // Victim's get_products (resolves to tenant_victim_real) must NOT see
    // the attacker's fixture.
    const victimResult = await callGetProducts(server, {
      account: { account_id: 'tenant_victim_alias', sandbox: true },
    });
    const victimProducts = victimResult.structuredContent.products ?? [];
    assert.ok(
      !victimProducts.some(p => p.product_id === 'attacker_product'),
      "victim's get_products MUST NOT see attacker's spoofed fixture (cross-tenant write vector)"
    );
  });

  it('mapping resolver: adapter writes under raw account_id (security-correct asymmetry, issue #1216)', async () => {
    // Adopters whose resolver maps `account_id` to a distinct internal `id`
    // (e.g., `acc_42` → `mapped:acc_42`) hit a documented limitation: the
    // adapter writes under the RAW account_id, but the bridge reads under
    // the framework-resolved id. Asymmetric — fixtures don't appear in
    // get_products. That's the security-correct trade-off:
    //
    // The alternative — having the adapter call platform.accounts.resolve
    // — would let a caller spoof account.account_id and have a non-validating
    // resolver write seeds into another tenant's namespace (the adapter has
    // no authInfo to pass to resolve). Architectural fix tracked at #1216:
    // widen ComplyControllerContext so the adapter sees the framework-resolved
    // account. Until then, mapping-resolver adopters wire explicit seed
    // adapters or use identity resolvers.
    const platform = basePlatform();
    platform.accounts.resolve = async ref => ({
      id: ref?.account_id ? `mapped:${ref.account_id}` : 'mapped:unknown',
      operator: 'test.example.com',
      ctx_metadata: {},
      authInfo: { kind: 'api_key' },
      ...(ref?.sandbox === true && { sandbox: true }),
    });

    const server = createAdcpServerFromPlatform(platform, {
      ...BASE_OPTS,
      complyTest: { sandboxGate: SANDBOX_GATE },
    });

    await callComply(server, {
      scenario: 'seed_product',
      account: { account_id: 'acc_42', sandbox: true },
      params: {
        product_id: 'mapped_product',
        fixture: { delivery_type: 'non_guaranteed', channels: ['display'] },
      },
    });

    const result = await callGetProducts(server, {
      account: { account_id: 'acc_42', sandbox: true },
    });

    // Adapter wrote to namespace 'acc_42'; bridge reads from resolved id
    // 'mapped:acc_42' — no match. Documented limitation.
    const products = result.structuredContent.products ?? [];
    const seeded = products.find(p => p.product_id === 'mapped_product');
    assert.equal(seeded, undefined, 'mapping-resolver fixtures do NOT appear in get_products (documented limitation)');
  });

  it('warn-on-drop: seed_product with no account.account_id logs and drops, no fixture leaks (issue #1216)', async () => {
    // sandboxGate normally rejects account-less requests; this test pretends
    // the gate misconfigured (returns true unconditionally) so we hit the
    // adapter directly with no account ref. The auto-seed must NOT collapse
    // the missing-account case into a shared namespace — it must drop AND
    // emit a warn-level log so the misconfiguration is diagnosable.
    const warnings = [];
    const platform = basePlatform();
    const server = createAdcpServerFromPlatform(platform, {
      ...BASE_OPTS,
      logger: {
        debug: () => {},
        info: () => {},
        warn: (message, meta) => warnings.push({ message, meta }),
        error: () => {},
      },
      complyTest: {
        sandboxGate: () => true, // permissive gate (misconfiguration scenario)
      },
    });

    const result = await callComply(server, {
      scenario: 'seed_product',
      // account omitted — bypasses the normal sandboxGate check via the permissive gate above
      params: {
        product_id: 'orphan_product',
        fixture: { delivery_type: 'non_guaranteed' },
      },
    });

    // The seed call itself succeeds (returns SeedSuccess via SeedFixtureCache)
    // but the auto-seed adapter dropped the write and warned.
    assert.notStrictEqual(result.isError, true);
    const droppedWarning = warnings.find(w => w.message.includes('seed_product fired without `account.account_id`'));
    assert.ok(
      droppedWarning,
      'expected a warn-level log when seed fires with no account; got: ' + JSON.stringify(warnings)
    );
    assert.strictEqual(droppedWarning.meta.product_id, 'orphan_product');

    // Confirm no fixture leaked into a shared namespace: a sandbox account's
    // get_products must NOT see the orphan.
    const gpResult = await callGetProducts(server, {
      account: { account_id: 'any_acc', sandbox: true },
    });
    const products = gpResult.structuredContent.products ?? [];
    assert.ok(
      !products.some(p => p.product_id === 'orphan_product'),
      'orphan product must NOT leak into any account namespace'
    );
  });
});
