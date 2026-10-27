const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  CreativeFormatProjectionError,
  projectCreativeForDelivery,
  projectMediaBuyCreativesForDelivery,
  projectSyncCreativesForDelivery,
} = require('../../dist/lib/v2/projection/index.js');
const { migratedFormatOptionId } = require('../../dist/lib/v2/projection/v1-to-v2.js');

const AGENT = 'https://creative.adcontextprotocol.org';
const ref = (id, constraints = {}) => ({ agent_url: AGENT, id, ...constraints });
const imageRefs = [ref('display_300x250_image'), ref('display_728x90_image')];
const image = () => ({ asset_type: 'image', url: 'https://cdn.example/banner.png', width: 300, height: 250 });
const creative = (kind = 'image', asset = image()) => ({
  creative_id: 'primary-media',
  name: 'Primary media',
  format_kind: kind,
  assets: { media: asset },
});
const sync = (input, selector = { format_ids: imageRefs }) =>
  projectSyncCreativesForDelivery({ creatives: [input] }, [selector], 'legacy').creatives[0];

const cases = [
  ['image dimensions', 'image', image(), imageRefs],
  [
    'hosted video dimensions',
    'video_hosted',
    { asset_type: 'video', url: 'https://cdn.example/spot.mp4', width: 1080, height: 1920 },
    [ref('video_1080x1920'), ref('video_1920x1080')],
  ],
  [
    'hosted video duration',
    'video_hosted',
    { asset_type: 'video', url: 'https://cdn.example/spot.mp4', width: 1920, height: 1080, duration_ms: 15000 },
    [ref('video_standard_15s', { duration_ms: 15000 }), ref('video_standard_30s', { duration_ms: 30000 })],
  ],
  [
    'hosted audio duration',
    'audio_hosted',
    { asset_type: 'audio', url: 'https://cdn.example/spot.mp3', duration_ms: 15000 },
    [ref('audio_standard_15s', { duration_ms: 15000 }), ref('audio_standard_30s', { duration_ms: 30000 })],
  ],
];

describe('legacy format selection from primary media (#3445)', () => {
  for (const [label, kind, asset, refs] of cases) {
    for (const operation of ['sync_creatives', 'create_media_buy', 'update_media_buy']) {
      test(`${operation} selects from ${label} without mutating the caller`, () => {
        const input = creative(kind, asset);
        const selector = { package_id: 'package', product_id: 'product', format_ids: refs };
        const before = structuredClone({ input, selector });
        let projected;
        if (operation === 'sync_creatives') {
          projected = sync(input, selector);
        } else {
          const key = operation === 'update_media_buy' ? 'new_packages' : 'packages';
          projected = projectMediaBuyCreativesForDelivery(
            { [key]: [{ ...selector, creatives: [input] }] },
            'legacy',
            operation
          )[key][0].creatives[0];
        }
        assert.deepEqual(projected.format_id, refs[0]);
        assert.equal(projected.format_parameters, undefined);
        assert.deepEqual({ input, selector }, before);
      });
    }
  }

  for (const format_parameters of [{}, { seller_hint: 'landscape' }]) {
    test(`uses media facts when parameters supply no constraints: ${JSON.stringify(format_parameters)}`, () => {
      assert.deepEqual(sync({ ...creative(), format_parameters }).format_id, imageRefs[0]);
    });
  }

  test('explicit parameters take precedence over disagreeing media facts', () => {
    assert.deepEqual(sync({ ...creative(), format_parameters: { width: 728, height: 90 } }).format_id, imageRefs[1]);
  });

  test('does not fill partial explicit parameters with media facts', () => {
    assert.throws(
      () =>
        sync(
          { ...creative(), format_parameters: { width: 300 } },
          {
            format_ids: [ref('display_300x250_image'), ref('display_300x600_image')],
          }
        ),
      CreativeFormatProjectionError
    );
  });

  for (const second of [image(), { ...image(), width: 728, height: 90 }]) {
    test(`multiple image assets remain ambiguous (${second.width}x${second.height})`, () => {
      const input = creative();
      input.assets.logo = second;
      assert.throws(() => sync(input), CreativeFormatProjectionError);
    });
  }

  test('reads a single media asset inside a repeatable slot', () => {
    const input = creative();
    input.assets.media = [image()];
    assert.deepEqual(sync(input).format_id, imageRefs[0]);
  });

  test('multiple repeatable media entries remain ambiguous', () => {
    const input = creative();
    input.assets.media = [image(), { ...image(), width: 728, height: 90 }];
    assert.throws(() => sync(input), CreativeFormatProjectionError);
  });

  test('ignores other asset types and opaque metadata when identifying the primary media', () => {
    const input = creative();
    input.assets.poster = { asset_type: 'video', width: 728, height: 90 };
    input.assets.click = { asset_type: 'url', url_type: 'clickthrough', url: 'https://example.com' };
    input.ext = { asset_type: 'image', width: 728, height: 90 };
    assert.deepEqual(sync(input).format_id, imageRefs[0]);
  });

  test('does not derive image facts from a video asset', () => {
    assert.throws(() => sync(creative('image', { ...image(), asset_type: 'video' })), CreativeFormatProjectionError);
  });

  test('insufficient media facts leave distinct references ambiguous', () => {
    assert.throws(
      () => sync(creative('image', { asset_type: 'image', url: image().url })),
      CreativeFormatProjectionError
    );
  });

  for (const invalid of [0, -1, NaN, Infinity, '300']) {
    test(`invalid media dimensions do not select a format (${String(invalid)})`, () => {
      assert.throws(
        () => sync(creative('image', { ...image(), width: invalid, height: invalid })),
        CreativeFormatProjectionError
      );
    });
  }

  test('does not choose between different agents accepting the same media constraints', () => {
    assert.throws(
      () =>
        sync(creative(), {
          format_ids: [
            imageRefs[0],
            {
              ...imageRefs[0],
              agent_url: 'https://seller.example/formats',
              width: 300,
              height: 250,
            },
          ],
          format_kind: 'image',
        }),
      CreativeFormatProjectionError
    );
  });

  test('refuses a multi-reference selection with no matching media dimensions', () => {
    assert.throws(
      () => sync(creative('image', { ...image(), width: 1080, height: 1920 })),
      CreativeFormatProjectionError
    );
  });

  for (const [label, kind, asset, refs] of cases) {
    test(`preserves single-reference adaptation for ${label}`, () => {
      assert.deepEqual(sync(creative(kind, asset), { format_ids: [refs[1]] }).format_id, refs[1]);
    });
  }

  test('preserves an explicit format option pin even when asset dimensions differ', () => {
    const input = {
      ...creative(),
      format_option_ref: {
        scope: 'product',
        format_option_id: migratedFormatOptionId(imageRefs[1]),
      },
    };
    assert.deepEqual(sync(input).format_id, imageRefs[1]);
  });

  test('does not change canonical delivery', () => {
    const input = creative();
    assert.deepEqual(projectCreativeForDelivery(input, { format_ids: imageRefs }, 'canonical'), input);
  });

  test('preserves occupied legacy slots instead of replacing their values', () => {
    const input = creative();
    input.assets.banner_image = { asset_type: 'url', url: 'https://example.com/occupied' };
    const projected = sync(input);
    assert.deepEqual(projected.format_id, imageRefs[0]);
    assert.deepEqual(projected.assets.banner_image, input.assets.banner_image);
    assert.deepEqual(projected.assets.media, input.assets.media);
  });

  test('uses exact duration comparison without introducing a tolerance', () => {
    const input = creative('audio_hosted', {
      asset_type: 'audio',
      url: 'https://cdn.example/spot.mp3',
      duration_ms: 15006,
    });
    assert.throws(() => sync(input, { format_ids: cases[3][3] }), CreativeFormatProjectionError);
  });
});

