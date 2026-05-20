// Publisher-catalog helpers (AdCP 3.1) — extract / scope / resolve
// against the Meta community-mirror catalog the AAO hosts for
// publishers who haven't adopted adagents.json#/formats directly yet.
//
// Tests run unconditionally — the vendored fixture at
// test/lib/v2-projection-fixtures/community/meta.json is byte-identical
// to upstream (per .prettierignore on that subdirectory), so the SDK
// test surface doesn't depend on syncing a specific cache version.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const {
  extractPublisherFormats,
  scopePublisherFormats,
  resolveCapabilityId,
} = require('../../dist/lib/v2/publisher-catalog/index.js');

const META_FIXTURE_PATH = path.join(__dirname, 'v2-projection-fixtures', 'community', 'meta.json');
const META = JSON.parse(readFileSync(META_FIXTURE_PATH, 'utf-8'));

describe('extractPublisherFormats', () => {
  test('returns all formats from a 3.1 adagents.json', () => {
    const formats = extractPublisherFormats(META);
    assert.strictEqual(formats.length, 4, 'meta fixture has 4 formats');
    const capIds = formats.map(f => f.capability_id).sort();
    assert.deepStrictEqual(capIds, ['meta_feed_carousel', 'meta_feed_image', 'meta_reels', 'meta_stories_video']);
  });

  test('returns [] for a 3.0.x adagents.json without `formats[]`', () => {
    // Simulates a publisher who hasn't adopted 3.1 yet — the field is
    // simply absent; SDK doesn't throw.
    assert.deepStrictEqual(extractPublisherFormats({ authorized_agents: [], properties: [] }), []);
  });

  test('returns [] for null/undefined input (no AdAgentsJson resolved)', () => {
    // Defensive: callers may pipe a discovery result that failed to
    // resolve (404 + no MANAGERDOMAIN). Don't crash.
    assert.deepStrictEqual(extractPublisherFormats(null), []);
    assert.deepStrictEqual(extractPublisherFormats(undefined), []);
  });
});

describe('scopePublisherFormats — by propertyId', () => {
  const formats = extractPublisherFormats(META);

  test('matches formats scoped to the requested propertyId', () => {
    // All Meta formats are scoped to ['instagram', 'facebook']. The
    // request for 'instagram' should match all 4.
    const scoped = scopePublisherFormats(formats, { propertyId: 'instagram' });
    assert.strictEqual(scoped.length, 4);
  });

  test('excludes formats scoped to a different propertyId', () => {
    // No Meta format is scoped to 'whatsapp' — should return 0.
    const scoped = scopePublisherFormats(formats, { propertyId: 'whatsapp' });
    assert.strictEqual(scoped.length, 0);
  });

  test('includes formats with no `applies_to_*` regardless of propertyId', () => {
    // Synthesize a fixture with one unscoped + one scoped format.
    const mixed = [
      { capability_id: 'unscoped', format_kind: 'image' }, // no applies_to_*
      { capability_id: 'scoped', format_kind: 'image', applies_to_property_ids: ['x'] },
    ];
    const scoped = scopePublisherFormats(mixed, { propertyId: 'y' });
    // Unscoped matches (universal); scoped doesn't match 'y'.
    assert.strictEqual(scoped.length, 1);
    assert.strictEqual(scoped[0].capability_id, 'unscoped');
  });
});

describe('scopePublisherFormats — by propertyTags', () => {
  test('matches formats whose applies_to_property_tags overlaps the request', () => {
    const fixture = [
      { capability_id: 'feed', format_kind: 'image', applies_to_property_tags: ['feed'] },
      { capability_id: 'story', format_kind: 'image', applies_to_property_tags: ['story', 'short_form'] },
      { capability_id: 'feed_and_story', format_kind: 'image', applies_to_property_tags: ['feed', 'story'] },
    ];
    const scoped = scopePublisherFormats(fixture, { propertyTags: ['feed'] });
    const capIds = scoped.map(f => f.capability_id).sort();
    assert.deepStrictEqual(capIds, ['feed', 'feed_and_story']);
  });

  test('returns [] when no scoped format matches the requested tag', () => {
    const fixture = [{ capability_id: 'a', format_kind: 'image', applies_to_property_tags: ['x'] }];
    const scoped = scopePublisherFormats(fixture, { propertyTags: ['y'] });
    assert.strictEqual(scoped.length, 0);
  });
});

describe('scopePublisherFormats — empty scope', () => {
  test('returns only formats with no `applies_to_*` (publisher defaults)', () => {
    const formats = extractPublisherFormats(META);
    // All Meta formats are scoped to instagram/facebook, so empty scope
    // returns 0 (none are "universal defaults").
    const defaults = scopePublisherFormats(formats, {});
    assert.strictEqual(defaults.length, 0);
  });
});

describe('resolveCapabilityId', () => {
  const formats = extractPublisherFormats(META);

  test('finds a format by capability_id', () => {
    const found = resolveCapabilityId(formats, 'meta_reels');
    assert.ok(found, 'meta_reels should resolve');
    assert.strictEqual(found.format_kind, 'video_hosted');
    assert.deepStrictEqual(found.applies_to_property_ids, ['instagram', 'facebook']);
  });

  test('returns undefined when capability_id has no match', () => {
    const found = resolveCapabilityId(formats, 'meta_nonexistent');
    assert.strictEqual(found, undefined);
  });

  test('returns first match when capability_ids collide (publisher bug)', () => {
    // Spec leaves uniqueness to the publisher; helpers stay deterministic
    // by returning the first match in document order. Surfacing the
    // collision is the publisher's responsibility.
    const dupes = [
      { capability_id: 'x', format_kind: 'image', display_name: 'first' },
      { capability_id: 'x', format_kind: 'video_hosted', display_name: 'second' },
    ];
    const found = resolveCapabilityId(dupes, 'x');
    assert.strictEqual(found?.display_name, 'first');
  });
});
