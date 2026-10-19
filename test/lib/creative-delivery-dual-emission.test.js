const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  CreativeFormatProjectionError,
  canonicalFormatLegacyResolverFromRoutes,
  packageRefsForFormatOptions,
  projectCreativeForDelivery,
  projectMediaBuyCreativesForDelivery,
  projectSyncCreativesForDelivery,
  resolveCreativeFormatWireMode,
  toAdditiveCanonicalProduct,
  toCanonicalOnlyProduct,
} = require('../../dist/lib/v2/projection/index.js');

const AGENT = 'https://creative.adcontextprotocol.org';

function product() {
  return {
    product_id: 'dual-emitted',
    format_ids: [
      { agent_url: AGENT, id: 'display_300x250_image' },
      { agent_url: AGENT, id: 'display_728x90_image' },
    ],
    format_options: [
      { format_option_id: 'mrec', format_kind: 'image', params: { width: 300, height: 250 } },
      { format_option_id: 'leaderboard', format_kind: 'image', params: { width: 728, height: 90 } },
    ],
  };
}

function creative(format_option_id = 'mrec') {
  const [width, height] = format_option_id === 'leaderboard' ? [728, 90] : [300, 250];
  return {
    creative_id: 'c1',
    name: 'Display image',
    format_kind: 'image',
    format_option_ref: { scope: 'product', format_option_id },
    assets: { image: { asset_type: 'image', url: 'https://cdn.example/c1.png', width, height } },
  };
}

