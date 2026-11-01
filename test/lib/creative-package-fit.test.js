const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  fitCreativeToPackages,
  projectSyncCreativesForDelivery,
  CreativeFormatProjectionError,
} = require('../../dist/lib/v2/projection');
const { vectors } = require('../fixtures/canonical-image-pixel-ratio.json');
const VERSION = { adcpVersion: '3.3.0-beta.3' };
const OWNER = 'https://creative.adcontextprotocol.org';
const image = (facts = { width: 300, height: 250 }) => ({
  creative_id: 'image',
  name: 'Acme banner',
  format_kind: 'image',
  assets: { image_main: { asset_type: 'image', url: 'https://cdn.acme.example/banner.png', ...facts } },
});
const declaration = (params = {}, fields = {}) => ({
  format_kind: 'image',
  params,
  technical_requirements_complete: true,
  ...fields,
});
const pkg = (package_id, ...format_options) => ({ package_id, format_options });
const fit = (creative, packages, options = {}) => fitCreativeToPackages(creative, packages, { ...VERSION, ...options });
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

const legacyTag = () => ({
  creative_id: 'legacy-tag',
  name: 'Acme tall banner',
  format_kind: 'display_tag',
  format_parameters: { width: 300, height: 600 },
  assets: {
    tag_url: {
      asset_type: 'display_tag',
      delivery_type: 'inline_markup',
      markup_type: 'standard',
      markup: '<div>Acme</div>',
    },
  },
});
const legacyPackage = (package_id, ...format_ids) => ({ package_id, format_ids });
const legacyHtml = (width, height) => ({
  agent_url: OWNER,
  id: `display_${width}x${height}_html`,
  width,
  height,
});
const legacyFit = (creative, packages, options = {}) =>
  fit(creative, packages, { adcpVersion: '3.1', wireMode: 'legacy', ...options });

test('legacy fit: nine packages distinguish exact HTML sizes from known mismatches', () => {
  const sizes = [
    [[320, 50]],
    [[300, 250]],
    [[300, 600]],
    [[728, 90]],
    [[970, 250]],
    [[160, 600]],
    [[300, 600]],
    [
      [300, 250],
      [300, 600],
    ],
    [
      [320, 50],
      [300, 600],
    ],
  ];
  const packages = sizes.map((alternatives, index) =>
    legacyPackage(
      `P${index}`,
      ...alternatives.flatMap(([width, height]) => [
        legacyHtml(width, height),
        { agent_url: OWNER, id: 'display_html', width, height },
        { agent_url: OWNER, id: `display_${width}x${height}_image`, width, height },
        { agent_url: OWNER, id: 'display_js', width, height },
      ])
    )
  );
  const options = { primaryAssetFacts: { width: 300, height: 600, delivery_type: 'inline_markup' } };
  const decision = legacyFit(freeze(legacyTag()), freeze(packages), options);
  assert.deepEqual(
    decision.perPackage.map(entry => entry.verdict),
    ['does_not_fit', 'does_not_fit', 'fits', 'does_not_fit', 'does_not_fit', 'does_not_fit', 'fits', 'fits', 'fits']
  );
  assert.ok(decision.perPackage[0].reasons.some(reason => reason.code === 'size_mismatch'));
  assert.equal(decision.wire, undefined);
  const compatible = packages.filter((_, index) => [2, 6, 7, 8].includes(index));
  const accepted = legacyFit(legacyTag(), compatible, options);
  assert.equal(
    accepted.perPackage.every(entry => entry.verdict === 'fits'),
    true
  );
  assert.equal(accepted.wire.selector.format_id.id, 'display_300x600_html');
});

test('legacy fit: catalog-pinned sizes work without inline dimensions; unsized declarations stay unknown', () => {
  assert.equal(
    legacyFit(legacyTag(), [legacyPackage('A', { agent_url: OWNER, id: 'display_300x600_html' })]).perPackage[0]
      .verdict,
    'fits'
  );
  assert.equal(
    legacyFit(legacyTag(), [legacyPackage('A', { agent_url: OWNER, id: 'display_320x50_html' })]).perPackage[0].verdict,
    'does_not_fit'
  );
  assert.equal(
    legacyFit(legacyTag(), [legacyPackage('A', { agent_url: OWNER, id: 'display_html' })]).perPackage[0].verdict,
    'insufficient_facts'
  );
});

test('legacy fit: missing measurements stay unknown, but a known axis mismatch still rejects', () => {
  const creative = legacyTag();
  delete creative.format_parameters;
  const packages = [legacyPackage('A', legacyHtml(320, 50))];
  assert.equal(legacyFit(creative, packages).perPackage[0].verdict, 'insufficient_facts');
  const measured = legacyFit(creative, packages, { primaryAssetFacts: { width: 300 } });
  assert.equal(measured.perPackage[0].verdict, 'does_not_fit');
  assert.ok(measured.perPackage[0].reasons.some(reason => reason.code === 'size_mismatch'));
});

test('legacy fit: a public owner copying an AAO ID is not authoritative positive-fit evidence', () => {
  const alias = { ...legacyHtml(300, 600), agent_url: 'https://formats.acme.example' };
  assert.equal(legacyFit(legacyTag(), [legacyPackage('A', alias)]).perPackage[0].verdict, 'insufficient_facts');
  assert.equal(
    legacyFit(legacyTag(), [legacyPackage('A', { ...alias, width: 320, height: 50 })]).perPackage[0].verdict,
    'does_not_fit'
  );
  const converted = legacyFit(legacyTag(), [legacyPackage('A', alias)], {
    legacyFormatConverter: () => ({
      format_kind: 'display_tag',
      params: { width: 300, height: 600, supported_delivery_types: ['inline_markup'] },
    }),
  });
  assert.equal(converted.perPackage[0].verdict, 'fits');
  assert.equal(converted.wire.selector.format_id.agent_url, alias.agent_url);
});

test('legacy fit: native canonical contracts retain their completeness and size requirements', () => {
  const legacy = legacyHtml(300, 600);
  for (const [native, expected] of [
    [{ format_kind: 'display_tag', params: { width: 300, height: 600 } }, 'insufficient_facts'],
    [{ format_kind: 'display_tag', params: { width: 320, height: 50 } }, 'does_not_fit'],
  ]) {
    const result = legacyFit(legacyTag(), [{ package_id: 'A', format_ids: [legacy], format_options: [native] }]);
    assert.equal(result.perPackage[0].verdict, expected);
  }
});

test('legacy fit: hosted audio compares duration and leaves unstated duration unknown', () => {
  const creative = {
    creative_id: 'audio',
    name: 'Acme audio',
    format_kind: 'audio_hosted',
    assets: { audio_main: { asset_type: 'audio', duration_ms: 30000 } },
  };
  const ref = duration_ms => ({
    agent_url: OWNER,
    id: duration_ms ? `audio_standard_${duration_ms / 1000}s` : 'audio_standard',
    ...(duration_ms && { duration_ms }),
  });
  const result = legacyFit(creative, [
    legacyPackage('exact', ref(30000)),
    legacyPackage('wrong', ref(15000)),
    legacyPackage('unstated', ref()),
  ]);
  assert.deepEqual(
    result.perPackage.map(entry => entry.verdict),
    ['fits', 'does_not_fit', 'insufficient_facts']
  );
  assert.ok(result.perPackage[1].reasons.some(reason => reason.code === 'duration_mismatch'));
  delete creative.assets.audio_main.duration_ms;
  assert.equal(legacyFit(creative, [legacyPackage('A', ref(30000))]).perPackage[0].verdict, 'insufficient_facts');
});

