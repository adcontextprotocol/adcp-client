const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  expandCreativeAssetDirectivesWithDiagnostics: expand,
} = require('../../dist/lib/testing/storyboard/creative-assets');
const { runStoryboard } = require('../../dist/lib/testing');
const { validateStoryboardShape, parseStoryboard } = require('../../dist/lib/testing/storyboard/loader');
const { stringify } = require('yaml');

const reference = { agent_url: 'https://creative.example/formats', id: 'display_custom', width: 300, height: 250 };
const format = {
  format_id: reference,
  name: 'Acme display',
  assets: [
    { item_type: 'individual', asset_id: 'banner_image', asset_type: 'image', required: true },
    { item_type: 'individual', asset_id: 'landing_page', asset_type: 'url', required: true },
  ],
};
const kit = {
  creative_formats: [format],
  assets: {
    images: [{ url: 'https://assets.example/banner.jpg', width: 300, height: 250, mime_type: 'image/jpeg' }],
    click_url: 'https://acmeoutdoor.example/q3',
  },
};
const wrapper = ref => ({ format_id: ref, catalog: 'test_kit' });
const expandRef = (ref = reference, testKit = kit, context = {}) =>
  expand({ assets: { $build_assets_from_format: wrapper(ref) } }, context, testKit);

test('offline catalog uses exact legacy slots without mutating fixture inputs or discovery context', () => {
  const snapshot = structuredClone(kit);
  const context = { formats: [{ ...format, assets: [] }] };
  const before = structuredClone(context);
  const result = expandRef(reference, kit, context);
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.value.assets), ['banner_image', 'landing_page']);
  assert.equal(result.value.assets.banner_image.width, 300);
  assert.equal(result.value.assets.landing_page.url, kit.assets.click_url);
  assert.deepEqual(kit, snapshot);
  assert.deepEqual(context, before);
});

test('offline catalog canonicalizes the owner URL but preserves path boundaries', () => {
  assert.equal(expandRef({ ...reference, agent_url: 'https://CREATIVE.example:443/f%6Frmats#fragment' }).ok, true);
  for (const agent_url of [
    'https://other.example/formats',
    'https://creative.example/formats/',
    'http://creative.example/formats',
  ]) {
    const result = expandRef({ ...reference, agent_url });
    assert.equal(result.failure.reason, 'fixture_unavailable');
  }
});

test('offline catalog cannot match a slug while discarding variant parameters or extension fields', () => {
  for (const ref of [
    { ...reference, width: 320, height: 50 },
    { ...reference, duration_ms: 15000 },
    { ...reference, pixel_ratio: 2 },
    { ...reference, variant: { placement: 'hero' } },
    { agent_url: reference.agent_url, id: reference.id },
  ]) {
    const result = expandRef(ref);
    assert.equal(result.failure.reason, 'fixture_unavailable', JSON.stringify(ref));
    assert.equal(result.failure.slotId, 'format declaration');
  }
});

test('absent catalog and exact entry are coverage gaps even if context has a same-slug declaration', () => {
  for (const testKit of [undefined, {}, { ...kit, creative_formats: [] }]) {
    const result = expand(
      { assets: { $build_assets_from_format: wrapper(reference) } },
      { formats: [format] },
      testKit
    );
    assert.equal(result.failure.reason, 'fixture_unavailable');
    assert.equal(result.failure.assetType, 'format');
  }
});

