const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  AdcpError,
  PackageNotFoundError,
  MediaBuyNotFoundError,
  ProductNotFoundError,
  CreativeNotFoundError,
  ProductUnavailableError,
  CreativeRejectedError,
  BudgetTooLowError,
  BudgetExhaustedError,
  IdempotencyConflictError,
  InvalidRequestError,
  InvalidStateError,
  BackwardsTimeRangeError,
  AuthRequiredError,
  PermissionDeniedError,
  RateLimitedError,
  ServiceUnavailableError,
  UnsupportedFeatureError,
  ComplianceUnsatisfiedError,
  GovernanceDeniedError,
  PolicyViolationError,
} = require('../dist/lib/server');
const { getErrorRecovery } = require('../dist/lib/types/error-codes');

// Recovery is no longer hardcoded in typed-error classes — it's inherited
// from STANDARD_ERROR_CODES via getErrorRecovery(code). These assertions
// match the AdCP 3.0 spec recovery classifications. The drift guard at the
// bottom of this suite (`every typed error's recovery matches the spec`)
// makes hand-maintenance impossible: if the spec changes a recovery value,
// the typed class auto-updates and the only explicit assertion left is
// the spec invariant itself.

describe('Typed AdcpError subclasses — code + spec-correct recovery shape', () => {
  it('PackageNotFoundError', () => {
    const e = new PackageNotFoundError('pkg_123');
    assert.equal(e.code, 'PACKAGE_NOT_FOUND');
    assert.equal(e.recovery, 'correctable');
    assert.equal(e.field, 'package_id');
    assert.match(e.message, /pkg_123/);
    assert.ok(e instanceof AdcpError);
  });

  it('MediaBuyNotFoundError', () => {
    const e = new MediaBuyNotFoundError('mb_999');
    assert.equal(e.code, 'MEDIA_BUY_NOT_FOUND');
    assert.equal(e.recovery, 'correctable');
    assert.equal(e.field, 'media_buy_id');
    assert.match(e.message, /mb_999/);
  });

  it('ProductNotFoundError', () => {
    const e = new ProductNotFoundError('prod_x');
    assert.equal(e.code, 'PRODUCT_NOT_FOUND');
    assert.equal(e.recovery, 'correctable');
    assert.equal(e.field, 'product_id');
  });

  it('CreativeNotFoundError', () => {
    const e = new CreativeNotFoundError('cr_a');
    assert.equal(e.code, 'CREATIVE_NOT_FOUND');
    assert.equal(e.recovery, 'correctable');
    assert.equal(e.field, 'creative_id');
  });

  it('ProductUnavailableError', () => {
    const e = new ProductUnavailableError('prod_sold');
    assert.equal(e.code, 'PRODUCT_UNAVAILABLE');
    assert.equal(e.recovery, 'correctable');
    assert.match(e.message, /sold out/);
  });

  it('CreativeRejectedError carries reason in details', () => {
    const e = new CreativeRejectedError('cr_b', 'brand_safety_failed');
    assert.equal(e.code, 'CREATIVE_REJECTED');
    assert.equal(e.recovery, 'correctable');
    assert.equal(e.details.reason, 'brand_safety_failed');
  });

  it('BudgetTooLowError carries floor + currency in details', () => {
    const e = new BudgetTooLowError({ floor: 5000, currency: 'USD' });
    assert.equal(e.code, 'BUDGET_TOO_LOW');
    assert.equal(e.recovery, 'correctable');
    assert.equal(e.field, 'total_budget');
    assert.match(e.message, /5000/);
    assert.match(e.message, /USD/);
    assert.equal(e.details.floor, 5000);
  });

  it('BudgetExhaustedError', () => {
    const e = new BudgetExhaustedError();
    assert.equal(e.code, 'BUDGET_EXHAUSTED');
    assert.equal(e.recovery, 'terminal');
  });

  it('IdempotencyConflictError defaults to clear suggestion', () => {
    const e = new IdempotencyConflictError();
    assert.equal(e.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(e.recovery, 'correctable');
    assert.equal(e.field, 'idempotency_key');
    assert.match(e.suggestion, /fresh/);
  });

  it('InvalidRequestError carries field + message', () => {
    const e = new InvalidRequestError('packages[0].budget', 'budget must be positive');
    assert.equal(e.code, 'INVALID_REQUEST');
    assert.equal(e.recovery, 'correctable');
    assert.equal(e.field, 'packages[0].budget');
    assert.match(e.message, /must be positive/);
  });

  it('InvalidStateError', () => {
    const e = new InvalidStateError('status', 'cannot transition from completed to active');
    assert.equal(e.code, 'INVALID_STATE');
    assert.equal(e.recovery, 'correctable');
  });

  it('BackwardsTimeRangeError', () => {
    const e = new BackwardsTimeRangeError();
    assert.equal(e.code, 'INVALID_REQUEST');
    assert.equal(e.recovery, 'correctable');
    assert.equal(e.field, 'start_time');
    assert.match(e.message, /before end_time/);
  });

  it('AuthRequiredError', () => {
    const e = new AuthRequiredError();
    assert.equal(e.code, 'AUTH_REQUIRED');
    assert.equal(e.recovery, 'correctable');
  });

  it('PermissionDeniedError carries action in details', () => {
    const e = new PermissionDeniedError('create_media_buy');
    assert.equal(e.code, 'PERMISSION_DENIED');
    assert.equal(e.recovery, 'correctable');
    assert.equal(e.details.action, 'create_media_buy');
  });

  it('RateLimitedError clamps retry_after to spec range [1, 3600]', () => {
    assert.equal(new RateLimitedError(0).retry_after, 1);
    assert.equal(new RateLimitedError(7200).retry_after, 3600);
    assert.equal(new RateLimitedError(60).retry_after, 60);
  });

  it('ServiceUnavailableError defaults retry_after to 60s', () => {
    const e = new ServiceUnavailableError();
    assert.equal(e.code, 'SERVICE_UNAVAILABLE');
    assert.equal(e.recovery, 'transient');
    assert.equal(e.retry_after, 60);
  });

  it('UnsupportedFeatureError carries feature in details', () => {
    const e = new UnsupportedFeatureError('rfc_9421_signing');
    assert.equal(e.code, 'UNSUPPORTED_FEATURE');
    assert.equal(e.recovery, 'correctable');
    assert.equal(e.details.feature, 'rfc_9421_signing');
  });

  it('ComplianceUnsatisfiedError', () => {
    const e = new ComplianceUnsatisfiedError('missing_brand_safety_attestation');
    assert.equal(e.code, 'COMPLIANCE_UNSATISFIED');
    assert.equal(e.recovery, 'correctable');
    assert.equal(e.details.reason, 'missing_brand_safety_attestation');
  });

  it('GovernanceDeniedError', () => {
    const e = new GovernanceDeniedError('spending_authority_revoked');
    assert.equal(e.code, 'GOVERNANCE_DENIED');
    assert.equal(e.recovery, 'correctable');
  });

  it('PolicyViolationError', () => {
    const e = new PolicyViolationError('alcohol_in_kid_zone');
    assert.equal(e.code, 'POLICY_VIOLATION');
    assert.equal(e.recovery, 'correctable');
  });

  it('All typed errors are instanceof AdcpError', () => {
    const errors = [
      new PackageNotFoundError('x'),
      new MediaBuyNotFoundError('x'),
      new ProductNotFoundError('x'),
      new CreativeNotFoundError('x'),
      new ProductUnavailableError('x'),
      new CreativeRejectedError('x', 'r'),
      new BudgetTooLowError(),
      new BudgetExhaustedError(),
      new IdempotencyConflictError(),
      new InvalidRequestError('f', 'm'),
      new InvalidStateError('f', 'm'),
      new BackwardsTimeRangeError(),
      new AuthRequiredError(),
      new PermissionDeniedError('a'),
      new RateLimitedError(60),
      new ServiceUnavailableError(),
      new UnsupportedFeatureError('f'),
      new ComplianceUnsatisfiedError('r'),
      new GovernanceDeniedError('r'),
      new PolicyViolationError('p'),
    ];
    for (const e of errors) {
      assert.ok(e instanceof AdcpError, `${e.constructor.name} is not instanceof AdcpError`);
      assert.ok(e instanceof Error, `${e.constructor.name} is not instanceof Error`);
      assert.ok(typeof e.code === 'string' && e.code.length > 0);
      assert.ok(['transient', 'correctable', 'terminal'].includes(e.recovery));
    }
  });

  it('toStructuredError() projects to wire envelope shape', () => {
    const e = new PackageNotFoundError('pkg_123', { suggestion: 'Use pkg_456 instead' });
    const wire = e.toStructuredError();
    assert.equal(wire.code, 'PACKAGE_NOT_FOUND');
    assert.equal(wire.recovery, 'correctable');
    assert.equal(wire.field, 'package_id');
    assert.equal(wire.suggestion, 'Use pkg_456 instead');
  });

  // Drift guard: every typed class produces an error whose recovery matches
  // getErrorRecovery(error.code). If the spec rev changes a recovery
  // classification, this test stays green automatically because both sides
  // (the typed class default + the spec reference) read from STANDARD_ERROR_CODES.
  // If someone hardcodes recovery on a typed class to a wrong value, this
  // test fires.
  it('every typed-error class recovery matches getErrorRecovery(code)', () => {
    const errors = [
      new PackageNotFoundError('x'),
      new MediaBuyNotFoundError('x'),
      new ProductNotFoundError('x'),
      new CreativeNotFoundError('x'),
      new ProductUnavailableError('x'),
      new CreativeRejectedError('x', 'r'),
      new BudgetTooLowError(),
      new BudgetExhaustedError(),
      new IdempotencyConflictError(),
      new InvalidRequestError('f', 'm'),
      new InvalidStateError('f', 'm'),
      new BackwardsTimeRangeError(),
      new AuthRequiredError(),
      new PermissionDeniedError('a'),
      new RateLimitedError(60),
      new ServiceUnavailableError(),
      new UnsupportedFeatureError('f'),
      new ComplianceUnsatisfiedError('r'),
      new GovernanceDeniedError('r'),
      new PolicyViolationError('p'),
    ];
    for (const e of errors) {
      const specRecovery = getErrorRecovery(e.code);
      assert.equal(
        e.recovery,
        specRecovery,
        `${e.constructor.name} (${e.code}) recovery="${e.recovery}" but spec says "${specRecovery}"`
      );
    }
  });
});

describe('AdcpError — recovery defaults from spec when omitted', () => {
  it('omitting recovery falls back to getErrorRecovery(code) for standard codes', () => {
    const e = new AdcpError('TERMS_REJECTED', { message: 'omitted recovery' });
    assert.equal(e.recovery, 'correctable');
  });

  it('omitting recovery for a non-standard code falls back to correctable', () => {
    const e = new AdcpError('GAM_INTERNAL_QUOTA_EXCEEDED', { message: 'vendor code' });
    assert.equal(e.recovery, 'correctable');
  });

  it('explicit recovery still overrides the spec default', () => {
    const e = new AdcpError('PRODUCT_UNAVAILABLE', { recovery: 'terminal', message: 'permanent removal' });
    assert.equal(e.recovery, 'terminal');
  });
});