test('legacy fit: VAST player sizes fit independently while conflicting shared legacy references still refuse', () => {
  const creative = {
    creative_id: 'vast',
    name: 'Acme VAST',
    format_kind: 'video_vast',
    assets: { vast_tag: { asset_type: 'vast', url: 'https://cdn.acme.example/tag.xml' } },
  };
  const packages = [360, 480].map((height, index) =>
    legacyPackage(`P${index}`, { agent_url: OWNER, id: 'video_vast', width: 640, height, duration_ms: 30000 })
  );
  const result = legacyFit(creative, packages, { primaryAssetFacts: { duration_ms: 30000 } });
  assert.deepEqual(
    result.perPackage.map(entry => entry.verdict),
    ['fits', 'fits']
  );
  assert.equal(result.wire, undefined);
  assert.equal(result.refusal.code, 'wire_projection_failed');
  const explicit = legacyFit({ ...creative, format_parameters: { width: 640, height: 360 } }, packages, {
    primaryAssetFacts: { duration_ms: 30000 },
  });
  assert.deepEqual(
    explicit.perPackage.map(entry => entry.verdict),
    ['fits', 'does_not_fit']
  );
});

test('legacy fit: image density is part of its logical-size contract', () => {
  const ref = { agent_url: OWNER, id: 'display_image', width: 300, height: 250, pixel_ratio: 2 };
  assert.equal(
    legacyFit(image({ width: 600, height: 500, pixel_ratio: 2 }), [legacyPackage('A', ref)]).perPackage[0].verdict,
    'fits'
  );
  assert.equal(
    legacyFit(image({ width: 600, height: 500, pixel_ratio: 2 }), [legacyPackage('A', { ...ref, pixel_ratio: 1 })])
      .perPackage[0].verdict,
    'does_not_fit'
  );
});

test('fit reasons are deduplicated by code/path before the diagnostic budget', () => {
  const repeated = Array.from({ length: 40 }, () => declaration({ width: 320, height: 50 }));
  const unknown = declaration({ max_file_size_kb: 1 });
  const result = fit(image(), [pkg('A', ...repeated, unknown)]);
  const reasons = result.perPackage[0].reasons;
  const keys = reasons.map(reason => JSON.stringify([reason.code, reason.path]));
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(reasons.some(reason => reason.code === 'fact_missing'));
});

test('legacy fit: partial image facts reject only contradictions every accepted density proves', () => {
  for (const [asset, width, ratio, expected] of [
    [{ width: 300 }, 320, 1, 'does_not_fit'],
    [{ height: 600 }, 300, 1, 'does_not_fit'],
    [{ width: 600, pixel_ratio: 2 }, 320, 2, 'does_not_fit'],
    [{ width: 600, pixel_ratio: 2 }, 300, 2, 'insufficient_facts'],
  ]) {
    const ref = { agent_url: OWNER, id: 'display_image', width, height: 250, pixel_ratio: ratio };
    assert.equal(legacyFit(image(asset), [legacyPackage('A', ref)]).perPackage[0].verdict, expected);
  }
  const possible = fit(image({ width: 300 }), [
    pkg('A', declaration({ width: 150, height: 125, pixel_ratios: [1, 2] })),
  ]);
  assert.equal(possible.perPackage[0].verdict, 'insufficient_facts');
});

test('legacy fit: explicit dimensions never overwrite converter exact or ranged constraints', () => {
  const ref = { agent_url: 'https://formats.acme.example', id: 'custom-banner', width: 300, height: 600 };
  for (const params of [
    { width: 320, height: 50 },
    { min_width: 320, max_width: 640, min_height: 50, max_height: 100 },
    { sizes: [{ width: 320, height: 50 }] },
  ]) {
    const decision = legacyFit(legacyTag(), [legacyPackage('A', ref)], {
      legacyFormatConverter: () => ({
        format_kind: 'display_tag',
        params: { ...params, supported_delivery_types: ['inline_markup'] },
      }),
    });
    assert.equal(decision.perPackage[0].verdict, 'does_not_fit');
    assert.equal(decision.wire, undefined);
  }
});

test('legacy fit: explicit duration cannot override a converter exact duration or escape its range', () => {
  const creative = {
    creative_id: 'audio',
    name: 'Acme audio',
    format_kind: 'audio_hosted',
    assets: { audio_main: { asset_type: 'audio', duration_ms: 30000 } },
  };
  const ref = { agent_url: 'https://formats.acme.example', id: 'custom-audio', duration_ms: 30000 };
  for (const params of [{ duration_ms_exact: 15000 }, { duration_ms_range: [null, 15000] }]) {
    const result = legacyFit(creative, [legacyPackage('A', ref)], {
      legacyFormatConverter: () => ({ format_kind: 'audio_hosted', params }),
    });
    assert.equal(result.perPackage[0].verdict, 'does_not_fit');
    assert.equal(result.wire, undefined);
  }
});

test('legacy fit: explicit density cannot broaden a converter density contract', () => {
  const ref = {
    agent_url: 'https://formats.acme.example',
    id: 'custom-image',
    width: 300,
    height: 250,
    pixel_ratio: 2,
  };
  const result = legacyFit(image({ width: 600, height: 500, pixel_ratio: 2 }), [legacyPackage('A', ref)], {
    legacyFormatConverter: () => ({ format_kind: 'image', params: { width: 300, height: 250, pixel_ratios: [1] } }),
  });
  assert.equal(result.perPackage[0].verdict, 'does_not_fit');
});

test('legacy fit: SDK-derived options use retained refs, while mutations and JSON clones keep canonical checks', () => {
  const { projectV1ProductToV2 } = require('../../dist/lib/v2/projection/v1-to-v2');
  const product = () =>
    projectV1ProductToV2({ product_id: 'product', name: 'Acme display', format_ids: [legacyHtml(300, 600)] }).v2;
  const derived = product();
  assert.equal(legacyFit(legacyTag(), [{ package_id: 'A', ...derived }]).perPackage[0].verdict, 'fits');
  assert.equal(
    legacyFit(legacyTag(), [{ package_id: 'A', ...JSON.parse(JSON.stringify(derived)) }]).perPackage[0].verdict,
    'does_not_fit'
  );
  derived.format_options[0].params.width = 320;
  assert.equal(legacyFit(legacyTag(), [{ package_id: 'A', ...derived }]).perPackage[0].verdict, 'does_not_fit');
  const alias = projectV1ProductToV2({
    product_id: 'product',
    name: 'Acme alias',
    format_ids: [{ ...legacyHtml(300, 600), agent_url: 'https://formats.acme.example' }],
  }).v2;
  alias.format_options[0].params.width = 320;
  assert.equal(legacyFit(legacyTag(), [{ package_id: 'A', ...alias }]).perPackage[0].verdict, 'does_not_fit');
});

test('legacy fit: converter exceptions propagate and invalid answers remain unknown', () => {
  const packages = [
    legacyPackage('A', { agent_url: 'https://formats.acme.example', id: 'custom-banner', width: 300, height: 600 }),
  ];
  const failure = new Error('Acme converter failed');
  assert.throws(
    () =>
      legacyFit(legacyTag(), packages, {
        legacyFormatConverter: () => {
          throw failure;
        },
      }),
    error => error === failure
  );
  const result = legacyFit(legacyTag(), packages, { legacyFormatConverter: () => ({ format_kind: 'not-a-kind' }) });
  assert.equal(result.perPackage[0].verdict, 'insufficient_facts');
  assert.equal(result.wire, undefined);
});