describe('dual-emitted product format pairing (#3312)', () => {
  for (const mode of ['legacy', 'unknown']) {
    for (const [index, id] of ['mrec', 'leaderboard'].entries()) {
      test(`${mode} wire projects the ${id} option through its paired reference`, () => {
        const selected = product();
        const input = creative(id);
        const original = structuredClone({ selected, input });
        const projected = projectCreativeForDelivery(input, selected, mode, 'sync_creatives');
        assert.deepEqual(projected.format_id, selected.format_ids[index]);
        assert.equal(projected.format_kind, undefined);
        assert.equal(projected.format_option_ref, undefined);
        assert.deepEqual(projected.assets, { banner_image: input.assets.image });
        assert.deepEqual({ selected, input }, original);
        assert.deepEqual(Reflect.ownKeys(selected.format_options[0]), ['format_option_id', 'format_kind', 'params']);
      });
    }
  }

  test('uses seller-authored pairing even when the legacy ID has no registry mapping', () => {
    const selected = product();
    selected.format_ids[0] = { agent_url: 'https://seller.example/formats', id: 'seller_mrec' };
    assert.deepEqual(projectCreativeForDelivery(creative(), selected, 'legacy').format_id, selected.format_ids[0]);
  });

  test('does not add an ambiguous bare candidate for an already linked reference', () => {
    const selected = product();
    selected.format_ids.splice(1);
    selected.format_options.splice(1);
    const input = creative();
    delete input.format_option_ref;
    assert.deepEqual(projectCreativeForDelivery(input, selected, 'legacy').format_id, selected.format_ids[0]);
  });

  test('explicit declaration routes take precedence over index pairing', () => {
    const selected = product();
    const explicit = { agent_url: 'https://seller.example/formats', id: 'explicit_mrec' };
    selected.format_options[0].v1_format_ref = [explicit];
    assert.deepEqual(projectCreativeForDelivery(creative(), selected, 'legacy').format_id, explicit);
  });

  test('does not infer a pairing when list lengths differ or format_ids is absent', () => {
    for (const format_ids of [undefined, product().format_ids.slice(0, 1), [...product().format_ids, {}]]) {
      assert.throws(
        () => projectCreativeForDelivery(creative(), { ...product(), format_ids }, 'legacy'),
        CreativeFormatProjectionError
      );
    }
  });

  test('an invalid reference prevents inference for the whole product', () => {
    const selected = product();
    selected.format_ids[0] = {};
    assert.throws(() => projectCreativeForDelivery(creative(), selected, 'legacy'), CreativeFormatProjectionError);
    assert.throws(
      () => projectCreativeForDelivery(creative('leaderboard'), selected, 'legacy'),
      CreativeFormatProjectionError
    );
  });

  test('refuses an unknown option and a canonical-only option', () => {
    const selected = product();
    assert.throws(
      () => projectCreativeForDelivery(creative('missing'), selected, 'legacy'),
      CreativeFormatProjectionError
    );
    selected.format_options[0].canonical_formats_only = true;
    assert.throws(() => projectCreativeForDelivery(creative(), selected, 'legacy'), CreativeFormatProjectionError);
    assert.throws(
      () => projectCreativeForDelivery(creative('leaderboard'), selected, 'legacy'),
      CreativeFormatProjectionError
    );
  });

  for (const divergence of ['kind', 'catalog size', 'explicit size', 'declared sizes', 'duration']) {
    test(`refuses index inference for a divergent ${divergence} and retains diagnostics`, () => {
      const selected = product();
      if (divergence === 'kind') selected.format_ids[0].id = 'video_standard_30s';
      if (divergence === 'catalog size') selected.format_ids.reverse();
      if (divergence === 'explicit size') selected.format_ids[0].width = 728;
      if (divergence === 'declared sizes') selected.format_options[0].params = { sizes: [{ width: 728, height: 90 }] };
      if (divergence === 'duration') {
        selected.format_ids[0] = { agent_url: AGENT, id: 'custom_video', duration_ms: 30000 };
        selected.format_options[0] = {
          format_option_id: 'mrec',
          format_kind: 'video_hosted',
          params: { duration_ms_exact: 15000 },
        };
      }
      const input = creative();
      input.format_kind = selected.format_options[0].format_kind;
      assert.throws(() => projectCreativeForDelivery(input, selected, 'legacy'), CreativeFormatProjectionError);
      const canonical = toCanonicalOnlyProduct(selected);
      assert.equal(canonical.diagnostics.length, 2, 'untrusted alignment cannot hide unmapped references');
    });
  }

  test('one contradictory explicit route prevents inference for all other options', () => {
    const selected = product();
    selected.format_options[0].v1_format_ref = [selected.format_ids[1]];
    assert.throws(
      () => projectCreativeForDelivery(creative('leaderboard'), selected, 'legacy'),
      CreativeFormatProjectionError
    );
  });

  for (const params of [
    { min_width: 700 },
    { max_width: 200 },
    { min_height: 300 },
    { max_height: 100 },
    { sizes: [{ width: 300, height: 250 }], min_width: 700 },
  ]) {
    test(`refuses index pairing that contradicts dimension bounds ${JSON.stringify(params)}`, () => {
      const selected = product();
      selected.format_options[0].params = params;
      assert.throws(() => projectCreativeForDelivery(creative(), selected, 'legacy'), CreativeFormatProjectionError);
      assert.equal(toCanonicalOnlyProduct(selected).diagnostics.length, 2);
    });
  }

  for (const range of [
    [1000, 5000],
    [60000, 90000],
  ]) {
    test(`refuses index pairing that contradicts duration range ${range}`, () => {
      const selected = {
        product_id: 'video',
        format_ids: [{ agent_url: AGENT, id: 'custom_video', duration_ms: 30000 }],
        format_options: [
          { format_option_id: 'video', format_kind: 'video_hosted', params: { duration_ms_range: range } },
        ],
      };
      assert.equal(toCanonicalOnlyProduct(selected).diagnostics.length, 1);
    });
  }

  test('compatible bounds preserve pairing and exact duration takes precedence over range', () => {
    const selected = product();
    selected.format_options[0].params = { min_width: 300, max_width: 728, min_height: 90, max_height: 250 };
    assert.deepEqual(projectCreativeForDelivery(creative(), selected, 'legacy').format_id, selected.format_ids[0]);
    const video = {
      product_id: 'video',
      format_ids: [{ agent_url: AGENT, id: 'custom_video', duration_ms: 30000 }],
      format_options: [
        {
          format_option_id: 'video',
          format_kind: 'video_hosted',
          params: { duration_ms_exact: 30000, duration_ms_range: [1000, 5000] },
        },
      ],
    };
    assert.equal(toCanonicalOnlyProduct(video).diagnostics.length, 0);
    delete video.format_options[0].params.duration_ms_exact;
    video.format_options[0].params.duration_ms_range = [15000, 60000];
    assert.equal(toCanonicalOnlyProduct(video).diagnostics.length, 0);
  });

  test('duplicate references linked to distinct options remain ambiguous without a pin', () => {
    const selected = product();
    selected.format_ids[1] = { ...selected.format_ids[0] };
    selected.format_options[1].params = { ...selected.format_options[0].params };
    const input = creative();
    delete input.format_option_ref;
    assert.throws(() => projectCreativeForDelivery(input, selected, 'legacy'), CreativeFormatProjectionError);
  });

  test('restored explicit routes override the full product index pairing', () => {
    const selected = product();
    selected.format_options.reverse();
    selected.format_options[0].v1_format_ref = [selected.format_ids[1]];
    selected.format_options[1].v1_format_ref = [selected.format_ids[0]];
    const restored = JSON.parse(JSON.stringify(toAdditiveCanonicalProduct(selected)));
    const resolver = canonicalFormatLegacyResolverFromRoutes(restored.routes);
    const projected = projectSyncCreativesForDelivery(
      { creatives: [creative('leaderboard')] },
      [restored.product],
      'legacy',
      undefined,
      resolver
    );
    assert.deepEqual(projected.creatives[0].format_id, selected.format_ids[1]);
  });

  test('an adopter resolver takes precedence over index pairing', () => {
    const selected = product();
    const explicit = { agent_url: 'https://seller.example/formats', id: 'resolved_mrec' };
    const projected = projectCreativeForDelivery(
      creative(),
      selected,
      'legacy',
      'sync_creatives',
      undefined,
      context =>
        context.source === 'product' && context.declaration.format_option_id === 'mrec' ? explicit : undefined
    );
    assert.deepEqual(projected.format_id, explicit);
  });

  test('sync and inline create/update share the product pairing', () => {
    const selected = product();
    const sync = projectSyncCreativesForDelivery({ creatives: [creative()] }, [selected], 'unknown');
    assert.deepEqual(sync.creatives[0].format_id, selected.format_ids[0]);
    for (const [key, operation] of [
      ['packages', 'create_media_buy'],
      ['new_packages', 'update_media_buy'],
    ]) {
      const projected = projectMediaBuyCreativesForDelivery(
        {
          [key]: [
            {
              ...selected,
              format_option_refs: [{ scope: 'product', format_option_id: 'mrec' }],
              creatives: [creative()],
            },
          ],
        },
        'legacy',
        operation
      );
      assert.deepEqual(projected[key][0].format_ids, [selected.format_ids[0]]);
      assert.deepEqual(projected[key][0].creatives[0].format_id, selected.format_ids[0]);
    }
  });

  test('canonical discovery preserves private pairing and durable routes', () => {
    const selected = product();
    const original = structuredClone(selected);
    const additive = toAdditiveCanonicalProduct(selected);
    const canonical = toCanonicalOnlyProduct(selected);
    assert.deepEqual(canonical.diagnostics, []);
    assert.equal(canonical.product.format_ids, undefined);
    for (const discovered of [additive.product, canonical.product]) {
      const selection = packageRefsForFormatOptions(discovered, ['mrec']);
      const projected = projectSyncCreativesForDelivery({ creatives: [creative()] }, [selection], 'legacy');
      assert.deepEqual(projected.creatives[0].format_id, selected.format_ids[0]);
      assert.deepEqual(discovered.format_options, original.format_options);
      assert.deepEqual(Reflect.ownKeys(discovered.format_options[0]), Reflect.ownKeys(original.format_options[0]));
    }
    const restored = JSON.parse(JSON.stringify(additive));
    const resolver = canonicalFormatLegacyResolverFromRoutes(restored.routes);
    const selection = packageRefsForFormatOptions(restored.product, ['mrec']);
    const projected = projectSyncCreativesForDelivery(
      { creatives: [creative()] },
      [{ product_id: restored.product.product_id, ...selection }],
      'legacy',
      undefined,
      resolver
    );
    assert.deepEqual(projected.creatives[0].format_id, selected.format_ids[0]);
    assert.deepEqual(selected, original);
  });

  test('seller response assembly can preserve declarations without inferring buyer routes', () => {
    const selected = product();
    for (const project of [toAdditiveCanonicalProduct, toCanonicalOnlyProduct]) {
      const projected = project(selected, { _inferDualEmissionLegacyRefs: false });
      assert.deepEqual(projected.product.format_options, selected.format_options);
      const selection = packageRefsForFormatOptions(projected.product, ['mrec']);
      assert.throws(
        () => projectSyncCreativesForDelivery({ creatives: [creative()] }, [selection], 'legacy'),
        CreativeFormatProjectionError
      );
    }
    assert.equal(toCanonicalOnlyProduct(selected, { _inferDualEmissionLegacyRefs: false }).diagnostics.length, 2);
  });

  test('retains canonical delivery and conservative 3.1 wire negotiation', () => {
    const input = creative();
    assert.deepEqual(projectCreativeForDelivery(input, product(), 'canonical'), input);
    assert.equal(resolveCreativeFormatWireMode({ supportedVersions: ['3.0', '3.1'], features: {} }, '3.2'), 'unknown');
  });
});
