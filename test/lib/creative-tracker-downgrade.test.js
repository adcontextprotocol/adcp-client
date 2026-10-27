const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  CreativeFormatProjectionError,
  getCreativeDeliveryDiagnostics,
  projectCreativeForDelivery,
  projectSyncCreativesForDelivery,
} = require('../../dist/lib/v2/projection/index.js');
const { convertRequest, getVersionAdapter } = require('../../dist/lib/adapters/version/index.js');
const { getSchemaValidatorByRef } = require('../../dist/lib/validation/schema-loader.js');

const formatId = { agent_url: 'https://creative.adcontextprotocol.org', id: 'display_300x250_image' };
const tracker = (event = 'impression', method = 'img') => ({
  asset_type: 'pixel_tracker',
  event,
  method,
  url: 'https://track.example/event',
  ...(event === 'custom' && { custom_event_name: 'engaged' }),
});
const creative = assets => ({
  creative_id: 'tracked-image',
  name: 'Tracked image',
  format_kind: 'image',
  format_parameters: { width: 300, height: 250 },
  assets: {
    image: { asset_type: 'image', url: 'https://cdn.example/banner.png', width: 300, height: 250 },
    ...assets,
  },
});
function wireCreative(assets) {
  const { format_kind, format_parameters, assets: values, ...rest } = creative(assets);
  const { image, ...other } = values;
  return { ...rest, format_id: formatId, assets: { banner_image: image, ...other } };
}
function sync(assets) {
  return projectSyncCreativesForDelivery({ creatives: [creative(assets)] }, [{ format_ids: [formatId] }], 'legacy');
}
function convert(tool, params, toVersion = '3.0.25') {
  return convertRequest(tool, params, { fromVersion: '3.1.29', toVersion });
}
function explicitDefinition() {
  return {
    format_id: formatId,
    assets: [
      { asset_id: 'banner_image', asset_type: 'image' },
      { asset_id: 'impression_tracker', asset_type: 'url', requirements: { url_type: 'tracker_pixel' } },
      { asset_id: 'viewability_tracker', asset_type: 'url', requirements: { url_type: 'tracker_pixel' } },
      { asset_id: 'click_tracker', asset_type: 'url', requirements: { url_type: 'tracker_pixel' } },
    ],
  };
}
function projectExplicit(input, definition = explicitDefinition()) {
  return projectCreativeForDelivery(
    input,
    { format_ids: [formatId] },
    'legacy',
    'sync_creatives',
    undefined,
    undefined,
    [definition]
  );
}

