// Tests for issue #1676: request-normalizer must not fabricate account from brand.
//
// Prior to this fix, create_media_buy calls that omitted `account` but supplied
// `brand.domain` silently fabricated { brand, operator: brand.domain } — a value
// the caller never provided and that is semantically wrong for any topology with
// a buying-side intermediary. The shim was removed with the v2 sunset (AdCP 3.0 GA).

const { test, describe } = require('node:test');
const assert = require('node:assert');

describe('normalizeRequestParams — account validation (create_media_buy)', () => {
  let normalizeRequestParams;
  let ValidationError;

  test('setup', () => {
    const lib = require('../../dist/lib/index.js');
    normalizeRequestParams = lib.normalizeRequestParams;
    ValidationError = lib.ADCPValidationError;
    assert.ok(normalizeRequestParams, 'normalizeRequestParams must be exported');
    assert.ok(ValidationError, 'ADCPValidationError must be exported');
  });

  test('throws ValidationError when account is absent and brand is present with domain', () => {
    const lib = require('../../dist/lib/index.js');
    normalizeRequestParams = lib.normalizeRequestParams;
    ValidationError = lib.ADCPValidationError;

    assert.throws(
      () =>
        normalizeRequestParams('create_media_buy', {
          brand: { name: 'Acme', domain: 'acme.com' },
          packages: [],
        }),
      err => {
        assert.ok(err instanceof ValidationError, `expected ValidationError, got ${err.constructor.name}`);
        assert.strictEqual(err.code, 'VALIDATION_ERROR');
        assert.ok(err.message.includes('account'), 'error message should mention account field');
        return true;
      }
    );
  });

  test('throws ValidationError when account is absent and brand is absent', () => {
    const lib = require('../../dist/lib/index.js');
    normalizeRequestParams = lib.normalizeRequestParams;
    ValidationError = lib.ADCPValidationError;

    assert.throws(
      () =>
        normalizeRequestParams('create_media_buy', {
          packages: [],
        }),
      err => {
        assert.ok(err instanceof ValidationError, `expected ValidationError, got ${err.constructor.name}`);
        assert.strictEqual(err.code, 'VALIDATION_ERROR');
        return true;
      }
    );
  });

  test('does not throw when account is provided as account_id reference', () => {
    const lib = require('../../dist/lib/index.js');
    normalizeRequestParams = lib.normalizeRequestParams;

    assert.doesNotThrow(() =>
      normalizeRequestParams('create_media_buy', {
        account: { account_id: 'acc-123' },
        packages: [],
      })
    );
  });

  test('does not throw when account is provided as natural-key reference', () => {
    const lib = require('../../dist/lib/index.js');
    normalizeRequestParams = lib.normalizeRequestParams;

    assert.doesNotThrow(() =>
      normalizeRequestParams('create_media_buy', {
        account: { brand: { name: 'Acme', domain: 'acme.com' }, operator: 'agency.com' },
        packages: [],
      })
    );
  });

  test('does not throw for other task types that omit account', () => {
    const lib = require('../../dist/lib/index.js');
    normalizeRequestParams = lib.normalizeRequestParams;

    assert.doesNotThrow(() =>
      normalizeRequestParams('get_products', {
        brand: { name: 'Acme', domain: 'acme.com' },
      })
    );

    assert.doesNotThrow(() =>
      normalizeRequestParams('update_media_buy', {
        media_buy_id: 'mb-999',
      })
    );
  });

  test('does not fabricate account.operator from brand.domain', () => {
    const lib = require('../../dist/lib/index.js');
    normalizeRequestParams = lib.normalizeRequestParams;
    ValidationError = lib.ADCPValidationError;

    // Regression: the removed shim set operator = brand.domain, which is
    // semantically wrong for most topologies. Verify it never fires.
    let caught = null;
    try {
      normalizeRequestParams('create_media_buy', {
        brand: { name: 'Acme', domain: 'acme.com' },
        packages: [],
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof ValidationError, 'should throw, not fabricate');
    // The fabricated path would have set operator = 'acme.com'; verify it didn't
    // by confirming we got the error rather than a modified params object.
  });
});
