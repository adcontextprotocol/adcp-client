const test = require('node:test');
const assert = require('node:assert/strict');
const { getSchemaDocumentByRef, getSchemaValidatorByRef } = require('../../dist/lib/validation/schema-loader.js');
const {
  CanonicalProposalSchema,
  TargetingOverlaySchema,
  TargetingOverlayInputSchema,
} = require('../../dist/lib/types/schemas.generated.js');
const { proposalTermsDigest } = require('../../dist/lib/negotiation/verification.js');
const current = require('../fixtures/proposal-commercial-terms/current.json');

const targeting = getSchemaDocumentByRef('core/targeting.json').schema;
const request = getSchemaDocumentByRef('media-buy/buy-products-request.json').schema;
const purchaseRef = request.properties.purchases.items.$ref;
const validateInput = getSchemaValidatorByRef(`media-buy/${purchaseRef.split('/').at(-1)}`);
const permitsClear = purchaseRef.endsWith('/product-purchase-input.json');
assert.equal(permitsClear, true, 'the current pin must retain request-only targeting input');
const validateProposal = getSchemaValidatorByRef('core/canonical-proposal.json');
const roundtrip = value => JSON.parse(JSON.stringify(value));

const overlays = [
  ['omitted', undefined, true, true],
  ['empty overlay', {}, true, true],
  ['nonempty countries', { geo_countries: ['US', 'GB'] }, true, true],
  ['empty countries', { geo_countries: [] }, false, false],
  ['clear countries', { geo_countries: null }, permitsClear, false],
  ['invalid element', { geo_countries: [42] }, false, false],
  ['invalid country code', { geo_countries: ['USA'] }, false, false],
  ['null overlay', null, false, false],
  ...Object.keys(targeting.properties)
    .filter(dimension => dimension !== 'geo_countries')
    .map(dimension => [`clear ${dimension}`, { [dimension]: null }, true, false]),
];

for (const [name, overlay, validInput, validSnapshot] of overlays) {
  test(`targeting ${name}: request and proposal contracts survive JSON serialization`, () => {
    const purchase = { product_id: 'product-1', pricing_option_id: 'price-1' };
    if (overlay !== undefined) purchase.targeting_overlay = overlay;
    const wire = roundtrip(purchase);
    assert.deepEqual(wire, purchase);
    assert.equal(validateInput(wire), validInput, JSON.stringify(validateInput.errors));
    for (const kind of ['new_media_buy', 'media_buy_update', 'media_buy_cancellation']) {
      for (const status of ['draft', 'committed', 'accepted']) {
        const commercial_terms = structuredClone(current);
        if (overlay !== undefined) commercial_terms.purchases[0].targeting_overlay = overlay;
        if (kind === 'media_buy_cancellation') {
          commercial_terms.cancellation_terms = { effective_at: '2027-01-15T00:00:00Z' };
        }
        const proposal = roundtrip({
          proposal_id: 'proposal-1',
          proposal_kind: kind,
          proposal_status: status,
          name: 'Targeting contract',
          commercial_terms,
          terms_digest: proposalTermsDigest(commercial_terms),
          ...(kind !== 'new_media_buy' && {
            parent_proposal_id: 'parent-1',
            media_buy_id: 'buy-1',
            base_media_buy_revision: 1,
          }),
          ...(status === 'committed' && { expires_at: '2027-01-01T00:00:00Z' }),
          ...(status === 'accepted' && { media_buy_id: 'buy-1', accepted_at: '2027-01-01T00:00:00Z' }),
        });
        assert.equal(
          validateProposal(proposal),
          validSnapshot,
          `${kind}/${status}: ${JSON.stringify(validateProposal.errors)}`
        );
        const parsed = CanonicalProposalSchema.safeParse(proposal);
        assert.equal(parsed.success, validSnapshot, `${kind}/${status}`);
        if (parsed.success) assert.deepEqual(parsed.data, proposal);
        else assert.ok(parsed.error.issues.some(issue => issue.path.includes('targeting_overlay')));
      }
    }
  });
}

test('all known targeting dimensions distinguish clear commands from effective state', () => {
  const validateTargeting = getSchemaValidatorByRef('core/targeting.json');
  for (const [dimension, schema] of Object.entries(targeting.properties)) {
    const overlay = { [dimension]: null };
    assert.equal(
      validateInput({ product_id: 'product-1', pricing_option_id: 'price-1', targeting_overlay: overlay }),
      permitsClear,
      dimension
    );
    assert.equal(validateTargeting(overlay), false, dimension);
    assert.equal(TargetingOverlaySchema.safeParse(overlay).success, false, dimension);
    if (permitsClear) {
      const parsed = TargetingOverlayInputSchema.safeParse(overlay);
      assert.equal(parsed.success, true, dimension);
      assert.deepEqual(parsed.data, overlay, dimension);
    }
    if (schema.type === 'array') {
      assert.equal(schema.minItems, 1, dimension);
      assert.equal(
        validateInput({
          product_id: 'product-1',
          pricing_option_id: 'price-1',
          targeting_overlay: { [dimension]: [] },
        }),
        false,
        dimension
      );
      assert.equal(validateTargeting({ [dimension]: [] }), false, dimension);
    }
  }
});