describe('pixel tracker delivery to AdCP 3.0 (#3429)', () => {
  test('preserves an impression tracker through AdCP 3.0 request conversion', () => {
    const request = sync({ impression: tracker() });
    const before = structuredClone(request);
    const result = convert('sync_creatives', request);
    assert.deepEqual(result.refusedFields, []);
    assert.deepEqual(result.params.creatives[0].assets.impression_tracker, {
      asset_type: 'url',
      url_type: 'tracker_pixel',
      url: tracker().url,
    });
    assert.equal(
      getSchemaValidatorByRef(
        'core/assets/url-asset.json',
        '3.0.25'
      )(result.params.creatives[0].assets.impression_tracker),
      true
    );
    assert.deepEqual(request, before);
  });

  for (const [event, method, target, lossy] of [
    ['impression', 'img', 'impression_tracker', false],
    ['click', 'img', 'click_tracker', false],
    ['viewable_mrc_50', 'img', 'viewability_tracker', true],
    ['viewable_mrc_100', 'img', 'viewability_tracker', true],
    ['viewable_video_50', 'img', 'viewability_tracker', true],
    ['audible_video_complete', 'img', 'viewability_tracker', true],
    ['custom', 'img', 'impression_tracker', true],
    ['impression', 'js', 'impression_tracker', true],
  ]) {
    test(`maps ${event}/${method} and reports the specified loss`, () => {
      const result = convert('sync_creatives', { creatives: [wireCreative({ measurement: tracker(event, method) })] });
      assert.deepEqual(result.refusedFields, []);
      assert.deepEqual(result.params.creatives[0].assets[target], {
        asset_type: 'url',
        url_type: 'tracker_pixel',
        url: tracker().url,
      });
      assert.equal(
        result.drifts.some(d => d.type === 'PIXEL_TRACKER_LOSSY_DOWNGRADE'),
        lossy
      );
      if (lossy) assert.ok(result.drifts.some(d => d.message.includes('creatives[0].assets.measurement')));
    });
  }

  test('defaults the omitted method to img and preserves opaque asset metadata', () => {
    const { method, ...pixel } = tracker();
    pixel.provenance = { ext: { event: 'not a tracker field' } };
    const result = convert('sync_creatives', { creatives: [wireCreative({ impression: pixel })] });
    assert.equal(result.params.creatives[0].assets.impression_tracker.asset_type, 'url');
    assert.deepEqual(result.params.creatives[0].assets.impression_tracker.provenance, pixel.provenance);
    assert.equal(
      result.drifts.some(d => d.type === 'PIXEL_TRACKER_LOSSY_DOWNGRADE'),
      false
    );
  });

  for (const tool of ['create_media_buy', 'update_media_buy']) {
    test(`converts inline trackers on ${tool}`, () => {
      const input = { packages: [{ creatives: [wireCreative({ counter: tracker('click') })] }] };
      const result = convert(tool, input);
      assert.deepEqual(result.refusedFields, []);
      assert.equal(result.params.packages[0].creatives[0].assets.click_tracker.url_type, 'tracker_pixel');
    });
  }

  test('retains brand-field adaptation on create_media_buy', () => {
    const result = getVersionAdapter('3.0', 'create_media_buy').adaptRequest({
      brand: { domain: 'example.com', brand_kit_override: { colors: { accent: '#123456' } } },
      packages: [{ creatives: [wireCreative({ counter: tracker('custom') })] }],
    });
    assert.equal(result.params.brand.brand_kit_override, undefined);
    assert.equal(result.params.packages[0].creatives[0].assets.impression_tracker.asset_type, 'url');
    assert.ok(result.drift.constituentTypes.includes('pre31_brand_fields_stripped'));
    assert.ok(result.drift.constituentTypes.includes('PIXEL_TRACKER_LOSSY_DOWNGRADE'));
  });

  test('preserves repeatable trackers without overwriting an occupied slot', () => {
    const input = {
      creatives: [wireCreative({ impression: [tracker(), { ...tracker(), url: 'https://track.example/second' }] })],
    };
    const result = convert('sync_creatives', input);
    assert.equal(result.params.creatives[0].assets.impression_tracker.length, 2);
    assert.ok(result.params.creatives[0].assets.impression_tracker.every(a => a.asset_type === 'url'));
    assert.throws(
      () =>
        convert('sync_creatives', {
          creatives: [
            wireCreative({
              impression_tracker: {
                asset_type: 'url',
                url_type: 'tracker_pixel',
                url: 'https://track.example/original',
              },
              extra: tracker(),
            }),
          ],
        }),
      CreativeFormatProjectionError
    );
  });

  test('refuses competing trackers and leaves unsupported events to normal version validation', () => {
    assert.throws(
      () => convert('sync_creatives', { creatives: [wireCreative({ first: tracker(), second: tracker() })] }),
      CreativeFormatProjectionError
    );
    const input = { creatives: [wireCreative({ future_event: { ...tracker(), event: 'future_event' } })] };
    const result = convert('sync_creatives', input);
    assert.ok(result.refusedFields.some(f => f.path.includes('future_event')));
  });

  test('does not convert 3.1 calls or re-convert an already converted request', () => {
    const input = { creatives: [wireCreative({ impression: tracker() })] };
    assert.equal(convert('sync_creatives', input, '3.1.29').params, input);
    const once = getVersionAdapter('3.0', 'sync_creatives').adaptRequest(input).params;
    assert.equal(getVersionAdapter('3.0', 'sync_creatives').adaptRequest(once).params, once);
  });

  test('only converts creative assets, leaving opaque request ext untouched', () => {
    const input = {
      creatives: [wireCreative({ impression: tracker() })],
      ext: { creatives: [wireCreative({ impression: tracker('custom') })] },
    };
    const result = convert('sync_creatives', input);
    assert.deepEqual(result.params.ext, input.ext);
  });
});

