/**
 * Coverage for the specialism→required-tools runtime validator
 * (`src/lib/server/decisioning/validate-specialisms.ts`). This is option B
 * of #1299 — the runtime warning at server creation that catches adopters
 * declaring a specialism but forgetting to implement one of its required
 * methods.
 *
 * Spec reference: `manifest.json`'s `SPECIALISM_REQUIRED_TOOLS` (derived in
 * `manifest.generated.ts`); the validator looks up the per-specialism tool
 * list and checks `platform.{any-field}.{snakeToCamelCase(tool)}` exists
 * as a function.
 *
 * Note on synthetic test data: AdCP 3.0.4 ships every specialism with an
 * empty `required_tools` field, so the manifest-derived
 * `SPECIALISM_REQUIRED_TOOLS` lookup is empty. Tests inject synthetic data
 * via the validator's optional `requiredToolsLookup` parameter so the
 * validator's behavior can be exercised regardless of whether the spec
 * has populated authoritative required-tools lists yet.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateSpecialismRequiredTools,
  toolNameToMethodName,
  formatSpecialismIssue,
} = require('../../dist/lib/server/decisioning/validate-specialisms');

// Synthetic per-specialism required-tools lookup. Mirrors what the spec
// would populate in manifest.specialisms[*].required_tools once authors
// commit to canonical lists. Used here purely for test isolation.
const SYNTHETIC_REQUIREMENTS = {
  'sales-non-guaranteed': [
    'create_media_buy',
    'get_media_buy_delivery',
    'get_media_buys',
    'get_products',
    'sync_accounts',
    'sync_creatives',
    'update_media_buy',
  ],
  'signal-owned': ['activate_signal', 'get_signals'],
};

describe('toolNameToMethodName: snake_case → camelCase', () => {
  it('handles single-word', () => {
    assert.equal(toolNameToMethodName('foo'), 'foo');
  });
  it('handles two-word', () => {
    assert.equal(toolNameToMethodName('get_products'), 'getProducts');
  });
  it('handles three-word', () => {
    assert.equal(toolNameToMethodName('provide_performance_feedback'), 'providePerformanceFeedback');
  });
  it('preserves an already-camelCase name (no-op)', () => {
    assert.equal(toolNameToMethodName('getProducts'), 'getProducts');
  });
});

describe('validateSpecialismRequiredTools', () => {
  it('returns no issues when no specialisms are declared', () => {
    const platform = { sales: { getProducts: () => null } };
    assert.deepEqual(validateSpecialismRequiredTools(platform, undefined, SYNTHETIC_REQUIREMENTS), []);
    assert.deepEqual(validateSpecialismRequiredTools(platform, [], SYNTHETIC_REQUIREMENTS), []);
  });

  it('returns no issues when every required method exists somewhere on the platform', () => {
    const platform = {
      sales: {
        getProducts: () => null,
        createMediaBuy: () => null,
        updateMediaBuy: () => null,
        getMediaBuys: () => null,
        getMediaBuyDelivery: () => null,
        syncCreatives: () => null,
      },
      accounts: { syncAccounts: () => null },
    };
    assert.deepEqual(
      validateSpecialismRequiredTools(platform, ['sales-non-guaranteed'], SYNTHETIC_REQUIREMENTS),
      []
    );
  });

  it('flags missing methods with specialism + tool + method names', () => {
    const platform = { sales: {} };
    const issues = validateSpecialismRequiredTools(
      platform,
      ['sales-non-guaranteed'],
      SYNTHETIC_REQUIREMENTS
    );
    assert.equal(issues.length, 7);
    const methods = issues.map(i => i.method).sort();
    assert.deepEqual(methods, [
      'createMediaBuy',
      'getMediaBuyDelivery',
      'getMediaBuys',
      'getProducts',
      'syncAccounts',
      'syncCreatives',
      'updateMediaBuy',
    ]);
    for (const issue of issues) {
      assert.equal(issue.specialism, 'sales-non-guaranteed');
      assert.equal(typeof issue.tool, 'string');
      assert.equal(typeof issue.method, 'string');
    }
  });

  it('finds methods on any platform field — adopter layout is flexible', () => {
    // Cross-cutting placement: syncAccounts on accounts, the rest on sales.
    const platform = {
      sales: {
        getProducts: () => null,
        createMediaBuy: () => null,
        updateMediaBuy: () => null,
        getMediaBuys: () => null,
        getMediaBuyDelivery: () => null,
        syncCreatives: () => null,
      },
      accounts: { syncAccounts: () => null },
    };
    assert.deepEqual(
      validateSpecialismRequiredTools(platform, ['sales-non-guaranteed'], SYNTHETIC_REQUIREMENTS),
      []
    );
  });

  it('alternative non-conventional layout: single mega-platform exposes all methods', () => {
    const platform = {
      everything: {
        getProducts: () => null,
        createMediaBuy: () => null,
        updateMediaBuy: () => null,
        getMediaBuys: () => null,
        getMediaBuyDelivery: () => null,
        syncCreatives: () => null,
        syncAccounts: () => null,
      },
    };
    assert.deepEqual(
      validateSpecialismRequiredTools(platform, ['sales-non-guaranteed'], SYNTHETIC_REQUIREMENTS),
      []
    );
  });

  it('silently passes specialisms not present in the lookup', () => {
    // 'signed-requests' is not a per-specialism required-tools spec entry.
    const platform = { sales: {} };
    assert.deepEqual(
      validateSpecialismRequiredTools(platform, ['signed-requests'], SYNTHETIC_REQUIREMENTS),
      []
    );
  });

  it('aggregates issues across multiple specialisms', () => {
    const platform = { sales: { getProducts: () => null } };
    const issues = validateSpecialismRequiredTools(
      platform,
      ['sales-non-guaranteed', 'signal-owned'],
      SYNTHETIC_REQUIREMENTS
    );
    const specialisms = new Set(issues.map(i => i.specialism));
    assert.deepEqual([...specialisms].sort(), ['sales-non-guaranteed', 'signal-owned']);
  });

  it('handles a non-object platform gracefully', () => {
    assert.doesNotThrow(() =>
      validateSpecialismRequiredTools(null, ['sales-non-guaranteed'], SYNTHETIC_REQUIREMENTS)
    );
    assert.doesNotThrow(() =>
      validateSpecialismRequiredTools(undefined, ['sales-non-guaranteed'], SYNTHETIC_REQUIREMENTS)
    );
    assert.doesNotThrow(() =>
      validateSpecialismRequiredTools(42, ['sales-non-guaranteed'], SYNTHETIC_REQUIREMENTS)
    );
    const issues = validateSpecialismRequiredTools(null, ['sales-non-guaranteed'], SYNTHETIC_REQUIREMENTS);
    assert.ok(issues.length > 0);
  });

  it('default lookup (manifest-derived SPECIALISM_REQUIRED_TOOLS) is no-op in 3.0.4', () => {
    // Sanity: when callers don't pass a custom lookup, the manifest's empty
    // `required_tools` makes this a true no-op in 3.0.4. Activates when the
    // spec populates the field in a future release.
    const platform = { sales: {} };
    assert.deepEqual(validateSpecialismRequiredTools(platform, ['sales-non-guaranteed']), []);
  });
});

describe('formatSpecialismIssue', () => {
  it('produces a human-readable warning naming the specialism, tool, and method', () => {
    const message = formatSpecialismIssue({
      specialism: 'sales-non-guaranteed',
      tool: 'create_media_buy',
      method: 'createMediaBuy',
    });
    assert.match(message, /sales-non-guaranteed/);
    assert.match(message, /create_media_buy/);
    assert.match(message, /createMediaBuy/);
    assert.match(message, /strictSpecialismValidation/);
  });
});