test('legacy fit: inline markup never fits URL-only or HTML5 ZIP declarations', () => {
  for (const id of ['display_js', 'display_image']) {
    const result = legacyFit(legacyTag(), [legacyPackage('A', { agent_url: OWNER, id, width: 300, height: 600 })]);
    assert.equal(result.perPackage[0].verdict, 'does_not_fit');
  }
  const zip = legacyFit(
    legacyTag(),
    [legacyPackage('A', { agent_url: 'https://formats.acme.example', id: 'zip-banner', width: 300, height: 600 })],
    {
      legacyFormatConverter: () => ({ format_kind: 'html5', params: { width: 300, height: 600 } }),
    }
  );
  assert.equal(zip.perPackage[0].verdict, 'does_not_fit');
});

test('legacy fit: a converter slot contract is never rewritten as a catalog primary alias', () => {
  const ref = { agent_url: 'https://formats.acme.example', id: 'branded-banner', width: 300, height: 600 };
  const result = legacyFit(legacyTag(), [legacyPackage('A', ref)], {
    legacyFormatConverter: () => ({
      format_kind: 'display_tag',
      params: {
        width: 300,
        height: 600,
        supported_delivery_types: ['inline_markup'],
        slots: [{ asset_group_id: 'required_logo', asset_type: 'display_tag', required: true }],
      },
    }),
  });
  assert.equal(result.perPackage[0].verdict, 'does_not_fit');
  assert.ok(result.perPackage[0].reasons.some(reason => reason.code === 'required_slot_missing'));
});

test('legacy fit: resolved required image renditions survive the envelope check', () => {
  const ref = { agent_url: 'https://formats.acme.example', id: 'dense-image', width: 300, height: 250 };
  const options = {
    legacyFormatConverter: () => ({
      format_kind: 'image',
      params: {
        width: 300,
        height: 250,
        pixel_ratios: [1, 2],
        slots: [{ asset_group_id: 'image_main', asset_type: 'image', required_pixel_ratios: [1, 2] }],
      },
    }),
  };
  const packages = [legacyPackage('A', ref)];
  const missing = legacyFit(image({ width: 300, height: 250, pixel_ratio: 1 }), packages, options);
  assert.equal(missing.perPackage[0].verdict, 'does_not_fit');
  const creative = image();
  creative.assets.image_main = [
    { asset_type: 'image', width: 300, height: 250, pixel_ratio: 1 },
    { asset_type: 'image', width: 600, height: 500, pixel_ratio: 2 },
  ];
  const complete = legacyFit(creative, packages, options);
  assert.equal(complete.perPackage[0].verdict, 'fits');
  assert.equal(complete.wire, undefined);
});

test('legacy fit: catalog HTML alias retains its inline-only delivery requirement', () => {
  const creative = legacyTag();
  creative.assets.tag_url = {
    asset_type: 'display_tag',
    delivery_type: 'tag_url',
    url: 'https://cdn.acme.example/tag',
  };
  const result = legacyFit(creative, [legacyPackage('A', legacyHtml(300, 600))]);
  assert.equal(result.perPackage[0].verdict, 'does_not_fit');
  assert.equal(result.wire, undefined);
});

test('legacy fit: a shared reference gaining dimensions does not change its original synthetic contract', () => {
  const { projectV1ProductToV2 } = require('../../dist/lib/v2/projection/v1-to-v2');
  const packages = [{}, { width: 300, height: 600 }].map((size, index) => ({
    package_id: `P${index}`,
    ...projectV1ProductToV2({
      product_id: `product-${index}`,
      name: 'Acme HTML',
      format_ids: [{ agent_url: OWNER, id: 'display_html', ...size }],
    }).v2,
  }));
  const result = legacyFit(legacyTag(), packages);
  assert.deepEqual(
    result.perPackage.map(entry => entry.verdict),
    ['insufficient_facts', 'fits']
  );
  assert.deepEqual(result.wire.selector.format_id, { agent_url: OWNER, id: 'display_html', width: 300, height: 600 });
});

test('legacy fit: unknown library routing hints preserve existing projection while identified package constraints bind', () => {
  const creative = image({ width: 300, height: 250 });
  const selectors = [{ format_ids: [{ agent_url: OWNER, id: 'display_728x90_image' }] }];
  assert.equal(
    projectSyncCreativesForDelivery({ creatives: [creative] }, selectors, 'legacy').creatives[0].format_id.id,
    'display_728x90_image'
  );
  const packages = selectors.map(selector => ({ ...selector, package_id: 'A' }));
  assert.equal(legacyFit(creative, packages).perPackage[0].verdict, 'does_not_fit');
  assert.throws(
    () => projectSyncCreativesForDelivery({ creatives: [creative] }, packages, 'legacy'),
    CreativeFormatProjectionError
  );
});

test('legacy fit: unscoped legacy restrictions still bind every identified package', () => {
  const result = legacyFit(legacyTag(), [
    legacyPackage('A', legacyHtml(300, 600)),
    { format_ids: [legacyHtml(320, 50)] },
  ]);
  assert.equal(result.perPackage[0].verdict, 'does_not_fit');
  assert.equal(result.wire, undefined);
});

for (const vector of vectors) {
  test(`published image density: ${vector.id}`, () => {
    const params = { ...vector.params };
    if (vector.slot) params.slots = [{ asset_group_id: 'image_main', asset_type: 'image', ...vector.slot }];
    const creative = image();
    creative.assets.image_main = vector.assets
      ? vector.assets.map(asset => ({ asset_type: 'image', ...asset }))
      : { asset_type: 'image', ...vector.asset };
    const result = fit(freeze(creative), freeze([pkg('A', declaration(params))]));
    assert.equal(result.perPackage[0].verdict === 'fits', vector.expected.valid, JSON.stringify(result));
  });
}

