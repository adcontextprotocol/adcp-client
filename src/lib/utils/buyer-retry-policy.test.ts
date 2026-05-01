import { describe, it, expect } from 'vitest';
import { BuyerRetryPolicy } from './buyer-retry-policy';
import { STANDARD_ERROR_CODES } from '../types/error-codes';
import type { AdcpErrorInfo } from '../core/ConversationTypes';
import type { StandardErrorCode } from '../types/error-codes';

function makeError(code: string, overrides: Partial<AdcpErrorInfo> = {}): AdcpErrorInfo {
  const recovery = (STANDARD_ERROR_CODES as any)[code]?.recovery ?? 'terminal';
  return { code, message: `test error: ${code}`, recovery, ...overrides };
}

describe('BuyerRetryPolicy', () => {
  describe('every StandardErrorCode has a defined default', () => {
    const allCodes = Object.keys(STANDARD_ERROR_CODES) as StandardErrorCode[];

    it.each(allCodes)('code %s → valid RetryDecision on attempt 1', code => {
      const decision = BuyerRetryPolicy.decide(makeError(code), { attempt: 1 });
      expect(['retry', 'mutate-and-retry', 'escalate']).toContain(decision.action);
      expect(typeof decision.maxAttempts).toBe('number');
      if (decision.action === 'escalate') {
        expect(typeof decision.reason).toBe('string');
        expect(decision.maxAttempts).toBe(0);
      }
      if (decision.action === 'retry') {
        expect(typeof decision.delayMs).toBe('number');
        expect(decision.delayMs).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('governance-evasion codes always escalate', () => {
    const escalateCodes: StandardErrorCode[] = [
      'POLICY_VIOLATION',
      'COMPLIANCE_UNSATISFIED',
      'GOVERNANCE_DENIED',
      'CREATIVE_REJECTED',
      'AUTH_REQUIRED',
      'PERMISSION_DENIED',
    ];

    it.each(escalateCodes)('%s → escalate regardless of attempt', code => {
      expect(BuyerRetryPolicy.decide(makeError(code), { attempt: 1 }).action).toBe('escalate');
      expect(BuyerRetryPolicy.decide(makeError(code), { attempt: 5 }).action).toBe('escalate');
    });
  });

  describe('per-code override beats recovery-class routing', () => {
    it('GOVERNANCE_UNAVAILABLE is transient but still escalates', () => {
      const decision = BuyerRetryPolicy.decide(makeError('GOVERNANCE_UNAVAILABLE', { recovery: 'transient' }), {
        attempt: 1,
      });
      expect(decision.action).toBe('escalate');
    });

    it('CAMPAIGN_SUSPENDED is transient but still escalates', () => {
      const decision = BuyerRetryPolicy.decide(makeError('CAMPAIGN_SUSPENDED', { recovery: 'transient' }), {
        attempt: 1,
      });
      expect(decision.action).toBe('escalate');
    });

    it('SESSION_TERMINATED is correctable but maps to mutate-and-retry (re-initiate)', () => {
      const decision = BuyerRetryPolicy.decide(makeError('SESSION_TERMINATED', { recovery: 'correctable' }), {
        attempt: 1,
      });
      expect(decision.action).toBe('mutate-and-retry');
      if (decision.action === 'mutate-and-retry') {
        expect(decision.suggestion).toContain('si_initiate_session');
        expect(decision.maxAttempts).toBe(1);
      }
    });
  });

  describe('RATE_LIMITED — retry with backoff', () => {
    it('attempt 1 → retry', () => {
      const d = BuyerRetryPolicy.decide(makeError('RATE_LIMITED'), { attempt: 1 });
      expect(d.action).toBe('retry');
      if (d.action === 'retry') {
        expect(d.maxAttempts).toBe(5);
        expect(d.delayMs).toBeGreaterThan(0);
      }
    });

    it('honors retryAfterMs when present', () => {
      const d = BuyerRetryPolicy.decide(makeError('RATE_LIMITED', { retryAfterMs: 30_000 }), { attempt: 1 });
      expect(d.action).toBe('retry');
      if (d.action === 'retry') expect(d.delayMs).toBe(30_000);
    });

    it('attempt 6 → escalate (exceeded maxAttempts 5)', () => {
      const d = BuyerRetryPolicy.decide(makeError('RATE_LIMITED'), { attempt: 6 });
      expect(d.action).toBe('escalate');
    });

    it('attempt 5 → still retry (at the ceiling, not over)', () => {
      const d = BuyerRetryPolicy.decide(makeError('RATE_LIMITED'), { attempt: 5 });
      expect(d.action).toBe('retry');
    });
  });

  describe('CONFLICT — mutate-and-retry (re-read required)', () => {
    it('attempt 1 → mutate-and-retry with suggestion', () => {
      const d = BuyerRetryPolicy.decide(makeError('CONFLICT'), { attempt: 1 });
      expect(d.action).toBe('mutate-and-retry');
      if (d.action === 'mutate-and-retry') {
        expect(d.suggestion).toContain('revision');
        expect(d.maxAttempts).toBe(2);
      }
    });

    it('attempt 3 → escalate (exceeded maxAttempts 2)', () => {
      const d = BuyerRetryPolicy.decide(makeError('CONFLICT'), { attempt: 3 });
      expect(d.action).toBe('escalate');
    });
  });

  describe('IDEMPOTENCY_CONFLICT / IDEMPOTENCY_EXPIRED', () => {
    it('IDEMPOTENCY_CONFLICT → mutate-and-retry with fresh-key guidance', () => {
      const d = BuyerRetryPolicy.decide(makeError('IDEMPOTENCY_CONFLICT'), { attempt: 1 });
      expect(d.action).toBe('mutate-and-retry');
      if (d.action === 'mutate-and-retry') {
        expect(d.suggestion).toContain('UUID v4');
        expect(d.maxAttempts).toBe(1);
      }
    });

    it('IDEMPOTENCY_EXPIRED → mutate-and-retry with natural-key lookup guidance', () => {
      const d = BuyerRetryPolicy.decide(makeError('IDEMPOTENCY_EXPIRED'), { attempt: 1 });
      expect(d.action).toBe('mutate-and-retry');
      if (d.action === 'mutate-and-retry') {
        expect(d.suggestion).toContain('natural key');
        expect(d.maxAttempts).toBe(1);
      }
    });

    it('IDEMPOTENCY_CONFLICT attempt 2 → escalate', () => {
      expect(BuyerRetryPolicy.decide(makeError('IDEMPOTENCY_CONFLICT'), { attempt: 2 }).action).toBe('escalate');
    });
  });

  describe('terminal codes always escalate', () => {
    const terminalCodes: StandardErrorCode[] = [
      'ACCOUNT_NOT_FOUND',
      'ACCOUNT_PAYMENT_REQUIRED',
      'ACCOUNT_SUSPENDED',
      'BUDGET_EXHAUSTED',
    ];

    it.each(terminalCodes)('%s → escalate', code => {
      expect(BuyerRetryPolicy.decide(makeError(code), { attempt: 1 }).action).toBe('escalate');
    });
  });

  describe('correctable default — mutate-and-retry once', () => {
    it('PRODUCT_NOT_FOUND → mutate-and-retry', () => {
      const d = BuyerRetryPolicy.decide(makeError('PRODUCT_NOT_FOUND'), { attempt: 1 });
      expect(d.action).toBe('mutate-and-retry');
      if (d.action === 'mutate-and-retry') expect(d.maxAttempts).toBe(1);
    });

    it('PRODUCT_NOT_FOUND attempt 2 → escalate', () => {
      expect(BuyerRetryPolicy.decide(makeError('PRODUCT_NOT_FOUND'), { attempt: 2 }).action).toBe('escalate');
    });

    it('passes field from error when present', () => {
      const d = BuyerRetryPolicy.decide(makeError('VALIDATION_ERROR', { field: '/packages/0/budget' }), { attempt: 1 });
      expect(d.action).toBe('mutate-and-retry');
      if (d.action === 'mutate-and-retry') expect(d.field).toBe('/packages/0/budget');
    });
  });

  describe('instance overrides', () => {
    it('override POLICY_VIOLATION → mutate-and-retry', () => {
      const policy = new BuyerRetryPolicy({
        overrides: { POLICY_VIOLATION: { action: 'mutate-and-retry', maxAttempts: 2 } },
      });
      const d = policy.decide(makeError('POLICY_VIOLATION'), { attempt: 1 });
      expect(d.action).toBe('mutate-and-retry');
      if (d.action === 'mutate-and-retry') expect(d.maxAttempts).toBe(2);
    });

    it('override escalate with custom reason', () => {
      const policy = new BuyerRetryPolicy({
        overrides: { PRODUCT_NOT_FOUND: { action: 'escalate', reason: 'catalog out of date' } },
      });
      const d = policy.decide(makeError('PRODUCT_NOT_FOUND'), { attempt: 1 });
      expect(d.action).toBe('escalate');
      if (d.action === 'escalate') expect(d.reason).toBe('catalog out of date');
    });

    it('override retry with fixed delayMs', () => {
      const policy = new BuyerRetryPolicy({
        overrides: { RATE_LIMITED: { action: 'retry', maxAttempts: 10, delayMs: 500 } },
      });
      const d = policy.decide(makeError('RATE_LIMITED'), { attempt: 1 });
      expect(d.action).toBe('retry');
      if (d.action === 'retry') {
        expect(d.delayMs).toBe(500);
        expect(d.maxAttempts).toBe(10);
      }
    });

    it('override with custom code (unknown to SDK)', () => {
      const policy = new BuyerRetryPolicy({
        overrides: { MY_CUSTOM_ERROR: { action: 'retry', maxAttempts: 2 } },
      });
      const d = policy.decide({ code: 'MY_CUSTOM_ERROR', message: 'custom' }, { attempt: 1 });
      expect(d.action).toBe('retry');
    });
  });

  describe('static BuyerRetryPolicy.decide', () => {
    it('is equivalent to default instance', () => {
      const error = makeError('RATE_LIMITED');
      const ctx = { attempt: 1 };
      const staticResult = BuyerRetryPolicy.decide(error, ctx);
      const instanceResult = new BuyerRetryPolicy().decide(error, ctx);
      expect(staticResult).toEqual(instanceResult);
    });
  });

  describe('unknown / custom error codes', () => {
    it('unknown code with no recovery falls back to terminal → escalate', () => {
      const d = BuyerRetryPolicy.decide({ code: 'SELLER_CUSTOM_ERROR', message: 'platform-specific' }, { attempt: 1 });
      expect(d.action).toBe('escalate');
    });

    it('unknown code with explicit transient recovery → retry', () => {
      const d = BuyerRetryPolicy.decide(
        { code: 'SELLER_RATE_THROTTLED', message: 'slow down', recovery: 'transient', retryAfterMs: 2_000 },
        { attempt: 1 }
      );
      expect(d.action).toBe('retry');
      if (d.action === 'retry') expect(d.delayMs).toBe(2_000);
    });
  });
});
