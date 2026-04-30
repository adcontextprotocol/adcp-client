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

describe('Typed AdcpError subclasses — code + recovery shape', () => {
  it('PackageNotFoundError has correct code, recovery, field', () => {
    const e = new PackageNotFoundError('pkg_123');
    assert.equal(e.code, 'PACKAGE_NOT_FOUND');
    assert.equal(e.recovery, 'terminal');
    assert.equal(e.field, 'package_id');
    assert.match(e.message, /pkg_123/);
    assert.ok(e instanceof AdcpError);
  });

  it('MediaBuyNotFoundError has correct shape', () => {
    const e = new MediaBuyNotFoundError('mb_999');
    assert.equal(e.code, 'MEDIA_BUY_NOT_FOUND');
    assert.equal(e.recovery, 'terminal');
    assert.equal(e.field, 'media_buy_id');
    assert.match(e.message, /mb_999/);
  });

  it('ProductNotFoundError', () => {
    const e = new ProductNotFoundError('prod_x');
    assert.equal(e.code, 'PRODUCT_NOT_FOUND');
    assert.equal(e.recovery, 'terminal');
    assert.equal(e.field, 'product_id');
  });

  it('CreativeNotFoundError', () => {
    const e = new CreativeNotFoundError('cr_a');
    assert.equal(e.code, 'CREATIVE_NOT_FOUND');
    assert.equal(e.recovery, 'terminal');
    assert.equal(e.field, 'creative_id');
  });

  it('ProductUnavailableError', () => {
    const e = new ProductUnavailableError('prod_sold');
    assert.equal(e.code, 'PRODUCT_UNAVAILABLE');
    assert.equal(e.recovery, 'terminal');
    assert.match(e.message, /sold out/);
  });

  it('CreativeRejectedError carries reason in details', () => {
    const e = new CreativeRejectedError('cr_b', 'brand_safety_failed');
    assert.equal(e.code, 'CREATIVE_REJECTED');
    assert.equal(e.recovery, 'terminal');
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
    assert.equal(e.recovery, 'terminal');
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
    assert.equal(e.recovery, 'terminal');
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
    assert.equal(e.recovery, 'terminal');
  });

  it('PermissionDeniedError carries action in details', () => {
    const e = new PermissionDeniedError('create_media_buy');
    assert.equal(e.code, 'PERMISSION_DENIED');
    assert.equal(e.recovery, 'terminal');
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
    assert.equal(e.recovery, 'terminal');
    assert.equal(e.details.feature, 'rfc_9421_signing');
  });

  it('ComplianceUnsatisfiedError', () => {
    const e = new ComplianceUnsatisfiedError('missing_brand_safety_attestation');
    assert.equal(e.code, 'COMPLIANCE_UNSATISFIED');
    assert.equal(e.recovery, 'terminal');
    assert.equal(e.details.reason, 'missing_brand_safety_attestation');
  });

  it('GovernanceDeniedError', () => {
    const e = new GovernanceDeniedError('spending_authority_revoked');
    assert.equal(e.code, 'GOVERNANCE_DENIED');
    assert.equal(e.recovery, 'terminal');
  });

  it('PolicyViolationError', () => {
    const e = new PolicyViolationError('alcohol_in_kid_zone');
    assert.equal(e.code, 'POLICY_VIOLATION');
    assert.equal(e.recovery, 'terminal');
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
    assert.equal(wire.recovery, 'terminal');
    assert.equal(wire.field, 'package_id');
    assert.equal(wire.suggestion, 'Use pkg_456 instead');
  });
});
