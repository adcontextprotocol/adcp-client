// Wire-projection normalizer for per-row error rows (sync_creatives,
// sync_audiences, sync_accounts, report_usage, acquire_rights). Locks in
// buyer_reason forwarding on the object-shape branch so an adopter whose
// row exposes buyer_reason doesn't silently lose it before reaching the
// wire.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { normalizeError, normalizeErrors } = require('../dist/lib/server/normalize-errors');

const BUYER_REASON = {
  code: 'BUDGET_TOO_LOW',
  message: 'Your budget is below the publisher’s minimum.',
};

describe('normalizeError — buyer_reason', () => {
  it('preserves a well-formed buyer_reason from a plain object', () => {
    const out = normalizeError({
      code: 'INVALID_REQUEST',
      message: 'Bad request',
      recovery: 'correctable',
      buyer_reason: BUYER_REASON,
    });
    assert.deepEqual(out.buyer_reason, BUYER_REASON);
    assert.equal(out.code, 'INVALID_REQUEST');
    assert.equal(out.recovery, 'correctable');
  });

  it('preserves buyer_reason from an AdcpError instance', () => {
    const { AdcpError } = require('../dist/lib/server/decisioning/async-outcome');
    const err = new AdcpError('CREATIVE_REJECTED', {
      recovery: 'correctable',
      message: 'Creative rejected',
      buyer_reason: {
        code: 'CREATIVE_REJECTED',
        message: 'Please supply a creative that meets the publisher policy.',
      },
    });
    const out = normalizeError(err);
    assert.equal(out.buyer_reason.code, 'CREATIVE_REJECTED');
    assert.match(out.buyer_reason.message, /publisher policy/);
  });

  it('drops buyer_reason missing message (half-formed payloads never reach the wire)', () => {
    const out = normalizeError({
      code: 'INVALID_REQUEST',
      message: 'Bad',
      buyer_reason: { code: 'BUDGET_TOO_LOW' },
    });
    assert.equal(out.buyer_reason, undefined);
  });

  it('drops buyer_reason with empty-string code/message', () => {
    const out = normalizeError({
      code: 'INVALID_REQUEST',
      message: 'Bad',
      buyer_reason: { code: '', message: '' },
    });
    assert.equal(out.buyer_reason, undefined);
  });

  it('drops non-object buyer_reason', () => {
    const out = normalizeError({
      code: 'INVALID_REQUEST',
      message: 'Bad',
      buyer_reason: 'not an object',
    });
    assert.equal(out.buyer_reason, undefined);
  });

  it('leaves buyer_reason absent when the input does not carry it', () => {
    const out = normalizeError({ code: 'RATE_LIMITED', message: 'slow', recovery: 'transient' });
    assert.equal(out.buyer_reason, undefined);
  });

  it('normalizeErrors forwards buyer_reason on every entry', () => {
    const rows = normalizeErrors([
      { code: 'A', message: 'a', buyer_reason: BUYER_REASON },
      { code: 'B', message: 'b' },
      { code: 'C', message: 'c', buyer_reason: { code: 'X', message: 'y' } },
    ]);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[0].buyer_reason, BUYER_REASON);
    assert.equal(rows[1].buyer_reason, undefined);
    assert.deepEqual(rows[2].buyer_reason, { code: 'X', message: 'y' });
  });
});
