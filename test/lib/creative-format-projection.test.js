const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  CreativeFormatProjectionError,
  projectCreativeForDelivery,
  projectMediaBuyCreativesForDelivery,
  projectSyncCreativesForDelivery,
  resolveCreativeFormatWireMode,
  stripLegacyCreativeIdentity,
  CreativeFormatCapabilityError,
  packageRefsForFormatOptions,
} = require('../../dist/lib/v2/projection/index.js');
const { SingleAgentClient } = require('../../dist/lib/core/SingleAgentClient.js');
const {
  getSchemaValidatorByRef,
  registerExternalSchemaRoot,
  unregisterExternalSchemaRoot,
} = require('../../dist/lib/validation/schema-loader.js');

const SELLER = 'https://seller.example/mcp';

describe('creative format delivery projection', () => {
  test('recursively removes legacy identity keys and repeated values from diagnostics', () => {
    const legacyUrl = 'https://custom-formats.example/agent';
    const legacyId = 'custom_leaderboard_v7';
    const safe = stripLegacyCreativeIdentity({
      format_id: { agent_url: legacyUrl, id: legacyId },
      extension: {
        target_format_ids: [{ agent_url: legacyUrl, id: legacyId }],
        input_format_ids: [legacyId],
        output_format_ids: [legacyId],
        nested_format_id_hint: legacyId,
      },
      errors: [
        {
          message: `legacy format_id ${legacyId} came from ${legacyUrl}`,
          details: { offending_agent_url: legacyUrl },
        },
      ],
    });

    const json = JSON.stringify(safe);
    assert.doesNotMatch(json, /format_ids?|agent_url|v1_format_ref/);
    assert.doesNotMatch(json, /custom_leaderboard_v7|custom-formats\.example/);
    assert.match(safe.errors[0].message, /legacy creative identity/);
  });

  test('preserves non-creative agent URLs while failing closed on standalone format tuples and orphan diagnostics', () => {
    const buyerAgentUrl = 'https://legacy.example/formats';
    const safe = stripLegacyCreativeIdentity({
      buyer_agent_url: buyerAgentUrl,
      agent: { id: 'buyer-agent', name: 'Buyer agent', agent_url: buyerAgentUrl },
      request_property_list: { list_id: 'properties-1', agent_url: 'https://lists.example/mcp' },
      signal_id: { source: 'agent', id: 'sports-fans', agent_url: 'https://signals.example/mcp' },
      legacy_tuple: { agent_url: 'https://legacy.example/formats', id: 'orphan_custom_v9' },
      disguised_legacy_tuple: {
        agent_url: 'https://legacy.example/formats',
        id: 'orphan_custom_v10',
        list_id: 'not-a-list-context',
      },
      diagnostic: 'format_id orphan_custom_v9 from agent_url https://legacy.example/formats',
    });

    assert.equal(safe.buyer_agent_url, buyerAgentUrl);
    assert.equal(safe.agent.agent_url, buyerAgentUrl);
    assert.equal(safe.request_property_list.agent_url, 'https://lists.example/mcp');
    assert.deepEqual(safe.signal_id, {
      source: 'agent',
      id: 'sports-fans',
      agent_url: 'https://signals.example/mcp',
    });
    assert.deepEqual(safe.legacy_tuple, {});
    assert.deepEqual(safe.disguised_legacy_tuple, {});
    assert.doesNotMatch(safe.diagnostic, /orphan_custom_v9|legacy\.example/);
  });

  test('does not replace canonical values that happen to equal a legacy format ID', () => {
    const safe = stripLegacyCreativeIdentity({
      format_kind: 'image',
      format_id: { agent_url: 'https://legacy.example/formats', id: 'image' },
      message: 'image accepted',
    });

    assert.equal(safe.format_kind, 'image');
    assert.equal(safe.message, 'image accepted');
    assert.equal(safe.format_id, undefined);
  });

  test('sanitizes class-instance own fields and fails closed on neutral tuples and accessors', () => {
    class LegacyCarrier {
      constructor() {
        this.format_id = { agent_url: 'https://legacy.example/formats', id: 'custom_takeover_v9' };
        this.creative_agent_url = 'https://legacy.example/formats';
        this.message = 'format_id custom_takeover_v9 rejected by agent_url https://legacy.example/formats';
        Object.defineProperty(this, 'details', {
          enumerable: true,
          get: () => ({ format_id: this.format_id }),
        });
      }

      toJSON() {
        return { format_id: this.format_id };
      }
    }

    const source = { id: 'source-agent', name: 'Source agent', agent_url: 'https://legacy.example/formats' };
    const safe = stripLegacyCreativeIdentity({
      carrier: new LegacyCarrier(),
      extension: { vendor_ref: source },
      source_agent: source,
      diagnostic: 'Rejected source-agent from https://legacy.example/formats',
    });

    assert.equal(safe.carrier instanceof LegacyCarrier, false);
    assert.equal(Object.getPrototypeOf(safe.carrier), Object.prototype);
    assert.equal(Object.hasOwn(safe.carrier, 'format_id'), false);
    assert.equal(Object.hasOwn(safe.carrier, 'creative_agent_url'), false);
    assert.equal(Object.hasOwn(safe.carrier, 'details'), false);
    assert.doesNotMatch(safe.carrier.message, /custom_takeover_v9|legacy\.example/);
    assert.doesNotMatch(JSON.stringify(safe.carrier), /format_id|agent_url|custom_takeover_v9/);
    assert.deepEqual(safe.extension.vendor_ref, {});
    assert.deepEqual(safe.source_agent, source);
    assert.doesNotMatch(safe.diagnostic, /source-agent|legacy\.example/);

    const reversed = stripLegacyCreativeIdentity({
      source_agent: source,
      extension: { vendor_ref: source },
      diagnostic: 'Rejected source-agent from https://legacy.example/formats',
    });
    assert.deepEqual(reversed.source_agent, source);
    assert.deepEqual(reversed.extension.vendor_ref, {});
    assert.doesNotMatch(reversed.diagnostic, /source-agent|legacy\.example/);

    const plain = {
      safe: 'kept',
      format_id: { agent_url: 'https://legacy.example/formats', id: 'plain_legacy' },
      toJSON() {
        return { format_id: this.format_id };
      },
    };
    const safePlain = stripLegacyCreativeIdentity(plain);
    assert.equal(safePlain.safe, 'kept');
    assert.doesNotMatch(JSON.stringify(safePlain), /format_id|agent_url|plain_legacy/);

    let inheritedReads = 0;
    class InheritedCarrier {
      get format_id() {
        inheritedReads += 1;
        return { agent_url: 'https://legacy.example/formats', id: 'inherited_legacy' };
      }

      get details() {
        inheritedReads += 1;
        return { format_id: this.format_id };
      }
    }
    const safeInherited = stripLegacyCreativeIdentity(new InheritedCarrier());
    assert.equal(inheritedReads, 0);
    assert.equal(safeInherited instanceof InheritedCarrier, false);
    assert.equal(safeInherited.format_id, undefined);
    assert.equal(safeInherited.details, undefined);

    let arrayGetterReads = 0;
    class InheritedArray extends Array {
      get format_id() {
        arrayGetterReads += 1;
        return { agent_url: 'https://legacy.example/formats', id: 'array_legacy' };
      }
    }
    const safeArray = stripLegacyCreativeIdentity(new InheritedArray({ safe: true }));
    assert.equal(arrayGetterReads, 0);
    assert.equal(safeArray instanceof InheritedArray, false);
    assert.equal(Array.isArray(safeArray), true);
    assert.equal(safeArray.format_id, undefined);
  });

  test('fails closed on a root class-instance legacy tuple', () => {
    class LegacyTuple {
      constructor() {
        this.agent_url = 'https://legacy.example/formats';
        this.id = 'custom_takeover_v9';
      }

      toJSON() {
        return { format_id: { agent_url: this.agent_url, id: this.id } };
      }
    }

    const safe = stripLegacyCreativeIdentity(new LegacyTuple());
    assert.deepEqual(Object.keys(safe), []);
    assert.equal(JSON.stringify(safe), '{}');
  });

  test('uses explicit capability, treats 3.1 as unknown, and requires seller proof before the 3.2 guarantee', () => {
    assert.equal(resolveCreativeFormatWireMode({ features: { canonicalCreatives: true } }), 'canonical');
    assert.equal(resolveCreativeFormatWireMode({ features: { canonicalCreatives: false } }), 'legacy');
    assert.equal(
      resolveCreativeFormatWireMode({ media_buy: { features: { canonical_creatives: true } } }),
      'canonical'
    );
    assert.equal(resolveCreativeFormatWireMode({ adcp: { supported_versions: ['3.2'] } }), 'unknown');
    assert.equal(resolveCreativeFormatWireMode({}, '3.2'), 'unknown');
    assert.equal(resolveCreativeFormatWireMode({}, '3.1'), 'unknown');
    assert.equal(resolveCreativeFormatWireMode({}, '3.0'), 'legacy');
    assert.equal(
      resolveCreativeFormatWireMode({ supportedVersions: ['3.1'], features: { canonicalCreatives: false } }, '3.2'),
      'legacy'
    );
    assert.equal(
      resolveCreativeFormatWireMode({ supportedVersions: ['3.1'], features: { canonicalCreatives: true } }, '3.2'),
      'canonical'
    );
    assert.equal(resolveCreativeFormatWireMode({ supportedVersions: ['3.1'], features: {} }, '3.2'), 'unknown');
    assert.equal(resolveCreativeFormatWireMode({ version: 'v2', features: {} }, '3.2'), 'legacy');
    assert.equal(resolveCreativeFormatWireMode({ features: { canonicalCreatives: false } }, '3.2'), 'legacy');
    assert.throws(
      () =>
        resolveCreativeFormatWireMode({ supportedVersions: ['3.2'], features: { canonicalCreatives: false } }, '3.2'),
      CreativeFormatCapabilityError
    );
    assert.throws(
      () => resolveCreativeFormatWireMode({ supportedVersions: ['4.0'] }, '3.2'),
      err =>
        err instanceof CreativeFormatCapabilityError &&
        err.message.includes('No mutually supported AdCP release') &&
        err.message.includes('4.0')
    );
    assert.throws(
      () => resolveCreativeFormatWireMode({ supportedVersions: ['not-a-release'] }, '3.2'),
      err => err instanceof CreativeFormatCapabilityError && err.message.includes('none were valid release identifiers')
    );
    assert.throws(
      () =>
        resolveCreativeFormatWireMode({
          features: { canonicalCreatives: true },
          _raw: { media_buy: { features: { canonical_creatives: false } } },
        }),
      CreativeFormatCapabilityError
    );
    assert.equal(resolveCreativeFormatWireMode({ _raw: { adcp: { major_versions: [3] } } }), 'unknown');
    assert.equal(resolveCreativeFormatWireMode({ version: 'v3', majorVersions: [3] }), 'unknown');
    assert.equal(
      resolveCreativeFormatWireMode({ _synthetic: true, _raw: { adcp: { major_versions: [3] } } }),
      'unknown'
    );
  });

  test('does not negotiate from advisory seller build metadata', () => {
    const client = new SingleAgentClient(
      { id: 'future-build', name: 'Future build', agent_uri: SELLER, protocol: 'mcp' },
      { adcpVersion: '3.1' }
    );
    client.cachedToolSchemas = new Map([
      ['sync_creatives', { creatives: { items: { properties: { creative_id: {}, format_id: {} } } } }],
    ]);

    assert.equal(
      client.resolveCreativeFormatWireMode('sync_creatives', { buildVersion: '4.0.0', features: {} }),
      'legacy'
    );
    assert.throws(
      () =>
        client.resolveCreativeFormatWireMode('sync_creatives', {
          buildVersion: '4.0.0',
          features: { canonicalCreatives: true },
        }),
      CreativeFormatCapabilityError
    );

    client.cachedToolSchemas = new Map([
      ['sync_creatives', { creatives: { items: { properties: { creative_id: {}, format_kind: {} } } } }],
    ]);
    assert.throws(
      () =>
        client.resolveCreativeFormatWireMode('sync_creatives', {
          buildVersion: '4.0.0',
          features: { canonicalCreatives: false },
        }),
      CreativeFormatCapabilityError
    );
  });

  test('3.2 client fails closed when supported_versions and tool-schema evidence are both absent', () => {
    const client = new SingleAgentClient(
      { id: 'missing-release-proof', name: 'Missing release proof', agent_uri: SELLER, protocol: 'mcp' },
      { wireAdcpVersion: '3.2' }
    );
    client.cachedToolSchemas = new Map();

    assert.throws(
      () => client.resolveCreativeFormatWireMode('sync_creatives', { features: {} }),
      err =>
        err instanceof CreativeFormatCapabilityError &&
        err.message.includes('Cannot prove which AdCP release the seller serves')
    );
  });

  test('canonicalizes legacy-only package selectors through the registry', () => {
    const projected = projectMediaBuyCreativesForDelivery(
      {
        packages: [
          {
            product_id: 'legacy-product',
            format_ids: [{ agent_url: 'https://creative.adcontextprotocol.org/', id: 'display_300x250_image' }],
          },
        ],
      },
      'canonical'
    );

    assert.strictEqual(projected.packages[0].format_ids, undefined);
    assert.deepStrictEqual(projected.packages[0].format_option_refs, [
      { scope: 'product', format_option_id: 'migrated_1_image' },
    ]);
  });

  test('canonicalizes custom legacy-only package selectors through the converter', () => {
    const projected = projectMediaBuyCreativesForDelivery(
      {
        packages: [
          {
            product_id: 'custom-product',
            format_ids: [{ agent_url: 'https://seller.example/custom', id: 'homepage_takeover' }],
          },
        ],
      },
      'canonical',
      'create_media_buy',
      () => ({
        format_option_id: 'homepage-takeover',
        format_kind: 'custom',
        format_shape: 'multi_placement_takeover',
        format_schema: {
          uri: 'https://seller.example/formats/homepage_takeover.json',
          digest: `sha256:${'a'.repeat(64)}`,
        },
        params: {},
      })
    );

    assert.strictEqual(projected.packages[0].format_ids, undefined);
    assert.deepStrictEqual(projected.packages[0].format_option_refs, [
      { scope: 'product', format_option_id: 'homepage-takeover' },
    ]);
  });

  test('fails closed when a package-only format_kind has no legacy representation', () => {
    assert.throws(
      () =>
        projectMediaBuyCreativesForDelivery(
          {
            packages: [{ product_id: 'canonical-only', format_kind: 'image' }],
          },
          'legacy'
        ),
      err =>
        err instanceof CreativeFormatProjectionError &&
        err.message.includes('format_kind has no unambiguous legacy representation')
    );
  });

  test('resolves persisted canonical custom package and creative identities for a legacy wire', () => {
    const sources = [];
    const projected = projectMediaBuyCreativesForDelivery(
      {
        packages: [
          {
            product_id: 'persisted-custom',
            format_kind: 'custom',
            creatives: [
              {
                creative_id: 'persisted-custom-creative',
                format_kind: 'custom',
                assets: {},
              },
            ],
          },
        ],
      },
      'legacy',
      'create_media_buy',
      undefined,
      context => {
        sources.push(context.source);
        return { agent_url: 'https://seller.example/formats', id: 'homepage_takeover' };
      }
    );

    assert.deepStrictEqual(projected.packages[0].format_ids, [
      { agent_url: 'https://seller.example/formats', id: 'homepage_takeover' },
    ]);
    assert.deepStrictEqual(projected.packages[0].creatives[0].format_id, {
      agent_url: 'https://seller.example/formats',
      id: 'homepage_takeover',
    });
    assert.deepStrictEqual(new Set(sources), new Set(['creative', 'selector']));
  });

  const formats = [
    ['image', { agent_url: SELLER, id: 'display_300x250_image', width: 300, height: 250 }],
    ['html5', { agent_url: SELLER, id: 'display_728x90_html', width: 728, height: 90 }],
    ['display_tag', { agent_url: SELLER, id: 'display_300x600_js', width: 300, height: 600 }],
    ['video_hosted', { agent_url: SELLER, id: 'video_standard_30s', duration_ms: 30000 }],
    ['video_vast', { agent_url: SELLER, id: 'video_vast_15s', duration_ms: 15000 }],
    ['audio_hosted', { agent_url: SELLER, id: 'audio_standard_30s', duration_ms: 30000 }],
  ];

  for (const [kind, formatId] of formats) {
    test(`projects canonical ${kind} for inline create and update`, () => {
      for (const [key, operation] of [
        ['packages', 'create_media_buy'],
        ['new_packages', 'update_media_buy'],
      ]) {
        const request = {
          [key]: [
            {
              format_kind: kind,
              format_ids: [formatId],
              creatives: [{ creative_id: `creative-${kind}`, name: kind, format_kind: kind, assets: {} }],
            },
          ],
        };
        const projected = projectMediaBuyCreativesForDelivery(request, 'legacy', operation);
        assert.deepEqual(projected[key][0].creatives[0], {
          creative_id: `creative-${kind}`,
          name: kind,
          format_id: formatId,
          assets: {},
        });
        assert.equal(request[key][0].creatives[0].format_kind, kind, 'input remains canonical');
      }
    });
  }

  test('uses v1_format_ref arrays published on canonical format options', () => {
    const request = {
      packages: [
        {
          format_options: [
            {
              format_kind: 'image',
              params: { width: 320, height: 50 },
              v1_format_ref: [{ agent_url: SELLER, id: 'display_320x50_image', width: 320, height: 50 }],
            },
          ],
          creatives: [{ creative_id: 'mobile-image', name: 'Mobile', format_kind: 'image', assets: {} }],
        },
      ],
    };
    const projected = projectMediaBuyCreativesForDelivery(request, 'legacy');
    assert.equal(projected.packages[0].creatives[0].format_id.id, 'display_320x50_image');
  });

  test('projects the Optimera-style display_image selector that motivated the migration', () => {
    const projected = projectMediaBuyCreativesForDelivery(
      {
        packages: [
          {
            format_ids: [{ agent_url: 'https://adcontextprotocol.org', id: 'display_image' }],
            creatives: [{ creative_id: 'optimera-image', name: 'Image', format_kind: 'image', assets: {} }],
          },
        ],
      },
      'legacy'
    );
    assert.deepEqual(projected.packages[0].creatives[0].format_id, {
      agent_url: 'https://adcontextprotocol.org',
      id: 'display_image',
    });
  });

  test('produces a creative accepted by the bundled AdCP 3.0 schema', () => {
    const canonical = { creative_id: 'schema-image', name: 'Image', format_kind: 'image', assets: {} };
    const projected = projectMediaBuyCreativesForDelivery(
      {
        packages: [
          {
            format_ids: [{ agent_url: SELLER, id: 'display_300x250_image' }],
            creatives: [canonical],
          },
        ],
      },
      'legacy'
    ).packages[0].creatives[0];
    registerExternalSchemaRoot('3.0.12', path.resolve('schemas/cache/3.0.12'));
    try {
      const validate = getSchemaValidatorByRef('core/creative-asset.json', '3.0.12');
      assert.equal(typeof validate, 'function');
      assert.equal(validate(canonical), false);
      assert.equal(validate(projected), true);
    } finally {
      unregisterExternalSchemaRoot('3.0.12');
    }
  });

  test('keeps canonical for a canonical-only product and fails when legacy is required', () => {
    const request = {
      packages: [
        {
          format_options: [{ format_kind: 'image', params: {} }],
          creatives: [{ creative_id: 'canonical-only', name: 'Image', format_kind: 'image', assets: {} }],
        },
      ],
    };
    assert.deepEqual(projectMediaBuyCreativesForDelivery(request, 'canonical'), request);
    assert.throws(() => projectMediaBuyCreativesForDelivery(request, 'legacy'), CreativeFormatProjectionError);
  });

  test('does not guess that an unmapped custom seller ID matches a canonical kind', () => {
    const request = {
      packages: [
        {
          format_ids: [{ agent_url: SELLER, id: 'seller_custom_slot' }],
          creatives: [{ creative_id: 'custom-unknown', name: 'Image', format_kind: 'image', assets: {} }],
        },
      ],
    };
    assert.throws(() => projectMediaBuyCreativesForDelivery(request, 'canonical'), CreativeFormatProjectionError);
    assert.throws(() => projectMediaBuyCreativesForDelivery(request, 'legacy'), CreativeFormatProjectionError);
  });

  test('normalizes a known legacy creative before canonical delivery', () => {
    const projected = projectCreativeForDelivery(
      {
        creative_id: 'legacy-image',
        name: 'Legacy image',
        format_id: {
          agent_url: 'https://creative.adcontextprotocol.org/',
          id: 'display_300x250_image',
        },
        assets: {},
      },
      {},
      'canonical'
    );
    assert.equal(projected.format_kind, 'image');
    assert.equal(projected.format_id, undefined);
  });

  test('custom legacy converter provides the explicit format_kind custom escape hatch', () => {
    const projected = projectCreativeForDelivery(
      {
        creative_id: 'custom-takeover',
        name: 'Custom takeover',
        format_id: { agent_url: SELLER, id: 'homepage_takeover' },
        assets: {},
      },
      {},
      'canonical',
      'sync_creatives',
      ({ formatId }) => ({
        format_kind: 'custom',
        format_option_id: 'homepage-takeover',
        format_shape: 'multi_placement_takeover',
        format_schema: {
          uri: `https://seller.example/formats/${formatId.id}.json`,
          digest: `sha256:${'a'.repeat(64)}`,
        },
        params: {},
      })
    );
    assert.equal(projected.format_kind, 'custom');
    assert.equal(projected.format_id, undefined);
    assert.deepEqual(projected.format_option_ref, {
      scope: 'product',
      format_option_id: 'homepage-takeover',
    });
  });

  test('unmapped legacy creatives fail closed without a converter', () => {
    assert.throws(
      () =>
        projectCreativeForDelivery(
          {
            creative_id: 'unknown-legacy',
            name: 'Unknown legacy',
            format_id: { agent_url: SELLER, id: 'homepage_takeover' },
            assets: {},
          },
          {},
          'canonical'
        ),
      CreativeFormatProjectionError
    );
  });

  test('invalid explicit custom conversion fails closed', () => {
    assert.throws(
      () =>
        projectCreativeForDelivery(
          {
            creative_id: 'bad-custom',
            name: 'Bad custom',
            format_id: { agent_url: SELLER, id: 'homepage_takeover' },
            assets: {},
          },
          {},
          'canonical',
          'sync_creatives',
          () => ({ format_kind: 'custom', params: {} })
        ),
      CreativeFormatProjectionError
    );
  });

  test('converter output is validated against the canonical declaration schema', () => {
    for (const converter of [
      () => ({ format_kind: 'bogus', params: {} }),
      () => ({
        format_kind: 'custom',
        format_option_id: 'bad-schema',
        format_shape: 'takeover',
        format_schema: { uri: 'http://seller.example/schema.json', digest: 'sha256:not-a-digest' },
        params: {},
      }),
    ]) {
      assert.throws(
        () =>
          projectCreativeForDelivery(
            {
              creative_id: 'invalid-converter',
              name: 'Invalid converter',
              format_id: { agent_url: SELLER, id: 'custom_format' },
              assets: {},
            },
            {},
            'canonical',
            'sync_creatives',
            converter
          ),
        CreativeFormatProjectionError
      );
    }
  });

  test('converter output recursively rejects legacy creative identity', () => {
    for (const params of [
      { extension: { agent_url: 'https://legacy.example/' } },
      { nested: [{ format_id: { agent_url: 'https://legacy.example/', id: 'legacy' } }] },
      { migration: { format_ids_pending: ['legacy'] } },
      { migration: { target_format_ids: ['legacy'] } },
      { migration: { input_format_ids: ['legacy'] } },
      { migration: { output_format_ids: ['legacy'] } },
    ]) {
      assert.throws(
        () =>
          projectCreativeForDelivery(
            {
              creative_id: 'nested-legacy-converter',
              name: 'Nested legacy converter',
              format_id: { agent_url: SELLER, id: 'custom_format' },
              assets: {},
            },
            {},
            'canonical',
            'sync_creatives',
            () => ({
              format_kind: 'custom',
              format_option_id: 'nested-legacy',
              format_shape: 'takeover',
              format_schema: {
                uri: 'https://seller.example/formats/takeover.json',
                digest: `sha256:${'a'.repeat(64)}`,
              },
              params,
            })
          ),
        CreativeFormatProjectionError
      );
    }
  });

  test('format_option_ref preserves identity across same-kind legacy options', () => {
    const selector = {
      format_options: [
        {
          format_option_id: 'mobile',
          format_kind: 'image',
          params: { width: 320, height: 50 },
          v1_format_ref: [{ agent_url: SELLER, id: 'display_320x50_image', width: 320, height: 50 }],
        },
        {
          format_option_id: 'desktop',
          format_kind: 'image',
          params: { width: 728, height: 90 },
          v1_format_ref: [{ agent_url: SELLER, id: 'display_728x90_image', width: 728, height: 90 }],
        },
      ],
    };
    const legacy = projectCreativeForDelivery(
      {
        creative_id: 'same-kind',
        name: 'Same kind',
        format_kind: 'image',
        format_option_ref: { scope: 'product', format_option_id: 'mobile' },
        assets: {},
      },
      selector,
      'legacy'
    );
    assert.equal(legacy.format_id.id, 'display_320x50_image');

    const canonical = projectCreativeForDelivery(legacy, selector, 'canonical');
    assert.equal(canonical.format_kind, 'image');
    assert.deepEqual(canonical.format_option_ref, { scope: 'product', format_option_id: 'mobile' });
  });

  test('canonical creative option refs must agree with the package selection', () => {
    assert.throws(
      () =>
        projectMediaBuyCreativesForDelivery(
          {
            packages: [
              {
                format_option_refs: [{ scope: 'product', format_option_id: 'native_feed' }],
                creatives: [
                  {
                    creative_id: 'canonical-conflict',
                    name: 'Canonical conflict',
                    format_kind: 'native_in_feed',
                    format_option_ref: { scope: 'product', format_option_id: 'native_story' },
                    assets: {},
                  },
                ],
              },
            ],
          },
          'canonical'
        ),
      err =>
        err instanceof CreativeFormatProjectionError &&
        err.message.includes('format_option_ref conflicts with the package selected format_option_refs')
    );
  });

  test('legacy matching never crosses agent ownership or dimensions', () => {
    assert.throws(
      () =>
        projectCreativeForDelivery(
          {
            creative_id: 'wrong-owner',
            name: 'Wrong owner',
            format_id: {
              agent_url: 'https://creative.adcontextprotocol.org/',
              id: 'display_300x250_image',
              width: 300,
              height: 250,
            },
            assets: {},
          },
          {
            format_ids: [
              {
                agent_url: 'https://agent-b.example',
                id: 'display_300x250_image',
                width: 728,
                height: 90,
              },
            ],
          },
          'legacy'
        ),
      CreativeFormatProjectionError
    );
  });

  test('legacy identity preserves case-sensitive agent paths and format IDs', () => {
    assert.throws(
      () =>
        projectCreativeForDelivery(
          {
            creative_id: 'case-sensitive',
            name: 'Case-sensitive',
            format_id: { agent_url: 'https://seller.example/TenantA', id: 'HeroSlot' },
            assets: {},
          },
          {
            format_options: [
              {
                format_option_id: 'other-tenant',
                format_kind: 'image',
                params: {},
                v1_format_ref: [{ agent_url: 'https://seller.example/tenanta', id: 'heroslot' }],
              },
            ],
          },
          'canonical'
        ),
      CreativeFormatProjectionError
    );
  });

  test('rejects dual canonical and legacy creative identities', () => {
    assert.throws(
      () =>
        projectCreativeForDelivery(
          {
            creative_id: 'dual-identity',
            name: 'Dual',
            format_kind: 'video_hosted',
            format_id: { agent_url: SELLER, id: 'display_300x250_image' },
            assets: {},
          },
          {},
          'canonical'
        ),
      CreativeFormatProjectionError
    );
  });

  test('fails closed on ambiguous seller refs', () => {
    assert.throws(
      () =>
        projectMediaBuyCreativesForDelivery(
          {
            packages: [
              {
                format_ids: [
                  { agent_url: SELLER, id: 'display_300x250_image' },
                  { agent_url: SELLER, id: 'display_728x90_image' },
                ],
                creatives: [{ creative_id: 'ambiguous', name: 'Image', format_kind: 'image', assets: {} }],
              },
            ],
          },
          'legacy'
        ),
      CreativeFormatProjectionError
    );
  });

  test('scopes sync_creatives projection through assignments', () => {
    const projected = projectSyncCreativesForDelivery(
      {
        creatives: [{ creative_id: 'creative-image', name: 'Image', format_kind: 'image', assets: {} }],
        assignments: [{ creative_id: 'creative-image', package_id: 'mobile' }],
      },
      [
        { package_id: 'desktop', format_ids: [{ agent_url: SELLER, id: 'display_728x90_image' }] },
        { package_id: 'mobile', format_ids: [{ agent_url: SELLER, id: 'display_320x50_image' }] },
      ],
      'legacy'
    );
    assert.equal(projected.creatives[0].format_id.id, 'display_320x50_image');
    assert.equal(projected.creatives[0].format_kind, undefined);
  });

  test('SingleAgentClient applies projection to create, update, and configured sync calls', async () => {
    const client = new SingleAgentClient({
      id: 'legacy-seller',
      name: 'Legacy seller',
      agent_uri: SELLER,
      protocol: 'mcp',
    });
    const captured = [];
    client.getCapabilities = async () => ({ features: { canonicalCreatives: false } });
    client.executeAndHandle = async (_task, _handler, params) => {
      captured.push(params);
      return { success: true, status: 'completed', data: {} };
    };

    const creative = { creative_id: 'client-image', name: 'Image', format_kind: 'image', assets: {} };
    const selectedFormats = packageRefsForFormatOptions(
      {
        format_options: [
          {
            format_option_id: 'image-mrec',
            format_kind: 'image',
            params: {},
            v1_format_ref: [{ agent_url: SELLER, id: 'display_300x250_image' }],
          },
        ],
      },
      ['image-mrec']
    );
    const selector = {
      package_id: 'pkg-1',
      ...selectedFormats,
    };
    await client.createMediaBuy({
      account: { account_id: 'test-account' },
      brand: { domain: 'brand.example' },
      start_time: 'asap',
      end_time: '2027-12-31T00:00:00Z',
      idempotency_key: 'create-projection-1',
      packages: [
        {
          ...selector,
          product_id: 'product-1',
          budget: 1000,
          pricing_option_id: 'pricing-1',
          creatives: [creative],
        },
      ],
    });
    await client.updateMediaBuy({
      idempotency_key: 'update-projection-1',
      media_buy_id: 'mb-1',
      packages: [{ ...selector, creatives: [creative] }],
    });
    await client.syncCreatives(
      {
        account: { account_id: 'test-account' },
        idempotency_key: 'sync-projection-1',
        creatives: [creative],
        assignments: [{ creative_id: creative.creative_id, package_id: selector.package_id }],
      },
      undefined,
      { creativeFormatProjection: { selectorContainers: [selector] } }
    );

    assert.deepEqual(
      captured.map(request => (request.packages?.[0]?.creatives ?? request.creatives).map(item => item.format_id?.id)),
      [['display_300x250_image'], ['display_300x250_image'], ['display_300x250_image']]
    );
  });

  test('SingleAgentClient downgrades persisted canonical custom formats through the explicit resolver', async () => {
    const client = new SingleAgentClient({
      id: 'legacy-custom-seller',
      name: 'Legacy custom seller',
      agent_uri: SELLER,
      protocol: 'mcp',
    });
    client.getCapabilities = async () => ({ features: { canonicalCreatives: false } });
    let captured;
    client.executeAndHandle = async (_task, _handler, params) => {
      captured = params;
      return { success: true, status: 'completed', data: {} };
    };

    await client.createMediaBuy(
      {
        account: { account_id: 'test-account' },
        brand: { domain: 'brand.example' },
        start_time: 'asap',
        end_time: '2027-12-31T00:00:00Z',
        idempotency_key: 'custom-resolver-client',
        packages: [
          {
            product_id: 'persisted-custom-product',
            pricing_option_id: 'pricing-1',
            budget: 1000,
            format_kind: 'custom',
            creatives: [
              {
                creative_id: 'persisted-custom-creative',
                name: 'Persisted custom creative',
                format_kind: 'custom',
                assets: {},
              },
            ],
          },
        ],
      },
      undefined,
      {
        canonicalFormatLegacyResolver: context =>
          context.source === 'selector' || context.source === 'creative'
            ? { agent_url: 'https://seller.example/custom-formats', id: 'homepage_takeover' }
            : undefined,
      }
    );

    assert.deepStrictEqual(captured.packages[0].format_ids, [
      { agent_url: 'https://seller.example/custom-formats', id: 'homepage_takeover' },
    ]);
    assert.deepStrictEqual(captured.packages[0].creatives[0].format_id, {
      agent_url: 'https://seller.example/custom-formats',
      id: 'homepage_takeover',
    });
    assert.strictEqual(captured.packages[0].format_kind, undefined);
    assert.strictEqual(captured.packages[0].creatives[0].format_kind, undefined);
  });

  test('SingleAgentClient legacy escape hatch upgrades package selectors for a canonical seller', async () => {
    const client = new SingleAgentClient({
      id: 'canonical-seller',
      name: 'Canonical seller',
      agent_uri: SELLER,
      protocol: 'mcp',
    });
    client.getCapabilities = async () => ({ features: { canonicalCreatives: true } });
    let captured;
    client.executeAndHandle = async (_task, _handler, params) => {
      captured = params;
      return { success: true, status: 'completed', data: {} };
    };

    await client.createMediaBuyLegacy(
      {
        account: { account_id: 'test-account' },
        brand: { domain: 'brand.example' },
        start_time: 'asap',
        end_time: '2027-12-31T00:00:00Z',
        packages: [
          {
            product_id: 'known-product',
            pricing_option_id: 'pricing-1',
            budget: 1000,
            format_ids: [{ agent_url: 'https://creative.adcontextprotocol.org/', id: 'display_300x250_image' }],
          },
          {
            product_id: 'custom-product',
            pricing_option_id: 'pricing-1',
            budget: 1000,
            format_ids: [{ agent_url: 'https://seller.example/custom', id: 'homepage_takeover' }],
          },
        ],
      },
      undefined,
      {
        legacyFormatConverter: ({ formatId }) =>
          formatId.id === 'homepage_takeover'
            ? {
                format_option_id: 'homepage-takeover',
                format_kind: 'custom',
                format_shape: 'multi_placement_takeover',
                format_schema: {
                  uri: 'https://seller.example/formats/homepage_takeover.json',
                  digest: `sha256:${'a'.repeat(64)}`,
                },
                params: {},
              }
            : undefined,
      }
    );

    assert.deepStrictEqual(
      captured.packages.map(pkg => pkg.format_option_refs[0].format_option_id),
      ['migrated_1_image', 'homepage-takeover']
    );
    assert.ok(captured.packages.every(pkg => pkg.format_ids === undefined));
  });

  test('SingleAgentClient detects canonical creative support from the advertised tool schema', async () => {
    const client = new SingleAgentClient({
      id: 'canonical-3.1-seller',
      name: 'Canonical 3.1 seller',
      agent_uri: SELLER,
      protocol: 'mcp',
    });
    client.getCapabilities = async () => ({ supportedVersions: ['3.1'], features: {} });
    client.cachedToolSchemas = new Map([
      [
        'sync_creatives',
        {
          creatives: {
            items: {
              properties: {
                creative_id: { type: 'string' },
                format_kind: { type: 'string' },
              },
            },
          },
        },
      ],
    ]);
    let captured;
    client.executeAndHandle = async (_task, _handler, params) => {
      captured = params;
      return { success: true, status: 'completed', data: {} };
    };

    await client.syncCreatives({
      account: { account_id: 'test-account' },
      idempotency_key: 'canonical-schema-detection',
      creatives: [{ creative_id: 'canonical', name: 'Canonical', format_kind: 'image', assets: {} }],
    });

    assert.equal(captured.creatives[0].format_kind, 'image');
    assert.equal(captured.creatives[0].format_id, undefined);
  });

  test('SingleAgentClient keeps schema detection scoped to the current operation', async () => {
    const client = new SingleAgentClient({
      id: 'mixed-3.1-seller',
      name: 'Mixed 3.1 seller',
      agent_uri: SELLER,
      protocol: 'mcp',
    });
    client.getCapabilities = async () => ({ features: {} });
    client.cachedToolSchemas = new Map([
      ['sync_creatives', { creatives: { items: { properties: { creative_id: {}, format_kind: {} } } } }],
      ['create_media_buy', { packages: { items: { properties: { creative_id: {}, format_id: {} } } } }],
    ]);
    let captured;
    client.executeAndHandle = async (_task, _handler, params) => {
      captured = params;
      return { success: true, status: 'completed', data: {} };
    };

    await client.createMediaBuy({
      account: { account_id: 'test-account' },
      brand: { domain: 'brand.example' },
      start_time: 'asap',
      end_time: '2027-12-31T00:00:00Z',
      idempotency_key: 'mixed-operation-1',
      packages: [
        {
          product_id: 'product-1',
          budget: 1000,
          pricing_option_id: 'pricing-1',
          format_ids: [{ agent_url: SELLER, id: 'display_300x250_image' }],
          creatives: [{ creative_id: 'mixed', name: 'Mixed', format_kind: 'image', assets: {} }],
        },
      ],
    });
    assert.equal(captured.packages[0].creatives[0].format_id.id, 'display_300x250_image');
    assert.equal(captured.packages[0].creatives[0].format_kind, undefined);
  });
});
