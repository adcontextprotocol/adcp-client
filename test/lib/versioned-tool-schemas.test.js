const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  getCanonicalToolValidator,
  getSchemaDocumentByRef,
  getToolInputSchema,
  getToolResponseSchema,
} = require('../../dist/lib/schemas/index.js');

describe('version-aware tool JSON Schemas (#2678)', () => {
  it('selects distinct 3.0, 3.1, and 3.2 request schemas and reports the resolved release', () => {
    const v30 = getToolInputSchema('create_media_buy', { adcpVersion: '3.0' });
    const v31 = getToolInputSchema('create_media_buy', { adcpVersion: '3.1' });
    const v32 = getToolInputSchema('create_media_buy', { adcpVersion: '3.2.0-rc.6' });

    assert.strictEqual(v30.bundleKey, '3.0');
    assert.strictEqual(v30.resolvedVersion, '3.0.25');
    assert.ok(v30.schema.properties.adcp_major_version);
    assert.strictEqual(v30.schema.properties.paused, undefined);

    assert.strictEqual(v31.bundleKey, '3.1');
    assert.strictEqual(v31.resolvedVersion, '3.1.18');
    assert.strictEqual(v31.schema.properties.adcp_major_version, undefined);
    assert.ok(v31.schema.properties.paused);

    assert.strictEqual(v32.bundleKey, '3.2.0-rc.6');
    assert.strictEqual(v32.resolvedVersion, '3.2.0-rc.6');
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
      () => getToolInputSchema('create_media_buy', { adcpVersion: '3.2-rc' }),
      /moving prerelease-family alias/i
    );
  });

  it('compiles the complete canonical response graph with all-error diagnostics', () => {
    const validate = getCanonicalToolValidator('get_reporting_status', 'sync', {
      adcpVersion: '3.2.0-rc.6',
    });
    assert.ok(validate);

    const valid = {
      status: 'failed',
      view: 'summary',
      failure_kind: 'lookup_unavailable',
      message: 'Reporting status resource is unavailable.',
      errors: [{ code: 'NOT_FOUND', message: 'Reporting status resource is unavailable.' }],
    };
    assert.strictEqual(validate(valid), true, JSON.stringify(validate.errors));

    assert.strictEqual(validate({ status: 'completed', view: 'summary' }), false);
    const missingProperties = new Set(
      (validate.errors ?? []).filter(error => error.keyword === 'required').map(error => error.params.missingProperty)
    );
    assert.ok(missingProperties.has('ledger_snapshot_id'));
    assert.ok(missingProperties.has('ledger_as_of'));
    assert.ok(missingProperties.has('account_id'));
  });

  it('does not apply live-wire response-root relaxation to canonical validators', () => {
    const canonical = getCanonicalToolValidator('control_media_buy', 'sync', {
      adcpVersion: '3.2.0-rc.6',
    });
    const { getValidator } = require('../../dist/lib/validation/schema-loader.js');
    const runtime = getValidator('control_media_buy', 'sync', '3.2.0-rc.6');
    const envelopeExtended = {
      status: 'completed',
      media_buy_id: 'media-buy-1',
      revision: 1,
      replayed: true,
      future_envelope_field: true,
    };

    assert.strictEqual(runtime(envelopeExtended), true, JSON.stringify(runtime.errors));
    assert.strictEqual(canonical(envelopeExtended), false);
    assert.ok(canonical.errors.some(error => error.keyword === 'additionalProperties'));
  });

  it('validates mirrored async response roots across archived releases', () => {
    for (const adcpVersion of ['3.1', '3.2.0-rc.6']) {
      for (const variant of ['submitted', 'working', 'input-required']) {
        const validate = getCanonicalToolValidator('get_products', variant, { adcpVersion });
        assert.ok(validate, `${adcpVersion} ${variant}`);
      }
    }
  });

  it('returns undefined for an unknown canonical tool and exposes immutable authored documents', () => {
    assert.strictEqual(getCanonicalToolValidator('not_a_tool', 'sync', { adcpVersion: '3.2.0-rc.6' }), undefined);

    const root = getToolResponseSchema('get_reporting_status', { adcpVersion: '3.2.0-rc.6' });
    const document = getSchemaDocumentByRef('media-buy/get-reporting-status-response.json', '3.2.0-rc.6');
    assert.match(root.schema.$id, /\/media-buy\/get-reporting-status-response\.json$/);
    assert.match(document.schema.$id, /\/media-buy\/get-reporting-status-response\.json$/);
    assert.strictEqual(document.schema._bundled, undefined);
    assert.strictEqual(Object.isFrozen(document.schema), true);
  });

  it('exposes the canonical validator from the ESM schema entry point', async () => {
    const esm = await import('../../dist/lib/schemas/index.mjs');
    const validate = esm.getCanonicalToolValidator('get_reporting_status', 'sync', {
      adcpVersion: '3.2.0-rc.6',
    });
    assert.ok(validate);
    assert.strictEqual(
      validate({
        status: 'failed',
        view: 'summary',
        failure_kind: 'lookup_unavailable',
        errors: [{ code: 'NOT_FOUND', message: 'Reporting status resource is unavailable.' }],
      }),
      true,
      JSON.stringify(validate.errors)
    );
  });
});
