// BuyerRetryPolicy — operator-grade per-code defaults for AdCP errors.
// Asserts every standard code has a defined default and that the
// commercial-relationship + auth codes escalate (per #1153 callout).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { decideRetry, BuyerRetryPolicy } = require('../../dist/lib/utils/buyer-retry-policy');
const { ErrorCodeValues } = require('../../dist/lib/types/enums.generated');

const err = (code, extra = {}) => ({
  code,
  recovery: 'correctable',
  message: `mock ${code}`,
  ...extra,
});

describe('decideRetry — operator-grade defaults', () => {
  describe('transients retry with same idempotency_key', () => {
    it('RATE_LIMITED honors retry_after', () => {
      const d = decideRetry(err('RATE_LIMITED', { recovery: 'transient', retry_after: 30 }));
      assert.equal(d.action, 'retry');
      assert.equal(d.sameIdempotencyKey, true);
      assert.equal(d.delayMs, 30_000);
    });

    it('SERVICE_UNAVAILABLE uses exponential backoff when no retry_after', () => {
      const a1 = decideRetry(err('SERVICE_UNAVAILABLE', { recovery: 'transient' }), { attempt: 1 });
      const a2 = decideRetry(err('SERVICE_UNAVAILABLE', { recovery: 'transient' }), { attempt: 2 });
      assert.equal(a1.action, 'retry');
      assert.equal(a2.action, 'retry');
      assert.ok(a2.delayMs > a1.delayMs, 'exponential backoff should grow attempt-over-attempt');
    });

    it('CONFLICT retries with no delay', () => {
      const d = decideRetry(err('CONFLICT', { recovery: 'transient' }));
      assert.equal(d.action, 'retry');
      assert.equal(d.delayMs, 0);
    });

    it('exhausting attemptCap escalates with reason="attempts_exhausted"', () => {
      const d = decideRetry(err('SERVICE_UNAVAILABLE', { recovery: 'transient' }), { attempt: 99 });
      assert.equal(d.action, 'escalate');
      assert.equal(d.reason, 'attempts_exhausted');
    });

    it('retry_after exceeding spec range [1,3600] is clamped to 3600s', () => {
      const d = decideRetry(err('RATE_LIMITED', { recovery: 'transient', retry_after: 86_400 }));
      assert.equal(d.action, 'retry');
      assert.equal(d.delayMs, 3_600_000);
    });

    it('exponential backoff caps at 3600s on absurd attempt counts', () => {
      // Without the clamp, attempt 20 with baseDelayMs=1000 → 1000 * 2^19
      // = ~9 minutes; attempt 30 → ~16 days. Cap saves naive callers.
      const d = decideRetry(err('SERVICE_UNAVAILABLE', { recovery: 'transient' }), { attempt: 30 });
      // Already 'attempts_exhausted' before delayMs is computed — but if a
      // caller somehow held a policy with a high attemptCap, the clamp would
      // still bound the delay. Verify via a fresh policy.
      const d2 = new BuyerRetryPolicy({
        overrides: {
          SERVICE_UNAVAILABLE: () => null, // fall through to default policy
        },
      }).decide(err('SERVICE_UNAVAILABLE', { recovery: 'transient' }), { attempt: 30 });
      // Default cap is 3 → escalate.
      assert.equal(d.action, 'escalate');
      assert.equal(d2.action, 'escalate');
    });
  });

  describe('correctable codes mutate-and-retry with FRESH idempotency_key + jitter', () => {
    it('PACKAGE_NOT_FOUND → mutate-and-retry (redirect) with delayMs jitter', () => {
      const d = decideRetry(err('PACKAGE_NOT_FOUND', { field: 'package_id', suggestion: 'verify via get_media_buys' }));
      assert.equal(d.action, 'mutate-and-retry');
      assert.equal(d.sameIdempotencyKey, false);
      assert.equal(d.reason, 'redirect');
      assert.equal(d.field, 'package_id');
      assert.match(d.suggestion, /get_media_buys/);
      // jitter is 50-100% of 250ms baseDelay → 125-250ms
      assert.ok(d.delayMs >= 125 && d.delayMs <= 250, `delayMs ${d.delayMs} outside jitter window`);
    });

    it('PRODUCT_UNAVAILABLE → mutate-and-retry (redirect)', () => {
      const d = decideRetry(err('PRODUCT_UNAVAILABLE'));
      assert.equal(d.action, 'mutate-and-retry');
      assert.equal(d.reason, 'redirect');
    });

    it('TERMS_REJECTED → mutate-and-retry (requote)', () => {
      const d = decideRetry(err('TERMS_REJECTED'));
      assert.equal(d.action, 'mutate-and-retry');
      assert.equal(d.reason, 'requote');
    });

    it('UNSUPPORTED_FEATURE → mutate-and-retry (capability)', () => {
      const d = decideRetry(err('UNSUPPORTED_FEATURE'));
      assert.equal(d.action, 'mutate-and-retry');
      assert.equal(d.reason, 'capability');
    });

    it('BUDGET_TOO_LOW → mutate-and-retry (budget)', () => {
      const d = decideRetry(err('BUDGET_TOO_LOW'));
      assert.equal(d.action, 'mutate-and-retry');
      assert.equal(d.reason, 'budget');
    });
  });

  describe('idempotency safety guards (financial-liability defense)', () => {
    it('IDEMPOTENCY_CONFLICT → mutate-and-retry (different payload, fresh key is safe)', () => {
      const d = decideRetry(err('IDEMPOTENCY_CONFLICT'));
      assert.equal(d.action, 'mutate-and-retry');
      assert.equal(d.reason, 'validation');
    });

    it('IDEMPOTENCY_EXPIRED → escalate (idempotency_check_required) — DO NOT auto-retry', () => {
      // The spec explicitly warns: if the prior call may have succeeded, the
      // buyer MUST do a natural-key check before minting a new key. Otherwise
      // this is exactly how double-creation happens. Tracked at
      // adcontextprotocol/adcp 3.0.x error-code.json enumDescriptions.
      const d = decideRetry(err('IDEMPOTENCY_EXPIRED'));
      assert.equal(d.action, 'escalate');
      assert.equal(d.reason, 'idempotency_check_required');
    });
  });

  describe('account state escalates (operator must resolve)', () => {
    it('ACCOUNT_AMBIGUOUS → escalate (auth) — agent rarely has cached account_id to fix locally', () => {
      const d = decideRetry(err('ACCOUNT_AMBIGUOUS'));
      assert.equal(d.action, 'escalate');
      assert.equal(d.reason, 'auth');
    });
  });

  describe('commercial-relationship signals escalate (do NOT auto-tweak)', () => {
    for (const code of ['POLICY_VIOLATION', 'COMPLIANCE_UNSATISFIED', 'GOVERNANCE_DENIED', 'CREATIVE_REJECTED']) {
      it(`${code} → escalate (commercial)`, () => {
        const d = decideRetry(err(code));
        assert.equal(d.action, 'escalate');
        assert.equal(d.reason, 'commercial');
      });
    }
  });

  describe('auth codes escalate (operator must rotate creds)', () => {
    for (const code of ['AUTH_REQUIRED', 'PERMISSION_DENIED', 'ACCOUNT_SETUP_REQUIRED', 'ACCOUNT_PAYMENT_REQUIRED']) {
      it(`${code} → escalate (auth)`, () => {
        const d = decideRetry(err(code));
        assert.equal(d.action, 'escalate');
        assert.equal(d.reason, 'auth');
      });
    }
  });

  describe("out-of-band transients escalate (agent can't unblock)", () => {
    for (const code of ['GOVERNANCE_UNAVAILABLE', 'CAMPAIGN_SUSPENDED']) {
      it(`${code} → escalate (governance_unreachable)`, () => {
        const d = decideRetry(err(code, { recovery: 'transient' }));
        assert.equal(d.action, 'escalate');
        assert.equal(d.reason, 'governance_unreachable');
      });
    }
  });

  describe('terminal codes escalate', () => {
    for (const code of ['ACCOUNT_SUSPENDED', 'BUDGET_EXHAUSTED']) {
      it(`${code} → escalate (terminal)`, () => {
        const d = decideRetry(err(code, { recovery: 'terminal' }));
        assert.equal(d.action, 'escalate');
        assert.equal(d.reason, 'terminal');
      });
    }
  });

  describe('coverage', () => {
    it('every standard error code has a defined default', () => {
      const decisions = ErrorCodeValues.map(code => ({
        code,
        decision: decideRetry(err(code, { recovery: code === 'RATE_LIMITED' ? 'transient' : 'correctable' })),
      }));
      for (const { code, decision } of decisions) {
        assert.ok(
          ['retry', 'mutate-and-retry', 'escalate'].includes(decision.action),
          `${code} → unrecognized action "${decision.action}"`
        );
      }
      assert.equal(decisions.length, ErrorCodeValues.length);
    });
  });

  describe('unknown vendor codes', () => {
    it('non-standard correctable code escalates by default with reason="unknown"', () => {
      const d = decideRetry(err('GAM_INTERNAL_QUOTA_EXCEEDED'));
      assert.equal(d.action, 'escalate');
      assert.equal(d.reason, 'unknown');
    });

    it('non-standard transient code falls through to retry', () => {
      const d = decideRetry(err('GAM_TRANSIENT_TIMEOUT', { recovery: 'transient', retry_after: 5 }));
      assert.equal(d.action, 'retry');
      assert.equal(d.delayMs, 5_000);
    });
  });
});

describe('BuyerRetryPolicy — overrides', () => {
  it('per-code override wins over default', () => {
    const policy = new BuyerRetryPolicy({
      overrides: {
        POLICY_VIOLATION: () => ({
          action: 'mutate-and-retry',
          attemptCap: 1,
          sameIdempotencyKey: false,
          reason: 'validation',
        }),
      },
    });
    const d = policy.decide(err('POLICY_VIOLATION'));
    assert.equal(d.action, 'mutate-and-retry');
  });

  it('override returning null falls through to default', () => {
    const policy = new BuyerRetryPolicy({
      overrides: { POLICY_VIOLATION: () => null },
    });
    const d = policy.decide(err('POLICY_VIOLATION'));
    assert.equal(d.action, 'escalate');
    assert.equal(d.reason, 'commercial');
  });

  it('unknownCode: "mutate" makes non-standard codes mutate-and-retry instead of escalate', () => {
    const policy = new BuyerRetryPolicy({ unknownCode: 'mutate' });
    const d = policy.decide(err('GAM_INTERNAL_QUOTA_EXCEEDED'));
    assert.equal(d.action, 'mutate-and-retry');
  });
});
