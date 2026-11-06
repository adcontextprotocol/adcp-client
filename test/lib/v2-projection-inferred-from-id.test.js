// A legacy id under a seller's own agent URL belongs to that seller. The
// projector may still guess its meaning from the AAO naming conventions, but it
// must say so, let a caller turn the guess off, and never let the guess
// contradict the seller's own format_options[] (adcp-client#3634).

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  isAaoAgentUrl,
  legacyRoutesForProduct,
  projectV1ProductToV2,
  toAdditiveCanonicalProduct,
  toCanonicalOnlyProduct,
} = require('../../dist/lib/v2/projection/index.js');

const AAO = 'https://creative.adcontextprotocol.org/';
const SELLER = 'https://seller.example/mcp';

function legacyProduct(format_ids) {
  return { product_id: 'p1', name: 'Legacy product', description: 'Legacy-only', format_ids };
}

describe('a display_WxH id at a seller URL with a display_tag format option', () => {
  const ref = { agent_url: SELLER, id: 'display_300x250' };
  const tag = {
    format_option_id: 'tag_300x250',
    format_kind: 'display_tag',
    params: { sizes: [{ width: 300, height: 250 }] },
  };

  test('the guess does not stop the seller pairing its option with its id', () => {
    const product = { ...legacyProduct([ref]), format_options: [tag] };

    const canonical = toCanonicalOnlyProduct(product);
    assert.deepEqual(canonical.diagnostics, [], 'the seller id is covered by its own option');
    assert.equal(canonical.product.format_options[0].format_kind, 'display_tag');

    const additive = toAdditiveCanonicalProduct(product);
    assert.deepEqual(additive.diagnostics, []);
    assert.equal(additive.product.format_options[0].format_kind, 'display_tag');
    assert.deepEqual(
      additive.routes.map(route => ({ ref: route.format_option_ref, ids: route.format_ids })),
      [{ ref: { scope: 'product', format_option_id: 'tag_300x250' }, ids: [ref] }]
    );
  });

  test('an explicit route keeps the seller declaration, and authoritative projection finds no contradiction', () => {
    const product = { ...legacyProduct([ref]), format_options: [{ ...tag, v1_format_ref: [ref] }] };

    const additive = toAdditiveCanonicalProduct(product);
    assert.deepEqual(additive.diagnostics, []);
    assert.equal(additive.product.format_options[0].format_kind, 'display_tag');
    assert.deepEqual(additive.routes[0].format_ids, [ref]);
    assert.equal(additive.routes[0].inferred_from_id, undefined, "the seller's own option is not a guess");

    // A consumer cross-checking the seller's options against its ids gets no
    // competing `image` declaration once guesses are off.
    const projected = projectV1ProductToV2(legacyProduct([ref]), { authoritativeOnly: true });
    assert.deepEqual(projected.v2.format_options, []);
    assert.equal(projected.diagnostics[0].error.details.resolution_failure, 'no_match');
  });

  test('an authoritative mapping that contradicts the seller still vetoes the pairing', () => {
    const aaoRef = { agent_url: AAO, id: 'display_300x250_image' };
    const product = { ...legacyProduct([aaoRef]), format_options: [tag] };
    const additive = toAdditiveCanonicalProduct(product);
    assert.deepEqual(additive.routes, [], 'the display_tag option gets no route to an image id');
  });
});

