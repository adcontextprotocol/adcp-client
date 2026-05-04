/**
 * Wire-strip test for `Product.implementation_config` — Recipe data
 * (network codes, line-item template ids, ad-unit ids, GAM line-item
 * priority, etc.) MUST NEVER cross to the buyer's wire response.
 *
 * Parallel to `server-decisioning-ctx-metadata-strip.test.js`. The
 * framework's response-boundary chokepoint runs `stripImplementationConfig`
 * after `stripCtxMetadata`; this test exercises the strip directly.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { stripImplementationConfig, hasImplementationConfig } = require('../../dist/lib/server/index.js');

test('stripImplementationConfig: products[] carrier — recipe deleted, product preserved', () => {
  const wire = {
    products: [
      {
        product_id: 'prod_a',
        name: 'Sports Preroll',
        delivery_type: 'guaranteed',
        implementation_config: {
          recipe_kind: 'gam',
          network_code: 'net_topology_leak',
          ad_unit_ids: ['au_internal_1', 'au_internal_2'],
          upstream_ids: { line_item_template_id: 'lit_secret_42' },
        },
      },
      {
        product_id: 'prod_b',
        name: 'Display ROS',
        // no implementation_config — leave alone
      },
    ],
  };
  stripImplementationConfig(wire);
  assert.strictEqual(wire.products[0].implementation_config, undefined);
  assert.strictEqual(wire.products[0].product_id, 'prod_a', 'other fields preserved');
  assert.strictEqual(wire.products[1].product_id, 'prod_b');
  const serialized = JSON.stringify(wire);
  assert.ok(!serialized.includes('net_topology_leak'), `recipe network leaked: ${serialized}`);
  assert.ok(!serialized.includes('lit_secret_42'), `line-item template id leaked: ${serialized}`);
});

test('stripImplementationConfig: nested under proposals[].products — also stripped', () => {
  const wire = {
    proposals: [
      {
        proposal_id: 'p1',
        products: [
          {
            product_id: 'prod_a',
            implementation_config: { recipe_kind: 'gam', network_code: 'leak' },
          },
        ],
      },
    ],
  };
  stripImplementationConfig(wire);
  assert.strictEqual(wire.proposals[0].products[0].implementation_config, undefined);
  assert.strictEqual(wire.proposals[0].products[0].product_id, 'prod_a');
});

test('stripImplementationConfig: leaves non-Product objects alone', () => {
  // Field name happens to appear on a non-Product carrier — strip is
  // shape-aware (requires product_id), not blindly key-matched.
  const wire = {
    diagnostic_envelope: {
      // no product_id; not a Product
      implementation_config: { keep: true },
    },
  };
  stripImplementationConfig(wire);
  assert.deepStrictEqual(wire.diagnostic_envelope.implementation_config, { keep: true });
});

test('stripImplementationConfig: handles null / non-object inputs without throwing', () => {
  assert.strictEqual(stripImplementationConfig(null), null);
  assert.strictEqual(stripImplementationConfig(undefined), undefined);
  assert.strictEqual(stripImplementationConfig('string'), 'string');
  assert.strictEqual(stripImplementationConfig(42), 42);
});

test('hasImplementationConfig: detects across product carriers', () => {
  assert.ok(
    hasImplementationConfig({
      products: [{ product_id: 'p', implementation_config: { recipe_kind: 'gam' } }],
    })
  );
  assert.ok(
    hasImplementationConfig({
      proposals: [{ products: [{ product_id: 'p', implementation_config: {} }] }],
    })
  );
  assert.ok(!hasImplementationConfig({ products: [{ product_id: 'p' }] }));
  assert.ok(!hasImplementationConfig({}));
  assert.ok(!hasImplementationConfig(null));
});
