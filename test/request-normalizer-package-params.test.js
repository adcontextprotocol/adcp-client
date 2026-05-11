// Tests for pre-3.0 fail-closed guards in normalizePackageParams.
// AdCP 3.0 PackageRequest uses product_id (singular string) and budget (number).
// Pre-3.0 shapes product_ids[] and budget:{total,currency} cannot be translated
// without data loss, so the normalizer throws rather than passing them silently.

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { normalizePackageParams, normalizeRequestParams } = require('../dist/lib/utils/request-normalizer');
const { ValidationError } = require('../dist/lib/errors');

describe('normalizePackageParams — pre-3.0 fail-closed guards', () => {
  it('throws ValidationError for product_ids[] (pre-3.0 plural shape)', () => {
    assert.throws(
      () => normalizePackageParams({ product_ids: ['prod-1', 'prod-2'], pricing_option_id: 'po-1', budget: 1000 }),
      err => {
        assert.ok(err instanceof ValidationError, 'should be ValidationError');
        assert.strictEqual(err.code, 'VALIDATION_ERROR');
        assert.ok(err.field === 'packages[].product_ids', `unexpected field: ${err.field}`);
        return true;
      }
    );
  });

  it('throws ValidationError for budget as object (pre-3.0 {total,currency} shape)', () => {
    assert.throws(
      () =>
        normalizePackageParams({
          product_id: 'prod-1',
          pricing_option_id: 'po-1',
          budget: { total: 1000, currency: 'USD' },
        }),
      err => {
        assert.ok(err instanceof ValidationError, 'should be ValidationError');
        assert.strictEqual(err.code, 'VALIDATION_ERROR');
        assert.ok(err.field === 'packages[].budget', `unexpected field: ${err.field}`);
        return true;
      }
    );
  });

  it('throws ValidationError for budget as {amount,currency} object variant', () => {
    assert.throws(
      () =>
        normalizePackageParams({
          product_id: 'prod-1',
          pricing_option_id: 'po-1',
          budget: { amount: 500, currency: 'EUR' },
        }),
      err => {
        assert.ok(err instanceof ValidationError);
        assert.strictEqual(err.field, 'packages[].budget');
        return true;
      }
    );
  });

  it('passes through a valid 3.0-shape package unchanged', () => {
    const pkg = { product_id: 'prod-1', pricing_option_id: 'po-1', budget: 1000 };
    const result = normalizePackageParams(pkg);
    assert.strictEqual(result.product_id, 'prod-1');
    assert.strictEqual(result.budget, 1000);
    assert.strictEqual(result.pricing_option_id, 'po-1');
  });

  it('does not throw for empty product_ids[] (no ambiguity — nothing to pick)', () => {
    assert.doesNotThrow(() =>
      normalizePackageParams({ product_ids: [], product_id: 'prod-1', pricing_option_id: 'po-1', budget: 1000 })
    );
  });

  it('passes through null/non-object without throwing', () => {
    assert.strictEqual(normalizePackageParams(null), null);
    assert.strictEqual(normalizePackageParams(undefined), undefined);
    assert.strictEqual(normalizePackageParams('string'), 'string');
  });
});

describe('normalizeRequestParams — pre-3.0 package shapes propagate through create_media_buy', () => {
  it('throws when packages[] contain product_ids[]', () => {
    assert.throws(
      () =>
        normalizeRequestParams('create_media_buy', {
          idempotency_key: 'test-key',
          packages: [{ product_ids: ['prod-1'], pricing_option_id: 'po-1', budget: 1000 }],
        }),
      err => {
        assert.ok(err instanceof ValidationError);
        assert.strictEqual(err.field, 'packages[].product_ids');
        return true;
      }
    );
  });

  it('throws when packages[] contain object budget', () => {
    assert.throws(
      () =>
        normalizeRequestParams('create_media_buy', {
          idempotency_key: 'test-key',
          packages: [{ product_id: 'prod-1', pricing_option_id: 'po-1', budget: { total: 1000, currency: 'USD' } }],
        }),
      err => {
        assert.ok(err instanceof ValidationError);
        assert.strictEqual(err.field, 'packages[].budget');
        return true;
      }
    );
  });
});
