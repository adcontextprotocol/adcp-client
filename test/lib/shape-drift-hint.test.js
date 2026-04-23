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
  assert.match(hint, /platform-native fields at the top level/);
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

test('each detector branch is scoped to its own tool', () => {
  // build_creative-specific fields (tag_url, media_type, tag_type) must not
  // trigger the sync_creatives or preview_creative branches, and vice versa.
  // Cross-tool patterns must not bleed across branches.
  assert.strictEqual(detectShapeDriftHint('get_products', { tag_url: 'x' }), undefined);
  assert.strictEqual(detectShapeDriftHint('preview_creative', { media_type: 'image/png' }), undefined);
  assert.strictEqual(detectShapeDriftHint('build_creative', { preview_url: 'https://x' }), undefined);
  // Each new branch must not steal the other new branch's signals:
  assert.strictEqual(detectShapeDriftHint('sync_creatives', { preview_url: 'x' }), undefined);
  assert.strictEqual(
    detectShapeDriftHint('preview_creative', { creative_id: 'c1', platform_id: 'p1', action: 'created' }),
    undefined
  );
});

test('empty / unrelated build_creative payload → no hint', () => {
  assert.strictEqual(detectShapeDriftHint('build_creative', {}), undefined);
  assert.strictEqual(detectShapeDriftHint('build_creative', { foo: 'bar' }), undefined);
});

// ────────────────────────────────────────────────────────────
// sync_creatives — single-creative shape bubbled up to top level
// ────────────────────────────────────────────────────────────

test('sync_creatives with top-level creative_id + platform_id + action → hint fires', () => {
  // Classic drift: handler returned one creative's row without wrapping
  // it in the creatives array.
  const hint = detectShapeDriftHint('sync_creatives', {
    creative_id: 'c1',
    platform_id: 'plat_abc',
    action: 'created',
  });
  assert.ok(hint, 'expected a hint for unwrapped per-item sync response');
  assert.match(hint, /single creative's inner shape/);
  assert.match(hint, /creatives: \[\{/);
  assert.match(hint, /syncCreativesResponse/);
  assert.match(hint, /@adcp\/client\/server/);
  assert.match(hint, /creative_id/);
});

test('sync_creatives with creatives array present → no hint', () => {
  const hint = detectShapeDriftHint('sync_creatives', {
    creatives: [{ creative_id: 'c1', action: 'created', platform_id: 'plat_abc' }],
  });
  assert.strictEqual(hint, undefined);
});

test('sync_creatives error branch (errors array) → no hint', () => {
  const hint = detectShapeDriftHint('sync_creatives', {
    errors: [{ code: 'UNAUTHENTICATED', message: 'bad token' }],
  });
  assert.strictEqual(hint, undefined);
});

test('sync_creatives submitted branch (task_id) → no hint', () => {
  const hint = detectShapeDriftHint('sync_creatives', {
    status: 'submitted',
    task_id: 'task-abc',
  });
  assert.strictEqual(hint, undefined);
});

test('sync_creatives with unrelated top-level fields → no hint', () => {
  // Empty payload and no-signal payloads must not trip the detector.
  assert.strictEqual(detectShapeDriftHint('sync_creatives', {}), undefined);
  assert.strictEqual(detectShapeDriftHint('sync_creatives', { sandbox: true }), undefined);
});

test('sync_creatives with wrong wrapper key { results: [...] } → hint suggests { creatives }', () => {
  // Copy-paste from preview_creative batch or a generic success envelope —
  // handler used `results` instead of `creatives`. Catch when `results`
  // contains per-item sync shapes.
  const hint = detectShapeDriftHint('sync_creatives', {
    results: [{ creative_id: 'c1', action: 'created', platform_id: 'plat_abc' }],
  });
  assert.ok(hint, 'expected a hint for wrong wrapper key');
  assert.match(hint, /results.*instead of.*creatives/);
  assert.match(hint, /wrong wrapper key/);
  assert.match(hint, /syncCreativesResponse/);
});

test('sync_creatives with results that do NOT look like creative rows → no hint', () => {
  // Generic `results: [...]` shape that doesn't carry creative_id/action
  // should not spuriously fire the wrong-wrapper branch.
  const hint = detectShapeDriftHint('sync_creatives', {
    results: [{ id: 'x1', value: 42 }],
  });
  assert.strictEqual(hint, undefined);
});

test('sync_creatives with both creatives and results → no hint (creatives wrapper wins)', () => {
  // If the handler emits BOTH wrappers, the detector must stay silent —
  // wrong-wrapper detection is gated on `!hasValidWrapper`.
  const hint = detectShapeDriftHint('sync_creatives', {
    creatives: [{ creative_id: 'c1', action: 'created' }],
    results: [{ creative_id: 'c1', action: 'created' }],
  });
  assert.strictEqual(hint, undefined);
});

// ────────────────────────────────────────────────────────────
// preview_creative — raw render fields at top level
// ────────────────────────────────────────────────────────────

test('preview_creative with top-level preview_url → hint fires', () => {
  const hint = detectShapeDriftHint('preview_creative', {
    preview_url: 'https://cdn.example/preview.html',
    expires_at: '2026-05-01T00:00:00Z',
  });
  assert.ok(hint, 'expected a hint for unwrapped render fields');
  assert.match(hint, /raw render fields at the top level/);
  assert.match(hint, /previews: \[\{ renders/);
  assert.match(hint, /previewCreativeResponse/);
  assert.match(hint, /@adcp\/client\/server/);
  assert.match(hint, /preview_url/);
});

test('preview_creative with top-level preview_html → hint fires', () => {
  const hint = detectShapeDriftHint('preview_creative', {
    preview_html: '<div>ad</div>',
  });
  assert.ok(hint);
  assert.match(hint, /preview_html/);
});

test('preview_creative single response (response_type + previews) → no hint', () => {
  const hint = detectShapeDriftHint('preview_creative', {
    response_type: 'single',
    previews: [{ preview_id: 'p1', renders: [{ preview_url: 'x' }], input: { name: 'default' } }],
    expires_at: '2026-05-01T00:00:00Z',
  });
  assert.strictEqual(hint, undefined);
});

test('preview_creative batch response (results array) → no hint', () => {
  const hint = detectShapeDriftHint('preview_creative', {
    response_type: 'batch',
    results: [{ success: true, creative_id: 'c1' }],
  });
  assert.strictEqual(hint, undefined);
});

test('preview_creative with only interactive_url → no hint (legitimate top-level field)', () => {
  // interactive_url is a valid top-level sibling on the single branch.
  // Flagging it alone would false-positive on legit responses that happen
  // to carry only that optional field above the previews array.
  const hint = detectShapeDriftHint('preview_creative', {
    response_type: 'single',
    previews: [{ preview_id: 'p1', renders: [], input: { name: 'default' } }],
    interactive_url: 'https://cdn.example/sandbox',
    expires_at: '2026-05-01T00:00:00Z',
  });
  assert.strictEqual(hint, undefined);
});

test('preview_creative with ONLY interactive_url and no wrapper → no hint', () => {
  // Defensive: even without any wrapper, `interactive_url` alone is not a
  // drift signal — a future maintainer refactoring the filter could break
  // the deliberate exclusion without this test catching it.
  const hint = detectShapeDriftHint('preview_creative', {
    interactive_url: 'https://cdn.example/sandbox',
  });
  assert.strictEqual(hint, undefined);
});

test('preview_creative empty payload → no hint', () => {
  assert.strictEqual(detectShapeDriftHint('preview_creative', {}), undefined);
});
