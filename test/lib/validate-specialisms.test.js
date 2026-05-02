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
 * as a function. "Any field" is intentional — required tools span platform
 * fields (`sync_accounts` lives on `accounts`, not on `sales`), and
 * pinning ownership upfront would either need a per-tool field map or
 * cause false-positives on legitimate alternative layouts.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateSpecialismRequiredTools,
  toolNameToMethodName,
  formatSpecialismIssue,
} = require('../../dist/lib/server/decisioning/validate-specialisms');

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
    assert.deepEqual(validateSpecialismRequiredTools(platform, undefined), []);
    assert.deepEqual(validateSpecialismRequiredTools(platform, []), []);
  });

  it('returns no issues when every required method exists somewhere on the platform', () => {
    // sales-non-guaranteed requires: create_media_buy, get_media_buy_delivery,
    // get_media_buys, get_products, sync_accounts, sync_creatives, update_media_buy
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
    assert.deepEqual(validateSpecialismRequiredTools(platform, ['sales-non-guaranteed']), []);
  });

  it('flags missing methods with specialism + tool + method names', () => {
    // sales-non-guaranteed declared but no methods exist
    const platform = { sales: {} };
    const issues = validateSpecialismRequiredTools(platform, ['sales-non-guaranteed']);
    assert.equal(issues.length, 7); // 7 required tools per manifest
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
    // "Cross-cutting" placement: syncAccounts on accounts, the rest on sales.
    // The validator's hasMethodAnywhere semantic accepts this.
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
    assert.deepEqual(validateSpecialismRequiredTools(platform, ['sales-non-guaranteed']), []);
  });

  it('alternative non-conventional layout: single mega-platform exposes all methods', () => {
    // Adopter chose to put everything on one field. The validator doesn't care.
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
    assert.deepEqual(validateSpecialismRequiredTools(platform, ['sales-non-guaranteed']), []);
  });

  it('silently passes specialisms not present in SPECIALISM_REQUIRED_TOOLS', () => {
    // Manifest doesn't enumerate this; treat as no-op.
    const platform = { sales: {} };
    assert.deepEqual(validateSpecialismRequiredTools(platform, ['signed-requests']), []);
  });

  it('aggregates issues across multiple specialisms', () => {
    const platform = { sales: { getProducts: () => null } };
    const issues = validateSpecialismRequiredTools(platform, ['sales-non-guaranteed', 'signal-owned']);
    const specialisms = new Set(issues.map(i => i.specialism));
    assert.deepEqual([...specialisms].sort(), ['sales-non-guaranteed', 'signal-owned']);
  });

  it('handles a non-object platform gracefully', () => {
    // Defensive: validator shouldn't throw on undefined / null / primitive.
    assert.doesNotThrow(() => validateSpecialismRequiredTools(null, ['sales-non-guaranteed']));
    assert.doesNotThrow(() => validateSpecialismRequiredTools(undefined, ['sales-non-guaranteed']));
    assert.doesNotThrow(() => validateSpecialismRequiredTools(42, ['sales-non-guaranteed']));
    // Each call should return issues for every required tool since no methods are reachable.
    const issues = validateSpecialismRequiredTools(null, ['sales-non-guaranteed']);
    assert.ok(issues.length > 0);
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