test('public API is available from the root entry point', () => {
  assert.equal(require('../../dist/lib').fitCreativeToPackages, fitCreativeToPackages);
});
test('rejects a tall banner against a small horizontal package before sync', () => {
  const creative = image({ width: 300, height: 600 });
  const packages = [pkg('A', declaration({ width: 320, height: 50 }))];
  const decision = fit(creative, packages);
  assert.equal(decision.perPackage[0].verdict, 'does_not_fit');
  assert.equal(decision.refusal.code, 'package_does_not_fit');
  assert.equal(decision.wire, undefined);
  assert.throws(
    () => projectSyncCreativesForDelivery({ creatives: [creative] }, packages, 'canonical'),
    /does not fit/
  );
});
test('same aspect ratio does not imply resizing permission', () => {
  assert.equal(
    fit(image({ width: 600, height: 500 }), [pkg('A', declaration({ sizes: [{ width: 300, height: 250 }] }))])
      .perPackage[0].verdict,
    'does_not_fit'
  );
});
test('measured facts need no synthesized format_parameters and appear in the wire creative', () => {
  const creative = freeze(image({ width: undefined, height: undefined }));
  const decision = fit(creative, [pkg('A', declaration({ width: 300, height: 250 }))], {
    primaryAssetFacts: { width: 300, height: 250 },
  });
  assert.equal(decision.perPackage[0].verdict, 'fits');
  assert.equal(decision.wire.creative.assets.image_main.width, 300);
  assert.equal(creative.assets.image_main.width, undefined);
  assert.equal(decision.wire.creative.format_parameters, undefined);
});
test('contradictory measurements fail rather than replacing facts', () => {
  const result = fit(image(), [pkg('A', declaration())], { primaryAssetFacts: { width: 320 } });
  assert.equal(result.perPackage[0].verdict, 'does_not_fit');
  assert.ok(result.perPackage[0].reasons.some(reason => reason.code === 'conflicting_facts'));
});
test('missing facts and incomplete declarations retain wire availability without claiming fit', () => {
  for (const [creative, option] of [
    [image({}), declaration({ width: 300, height: 250 })],
    [image(), { format_kind: 'image', params: {} }],
  ]) {
    const result = fit(creative, [pkg('A', option)]);
    assert.equal(result.perPackage[0].verdict, 'insufficient_facts');
    assert.equal(result.wire.mode, 'canonical');
  }
});
test('closed alternatives: any fit wins; unknown beats rejected; all rejected fail', () => {
  const reject = declaration({ width: 320, height: 50 });
  const unknown = declaration({ max_file_size_kb: 10 });
  const accept = declaration({ width: 300, height: 250 }, { format_option_id: 'rectangle' });
  assert.equal(fit(image(), [pkg('A', reject, unknown, accept)]).perPackage[0].verdict, 'fits');
  assert.equal(fit(image(), [pkg('A', reject, unknown)]).perPackage[0].verdict, 'insufficient_facts');
  assert.equal(fit(image(), [pkg('A', reject)]).perPackage[0].verdict, 'does_not_fit');
});
test('each package and each nested layer must fit; no assignment pooling', () => {
  const a = pkg('A', declaration({ width: 300, height: 250 }));
  const b = pkg('B', declaration({ width: 320, height: 50 }));
  assert.deepEqual(
    fit(image(), [a, b]).perPackage.map(item => item.verdict),
    ['fits', 'does_not_fit']
  );
  assert.equal(fit(image(), [{ package_id: 'A', selector_containers: [a, b] }]).perPackage[0].verdict, 'does_not_fit');
});
test('publisher pins cannot match a same-named option in a different namespace', () => {
  const creative = {
    ...image(),
    format_option_ref: { scope: 'publisher', publisher_domain: 'one.acme.example', format_option_id: 'rectangle' },
  };
  const result = fit(creative, [
    pkg('A', declaration({}, { publisher_domain: 'two.acme.example', format_option_id: 'rectangle' })),
  ]);
  assert.equal(result.wire, undefined);
});
test('nullable duration endpoints and exact-over-range precedence use measured duration', () => {
  const creative = {
    creative_id: 'v',
    name: 'Acme video',
    format_kind: 'video_hosted',
    assets: { video_main: { asset_type: 'video', duration_ms: 30000 } },
  };
  const option = params => ({ format_kind: 'video_hosted', technical_requirements_complete: true, params });
  assert.equal(fit(creative, [pkg('A', option({ duration_ms_range: [null, 30000] }))]).perPackage[0].verdict, 'fits');
  assert.equal(
    fit(creative, [pkg('A', option({ duration_ms_exact: 30000, duration_ms_range: [0, 1000] }))]).perPackage[0].verdict,
    'fits'
  );
  assert.equal(
    fit(creative, [pkg('A', option({ duration_ms_range: [30001, null] }))]).perPackage[0].verdict,
    'does_not_fit'
  );
});
test('unknown constraints and proposed adaptations cannot become a fit certificate', () => {
  for (const option of [
    declaration({ future_constraint: true }),
    declaration({}, { serve_adaptations: { resize: true } }),
  ])
    assert.equal(fit(image(), [pkg('A', option)]).perPackage[0].verdict, 'insufficient_facts');
});
test('required slots cannot be silently ignored', () => {
  const result = fit(image(), [
    pkg('A', declaration({ slots: [{ asset_group_id: 'logo', asset_type: 'image', required: true }] })),
  ]);
  assert.equal(result.perPackage[0].verdict, 'does_not_fit');
});
test('VAST player dimensions do not constrain intrinsic media, but one complete MediaFile witness is required', () => {
  const creative = {
    creative_id: 'vast',
    name: 'Acme VAST',
    format_kind: 'video_vast',
    assets: { vast_tag: { asset_type: 'vast', url: 'https://cdn.acme.example/tag.xml' } },
  };
  const option = {
    format_kind: 'video_vast',
    params: { min_width: 1920, media_file_requirements: { min_width: 640, codecs: ['h264'] } },
    technical_requirements_complete: true,
  };
  const packages = [pkg('A', option)];
  assert.equal(fit(creative, packages).perPackage[0].verdict, 'insufficient_facts');
  assert.equal(
    fit(creative, packages, {
      vastInlineCreatives: [{ creative_type: 'linear', media_files: [{ width: 640, codec: 'h264' }] }],
    }).perPackage[0].verdict,
    'fits'
  );
  assert.equal(
    fit(creative, packages, {
      vastInlineCreatives: [
        {
          creative_type: 'linear',
          media_files: [
            { width: 640, codec: 'vp9' },
            { width: 320, codec: 'h264' },
          ],
        },
      ],
    }).perPackage[0].verdict,
    'does_not_fit'
  );
});
test('packages can each fit VAST while legacy dimensions prevent one shared reference', () => {
  const creative = {
    creative_id: 'v',
    name: 'Acme tag',
    format_kind: 'video_vast',
    format_parameters: { duration_ms: 30000 },
    assets: { vast_tag: { asset_type: 'vast', url: 'https://cdn.acme.example/tag.xml' } },
  };
  const packages = [360, 480].map((height, index) =>
    pkg(`P${index}`, {
      format_kind: 'video_vast',
      params: { width: 640, height, duration_ms_exact: 30000 },
      technical_requirements_complete: true,
      v1_format_ref: [{ agent_url: OWNER, id: 'video_vast', width: 640, height, duration_ms: 30000 }],
    })
  );
  const result = fit(creative, packages, { adcpVersion: '3.1.0' });
  assert.deepEqual(
    result.perPackage.map(item => item.verdict),
    ['fits', 'fits']
  );
  assert.equal(result.wire, undefined);
  assert.equal(result.refusal.code, 'wire_projection_failed');
  assert.ok(result.refusal.conflicts.conflicts.some(item => item.constraint === 'size'));
  assert.equal(fit(creative, packages).wire.mode, 'canonical');
});
test('unrecognized versions throw before any projection', () => {
  for (const version of ['latest', '3.10garbage', '4.0.0'])
    assert.throws(() => fit(image(), [], { adcpVersion: version }), TypeError);
});

