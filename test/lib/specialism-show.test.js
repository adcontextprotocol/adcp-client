/**
 * Tests for `loadSpecialismDetail` — the resolution that powers
 * `adcp specialism show <slug>`.
 *
 * Anchors against the bundled compliance cache so a regression here
 * (renamed slug, broken requires_scenarios linkage) surfaces immediately.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const { listSpecialisms, loadSpecialismDetail } = require('../../dist/lib/testing/storyboard/index.js');

describe('listSpecialisms', () => {
  test('returns the kebab-case slugs from the compliance index', () => {
    const items = listSpecialisms();
    assert.ok(items.length > 0, 'expected at least one specialism');
    const slugs = items.map(s => s.id);
    assert.ok(slugs.includes('sales-guaranteed'), 'sales-guaranteed should be present');
    assert.ok(slugs.includes('creative-template'), 'creative-template should be present');
  });
});

describe('loadSpecialismDetail', () => {
  test('resolves the storyboard + required scenarios for sales-guaranteed', () => {
    const detail = loadSpecialismDetail('sales-guaranteed');
    assert.strictEqual(detail.slug, 'sales-guaranteed');
    assert.strictEqual(detail.protocol, 'media-buy');
    assert.ok(detail.storyboard, 'storyboard must be loaded');
    assert.ok(detail.storyboard.phases.length > 0, 'storyboard must have phases');
    assert.ok(
      detail.required_scenarios.length > 0,
      'sales-guaranteed declares requires_scenarios; resolver must produce non-empty set'
    );
    assert.deepStrictEqual(
      detail.unresolved_scenarios,
      [],
      'all required scenarios must resolve from the bundled cache'
    );
  });

  test('required_scenarios entries each carry an id and at least one step', () => {
    const detail = loadSpecialismDetail('sales-guaranteed');
    for (const sb of detail.required_scenarios) {
      assert.ok(sb.id, 'scenario must have an id');
      const stepCount = sb.phases.reduce((n, p) => n + p.steps.length, 0);
      assert.ok(stepCount > 0, `scenario ${sb.id} must have at least one step`);
    }
  });

  test('unknown slug throws with a guide to known slugs', () => {
    assert.throws(
      () => loadSpecialismDetail('not-a-real-slug'),
      err => {
        assert.match(err.message, /Unknown specialism "not-a-real-slug"/);
        assert.match(err.message, /Known specialisms:/);
        return true;
      }
    );
  });
});
