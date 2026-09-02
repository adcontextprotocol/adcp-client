const { describe, it } = require('node:test');
const assert = require('node:assert');

const { getToolInputSchema, getToolResponseSchema } = require('../../dist/lib/schemas/index.js');

describe('version-aware tool JSON Schemas (#2678)', () => {
  it('selects distinct 3.0, 3.1, and 3.2 request schemas and reports the resolved release', () => {
    const v30 = getToolInputSchema('create_media_buy', { adcpVersion: '3.0' });
    const v31 = getToolInputSchema('create_media_buy', { adcpVersion: '3.1' });
    const v32 = getToolInputSchema('create_media_buy', { adcpVersion: '3.2.0-beta.11' });

    assert.strictEqual(v30.bundleKey, '3.0');
    assert.strictEqual(v30.resolvedVersion, '3.0.25');
    assert.ok(v30.schema.properties.adcp_major_version);
    assert.strictEqual(v30.schema.properties.paused, undefined);

    assert.strictEqual(v31.bundleKey, '3.1');
    assert.strictEqual(v31.resolvedVersion, '3.1.18');
    assert.strictEqual(v31.schema.properties.adcp_major_version, undefined);
    assert.ok(v31.schema.properties.paused);

    assert.strictEqual(v32.bundleKey, '3.2.0-beta.11');
    assert.strictEqual(v32.resolvedVersion, '3.2.0-beta.11');
    assert.strictEqual(v32.schema.deprecated, true);
    assert.deepStrictEqual(v32.schema['x-superseded-by'], ['buy_products', 'accept_proposal']);
  });

  it('returns protocol-authored response documents and independent caller-owned objects', () => {
    const first = getToolResponseSchema('create_media_buy', { adcpVersion: '3.0' });
    first.schema.title = 'caller mutation';
    const second = getToolResponseSchema('create_media_buy', { adcpVersion: '3.0' });

    assert.strictEqual(second.direction, 'sync');
    assert.notStrictEqual(second.schema.title, 'caller mutation');

    const submitted = getToolResponseSchema('get_products', { adcpVersion: '3.1', variant: 'submitted' });
    assert.strictEqual(submitted.direction, 'submitted');
    assert.strictEqual(submitted.resolvedVersion, '3.1.18');
  });

  it('fails clearly for unavailable bundles, tools, and response variants', () => {
    assert.throws(
      () => getToolInputSchema('create_media_buy', { adcpVersion: '99.0' }),
      /schema data for version|schema bundle/i
    );
    assert.strictEqual(getToolInputSchema('not_a_tool', { adcpVersion: '3.1' }), undefined);
    assert.strictEqual(
      getToolResponseSchema('get_adcp_capabilities', { adcpVersion: '3.1', variant: 'submitted' }),
      undefined
    );
    assert.throws(
      () => getToolInputSchema('create_media_buy', { adcpVersion: '3.2-beta' }),
      /moving prerelease-family alias/i
    );
  });
});