test('unique same-kind option is pinned on canonical wire and sync uses that selection', () => {
  const packages = [
    pkg(
      'A',
      declaration({ width: 320, height: 50 }, { format_option_id: 'small' }),
      declaration({ width: 300, height: 250 }, { format_option_id: 'rectangle' })
    ),
  ];
  const result = fit(image(), packages);
  assert.deepEqual(result.wire.selector.format_option_ref, { scope: 'product', format_option_id: 'rectangle' });
  const sync = projectSyncCreativesForDelivery({ creatives: [image()] }, packages, 'canonical');
  assert.deepEqual(sync.creatives[0].format_option_ref, result.wire.selector.format_option_ref);
});
test('several fitting same-kind options require an explicit pin', () => {
  const packages = [
    pkg('A', declaration({}, { format_option_id: 'one' }), declaration({}, { format_option_id: 'two' })),
  ];
  const result = fit(image(), packages);
  assert.equal(result.perPackage[0].verdict, 'fits');
  assert.equal(result.wire, undefined);
  assert.equal(result.refusal.reasons[0].code, 'format_option_ref_ambiguous');
  assert.equal(
    fit({ ...image(), format_option_ref: { scope: 'product', format_option_id: 'two' } }, packages).wire.selector
      .format_option_ref.format_option_id,
    'two'
  );
});
test('different required package pins cannot be collapsed into one canonical pin', () => {
  const packages = ['A', 'B'].map(id =>
    pkg(
      id,
      declaration({}, { format_option_id: id }),
      declaration({ width: 1, height: 1 }, { format_option_id: `${id}-other` })
    )
  );
  const result = fit(image(), packages);
  assert.deepEqual(
    result.perPackage.map(item => item.verdict),
    ['fits', 'fits']
  );
  assert.equal(result.wire, undefined);
});
test('canonical-capable 3.1 peers use the same negotiated wire mode as sync', () => {
  const packages = [pkg('A', declaration({}, { canonical_formats_only: true }))];
  const result = fit(image(), packages, { adcpVersion: '3.1.0', wireMode: 'canonical' });
  assert.equal(result.wire.mode, 'canonical');
  assert.equal(fit(image(), packages, { adcpVersion: '3.1.0' }).wire, undefined);
});
test('measured-only audio facts use channel layouts and detect codec contradictions', () => {
  const creative = {
    creative_id: 'audio',
    name: 'Acme audio',
    format_kind: 'audio_hosted',
    assets: { audio_main: { asset_type: 'audio', url: 'https://cdn.acme.example/audio.mp3' } },
  };
  const packages = [
    pkg('A', {
      format_kind: 'audio_hosted',
      technical_requirements_complete: true,
      params: { audio_channels: ['stereo'], audio_codecs: ['aac'] },
    }),
  ];
  const primaryAssetFacts = { channels: 'stereo', codec: 'aac' };
  assert.equal(fit(creative, packages, { primaryAssetFacts }).perPackage[0].verdict, 'fits');
  assert.equal(
    fit(creative, packages, { primaryAssetFacts: { ...primaryAssetFacts, audio_codec: 'mp3' } }).perPackage[0].verdict,
    'does_not_fit'
  );
});
test('missing default primaries and unproven aliases cannot establish a fit', () => {
  for (const kind of ['image', 'html5', 'display_tag', 'video_hosted', 'audio_hosted', 'video_vast']) {
    const result = fit({ creative_id: 'empty', name: 'Empty', format_kind: kind, assets: {} }, [
      pkg('A', { format_kind: kind, params: {}, technical_requirements_complete: true }),
    ]);
    assert.equal(result.perPackage[0].verdict, 'insufficient_facts', kind);
  }
  const creative = image();
  creative.assets = { unrelated_slot: creative.assets.image_main };
  assert.equal(fit(creative, [pkg('A', declaration())]).perPackage[0].verdict, 'insufficient_facts');
  assert.equal(
    fit(creative, [
      pkg('A', declaration({ slots: [{ asset_group_id: 'unrelated_slot', asset_type: 'image', required: true }] })),
    ]).perPackage[0].verdict,
    'fits'
  );
});
test('known partial dimension violations beat a missing other axis', () => {
  for (const kind of ['video_hosted', 'video_vast']) {
    const creative = {
      creative_id: 'partial',
      name: 'Partial',
      format_kind: kind,
      format_parameters: { width: 640 },
      assets:
        kind === 'video_vast'
          ? { vast_tag: { asset_type: 'vast' } }
          : { video_main: { asset_type: 'video', width: 640 } },
    };
    assert.equal(
      fit(creative, [
        pkg('A', { format_kind: kind, params: { width: 940, height: 529 }, technical_requirements_complete: true }),
      ]).perPackage[0].verdict,
      'does_not_fit'
    );
  }
});
test('VAST MIME evidence trims whitespace and ignores case', () => {
  const creative = {
    creative_id: 'v',
    name: 'Acme tag',
    format_kind: 'video_vast',
    assets: { vast_tag: { asset_type: 'vast' } },
  };
  const packages = [
    pkg('A', {
      format_kind: 'video_vast',
      params: { media_file_requirements: { mime_types: ['video/mp4'] } },
      technical_requirements_complete: true,
    }),
  ];
  assert.equal(
    fit(creative, packages, {
      vastInlineCreatives: [{ creative_type: 'linear', media_files: [{ mime_type: ' Video/MP4 ' }] }],
    }).perPackage[0].verdict,
    'fits'
  );
});
test('secondary slot density constraints remain unproven when unsupported', () => {
  const result = fit(image(), [
    pkg('A', declaration({ slots: [{ asset_group_id: 'logo', asset_type: 'image', pixel_ratios: [2] }] })),
  ]);
  assert.equal(result.perPackage[0].verdict, 'insufficient_facts');
});
test('invalid numeric measurements cannot be certified by unconstrained options', () => {
  for (const value of [NaN, Infinity, -1])
    assert.equal(
      fit(image(), [pkg('A', declaration())], { primaryAssetFacts: { bitrate_kbps: value } }).perPackage[0].verdict,
      'does_not_fit'
    );
});
test('dynamic diagnostics are bounded and safe for a single log line', () => {
  const key = 'seller\n\u0085\u2028' + 'x'.repeat(10000);
  const result = fit(image(), [pkg('A', declaration({ [key]: true }))]);
  for (const reason of result.perPackage[0].reasons) {
    assert.ok(reason.path.length <= 120);
    assert.doesNotMatch(reason.path, /[\x00-\x1f\x7f-\x9f\u2028\u2029]/);
  }
});
test('caller resolver errors propagate unchanged without leaking into fit diagnostics', () => {
  const error = new Error('private resolver failure');
  assert.throws(
    () =>
      fit(image(), [pkg('A', declaration())], {
        adcpVersion: '3.1.0',
        canonicalFormatLegacyResolver: () => {
          throw error;
        },
      }),
    caught => caught === error
  );
});
test('unscoped context cannot collide with a real package ID', () => {
  const result = fit(image(), [
    pkg('context[1]', declaration()),
    { format_options: [declaration({ width: 320, height: 50 })] },
  ]);
  assert.equal(result.perPackage.length, 1);
  assert.equal(result.perPackage[0].package_id, 'context[1]');
  assert.equal(result.perPackage[0].verdict, 'does_not_fit');
});
test('sync accepts the same creative measurements used for planning', () => {
  const creative = image({ width: undefined, height: undefined });
  const packages = [pkg('A', declaration({ width: 300, height: 250 }))];
  const primaryAssetFacts = { width: 300, height: 250 };
  const plan = fit(creative, packages, { primaryAssetFacts });
  const sync = projectSyncCreativesForDelivery(
    { creatives: [creative] },
    packages,
    'canonical',
    undefined,
    undefined,
    undefined,
    { creativeFacts: { image: { primaryAssetFacts } } }
  );
  assert.deepEqual(sync.creatives[0], plan.wire.creative);
});

