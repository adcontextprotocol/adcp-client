const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

// Exercise the current TypeScript sources without rebuilding the package.
require('tsx/cjs');
const assignments = require('../../src/lib/utils/creative-adapter.ts');
const formats = require('../../src/lib/utils/format-renders.ts');
const previews = require('../../src/lib/utils/preview-normalizer.ts');

describe('AdCP 3 creative assignment helpers', () => {
  test('reads assignments in order and preserves weights, placements, and extensions', () => {
    const creativeAssignments = [
      { creative_id: 'creative-a', weight: 30, placement_ids: ['placement-a'], ext: { rotation: 'a' } },
      { creative_id: 'creative-b', weight: 70 },
    ];
    const pkg = { package_id: 'package-a', creative_assignments: creativeAssignments, ext: { revision: 2 } };

    assert.strictEqual(assignments.getCreativeAssignments(pkg), creativeAssignments);
    assert.deepEqual(assignments.getCreativeIds(pkg), ['creative-a', 'creative-b']);
    assert.equal(assignments.usesV3CreativeAssignments(pkg), true);
    assert.strictEqual(assignments.normalizePackageResponse(pkg), pkg);
    const response = { media_buy_id: 'buy-a', packages: [pkg], ext: { revision: 3 } };
    assert.deepEqual(assignments.normalizeMediaBuyResponse(response), response);
    assert.strictEqual(assignments.normalizeMediaBuyResponse(response).packages[0], pkg);
  });

  test('cleans null assignments without changing null extension fields', () => {
    const pkg = { package_id: 'package-a', creative_assignments: null, products: null, ext: { revision: 2 } };
    const response = { media_buy_id: 'buy-a', packages: [pkg], ext: { revision: 3 } };
    assert.deepEqual(assignments.normalizeMediaBuyResponse(response), {
      ...response,
      packages: [{ package_id: 'package-a', products: null, ext: { revision: 2 } }],
    });
    assert.equal(pkg.creative_assignments, null);
    assert.equal(pkg.products, null);
    assert.deepEqual(assignments.getCreativeAssignments({}), []);
    assert.deepEqual(assignments.getCreativeIds({ creative_assignments: [] }), []);
    assert.equal(assignments.usesV3CreativeAssignments({ creative_assignments: [] }), true);
  });

  test('does not infer assignments from legacy creative IDs', () => {
    const legacy = { creative_ids: ['legacy-creative'], ext: { revision: 2 } };
    assert.strictEqual(assignments.normalizePackageResponse(legacy), legacy);
    assert.equal(assignments.normalizePackageResponse(legacy).creative_assignments, undefined);
    assert.deepEqual(assignments.getCreativeAssignments(legacy), []);
    assert.deepEqual(assignments.getCreativeIds(legacy), []);
    assert.equal(assignments.usesV3CreativeAssignments(legacy), false);

    const modern = { ...legacy, creative_assignments: [{ creative_id: 'modern-creative' }] };
    assert.deepEqual(assignments.getCreativeIds(modern), ['modern-creative']);
  });
});

describe('AdCP 3 format render helpers', () => {
  test('selects primary and companion renders while preserving their complete data', () => {
    const companion = { render_id: 'banner', role: 'companion', dimensions: { width: 300, height: 250 } };
    const primary = {
      render_id: 'video',
      role: 'primary',
      dimensions: { width: 1920, height: 1080 },
      ext: { player: 'seller-player' },
    };
    const format = { format_id: { id: 'video' }, renders: [companion, primary], ext: { revision: 2 } };

    assert.strictEqual(formats.normalizeFormatRenders(format), format);
    assert.strictEqual(formats.getFormatRenders(format), format.renders);
    assert.strictEqual(formats.getPrimaryRender(format), primary);
    assert.strictEqual(formats.getFormatDimensions(format), primary.dimensions);
    assert.deepEqual(formats.getCompanionRenders(format), [companion]);
    assert.equal(formats.isMultiRenderFormat(format), true);
    assert.equal(formats.usesV3Renders(format), true);
    assert.strictEqual(formats.getPrimaryRender({ renders: [companion] }), companion);

    const response = { formats: [format], ext: { cursor: 'next' } };
    assert.strictEqual(formats.normalizeFormatsResponse(response), response);
    assert.deepEqual(formats.normalizeFormatsResponse([format]), { formats: [format] });
  });

  test('preserves parameterized renders without inventing dimensions', () => {
    const parameterized = { render_id: 'audio', role: 'primary', parameters_from_format_id: true };
    assert.deepEqual(formats.getFormatRenders({ renders: [parameterized] }), [parameterized]);
    assert.equal(formats.getFormatDimensions({ renders: [parameterized] }), undefined);
    assert.equal(formats.getPrimaryRender({ renders: [] }), undefined);
    assert.equal(formats.isMultiRenderFormat({}), false);
  });

  test('does not promote top-level dimensions into renders', () => {
    for (const legacy of [{ width: 300, height: 250 }, { dimensions: { width: 300, height: 250 } }]) {
      assert.strictEqual(formats.normalizeFormatRenders(legacy), legacy);
      assert.equal(formats.normalizeFormatRenders(legacy).renders, undefined);
      assert.deepEqual(formats.getFormatRenders(legacy), []);
      assert.equal(formats.getFormatDimensions(legacy), undefined);
      assert.equal(formats.getPrimaryRender(legacy), undefined);
      assert.equal(formats.usesV3Renders(legacy), false);
    }
  });
});