describe('seller option constraints for opaque legacy IDs (#3445 follow-up)', () => {
  const refs = [
    { agent_url: 'https://seller.example/formats', id: 'portrait' },
    { agent_url: 'https://seller.example/formats', id: 'landscape' },
  ];
  const selector = {
    format_options: refs.map((value, index) => ({
      format_option_id: index ? 'landscape' : 'portrait',
      format_kind: 'image',
      params: index ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 },
      v1_format_ref: [value],
    })),
  };
  const portrait = () => creative('image', { ...image(), width: 1080, height: 1920 });

  test('compares explicit creative dimensions with option params', () => {
    const input = { ...portrait(), format_parameters: { width: 1080, height: 1920 } };
    assert.deepEqual(sync(input, selector).format_id, refs[0]);
  });

  test('compares inferred media dimensions with option params without changing the wire reference', () => {
    const before = structuredClone(selector);
    assert.deepEqual(sync(portrait(), selector).format_id, refs[0]);
    assert.deepEqual(selector, before);
  });

  test('supports an option carrying one size in its sizes array', () => {
    const sizedOptions = {
      format_options: selector.format_options.map(option => ({
        ...option,
        params: { sizes: [option.params] },
      })),
    };
    assert.deepEqual(sync(portrait(), sizedOptions).format_id, refs[0]);
  });

  test('does not invent a size from an option advertising several sizes', () => {
    const options = {
      format_options: selector.format_options.map(option => ({
        ...option,
        params: {
          sizes: [
            { width: 1080, height: 1920 },
            { width: 1920, height: 1080 },
          ],
        },
      })),
    };
    assert.throws(() => sync(portrait(), options), CreativeFormatProjectionError);
  });

  test('uses exact option duration constraints for hosted audio', () => {
    const options = {
      format_options: selector.format_options.map((option, index) => ({
        ...option,
        format_kind: 'audio_hosted',
        params: { duration_ms_exact: index ? 30000 : 15000 },
      })),
    };
    assert.deepEqual(sync(creative('audio_hosted', cases[3][2]), options).format_id, refs[0]);
  });

  test('preserves HTML selection behavior outside the primary media kinds', () => {
    const options = {
      format_options: selector.format_options.map(option => ({
        ...option,
        format_kind: 'html5',
      })),
    };
    const input = {
      ...portrait(),
      format_kind: 'html5',
      format_parameters: { width: 1080, height: 1920 },
      assets: { bundle: { asset_type: 'zip', url: 'https://cdn.example/banner.zip' } },
    };
    assert.throws(() => sync(input, options), CreativeFormatProjectionError);
  });

  test('known reference constraints keep precedence over conflicting option metadata', () => {
    const options = {
      format_options: imageRefs.map(value => ({
        format_kind: 'image',
        v1_format_ref: [value],
        params: { width: 1080, height: 1920 },
      })),
    };
    assert.deepEqual(sync(creative(), options).format_id, imageRefs[0]);
  });
});
