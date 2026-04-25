/**
 * Structured `ShapeDriftHint` emission (issue #935).
 *
 * The legacy `detectShapeDriftHint` (string) is exercised by
 * `test/lib/shape-drift-hint.test.js` — those tests cover prose content
 * for every detection branch. This file covers the *structured* surface
 * that downstream renderers (CLI, Addie, JUnit) consume:
 *   - `kind: 'shape_drift'` is set verbatim (discriminator stability)
 *   - `tool` matches the dispatched task
 *   - `observed_variant` / `expected_variant` are the documented tokens
 *   - `instance_path` follows RFC 6901 (`""` for root, `/results` for
 *     wrong-wrapper-key drift)
 *   - `message` matches the legacy prose so consumers that only render
 *     `message` keep working
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { detectShapeDriftHints } = require('../../dist/lib/testing/storyboard/shape-drift-hints.js');

describe('detectShapeDriftHints: bare-array → list-tool wrapper', () => {
  test('list_creatives bare array → observed_variant=bare_array, instance_path=""', () => {
    const [hint] = detectShapeDriftHints('list_creatives', [{ creative_id: 'c1' }]);
    assert.ok(hint, 'expected exactly one hint');
    assert.equal(hint.kind, 'shape_drift');
    assert.equal(hint.tool, 'list_creatives');
    assert.equal(hint.observed_variant, 'bare_array');
    assert.equal(hint.expected_variant, '{ creatives: [...] }');
    assert.equal(hint.instance_path, '');
    assert.match(hint.message, /list_creatives/);
    assert.match(hint.message, /listCreativesResponse/);
  });

  test('get_products bare array → expected_variant names the products wrapper', () => {
    const [hint] = detectShapeDriftHints('get_products', [{ product_id: 'p1' }]);
    assert.equal(hint.expected_variant, '{ products: [...] }');
    assert.match(hint.message, /productsResponse/);
  });

  test('unknown tool with bare array → no hint (avoids false positives)', () => {
    const hints = detectShapeDriftHints('unknown_tool', [{ id: 1 }]);
    assert.deepEqual(hints, []);
  });
});

describe('detectShapeDriftHints: build_creative platform-native fields', () => {
  test('platform-native fields → observed_variant=platform_native_fields', () => {
    const [hint] = detectShapeDriftHints('build_creative', {
      tag_url: 'https://cdn.example.com/ad.mp3',
      creative_id: 'c1',
      media_type: 'audio/mpeg',
    });
    assert.ok(hint);
    assert.equal(hint.kind, 'shape_drift');
    assert.equal(hint.tool, 'build_creative');
    assert.equal(hint.observed_variant, 'platform_native_fields');
    assert.equal(hint.expected_variant, '{ creative_manifest: { format_id, assets } }');
    assert.equal(hint.instance_path, '');
  });

  test('valid creative_manifest → no hint', () => {
    const hints = detectShapeDriftHints('build_creative', {
      creative_manifest: { format_id: { agent_url: 'https://x', id: 'f' }, assets: {} },
    });
    assert.deepEqual(hints, []);
  });
});

describe('detectShapeDriftHints: sync_creatives drift variants', () => {
  test('per-item shape at top level → observed_variant=per_item_shape', () => {
    const [hint] = detectShapeDriftHints('sync_creatives', {
      creative_id: 'c1',
      action: 'created',
    });
    assert.equal(hint.observed_variant, 'per_item_shape');
    assert.equal(hint.instance_path, '');
  });

  test('wrong wrapper key { results } → observed_variant=wrong_wrapper_key, instance_path=/results', () => {
    const [hint] = detectShapeDriftHints('sync_creatives', {
      results: [{ creative_id: 'c1', action: 'created' }],
    });
    assert.equal(hint.observed_variant, 'wrong_wrapper_key');
    assert.equal(hint.instance_path, '/results');
    assert.match(hint.message, /wrong wrapper key/);
  });
});

describe('detectShapeDriftHints: preview_creative raw render fields', () => {
  test('top-level preview_url → observed_variant=raw_render_fields', () => {
    const [hint] = detectShapeDriftHints('preview_creative', {
      preview_url: 'https://cdn.example/preview.html',
    });
    assert.equal(hint.observed_variant, 'raw_render_fields');
    assert.match(hint.expected_variant, /response_type: 'single'/);
  });

  test('valid response_type + previews → no hint', () => {
    const hints = detectShapeDriftHints('preview_creative', {
      response_type: 'single',
      previews: [],
    });
    assert.deepEqual(hints, []);
  });
});

describe('detectShapeDriftHints: defensive', () => {
  test('null payload → no hint (does not throw)', () => {
    assert.deepEqual(detectShapeDriftHints('list_creatives', null), []);
  });

  test('primitive payload → no hint', () => {
    assert.deepEqual(detectShapeDriftHints('build_creative', 'oops'), []);
  });

  test('returns at most one hint per call', () => {
    // sync_creatives can match two patterns simultaneously (per-item shape
    // AND results array), but the detector emits one hint by design — the
    // first match wins so the operator sees one fix at a time.
    const hints = detectShapeDriftHints('sync_creatives', {
      creative_id: 'c1',
      action: 'created',
      results: [{ creative_id: 'c2', action: 'updated' }],
    });
    assert.equal(hints.length, 1);
    // The earlier `if` (per-item) wins.
    assert.equal(hints[0].observed_variant, 'per_item_shape');
  });
});

describe('detectShapeDriftHint (string shim): delegates to structured detector', () => {
  // The string-only shim in validations.ts must return the same `message`
  // the structured detector produces — issue #935 unified detection so
  // the two surfaces can't drift apart.
  const { detectShapeDriftHint } = require('../../dist/lib/testing/storyboard/validations.js');

  test('shim returns the same message as structured detector', () => {
    const payload = [{ creative_id: 'c1' }];
    const [structured] = detectShapeDriftHints('list_creatives', payload);
    const shim = detectShapeDriftHint('list_creatives', payload);
    assert.equal(shim, structured.message);
  });

  test('shim returns undefined when no drift detected', () => {
    assert.equal(detectShapeDriftHint('build_creative', { creative_manifest: {} }), undefined);
  });
});
