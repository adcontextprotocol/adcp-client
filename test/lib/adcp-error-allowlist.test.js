/**
 * Tests for `adcpError()` + `ADCP_ERROR_FIELD_ALLOWLIST` interaction.
 *
 * The builder consults the per-code inside-`adcp_error` allowlist and
 * drops any field not listed for the given code. `IDEMPOTENCY_CONFLICT`
 * is the canonical strict case — `recovery`, `field`, `suggestion`, and
 * `details` all silently drop so the envelope can't become a stolen-key
 * read oracle. Codes without a registered allowlist pass through
 * unchanged (default behavior).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  adcpError,
  ADCP_ERROR_FIELD_ALLOWLIST,
  CONFLICT_ADCP_ERROR_ALLOWLIST,
} = require('../../dist/lib/server/index.js');

describe('adcpError: IDEMPOTENCY_CONFLICT allowlist', () => {
  it('drops recovery even though STANDARD_ERROR_CODES declares it "correctable"', () => {
    const res = adcpError('IDEMPOTENCY_CONFLICT', { message: 'key reused' });
    const payload = res.structuredContent.adcp_error;
    assert.equal(payload.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(payload.message, 'key reused');
    assert.ok(!('recovery' in payload), 'recovery must be dropped on conflict');
  });

  it('drops field, suggestion, details even when the caller passes them', () => {
    // A seller that copies the error path from a different code path
    // (where `field` + `suggestion` are legitimate hints) shouldn't leak
    // payload context just because the builder accepts those keys.
    const res = adcpError('IDEMPOTENCY_CONFLICT', {
      message: 'key reused',
      field: 'idempotency_key',
      suggestion: 'mint a fresh uuid',
      details: { prior_budget: 5000, prior_start: '2026-06-01T00:00:00Z' },
    });
    const payload = res.structuredContent.adcp_error;
    assert.ok(!('field' in payload), 'field must be dropped on conflict');
    assert.ok(!('suggestion' in payload), 'suggestion must be dropped on conflict');
    assert.ok(!('details' in payload), 'details must be dropped on conflict');
  });

  it('drops retry_after too (terminal code, and a seller-computed value would leak cached-entry age)', () => {
    // Retry hints belong on transient codes (SERVICE_UNAVAILABLE,
    // RATE_LIMITED). On a terminal conflict, `retry_after` is either
    // meaningless or — worse — a cached-entry-age oracle if a seller
    // computed it from the prior payload's creation time.
    const res = adcpError('IDEMPOTENCY_CONFLICT', {
      message: 'key reused',
      retry_after: 5,
    });
    assert.ok(!('retry_after' in res.structuredContent.adcp_error));
  });

  it('mirrors structured + text payloads after filtering', () => {
    // Both transport layers MUST be the same filtered object — the L3
    // structuredContent payload and the L2 JSON-text fallback.
    const res = adcpError('IDEMPOTENCY_CONFLICT', {
      message: 'key reused',
      field: 'idempotency_key',
    });
    const text = JSON.parse(res.content[0].text).adcp_error;
    assert.deepEqual(text, res.structuredContent.adcp_error);
    assert.ok(!('field' in text));
  });
});

describe('adcpError: unlisted codes pass through unchanged', () => {
  it('emits recovery + suggestion for a code NOT in ADCP_ERROR_FIELD_ALLOWLIST', () => {
    const res = adcpError('PRODUCT_NOT_FOUND', {
      message: 'no match',
      field: 'query',
      suggestion: 'broaden search',
    });
    const payload = res.structuredContent.adcp_error;
    assert.equal(payload.code, 'PRODUCT_NOT_FOUND');
    assert.equal(payload.message, 'no match');
    assert.equal(payload.field, 'query');
    assert.equal(payload.suggestion, 'broaden search');
    assert.ok(payload.recovery, 'recovery populated from STANDARD_ERROR_CODES');
  });

  it('caller-supplied recovery wins over the standard-table default (when not filtered)', () => {
    const res = adcpError('PRODUCT_NOT_FOUND', {
      message: 'no match',
      recovery: 'terminal',
    });
    assert.equal(res.structuredContent.adcp_error.recovery, 'terminal');
  });
});

describe('ADCP_ERROR_FIELD_ALLOWLIST: registered shape', () => {
  it('IDEMPOTENCY_CONFLICT entry is frozen and excludes recovery', () => {
    const conflict = ADCP_ERROR_FIELD_ALLOWLIST.IDEMPOTENCY_CONFLICT;
    assert.ok(conflict instanceof Set);
    assert.ok(!conflict.has('recovery'));
    assert.ok(conflict.has('code'));
    assert.ok(conflict.has('message'));
  });

  it('CONFLICT_ADCP_ERROR_ALLOWLIST alias is the same reference', () => {
    assert.equal(CONFLICT_ADCP_ERROR_ALLOWLIST, ADCP_ERROR_FIELD_ALLOWLIST.IDEMPOTENCY_CONFLICT);
  });
});