describe('explicit legacy URL tracker slots', () => {
  test('converts and matches the slot in one projection without changing the input', () => {
    const input = creative({ counter: tracker() });
    const before = structuredClone(input);
    const result = projectExplicit(input);
    assert.equal(result.assets.impression_tracker.asset_type, 'url');
    assert.equal(result.assets.impression_tracker.url_type, 'tracker_pixel');
    assert.equal(result.assets.counter, undefined);
    assert.deepEqual(input, before);
  });

  test('converts already named tracker slots and exposes lossy diagnostics outside the wire object', () => {
    const result = projectExplicit(creative({ viewability_tracker: tracker('viewable_mrc_100', 'js') }));
    assert.equal(result.assets.viewability_tracker.asset_type, 'url');
    const diagnostics = getCreativeDeliveryDiagnostics(result);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].type, 'PIXEL_TRACKER_LOSSY_DOWNGRADE');
    assert.ok(diagnostics[0].message.includes('JavaScript'));
    assert.equal(JSON.stringify(result).includes('PIXEL_TRACKER_LOSSY_DOWNGRADE'), false);
    assert.deepEqual(projectExplicit(result), result);
    assert.deepEqual(getCreativeDeliveryDiagnostics(projectExplicit(result)), diagnostics);
  });

  test('keeps occupied slots and ambiguous roles intact', () => {
    const occupied = { asset_type: 'url', url_type: 'tracker_pixel', url: 'https://track.example/existing' };
    const input = creative({ impression_tracker: occupied, extra: tracker() });
    const result = projectExplicit(input);
    assert.equal(result.assets.impression_tracker, occupied);
    assert.equal(result.assets.extra.asset_type, 'pixel_tracker');
    const definition = explicitDefinition();
    definition.assets.push({
      asset_id: 'another_counter',
      asset_type: 'url',
      requirements: { url_type: 'tracker_pixel', role: 'impression_tracker' },
    });
    assert.equal(projectExplicit(creative({ extra: tracker() }), definition).assets.extra.asset_type, 'pixel_tracker');
  });

  test('keeps canonical and pixel-tracker slot contracts unchanged', () => {
    const input = creative({ impression: tracker('viewable_mrc_50', 'js') });
    assert.equal(projectCreativeForDelivery(input, {}, 'canonical').assets.impression.asset_type, 'pixel_tracker');
    assert.equal(
      projectCreativeForDelivery(input, { format_ids: [formatId] }, 'legacy').assets.viewability_tracker.asset_type,
      'pixel_tracker'
    );
  });
});