describe('AdCP 3 preview render helpers', () => {
  const renderer = {
    renderer_id: 'seller-renderer',
    version: '1.2.3',
    export: 'display',
    fidelity: 'representative',
    tracking_suppressed: true,
    ext: { provenance: 'seller' },
  };
  const companion = {
    render_id: 'companion',
    role: 'companion',
    output_format: 'url',
    preview_url: 'https://preview.example/companion',
  };
  const primary = {
    render_id: 'display',
    role: 'primary',
    output_format: 'both',
    preview_url: 'https://preview.example/display',
    preview_html: '<div>Preview</div>',
    dimensions: { width: 300, height: 250 },
    embedding: { requires_https: true, ext: { sandbox: 'strict' } },
    renderer,
    ext: { revision: 2 },
  };
  const preview = {
    preview_id: 'preview-a',
    expires_at: '2027-01-01T00:00:00Z',
    renders: [companion, primary],
    ext: { source: 'seller' },
  };

  test('preserves renderer provenance and all nested extensions', () => {
    assert.strictEqual(previews.normalizePreviewRender(primary), primary);
    assert.strictEqual(previews.normalizePreview(preview), preview);
    const single = { previews: [preview], ext: { revision: 3 } };
    assert.strictEqual(previews.normalizePreviewCreativeResponse(single), single);
    const batch = {
      results: [
        { success: true, response: single, ext: { request: 'a' } },
        { success: false, error: { code: 'NOT_FOUND' } },
      ],
      ext: { revision: 4 },
    };
    assert.deepEqual(previews.normalizePreviewCreativeResponse(batch), batch);
    assert.strictEqual(previews.normalizePreviewCreativeResponse(batch).results[0].response.previews[0], preview);
  });

  test('selects supplied primary render and falls back to the first supplied render', () => {
    assert.strictEqual(previews.getPrimaryPreviewRender(preview), primary);
    assert.equal(previews.getRenderId(primary), 'display');
    assert.equal(previews.getRenderRole(primary), 'primary');
    assert.equal(previews.usesV3RenderFields(primary), true);
    assert.equal(previews.getPreviewUrl(preview), primary.preview_url);
    assert.equal(previews.getPreviewHtml(preview), primary.preview_html);
    assert.strictEqual(previews.getPrimaryPreviewRender({ renders: [companion] }), companion);
    assert.equal(previews.getPrimaryPreviewRender({ renders: [] }), undefined);
    assert.equal(previews.getPreviewUrl({ renders: [] }), undefined);
    assert.equal(previews.getPreviewHtml({ renders: [] }), undefined);
  });

  test('does not promote legacy output fields or invent render identifiers and roles', () => {
    const legacy = { output_id: 'legacy-id', output_role: 'primary', output_format: 'url' };
    const missing = { output_format: 'url' };
    for (const render of [legacy, missing]) {
      assert.strictEqual(previews.normalizePreviewRender(render), render);
      assert.equal(previews.normalizePreviewRender(render).render_id, undefined);
      assert.equal(previews.normalizePreviewRender(render).role, undefined);
      assert.equal(previews.getRenderId(render), undefined);
      assert.equal(previews.getRenderRole(render), undefined);
      assert.equal(previews.usesV3RenderFields(render), false);
    }
    const mixed = { ...legacy, render_id: 'modern-id', role: 'companion' };
    assert.equal(previews.getRenderId(mixed), 'modern-id');
    assert.equal(previews.getRenderRole(mixed), 'companion');
  });
});
