const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  CreativeFormatProjectionError,
  projectMediaBuyCreativesForDelivery,
  projectSyncCreativesForDelivery,
  resolveCreativeFormatWireMode,
} = require('../../dist/lib/index.js');
const { SingleAgentClient } = require('../../dist/lib/core/SingleAgentClient.js');
const { getSchemaValidatorByRef } = require('../../dist/lib/validation/schema-loader.js');

const SELLER = 'https://seller.example/mcp';

describe('creative format delivery projection', () => {
  test('resolves release precision and treats major-only v3 as legacy', () => {
    assert.equal(resolveCreativeFormatWireMode({ adcp: { supported_versions: ['3.1'] } }), 'canonical');
    assert.equal(resolveCreativeFormatWireMode({ adcp: { supported_versions: ['3.0'] } }), 'legacy');
    assert.equal(resolveCreativeFormatWireMode({ _raw: { adcp: { major_versions: [3] } } }), 'legacy');
    assert.equal(resolveCreativeFormatWireMode({ version: 'v3', majorVersions: [3] }), 'legacy');
    assert.equal(
      resolveCreativeFormatWireMode({ _synthetic: true, _raw: { adcp: { major_versions: [3] } } }),
      'unknown'
    );
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
        const projected = projectMediaBuyCreativesForDelivery(request, 'canonical', operation);
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
    const projected = projectMediaBuyCreativesForDelivery(request);
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
    const validate = getSchemaValidatorByRef('core/creative-asset.json', '3.0');

    assert.equal(validate(canonical), false);
    assert.equal(validate(projected), true);
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
    assert.deepEqual(projectMediaBuyCreativesForDelivery(request, 'canonical'), request);
    assert.throws(() => projectMediaBuyCreativesForDelivery(request, 'legacy'), CreativeFormatProjectionError);
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
          'canonical'
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
    client.executeAndHandle = async (_task, _handler, params) => {
      captured.push(params);
      return { success: true, status: 'completed', data: {} };
    };

    const creative = { creative_id: 'client-image', name: 'Image', format_kind: 'image', assets: {} };
    const selector = {
      package_id: 'pkg-1',
      format_ids: [{ agent_url: SELLER, id: 'display_300x250_image' }],
    };
    await client.createMediaBuy({ idempotency_key: 'create-1', packages: [{ ...selector, creatives: [creative] }] });
    await client.updateMediaBuy({
      idempotency_key: 'update-1',
      media_buy_id: 'mb-1',
      packages: [{ ...selector, creatives: [creative] }],
    });
    await client.syncCreatives(
      {
        idempotency_key: 'sync-1',
        creatives: [creative],
        assignments: [{ creative_id: creative.creative_id, package_id: selector.package_id }],
      },
      undefined,
      { creativeFormatProjection: { selectorContainers: [selector], wireMode: 'legacy' } }
    );

    assert.deepEqual(
      captured.map(request => (request.packages?.[0]?.creatives ?? request.creatives).map(item => item.format_id?.id)),
      [['display_300x250_image'], ['display_300x250_image'], ['display_300x250_image']]
    );
  });
});