test('legacy links never replace a complete canonical size or duration contract', () => {
  const option = declaration(
    { width: 300, height: 250 },
    { v1_format_ref: [{ agent_url: OWNER, id: 'display_image', width: 728, height: 90 }] }
  );
  assert.equal(fit(image({ width: 728, height: 90 }), [pkg('A', option)]).perPackage[0].verdict, 'does_not_fit');
  assert.equal(fit(image(), [pkg('A', option)]).perPackage[0].verdict, 'fits');
  assert.equal(fit(image(), [pkg('A', option)], { adcpVersion: '3.1.0' }).wire, undefined);
  const video = {
    creative_id: 'v',
    name: 'Acme video',
    format_kind: 'video_hosted',
    assets: { video_main: { asset_type: 'video', duration_ms: 60000 } },
  };
  const videoOption = {
    format_kind: 'video_hosted',
    params: { duration_ms_range: [15000, 30000] },
    technical_requirements_complete: true,
    v1_format_ref: [{ agent_url: OWNER, id: 'video', duration_ms: 60000 }],
  };
  assert.equal(fit(video, [pkg('A', videoOption)]).perPackage[0].verdict, 'does_not_fit');
});
test('overlapping executable-display sizes need proof of constrained selection', () => {
  const creative = {
    creative_id: 'display',
    name: 'Acme bundle',
    format_kind: 'html5',
    assets: {
      html5_bundle: {
        asset_type: 'zip',
        sizes: [
          { width: 300, height: 250 },
          { width: 728, height: 90 },
        ],
      },
    },
  };
  const packages = [
    pkg('A', { format_kind: 'html5', params: { width: 300, height: 250 }, technical_requirements_complete: true }),
  ];
  assert.equal(fit(creative, packages).perPackage[0].verdict, 'insufficient_facts');
});
test('release negotiation rejects contradictory wire-mode overrides', () => {
  assert.throws(() => fit(image(), [], { adcpVersion: '3.3.0', wireMode: 'legacy' }), /wireMode/);
  assert.throws(() => fit(image(), [], { adcpVersion: '3.0.0', wireMode: 'canonical' }), /wireMode/);
});
test('declared density and duration ranges must agree with measurements', () => {
  const creative = {
    ...image({ width: 600, height: 500, pixel_ratio: 2 }),
    format_parameters: { width: 300, height: 250, pixel_ratio: 1 },
  };
  assert.equal(
    fit(creative, [pkg('A', declaration({ width: 300, height: 250, pixel_ratios: [1, 2] }))]).perPackage[0].verdict,
    'does_not_fit'
  );
  const video = {
    creative_id: 'v',
    name: 'Acme video',
    format_kind: 'video_hosted',
    format_parameters: { duration_ms_range: [10000, 20000] },
    assets: { video_main: { asset_type: 'video' } },
  };
  const packages = [
    pkg('A', {
      format_kind: 'video_hosted',
      params: { duration_ms_range: [0, 60000] },
      technical_requirements_complete: true,
    }),
  ];
  assert.equal(
    fit(video, packages, { primaryAssetFacts: { duration_ms: 30000 } }).perPackage[0].verdict,
    'does_not_fit'
  );
});
test('standard display tag binds tag_url rather than a landing-page URL', () => {
  const creative = {
    creative_id: 'tag',
    name: 'Acme tag',
    format_kind: 'display_tag',
    assets: {
      tag_url: { asset_type: 'url', url_type: 'ad_request', url: 'https://ads.acme.example/tag' },
      landing_page_url: { asset_type: 'url', url_type: 'landing_page', url: 'https://shop.acme.example' },
    },
  };
  const packages = [
    pkg('A', {
      format_kind: 'display_tag',
      params: { supported_delivery_types: ['tag_url'] },
      technical_requirements_complete: true,
    }),
  ];
  assert.equal(fit(creative, packages).perPackage[0].verdict, 'fits');
});
test('non-default legacy density is retained or refused, never silently discarded', () => {
  const ref = { agent_url: OWNER, id: 'display_image', width: 300, height: 250, pixel_ratio: 2 };
  const packages = [pkg('A', declaration({ width: 300, height: 250, pixel_ratios: [2] }, { v1_format_ref: [ref] }))];
  const result = fit(image({ width: 600, height: 500, pixel_ratio: 2 }), packages, { adcpVersion: '3.1.0' });
  assert.equal(result.perPackage[0].verdict, 'fits');
  assert.equal(result.wire.selector.format_id.pixel_ratio, 2);
  const shared = fit(
    image({ width: 600, height: 500, pixel_ratio: 2 }),
    [...packages, { ...packages[0], package_id: 'B' }],
    { adcpVersion: '3.1.0' }
  );
  assert.ok(!shared.wire || shared.wire.selector.format_id.pixel_ratio === 2);
});
test('sync snapshots measured creative facts before capability discovery', async () => {
  const { SingleAgentClient, ADCP_VERSION } = require('../../dist/lib');
  // The SDK's own 3.3 preview pin: only the current beta bundle ships.
  const client = new SingleAgentClient(
    { id: 'fit-seller', name: 'Acme seller', protocol: 'mcp', agent_uri: 'https://seller.acme.example/mcp' },
    { adcpVersion: ADCP_VERSION, validation: { requests: 'off', responses: 'off' } }
  );
  const creative = image();
  const packages = [pkg('A', declaration({ width: 300, height: 250 }))];
  const primaryAssetFacts = { width: 300, height: 250 };
  client.resolveCreativeWireMode = async () => {
    primaryAssetFacts.width = 320;
    return 'canonical';
  };
  const calls = [];
  client.executeAndHandle = async (_tool, _handler, params) => {
    calls.push(params);
    return { success: true, status: 'completed' };
  };
  await client.syncCreatives({ account: { account_id: 'account' }, creatives: [creative] }, undefined, {
    creativeFormatProjection: { selectorContainers: packages, creativeFacts: { image: { primaryAssetFacts } } },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].creatives[0].assets.image_main.width, 300);
  assert.equal(calls[0].creativeFacts, undefined);
});

test('an unselected unsupported legacy ref does not poison a pinned valid route', () => {
  const ref = { agent_url: OWNER, id: 'display_image', width: 300, height: 250 };
  const packages = [
    pkg(
      'A',
      declaration({ width: 300, height: 250 }, { format_option_id: 'one', v1_format_ref: [ref] }),
      declaration(
        { width: 300, height: 250, pixel_ratios: [2] },
        { format_option_id: 'two', v1_format_ref: [{ ...ref, pixel_ratio: 2 }] }
      )
    ),
  ];
  const creative = { ...image(), format_option_ref: { scope: 'product', format_option_id: 'one' } };
  const result = fit(creative, packages, { adcpVersion: '3.1.0' });
  assert.equal(result.wire.mode, 'legacy');
  assert.deepEqual(result.wire.selector.format_id, ref);
});
test('native constraints bind even when the seller has not asserted completeness', () => {
  const option = {
    format_kind: 'image',
    params: { width: 300, height: 250 },
    v1_format_ref: [{ agent_url: OWNER, id: 'display_image', width: 728, height: 90 }],
  };
  for (const adcpVersion of ['3.1.0', '3.3.0'])
    assert.equal(
      fit(image({ width: 728, height: 90 }), [pkg('A', option)], { adcpVersion }).perPackage[0].verdict,
      'does_not_fit'
    );
});

test('inferred 2x image density cannot be downgraded to an ordinary 1x ref', () => {
  const packages = [
    pkg(
      'A',
      declaration(
        { width: 300, height: 250, pixel_ratios: [2] },
        { v1_format_ref: [{ agent_url: OWNER, id: 'display_image', width: 300, height: 250 }] }
      )
    ),
  ];
  const result = fit(image({ width: 600, height: 500 }), packages, { adcpVersion: '3.1.0' });
  assert.equal(result.perPackage[0].verdict, 'fits');
  assert.equal(result.wire, undefined);
});