describe('tracker delivery over the official in-process MCP transport', () => {
  for (const release of ['3.0', '3.1']) {
    test(`${release} sends the correct tracker shape and surfaces any loss`, async () => {
      const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
      const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
      const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
      const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
      const { AgentClient } = require('../../dist/lib/index.js');
      const server = new Server({ name: 'tracker-shape-seller', version: '1.0.0' }, { capabilities: { tools: {} } });
      const calls = [];
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          { name: 'get_adcp_capabilities', inputSchema: { type: 'object', additionalProperties: true } },
          {
            name: 'sync_creatives',
            inputSchema: {
              type: 'object',
              additionalProperties: true,
              properties: {
                account: { type: 'object' },
                idempotency_key: { type: 'string' },
                creatives: { type: 'array', items: { type: 'object', properties: { format_id: { type: 'object' } } } },
              },
            },
          },
        ],
      }));
      server.setRequestHandler(CallToolRequestSchema, async request => {
        const capabilities = {
          adcp_version: release,
          adcp: {
            major_versions: [3],
            supported_versions: release === '3.0' ? ['3.0'] : ['3.0', '3.1'],
            idempotency: { supported: true, replay_ttl_seconds: 86400 },
          },
          supported_protocols: ['media_buy'],
          specialisms: [],
        };
        if (request.params.name === 'get_adcp_capabilities')
          return { content: [{ type: 'text', text: JSON.stringify(capabilities) }], structuredContent: capabilities };
        assert.equal(request.params.name, 'sync_creatives');
        calls.push(request.params.arguments);
        const response = { adcp_version: release, creatives: [] };
        return { content: [{ type: 'text', text: JSON.stringify(response) }], structuredContent: response };
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const mcp = new Client({ name: 'tracker-shape-buyer', version: '1.0.0' });
      try {
        await server.connect(serverTransport);
        await mcp.connect(clientTransport);
        const buyer = AgentClient.fromMCPClient(mcp, { adcpVersion: '3.1.29', validateFeatures: false });
        const result = await buyer.syncCreatives(
          {
            account: { account_id: 'tracker-account' },
            idempotency_key: 'tracker-downgrade-0001',
            creatives: [creative({ measurement: tracker('viewable_mrc_50', 'js') })],
          },
          undefined,
          { creativeFormatProjection: { selectorContainers: [{ format_ids: [formatId] }] } }
        );
        assert.equal(result.success, true, JSON.stringify(result));
        assert.equal(calls.length, 1);
        assert.equal(
          calls[0].creatives[0].assets.viewability_tracker.asset_type,
          release === '3.0' ? 'url' : 'pixel_tracker'
        );
        assert.equal(
          (result.debug_logs ?? []).some(log => log.type === 'PIXEL_TRACKER_LOSSY_DOWNGRADE'),
          release === '3.0'
        );
        if (release === '3.1') {
          const explicit = projectExplicit(creative({ viewability_tracker: tracker('viewable_mrc_100', 'js') }));
          const delivered = await buyer.syncCreatives(
            {
              account: { account_id: 'tracker-account' },
              idempotency_key: 'tracker-downgrade-0002',
              creatives: [explicit],
            },
            undefined,
            { creativeFormatProjection: { selectorContainers: [{ format_ids: [formatId] }] } }
          );
          assert.equal(delivered.success, true, JSON.stringify(delivered));
          assert.equal(calls[1].creatives[0].assets.viewability_tracker.asset_type, 'url');
          assert.ok((delivered.debug_logs ?? []).some(log => log.type === 'PIXEL_TRACKER_LOSSY_DOWNGRADE'));
          assert.equal(JSON.stringify(calls[1]).includes('PIXEL_TRACKER_LOSSY_DOWNGRADE'), false);
        }
      } finally {
        await mcp.close();
        await server.close();
      }
    });
  }
});

test('unknown seller release preserves the existing tracker representation', () => {
  const { SingleAgentClient } = require('../../dist/lib/index.js');
  const client = new SingleAgentClient(
    { id: 'unknown-seller', name: 'Unknown seller', protocol: 'mcp', agent_uri: 'https://seller.example/mcp' },
    { adcpVersion: '3.1.29' }
  );
  const input = { creatives: [wireCreative({ impression: tracker() })] };
  assert.equal(client.adaptRequest('sync_creatives', input, 'v3').params, input);
});

test('repeatable tracker events map to separate legacy slots without losing entries', () => {
  const input = { creatives: [wireCreative({ counters: [tracker(), tracker('click')] })] };
  const result = convert('sync_creatives', input);
  assert.deepEqual(result.refusedFields, []);
  const assets = result.params.creatives[0].assets;
  assert.equal(assets.impression_tracker.length, 1);
  assert.equal(assets.click_tracker.length, 1);
  assert.equal(assets.counters, undefined);
});

test('later projection preserves prior tracker advisories', () => {
  const first = projectExplicit(creative({ viewability_tracker: tracker('viewable_mrc_100') }));
  first.assets.click = tracker('click', 'js');
  const second = projectExplicit(first);
  assert.equal(getCreativeDeliveryDiagnostics(second).length, 2);
});
