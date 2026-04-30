// Tests for resolveStartTime helper.

process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { resolveStartTime } = require('../dist/lib/server/decisioning/start-time');
const { AdcpError } = require('../dist/lib/server/decisioning/async-outcome');

describe('resolveStartTime', () => {
  it("'asap' with no lead time returns now()", () => {
    const before = Date.now();
    const result = resolveStartTime('asap', {});
    const after = Date.now();
    assert.ok(result.getTime() >= before && result.getTime() <= after);
  });

  it("'asap' with asapLeadTimeMs returns now() + lead", () => {
    const lead = 2 * 86_400_000;
    const before = Date.now();
    const result = resolveStartTime('asap', { asapLeadTimeMs: lead });
    assert.ok(result.getTime() >= before + lead);
    assert.ok(result.getTime() <= before + lead + 1000);
  });

  it('undefined uses defaultLeadTimeMs (or asap lead as fallback)', () => {
    const before = Date.now();
    const r1 = resolveStartTime(undefined, { defaultLeadTimeMs: 1000 });
    assert.ok(r1.getTime() >= before + 1000);
    assert.ok(r1.getTime() <= before + 2000);

    // Falls back to asapLeadTimeMs when defaultLeadTimeMs is omitted
    const r2 = resolveStartTime(undefined, { asapLeadTimeMs: 5000 });
    assert.ok(r2.getTime() >= before + 5000);
  });

  it('valid ISO 8601 string parses to that date', () => {
    const result = resolveStartTime('2030-05-01T00:00:00Z', {});
    assert.strictEqual(result.toISOString(), '2030-05-01T00:00:00.000Z');
  });

  it('invalid ISO string throws AdcpError(INVALID_REQUEST)', () => {
    assert.throws(
      () => resolveStartTime('not-a-date', {}),
      err => {
        assert.ok(err instanceof AdcpError);
        assert.strictEqual(err.code, 'INVALID_REQUEST');
        assert.strictEqual(err.recovery, 'correctable');
        assert.match(err.message, /not a valid ISO 8601/);
        assert.strictEqual(err.field, 'start_time');
        return true;
      }
    );
  });

  it('past date with notBefore throws AdcpError(INVALID_REQUEST)', () => {
    assert.throws(
      () => resolveStartTime('2020-01-01T00:00:00Z', { notBefore: new Date() }),
      err => {
        assert.ok(err instanceof AdcpError);
        assert.strictEqual(err.code, 'INVALID_REQUEST');
        assert.match(err.message, /is in the past/);
        return true;
      }
    );
  });

  it('past date without notBefore is accepted (caller did not opt in)', () => {
    const result = resolveStartTime('2020-01-01T00:00:00Z', {});
    assert.strictEqual(result.toISOString(), '2020-01-01T00:00:00.000Z');
  });

  it('fieldName override surfaces in error message', () => {
    assert.throws(
      () => resolveStartTime('garbage', { fieldName: 'patch.start_time' }),
      err => {
        assert.strictEqual(err.field, 'patch.start_time');
        assert.match(err.message, /patch\.start_time/);
        return true;
      }
    );
  });

  it('broadcast-style usage: 2-day asap lead + notBefore guard', () => {
    const before = Date.now();
    const result = resolveStartTime('asap', {
      asapLeadTimeMs: 2 * 86_400_000,
      notBefore: new Date(),
    });
    assert.ok(result.getTime() >= before + 2 * 86_400_000);
  });

  it('programmatic-style usage: no lead, no notBefore', () => {
    const before = Date.now();
    const result = resolveStartTime('asap', {});
    assert.ok(result.getTime() <= before + 100);
  });
});