test('planning needs an identified package; empty or solely unscoped context cannot certify acceptance', () => {
  for (const packages of [[], [{ format_options: [declaration()] }]]) {
    const result = fit(image(), packages);
    assert.equal(result.wire, undefined);
    assert.equal(result.refusal.code, 'package_context_missing');
  }
});
test('public decision values do not alias mutable caller assets', () => {
  const creative = image();
  const result = fit(creative, [pkg('A', declaration())]);
  result.wire.creative.assets.image_main.width = 10;
  assert.equal(creative.assets.image_main.width, 300);
});

test('explicit assignments retain unscoped technical layers just like planning', () => {
  const packages = [
    pkg('A', declaration({ width: 300, height: 250 })),
    { format_options: [declaration({ width: 320, height: 50 })] },
  ];
  assert.equal(fit(image(), packages).wire, undefined);
  assert.throws(
    () =>
      projectSyncCreativesForDelivery(
        { creatives: [image()], assignments: [{ creative_id: 'image', package_id: 'A' }] },
        packages,
        'canonical'
      ),
    /does not fit/
  );
});

test('explicit slot overrides cannot certify an undeclared default primary', () => {
  const creative = image();
  creative.assets.hero = { asset_type: 'image', width: 320, height: 50 };
  const packages = [
    pkg(
      'A',
      declaration({ width: 300, height: 250, slots: [{ asset_group_id: 'hero', asset_type: 'image', required: true }] })
    ),
  ];
  assert.equal(fit(creative, packages).perPackage[0].verdict, 'insufficient_facts');
  assert.equal(
    fit(creative, packages, { primaryAssetFacts: { asset_group_id: 'hero' } }).perPackage[0].verdict,
    'does_not_fit'
  );
});

test('wrong-typed default slot cannot establish a primary binding through another asset', () => {
  const creative = image();
  creative.assets.other = creative.assets.image_main;
  creative.assets.image_main = { asset_type: 'url', url: 'https://cdn.acme.example/landing' };
  assert.equal(
    fit(creative, [pkg('A', declaration({ width: 300, height: 250 }))]).perPackage[0].verdict,
    'insufficient_facts'
  );
});
test('multi-density legacy safety is independent of rendition order', () => {
  const params = {
    width: 300,
    height: 250,
    slots: [{ asset_group_id: 'image_main', asset_type: 'image', pixel_ratios: [1, 2], required_pixel_ratios: [1, 2] }],
  };
  const packages = [
    pkg(
      'A',
      declaration(params, { v1_format_ref: [{ agent_url: OWNER, id: 'display_image', width: 300, height: 250 }] })
    ),
  ];
  const renditions = [
    { asset_type: 'image', width: 300, height: 250, pixel_ratio: 1 },
    { asset_type: 'image', width: 600, height: 500, pixel_ratio: 2 },
  ];
  for (const values of [renditions, [...renditions].reverse()]) {
    const creative = { ...image(), assets: { image_main: values } };
    assert.equal(fit(creative, packages).perPackage[0].verdict, 'fits');
    assert.equal(fit(creative, packages, { adcpVersion: '3.1.0' }).wire, undefined);
  }
});
test('rounded aspect ratios retain the existing one-percent comparison', () => {
  const creative = {
    creative_id: 'video',
    name: 'Acme video',
    format_kind: 'video_hosted',
    assets: { video_main: { asset_type: 'video', width: 940, height: 529 } },
  };
  const option = aspect_ratio => ({
    format_kind: 'video_hosted',
    params: { aspect_ratio },
    technical_requirements_complete: true,
  });
  assert.equal(fit(creative, [pkg('A', option('16:9'))]).perPackage[0].verdict, 'fits');
  assert.equal(fit(creative, [pkg('A', option('9:16'))]).perPackage[0].verdict, 'does_not_fit');
});

test('display-tag measurements cannot relabel a landing page or ad-request URL', () => {
  const creative = {
    creative_id: 'tag',
    name: 'Acme tag',
    format_kind: 'display_tag',
    assets: { tag_url: { asset_type: 'url', url_type: 'landing_page', url: 'https://shop.acme.example' } },
  };
  const packages = [pkg('A', { format_kind: 'display_tag', params: {}, technical_requirements_complete: true })];
  assert.equal(fit(creative, packages).perPackage[0].verdict, 'does_not_fit');
  creative.assets.tag_url.url_type = 'ad_request';
  assert.equal(
    fit(creative, packages, { primaryAssetFacts: { delivery_type: 'inline_markup' } }).perPackage[0].verdict,
    'does_not_fit'
  );
});
test('planning can retain the same deprecated explicit VAST player-size override as sync', () => {
  const creative = {
    creative_id: 'v',
    name: 'Acme VAST',
    format_kind: 'video_vast',
    format_parameters: { duration_ms: 30000 },
    assets: { vast_tag: { asset_type: 'vast', url: 'https://cdn.acme.example/vast.xml' } },
  };
  const packages = [360, 480].map((height, index) =>
    pkg(`P${index}`, {
      format_kind: 'video_vast',
      params: { width: 640, height, duration_ms_exact: 30000 },
      v1_format_ref: [{ agent_url: OWNER, id: 'video_vast', width: 640, height, duration_ms: 30000 }],
    })
  );
  const policy = { playerSizedRefs: 'omit_unstated_size' };
  const result = fit(creative, packages, { adcpVersion: '3.1.0', ...policy });
  const sync = projectSyncCreativesForDelivery(
    { creatives: [creative] },
    packages,
    'legacy',
    undefined,
    undefined,
    undefined,
    policy
  );
  assert.deepEqual(result.wire.creative, sync.creatives[0]);
});

test('legacy density checks preserve OR alternatives and the selected full reference', () => {
  const ref = (width, height, pixel_ratio) => ({
    agent_url: OWNER,
    id: 'display_image',
    width,
    height,
    ...(pixel_ratio && { pixel_ratio }),
  });
  const packages = [
    pkg(
      'A',
      declaration(
        { width: 300, height: 250, pixel_ratios: [2] },
        { format_option_id: 'retina', v1_format_ref: [ref(300, 250, 2)] }
      ),
      declaration({ width: 600, height: 500 }, { format_option_id: 'native', v1_format_ref: [ref(600, 500)] })
    ),
  ];
  const result = fit(image({ width: 600, height: 500 }), packages, { adcpVersion: '3.1.0' });
  assert.equal(result.perPackage[0].verdict, 'fits');
  assert.equal(result.wire.mode, 'legacy');
  assert.deepEqual(result.wire.selector.format_id, ref(600, 500));
});

