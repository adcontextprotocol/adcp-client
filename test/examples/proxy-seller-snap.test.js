/**
 * CI gates for `examples/proxy-seller-snap/`.
 *
 * This is intentionally lighter than the hello-adapter fork matrix: the
 * example is a bridge wiring artifact, not a complete Snap implementation.
 * The behavior gate proves controller seeds flow through resolved-account
 * session loading and merge after the Snap-shaped read handlers run.
 */

require('tsx/cjs');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const EXAMPLE_FILE = path.join(REPO_ROOT, 'examples', 'proxy-seller-snap', 'index.ts');
const SANDBOX_ACCOUNT = { account_id: 'snap_sandbox_acme', sandbox: true };

const {
  createInMemorySnapSessionStore,
  createProxySellerSnapServer,
} = require('../../examples/proxy-seller-snap/index.ts');

function dispatch(server, name, args) {
  return server.dispatchTestRequest({
    method: 'tools/call',
    params: { name, arguments: args },
  });
}

function product(productId) {
  return {
    product_id: productId,
    name: productId,
    description: productId,
    publisher_properties: [{ publisher_domain: 'snap.com', selection_type: 'all' }],
    channels: ['social'],
    delivery_type: 'non_guaranteed',
    format_ids: [{ agent_url: 'http://127.0.0.1:3018', id: 'snap-single-image' }],
    pricing_options: [
      {
        pricing_option_id: 'cpm',
        pricing_model: 'cpm',
        currency: 'USD',
        floor_price: 5,
      },
    ],
    reporting_capabilities: {
      available_reporting_frequencies: ['daily'],
      expected_delay_minutes: 60,
      timezone: 'UTC',
      supports_webhooks: false,
      available_metrics: ['impressions', 'clicks', 'spend'],
      date_range_support: 'date_range',
    },
  };
}

describe('examples/proxy-seller-snap', () => {
  it('passes strict TypeScript compilation', () => {
    const res = spawnSync(
      'npx',
      [
        'tsc',
        '--noEmit',
        EXAMPLE_FILE,
        '--target',
        'ES2022',
        '--module',
        'Node16',
        '--moduleResolution',
        'node16',
        '--esModuleInterop',
        '--skipLibCheck',
        '--strict',
        '--noUncheckedIndexedAccess',
        '--exactOptionalPropertyTypes',
        '--noImplicitOverride',
        '--noFallthroughCasesInSwitch',
        '--noPropertyAccessFromIndexSignature',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 }
    );
    assert.equal(res.status, 0, `tsc reported errors:\n${(res.stdout || '') + (res.stderr || '')}`);
  });

  it('merges controller-seeded products and creatives after Snap-shaped handlers run', async () => {
    const calls = [];
    const sessionStore = createInMemorySnapSessionStore();
    const server = createProxySellerSnapServer({
      sessionStore,
      enableComplyTestController: true,
      validation: { requests: 'off', responses: 'off' },
      snapClient: {
        async listProducts(adAccountId) {
          calls.push(`products:${adAccountId}`);
          return [product('snap-upstream-product')];
        },
        async listCreatives(adAccountId) {
          calls.push(`creatives:${adAccountId}`);
          return [{ creative_id: 'snap-upstream-creative', name: 'Upstream creative' }];
        },
        async listPropertyLists(adAccountId) {
          calls.push(`property-lists:${adAccountId}`);
          return [];
        },
      },
    });

    await dispatch(server, 'comply_test_controller', {
      scenario: 'seed_product',
      params: { product_id: 'snap-seeded-product', fixture: { name: 'Seeded product' } },
      account: SANDBOX_ACCOUNT,
    });
    await dispatch(server, 'comply_test_controller', {
      scenario: 'seed_creative',
      params: { creative_id: 'snap-seeded-creative', fixture: { name: 'Seeded creative' } },
      account: SANDBOX_ACCOUNT,
    });

    const products = await dispatch(server, 'get_products', {
      buying_mode: 'brief',
      brief: 'outdoor apparel',
      account: SANDBOX_ACCOUNT,
    });
    assert.deepEqual(
      products.structuredContent.products.map(p => p.product_id),
      ['snap-upstream-product', 'snap-seeded-product']
    );
    assert.equal(products.structuredContent._bridge.callback, 'getSeededProducts');

    const creatives = await dispatch(server, 'list_creatives', { account: SANDBOX_ACCOUNT });
    assert.deepEqual(
      creatives.structuredContent.creatives.map(c => c.creative_id),
      ['snap-upstream-creative', 'snap-seeded-creative']
    );
    assert.equal(creatives.structuredContent._bridge.callback, 'getSeededCreatives');
    assert.deepEqual(calls, ['products:sandbox_acme', 'creatives:sandbox_acme']);
  });

  it('keys governance bridge reads on the resolved account session', async () => {
    const sessionStore = createInMemorySnapSessionStore();
    sessionStore.load('snap:snap_sandbox_acme').seededPropertyLists.push({
      list_id: 'snap-brand-safe-sites',
      name: 'Brand-safe sites',
      list_type: 'allow',
      sources: [],
    });

    const server = createProxySellerSnapServer({
      sessionStore,
      validation: { requests: 'off', responses: 'off' },
      snapClient: {
        async listProducts() {
          return [];
        },
        async listCreatives() {
          return [];
        },
        async listPropertyLists() {
          return [];
        },
      },
    });

    const lists = await dispatch(server, 'list_property_lists', { account: SANDBOX_ACCOUNT });
    assert.deepEqual(
      lists.structuredContent.lists.map(l => l.list_id),
      ['snap-brand-safe-sites']
    );
    assert.equal(lists.structuredContent._bridge.callback, 'getSeededPropertyLists');
  });

  it('does not fabricate get_property_list data when upstream has no matching list', async () => {
    const server = createProxySellerSnapServer({
      validation: { requests: 'off', responses: 'off' },
      snapClient: {
        async listProducts() {
          return [];
        },
        async listCreatives() {
          return [];
        },
        async listPropertyLists() {
          return [];
        },
      },
    });

    const result = await dispatch(server, 'get_property_list', {
      account: SANDBOX_ACCOUNT,
      list_id: 'missing-list',
    });

    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.adcp_error.code, 'REFERENCE_NOT_FOUND');
    assert.equal(result.structuredContent._bridge, undefined);
  });

  it('does not treat caller-supplied sandbox as the resolved-account trust boundary', async () => {
    const sessionStore = createInMemorySnapSessionStore();
    sessionStore.load('snap:snap_live_acme').seededProducts.set('should-not-merge', { name: 'Leaked fixture' });
    const server = createProxySellerSnapServer({
      sessionStore,
      validation: { requests: 'off', responses: 'off' },
      snapClient: {
        async listProducts() {
          return [product('snap-upstream-product')];
        },
        async listCreatives() {
          return [];
        },
        async listPropertyLists() {
          return [];
        },
      },
    });

    const result = await dispatch(server, 'get_products', {
      buying_mode: 'brief',
      brief: 'outdoor apparel',
      account: { account_id: 'snap_live_acme', sandbox: true },
    });

    assert.deepEqual(
      result.structuredContent.products.map(p => p.product_id),
      ['snap-upstream-product']
    );
    assert.equal(result.structuredContent._bridge, undefined);
  });
});