test('malformed catalog, slots, duplicate refs and malformed captured refs remain authoring errors', () => {
  const badCatalogs = [
    {},
    [null],
    [{ format_id: reference, name: 'Missing contract' }],
    [{ ...format, assets: [{ asset_id: 'banner_image', asset_type: 'image', required: true }] }],
    [{ ...format, assets: [{ ...format.assets[0], required: 'true' }] }],
    [{ ...format, assets: [format.assets[0], format.assets[0]] }],
    [{ ...format, assets: [{ ...format.assets[0], requirements: { pixel_ratios: [] } }] }],
    [{ ...format, renders: [] }],
    [
      {
        ...format,
        assets: [
          {
            item_type: 'repeatable_group',
            asset_group_id: 'cards',
            required: false,
            min_count: 1,
            max_count: 2,
            assets: [
              { asset_id: 'image', asset_type: 'image', required: true },
              { asset_id: 'image', asset_type: 'image', required: true },
            ],
          },
        ],
      },
    ],
    [format, { ...format, format_id: { ...reference, agent_url: 'https://CREATIVE.example:443/formats' } }],
  ];
  for (const creative_formats of badCatalogs) {
    assert.equal(expandRef(reference, { ...kit, creative_formats }).failure.reason, 'malformed_directive');
  }
  for (const ref of [
    null,
    '$context.not_ready',
    { id: reference.id },
    { ...reference, height: undefined },
    { ...reference, agent_url: 'https://user:secret@creative.example/formats' },
  ]) {
    assert.equal(expandRef(ref).failure.reason, 'malformed_directive');
  }
  for (const directive of [
    { ...wrapper(reference), extra: true },
    { ...wrapper(reference), catalog: 'remote' },
  ]) {
    const result = expand({ assets: { $build_assets_from_format: directive } }, {}, kit);
    assert.equal(result.failure.reason, 'malformed_directive');
  }
});

test('explicit empty contracts are supported and required unsupported slots remain fixture gaps', () => {
  const empty = expandRef(reference, { ...kit, creative_formats: [{ ...format, assets: [] }] });
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.value.assets, {});
  const unsupported = {
    ...format,
    assets: [{ item_type: 'individual', asset_id: 'legal', asset_type: 'text', required: true }],
  };
  const result = expandRef(reference, { ...kit, creative_formats: [unsupported] });
  assert.equal(result.failure.reason, 'fixture_unavailable');
  assert.equal(result.failure.slotId, 'legal');
});

test('unverified parameters and required constraints are never silently dropped', () => {
  const dense = { ...reference, pixel_ratio: 2 };
  assert.equal(
    expandRef(dense, { ...kit, creative_formats: [{ ...format, format_id: dense }] }).failure.reason,
    'fixture_unavailable'
  );
  const constrained = { ...format, assets: [{ ...format.assets[0], requirements: { max_file_size_kb: 25 } }] };
  assert.equal(expandRef(reference, { ...kit, creative_formats: [constrained] }).failure.reason, 'fixture_unavailable');
});

test('asset ids named __proto__ remain own wire slots and cannot change the output prototype', () => {
  const named = { ...format, assets: [{ ...format.assets[0], asset_id: '__proto__' }] };
  const result = expandRef(reference, { ...kit, creative_formats: [named] });
  assert.equal(result.ok, true);
  assert.equal(Object.getPrototypeOf(result.value.assets), Object.prototype);
  assert.equal(Object.hasOwn(result.value.assets, '__proto__'), true);
  assert.equal(JSON.parse(JSON.stringify(result.value.assets)).__proto__.asset_type, 'image');
});