describe('a guessed declaration is marked as a guess', () => {
  test('a registry id glob at a seller URL is marked inferred_from_id', () => {
    const ref = { agent_url: SELLER, id: 'display_300x250' };
    const { product, diagnostics, routes } = toAdditiveCanonicalProduct(legacyProduct([ref]));

    // Default output is unchanged: the guess is still returned.
    assert.deepEqual(diagnostics, []);
    assert.equal(product.format_options.length, 1);
    assert.equal(product.format_options[0].format_kind, 'image');
    assert.deepEqual(product.format_options[0].params, { width: 300, height: 250 });
    assert.equal('inferred_from_id' in product.format_options[0], false, 'the declaration itself gains no field');

    assert.equal(routes.length, 1);
    assert.equal(routes[0].inferred_from_id, true);
    assert.deepEqual(routes[0].format_ids, [ref]);
    assert.equal(JSON.parse(JSON.stringify(routes))[0].inferred_from_id, true, 'the marker survives JSON');
  });

  test('an AAO catalog id copied under a seller URL is marked inferred_from_id', () => {
    const ref = { agent_url: SELLER, id: 'display_300x250_image' };
    const { v2, legacyRoutes } = projectV1ProductToV2(legacyProduct([ref]));
    assert.equal(v2.format_options[0].format_kind, 'image');
    assert.equal(legacyRoutes[0].inferred_from_id, true);
  });

  test('a video_WxH id at a seller URL is marked inferred_from_id', () => {
    const ref = { agent_url: SELLER, id: 'video_640x480' };
    const { product, routes } = toAdditiveCanonicalProduct(legacyProduct([ref]));
    assert.equal(product.format_options[0].format_kind, 'video_hosted');
    assert.equal(routes[0].inferred_from_id, true);
  });

  test('declarations from the AAO agent or an explicit converter are not marked', () => {
    const aaoRefs = [
      { agent_url: AAO, id: 'display_300x250_image' },
      { agent_url: AAO, id: 'display_300x250' },
    ];
    const aao = toAdditiveCanonicalProduct(legacyProduct(aaoRefs));
    assert.equal(aao.routes.length, 2);
    for (const route of aao.routes) assert.equal('inferred_from_id' in route, false);

    const ref = { agent_url: SELLER, id: 'display_300x250' };
    const converted = toAdditiveCanonicalProduct(legacyProduct([ref]), {
      authoritativeOnly: true,
      legacyFormatConverter: () => ({
        format_option_id: 'seller_tag',
        format_kind: 'display_tag',
        params: { sizes: [{ width: 300, height: 250 }] },
      }),
    });
    assert.equal(converted.product.format_options[0].format_kind, 'display_tag');
    assert.equal('inferred_from_id' in converted.routes[0], false);
  });

  test('the marker follows a canonical-only projection into later route extraction', () => {
    const ref = { agent_url: SELLER, id: 'display_300x250' };
    const { product } = toCanonicalOnlyProduct(legacyProduct([ref]));
    assert.equal(legacyRoutesForProduct('p1', product.format_options)[0].inferred_from_id, true);
  });
});

describe('authoritativeOnly turns guessing off', () => {
  test('a seller id that only a guess could resolve is reported instead of projected', () => {
    const refs = [
      { agent_url: SELLER, id: 'display_300x250' },
      { agent_url: SELLER, id: 'display_300x250_image' },
    ];
    const { product, diagnostics, routes } = toAdditiveCanonicalProduct(legacyProduct(refs), {
      authoritativeOnly: true,
    });
    assert.deepEqual(product.format_options, []);
    assert.deepEqual(routes, []);
    assert.deepEqual(product.format_ids, refs, 'the legacy ids stay on the product');
    assert.equal(diagnostics.length, 2);
    for (const diagnostic of diagnostics) {
      assert.equal(diagnostic.code, 'FORMAT_PROJECTION_FAILED');
      assert.equal(diagnostic.error.details.resolution_failure, 'no_match');
    }
  });

  test('ids at the AAO reference agent still resolve', () => {
    const refs = [
      { agent_url: AAO, id: 'display_300x250_image' },
      { agent_url: AAO.replace(/\/$/, ''), id: 'display_300x250' },
    ];
    const { v2, diagnostics } = projectV1ProductToV2(legacyProduct(refs), { authoritativeOnly: true });
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(
      v2.format_options.map(option => option.format_kind),
      ['image', 'image']
    );
  });

  test('isAaoAgentUrl names the AAO reference agent only', () => {
    assert.equal(isAaoAgentUrl(AAO), true);
    assert.equal(isAaoAgentUrl('https://creative.adcontextprotocol.org'), true);
    assert.equal(isAaoAgentUrl(SELLER), false);
  });
});
