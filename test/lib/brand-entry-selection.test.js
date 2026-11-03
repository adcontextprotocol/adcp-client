const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { selectBrandEntry } = require('@adcp/sdk/brand');

const spark = {
  id: 'spark',
  names: [{ 'en-GB': 'Spark' }, { fr: 'Étincelle' }],
  url: 'https://spark.example/about',
  properties: [{ type: 'website', identifier: 'spark.example', relationship: 'owned' }],
  tagline: [{ 'en-GB': 'A brighter day' }],
  fonts: { primary: { family: 'Example Sans' } },
  tone: { voice: [{ 'en-GB': 'Warm and direct' }] },
  colors: { primary: '#047857' },
};
const glow = { id: 'glow', names: [{ en: 'Glow' }] };
const portfolio = { house: { domain: 'nova-brands.example', name: 'Nova Brands' }, brands: [glow, spark] };

describe('selectBrandEntry', () => {
  it('retains the full matching entry and all localized field shapes', () => {
    assert.deepEqual(selectBrandEntry(portfolio, 'SPARK.EXAMPLE'), spark);
    assert.deepEqual(selectBrandEntry(spark, 'spark.example'), spark);
    assert.deepEqual(selectBrandEntry(portfolio, { domain: 'nova-brands.example', brandId: 'spark' }), spark);
    assert.equal(selectBrandEntry(portfolio, { domain: 'spark.example', brandId: 'missing' }), undefined);
    assert.equal(selectBrandEntry(spark, { domain: 'spark.example', brandId: 'glow' }), undefined);
  });

  it('matches a homepage URL or an owned website without fetching', () => {
    const homepage = { ...spark, properties: [] };
    assert.deepEqual(selectBrandEntry({ ...portfolio, brands: [homepage] }, 'spark.example'), homepage);
    const owned = { ...spark, url: undefined, properties: [{ type: 'website', identifier: 'SPARK.EXAMPLE' }] };
    assert.deepEqual(selectBrandEntry({ ...portfolio, brands: [owned] }, 'spark.example'), owned);
    for (const relationship of ['direct', 'delegated', 'ad_network']) {
      assert.equal(
        selectBrandEntry(
          { ...portfolio, brands: [{ ...owned, properties: [{ ...owned.properties[0], relationship }] }] },
          'spark.example'
        ),
        undefined
      );
    }
    assert.equal(
      selectBrandEntry(
        { ...portfolio, brands: [{ ...owned, properties: [{ type: 'mobile_app', identifier: 'spark.example' }] }] },
        'spark.example'
      ),
      undefined
    );
  });

  it('does not infer ownership from a property carrying a compatibility delegation marker', () => {
    for (const delegation_type of ['direct', 'delegated', 'ad_network', 'unknown', null]) {
      for (const relationship of [undefined, 'owned']) {
        const property = { type: 'website', identifier: 'spark.example', relationship, delegation_type };
        const entry = { ...spark, url: undefined, properties: [property] };
        assert.equal(selectBrandEntry({ ...portfolio, brands: [entry] }, 'spark.example'), undefined);
      }
    }
  });

  it('never picks the first of several matching entries or duplicate IDs', () => {
    assert.equal(
      selectBrandEntry({ ...portfolio, brands: [spark, { ...glow, properties: spark.properties }] }, 'spark.example'),
      undefined
    );
    assert.equal(
      selectBrandEntry(
        { ...portfolio, brands: [spark, { ...spark }] },
        { domain: 'nova-brands.example', brandId: 'spark' }
      ),
      undefined
    );
    assert.equal(
      selectBrandEntry(
        { ...portfolio, brand_refs: [{ domain: 'spark.example', brand_id: 'pointed' }] },
        'spark.example'
      ),
      undefined
    );
  });

  it('restricts defaults to the house, requiring a unique master or a sole child', () => {
    const master = { ...glow, keller_type: 'master' };
    assert.deepEqual(selectBrandEntry({ ...portfolio, brands: [spark, master] }, 'nova-brands.example'), master);
    assert.equal(selectBrandEntry({ ...portfolio, brands: [spark, master] }, 'unrelated.example'), undefined);
    assert.deepEqual(selectBrandEntry({ ...portfolio, brands: [glow] }, 'nova-brands.example'), glow);
    assert.equal(selectBrandEntry(portfolio, 'nova-brands.example'), undefined);
    assert.equal(
      selectBrandEntry({ ...portfolio, brands: [master, { ...spark, keller_type: 'master' }] }, 'nova-brands.example'),
      undefined
    );
    assert.equal(
      selectBrandEntry(
        { ...portfolio, brands: [glow], brand_refs: [{ domain: 'spark.example', brand_id: 'spark' }] },
        'nova-brands.example'
      ),
      undefined
    );
  });

  it('requires a confirmed www/apex normalization hostname rather than inferring one', () => {
    const www = { ...portfolio, house: { domain: 'www.nova-brands.example' }, brands: [glow] };
    assert.equal(selectBrandEntry(www, 'nova-brands.example'), undefined);
    assert.deepEqual(
      selectBrandEntry(www, { domain: 'nova-brands.example', houseDomains: ['www.nova-brands.example'] }),
      glow
    );
  });

  it('does not turn unresolved redirects, agents, or malformed documents into brand entries', () => {
    for (const document of [
      { house: 'nova-brands.example' },
      { authoritative_location: 'https://assets.example/brand.json' },
      { agents: [{ type: 'brand', url: 'https://agent.example/mcp' }] },
      { ...portfolio, brands: [], brand_refs: [{ domain: 'spark.example', brand_id: 'spark' }] },
      { ...portfolio, brands: [glow, { name: 'Invalid sibling' }] },
      { name: 'Legacy enrichment without a canonical entry' },
      [],
      null,
    ])
      assert.equal(selectBrandEntry(document, 'spark.example'), undefined);
  });

  it('strips ephemeral context from the output without changing the input', () => {
    const document = { ...spark, brand_context: { private_notes: 'not public' } };
    assert.deepEqual(selectBrandEntry(document, 'spark.example'), spark);
    assert.deepEqual(document.brand_context, { private_notes: 'not public' });
  });
});
