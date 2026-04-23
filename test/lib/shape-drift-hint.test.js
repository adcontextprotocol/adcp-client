/**
 * Tests for detectShapeDriftHint — the actionable-recipe emitter that
 * recognizes common response-shape mistakes and surfaces next to the
 * schema error.
 *
 * The motivating bug: scope3 agentic-adapters#100 returned a build_creative
 * response with { tag_url, creative_id, media_type } at the top level
 * instead of { creative_manifest: { format_id, assets } }. A bare AJV
 * pointer ("/ must have required property 'creative_manifest'") doesn't
 * tell a developer they have the shape inverted — this hint does.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { detectShapeDriftHint } = require('../../dist/lib/testing/storyboard/validations');

test('build_creative with platform-native tag_url at top level → hint fires', () => {
  const hint = detectShapeDriftHint('build_creative', {
    tag_url: 'https://cdn.example.com/ad.mp3',
    creative_id: 'c1',
    media_type: 'audio/mpeg',
  });
  assert.ok(hint, 'expected a hint for platform-native shape');
  assert.match(hint, /platform-native response/);
  assert.match(hint, /creative_manifest/);
  assert.match(hint, /buildCreativeResponse/);
  assert.match(hint, /@adcp\/client\/server/);
  // Names which offending fields were found so the reader sees the evidence
  assert.match(hint, /tag_url/);
});

test('build_creative with creative_manifest present → no hint (correct shape)', () => {
  const hint = detectShapeDriftHint('build_creative', {
    creative_manifest: {
      format_id: { agent_url: 'https://audiostack.example', id: 'audio_ad' },
      assets: {},
    },
  });
  assert.strictEqual(hint, undefined);
});

test('build_creative with creative_manifests (multi) → no hint', () => {
  const hint = detectShapeDriftHint('build_creative', {
    creative_manifests: [
      {
        format_id: { agent_url: 'https://x.example', id: 'f1' },
        assets: {},
      },
    ],
  });
  assert.strictEqual(hint, undefined);
});

test('partial drift: tag_type alone without creative_manifest → hint fires', () => {
  // Any single platform-native key without creative_manifest earns a hint.
  const hint = detectShapeDriftHint('build_creative', { tag_type: 'url' });
  assert.ok(hint);
  assert.match(hint, /tag_type/);
});

test('other tools are unaffected by the build_creative heuristic', () => {
  // A tag_url in a tool response that isn't build_creative must not trip
  // the hint — the pattern is build_creative-specific.
  assert.strictEqual(detectShapeDriftHint('get_products', { tag_url: 'x' }), undefined);
  assert.strictEqual(detectShapeDriftHint('sync_creatives', { creative_id: 'c1' }), undefined);
  assert.strictEqual(detectShapeDriftHint('preview_creative', { media_type: 'image/png' }), undefined);
});

test('empty / unrelated build_creative payload → no hint', () => {
  assert.strictEqual(detectShapeDriftHint('build_creative', {}), undefined);
  assert.strictEqual(detectShapeDriftHint('build_creative', { foo: 'bar' }), undefined);
});