test('AND layers need one shared image density and logical-size interpretation', () => {
  const creative = image({ width: 600, height: 500 });
  const conflict = {
    package_id: 'A',
    format_options: [declaration({ width: 600, height: 500 })],
    selector_containers: [{ format_options: [declaration({ width: 300, height: 250, pixel_ratios: [2] })] }],
  };
  assert.equal(fit(creative, [conflict]).perPackage[0].verdict, 'does_not_fit');
  const compatible = {
    ...conflict,
    selector_containers: [{ format_options: [declaration({ width: 600, height: 500 })] }],
  };
  assert.equal(fit(creative, [compatible]).perPackage[0].verdict, 'fits');
  const alternatives = {
    ...conflict,
    format_options: [
      declaration({ width: 600, height: 500 }),
      declaration({ width: 300, height: 250, pixel_ratios: [2] }),
    ],
  };
  assert.equal(fit(creative, [alternatives]).perPackage[0].verdict, 'fits');
});
test('different packages can infer different image densities independently', () => {
  const result = fit(image({ width: 600, height: 500 }), [
    pkg('A', declaration({ width: 600, height: 500 })),
    pkg('B', declaration({ width: 300, height: 250, pixel_ratios: [2] })),
  ]);
  assert.deepEqual(
    result.perPackage.map(item => item.verdict),
    ['fits', 'fits']
  );
  assert.equal(result.wire.mode, 'canonical');
});
test('AND layers cannot independently inherit incompatible VAST placement sizes as proven fits', () => {
  const creative = {
    creative_id: 'v',
    name: 'Acme VAST',
    format_kind: 'video_vast',
    assets: { vast_tag: { asset_type: 'vast', url: 'https://cdn.acme.example/vast.xml' } },
  };
  const option = (width, height) => ({
    format_kind: 'video_vast',
    params: { width, height },
    technical_requirements_complete: true,
  });
  const packages = [
    {
      package_id: 'A',
      format_options: [option(640, 360)],
      selector_containers: [{ format_options: [option(940, 529)] }],
    },
  ];
  assert.equal(fit(creative, packages).perPackage[0].verdict, 'insufficient_facts');
});
test('a physical witness cannot borrow a different option legacy route', () => {
  const generic = { agent_url: OWNER, id: 'display_image', width: 300, height: 250 };
  const options = [
    declaration(
      { width: 300, height: 250, image_formats: ['png'] },
      { format_option_id: 'png-a', v1_format_ref: [generic] }
    ),
    declaration(
      { width: 300, height: 250, image_formats: ['png'] },
      { format_option_id: 'png-d', v1_format_ref: [generic] }
    ),
    declaration(
      { width: 300, height: 250, image_formats: ['jpeg'] },
      { format_option_id: 'jpeg-b', v1_format_ref: [{ agent_url: OWNER, id: 'display_300x250_image' }] }
    ),
  ];
  const result = fit(image({ width: 300, height: 250, format: 'png' }), [pkg('A', ...options)], {
    adcpVersion: '3.1.0',
  });
  assert.equal(result.perPackage[0].verdict, 'fits');
  assert.ok(!result.wire || result.wire.selector.format_id.id !== 'display_300x250_image');
});
test('untyped top-level constraints do not disappear behind nested declarations', () => {
  const result = fit(image(), [
    {
      package_id: 'A',
      params: { width: 320 },
      selector_containers: [{ format_options: [declaration({ width: 300, height: 250 })] }],
    },
  ]);
  assert.equal(result.perPackage[0].verdict, 'insufficient_facts');
});

test('product plus SDK package-selection sidecar is one logical option', () => {
  const { packageRefsForFormatOptions } = require('../../dist/lib/v2/projection');
  const product = {
    product_id: 'product',
    format_options: [declaration({ width: 300, height: 250 }, { format_option_id: 'mrec' })],
  };
  const selection = packageRefsForFormatOptions(product, ['mrec']);
  const result = fit(image(), [{ ...product, package_id: 'A', ...selection }]);
  assert.equal(result.perPackage[0].verdict, 'fits');
  assert.equal(result.wire.mode, 'canonical');
});
test('selected sidecars cannot widen a fresh native product contract', () => {
  const { packageRefsForFormatOptions } = require('../../dist/lib/v2/projection');
  const product = {
    product_id: 'product',
    format_options: [declaration({ width: 300, height: 250 }, { format_option_id: 'mrec' })],
  };
  const selection = packageRefsForFormatOptions(product, ['mrec']);
  const changed = {
    ...product,
    format_options: [declaration({ width: 320, height: 50 }, { format_option_id: 'mrec' })],
  };
  assert.equal(fit(image(), [{ ...changed, package_id: 'A', ...selection }]).perPackage[0].verdict, 'does_not_fit');
});

test('an explicitly empty native option set cannot regain a proven fit from old sidecars', () => {
  const { packageRefsForFormatOptions } = require('../../dist/lib/v2/projection');
  const product = {
    product_id: 'product',
    format_options: [declaration({ width: 300, height: 250 }, { format_option_id: 'mrec' })],
  };
  const selection = packageRefsForFormatOptions(product, ['mrec']);
  assert.notEqual(
    fit(image(), [{ ...product, format_options: [], package_id: 'A', ...selection }]).perPackage[0].verdict,
    'fits'
  );
});

test('a creative resolver cannot replace an authoritative linked option identity', () => {
  const creative = {
    ...image(),
    format_parameters: { width: 300, height: 250 },
    format_option_ref: { scope: 'product', format_option_id: 'pinned' },
  };
  const packages = [
    pkg(
      'A',
      declaration(
        { width: 300, height: 250 },
        { format_option_id: 'pinned', v1_format_ref: [{ agent_url: OWNER, id: 'display_728x90_image' }] }
      )
    ),
  ];
  const result = fit(creative, packages, {
    adcpVersion: '3.1.0',
    canonicalFormatLegacyResolver: context =>
      context.source === 'creative' ? { agent_url: OWNER, id: 'display_300x250_image' } : undefined,
  });
  assert.equal(result.perPackage[0].verdict, 'fits');
  assert.equal(result.wire, undefined);
});

test('fresh native legacy routes outrank stale selected sidecars', () => {
  const { packageRefsForFormatOptions } = require('../../dist/lib/v2/projection');
  const old = { agent_url: OWNER, id: 'display_300x250_image' };
  const fresh = { agent_url: OWNER, id: 'display_image', width: 300, height: 250 };
  const product = {
    product_id: 'product',
    format_options: [declaration({ width: 300, height: 250 }, { format_option_id: 'mrec', v1_format_ref: [old] })],
  };
  const selection = packageRefsForFormatOptions(product, ['mrec']);
  assert.equal(
    fit(image(), [{ ...product, package_id: 'A', ...selection }], { adcpVersion: '3.1.0' }).wire.selector.format_id.id,
    old.id
  );
  const changed = {
    ...product,
    format_options: [declaration({ width: 300, height: 250 }, { format_option_id: 'mrec', v1_format_ref: [fresh] })],
  };
  const result = fit(image(), [{ ...changed, package_id: 'A', ...selection }], { adcpVersion: '3.1.0' });
  assert.ok(!result.wire || result.wire.selector.format_id.id === fresh.id);
  const restored = {
    ...product,
    format_options: [declaration({ width: 300, height: 250 }, { format_option_id: 'mrec' })],
  };
  assert.equal(
    fit(image(), [{ ...restored, package_id: 'A', ...selection }], { adcpVersion: '3.1.0' }).wire.selector.format_id.id,
    old.id
  );
});
test('pinned mapped aliases cannot be widened by a creative resolver', () => {
  const first = { agent_url: OWNER, id: 'display_image', width: 300, height: 250 };
  const second = { ...first, agent_url: 'https://formats.acme.example/mcp' };
  const third = { ...first, agent_url: 'https://other.acme.example/mcp' };
  const packages = [
    pkg('A', declaration({ width: 300, height: 250 }, { format_option_id: 'pinned', v1_format_ref: [first, second] })),
  ];
  const creative = { ...image(), format_option_ref: { scope: 'product', format_option_id: 'pinned' } };
  let calls = 0;
  const result = fit(creative, packages, {
    adcpVersion: '3.1.0',
    canonicalFormatLegacyResolver: context => {
      if (context.source !== 'creative') return undefined;
      calls++;
      return third;
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.wire, undefined);
  const allowed = fit(creative, packages, {
    adcpVersion: '3.1.0',
    canonicalFormatLegacyResolver: context => (context.source === 'creative' ? first : undefined),
  });
  assert.deepEqual(allowed.wire.selector.format_id, first);
});