test('canonical/helper extensions cannot replace a legacy asset contract or override reference dimensions', () => {
  const result = expandRef(reference, {
    ...kit,
    creative_formats: [
      {
        ...format,
        slots: [],
        width: 320,
        height: 50,
        assets: format.assets.map(slot => ({ ...slot, width: 320, height: 50 })),
      },
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.value.assets), ['banner_image', 'landing_page']);
  assert.equal(result.value.assets.banner_image.width, 300);
  assert.equal(result.value.assets.banner_image.height, 250);
});

test('offline formats do not derive constraints from a size-looking slug', () => {
  const ref = { agent_url: reference.agent_url, id: 'custom_320x50' };
  const result = expandRef(ref, { ...kit, creative_formats: [{ ...format, format_id: ref }] });
  assert.equal(result.ok, true);
  assert.equal(result.value.assets.banner_image.width, 300);
});

test('non-1x image fixtures are not sent without their required density metadata', () => {
  const denseKit = {
    ...kit,
    assets: { ...kit.assets, images: [{ ...kit.assets.images[0], pixel_ratio: 2 }] },
    creative_formats: [{ ...format, assets: [{ ...format.assets[0], requirements: { pixel_ratios: [2] } }] }],
  };
  assert.equal(expandRef(reference, denseKit).failure.reason, 'fixture_unavailable');
});

test('unsupported accessibility, delivery, nested dimensions and unparameterized templates are coverage gaps', () => {
  for (const declaration of [
    { ...format, accessibility: { wcag_level: 'AA', requires_accessible_assets: true } },
    { ...format, delivery: { required_mode: 'special' } },
    {
      ...format,
      assets: [
        {
          ...format.assets[0],
          requirements: {
            dimensions: { width: 300, height: 250, max_width: 100 },
          },
        },
      ],
    },
    {
      ...format,
      format_id: { agent_url: reference.agent_url, id: reference.id },
      assets: [{ ...format.assets[0], requirements: { parameters_from_format_id: true } }],
    },
  ]) {
    const result = expandRef(declaration.format_id, { ...kit, creative_formats: [declaration] });
    assert.equal(result.failure.reason, 'fixture_unavailable', JSON.stringify(declaration));
  }
});

test('parameterized legacy slots cannot override reference dimensions through helper requirement fields', () => {
  for (const dimensions of [{ width: 600, height: 500 }, { dimensions: { width: 600, height: 500 } }]) {
    const conflicting = {
      ...format,
      assets: [
        {
          ...format.assets[0],
          requirements: {
            parameters_from_format_id: true,
            ...dimensions,
          },
        },
      ],
    };
    const result = expandRef(reference, {
      ...kit,
      creative_formats: [conflicting],
      assets: { ...kit.assets, images: [{ url: 'https://assets.example/large.jpg', width: 600, height: 500 }] },
    });
    assert.equal(result.ok, false);
    assert.equal(result.failure.reason, 'fixture_unavailable');
  }
  assert.equal(
    expandRef(reference, {
      ...kit,
      creative_formats: [
        {
          ...format,
          assets: [{ ...format.assets[0], requirements: { parameters_from_format_id: true, width: 300, height: 250 } }],
        },
      ],
    }).ok,
    true
  );
});

test('authored offline directives cannot run without the forward compatibility gate', () => {
  const source = storyboard();
  delete source.requires;
  assert.throws(() => validateStoryboardShape(source), /test_kit_format_catalog_runner/);
  source.requires = ['test_kit_format_catalog_runner'];
  assert.doesNotThrow(() => validateStoryboardShape(source));
});

test('synthetic rate-limit target requests require the offline gate in programmatic and YAML storyboards', () => {
  const source = storyboard();
  const request = source.phases[1].steps[0].sample_request;
  source.phases = [
    {
      id: 'trip',
      title: 'Trip',
      steps: [
        {
          id: 'trip',
          title: 'Trip',
          task: 'expect_rate_limit_not_replayed',
          requires_contract: 'rate_limit_trip_runner',
          rate_limit_trip: {
            trip_target_task: 'create_media_buy',
            trip_target_sample_request: request,
            max_attempts: 50,
            replay_max_wait_seconds: 1,
          },
          validations: [],
        },
      ],
    },
  ];
  delete source.requires;
  assert.throws(() => validateStoryboardShape(source), /test_kit_format_catalog_runner/);
  assert.throws(() => parseStoryboard(stringify(source)), /test_kit_format_catalog_runner/);
  source.requires = ['test_kit_format_catalog_runner'];
  assert.doesNotThrow(() => validateStoryboardShape(source));
  assert.doesNotThrow(() => parseStoryboard(stringify(source)));
});

function storyboard({ updateRef = reference } = {}) {
  const creative = ref => ({
    creative_id: 'acme-inline',
    format_id: ref,
    assets: { $build_assets_from_format: wrapper(ref) },
  });
  const buy = (id, ref) => ({
    id,
    title: id,
    task: 'create_media_buy',
    stateful: true,
    sample_request: { packages: [{ creatives: [creative(ref)] }] },
    validations: [],
  });
  return {
    id: 'offline_legacy_preflight',
    version: '1.0.0',
    title: 'Offline legacy preflight',
    category: 'test',
    summary: '',
    narrative: '',
    agent: { interaction_model: '*', capabilities: [] },
    caller: { role: 'buyer_agent' },
    requires: ['test_kit_format_catalog_runner'],
    phases: [
      {
        id: 'discovery',
        title: 'Discovery',
        optional: true,
        steps: [
          {
            id: 'discover',
            title: 'Discover',
            task: 'get_products',
            sample_request: {},
            validations: [],
            context_outputs: [{ path: 'products[0].format_ids[0]', key: 'legacy_ref' }],
          },
        ],
      },
      {
        id: 'legacy',
        title: 'Legacy',
        skip_if: '!context.legacy_ref',
        steps: [
          buy('legacy_buy', '$context.legacy_ref'),
          { ...buy('legacy_update', updateRef), task: 'update_media_buy' },
        ],
      },
      {
        id: 'canonical',
        title: 'Canonical',
        depends_on: ['discovery'],
        steps: [
          {
            id: 'canonical_buy',
            title: 'Canonical buy',
            task: 'create_media_buy',
            stateful: true,
            sample_request: {},
            validations: [],
          },
        ],
      },
    ],
  };
}

async function run(testKit, settings = {}) {
  const calls = [];
  const tools = ['get_products', 'create_media_buy', 'update_media_buy'];
  const result = await runStoryboard('https://seller.example/mcp', storyboard(settings), {
    protocol: 'mcp',
    test_kit: testKit,
    agentTools: tools,
    _profile: { name: 'Inline seller', tools },
    _client: {
      async executeTask(task, request) {
        calls.push({ task, request });
        return {
          success: settings.reject !== task,
          status: 'completed',
          data:
            task === 'get_products' ? { products: [{ format_ids: settings.canonicalOnly ? [] : [reference] }] } : {},
        };
      },
    },
  });
  return { calls, result };
}

test('runner gate is intrinsic and offline preparation works on a media-buy-only seller', async () => {
  const { calls, result } = await run(kit);
  assert.equal(result.failed_count, 0);
  assert.equal(result.skipped_count, 0);
  assert.equal(calls.filter(call => call.task === 'create_media_buy').length, 2);
  assert.deepEqual(
    Object.keys(calls.find(call => call.task === 'update_media_buy').request.packages[0].creatives[0].assets),
    ['banner_image', 'landing_page']
  );
  assert.ok(calls.every(call => !['list_creative_formats', 'sync_creatives'].includes(call.task)));
});

test('missing operator preparation stops a mixed seller before any buy or update', async () => {
  const { calls, result } = await run({ assets: kit.assets });
  assert.deepEqual(
    calls.map(call => call.task),
    ['get_products']
  );
  assert.equal(result.failed_count, 0);
  assert.equal(
    result.phases.flatMap(phase => phase.steps).find(step => step.skipped).skip.reason,
    'fixture_unavailable'
  );
});

test('an unsupported update-only fixture is preflighted before the first buy', async () => {
  const updateRef = { ...reference, id: 'unsupported_update' };
  const unsupported = {
    ...format,
    format_id: updateRef,
    assets: [{ item_type: 'individual', asset_id: 'legal', asset_type: 'text', required: true }],
  };
  const { calls, result } = await run({ ...kit, creative_formats: [format, unsupported] }, { updateRef });
  assert.deepEqual(
    calls.map(call => call.task),
    ['get_products']
  );
  assert.equal(result.failed_count, 0);
  const skipped = result.phases.flatMap(phase => phase.steps).find(step => step.skipped);
  assert.equal(skipped.skip.reason, 'fixture_unavailable');
  assert.match(skipped.skip.detail, /legal/);
});

test('canonical-only catalogs need no offline legacy catalog', async () => {
  const { calls, result } = await run(undefined, { canonicalOnly: true });
  assert.equal(result.failed_count, 0, JSON.stringify(result));
  assert.equal(calls.filter(call => call.task === 'create_media_buy').length, 1);
  assert.equal(
    calls.some(call => call.task === 'update_media_buy'),
    false
  );
});

test('seller refusal of a valid prepared manifest remains a failure', async () => {
  const { result } = await run(kit, { reject: 'create_media_buy' });
  assert.ok(result.failed_count > 0);
  assert.equal(
    result.phases.flatMap(phase => phase.steps).some(step => step.skip?.reason === 'fixture_unavailable'),
    false
  );
});
