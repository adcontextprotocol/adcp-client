const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  generateIdempotencyKey,
  isMutatingTask,
  isValidIdempotencyKey,
  IDEMPOTENCY_KEY_PATTERN,
  MUTATING_TASKS,
  IdempotencyConflictError,
  IdempotencyExpiredError,
  isADCPError,
} = require('../../dist/lib/index.js');

describe('idempotency utilities', () => {
  describe('generateIdempotencyKey', () => {
    it('returns a spec-compliant key', () => {
      const key = generateIdempotencyKey();
      assert.ok(IDEMPOTENCY_KEY_PATTERN.test(key), `${key} should match spec pattern`);
      assert.equal(key.length, 36); // UUID v4
    });

    it('returns a unique key each call', () => {
      const set = new Set();
      for (let i = 0; i < 100; i++) set.add(generateIdempotencyKey());
      assert.equal(set.size, 100);
    });
  });

  describe('isValidIdempotencyKey', () => {
    it('accepts UUID v4', () => {
      assert.ok(isValidIdempotencyKey('a1b2c3d4-e5f6-7890-abcd-ef1234567890'));
    });

    it('accepts 16-char minimum', () => {
      assert.ok(isValidIdempotencyKey('abcdefghij123456'));
    });

    it('rejects keys under 16 chars', () => {
      assert.ok(!isValidIdempotencyKey('too-short'));
    });

    it('rejects keys over 255 chars', () => {
      assert.ok(!isValidIdempotencyKey('a'.repeat(256)));
    });

    it('rejects whitespace', () => {
      assert.ok(!isValidIdempotencyKey('has space here-1234'));
    });

    it('rejects unicode', () => {
      assert.ok(!isValidIdempotencyKey('café-abcdefghij1234'));
    });
  });

  describe('isMutatingTask', () => {
    it('returns true for known mutating tools', () => {
      assert.ok(isMutatingTask('create_media_buy'));
      assert.ok(isMutatingTask('update_media_buy'));
      assert.ok(isMutatingTask('activate_signal'));
      assert.ok(isMutatingTask('sync_accounts'));
      assert.ok(isMutatingTask('si_send_message'));
      assert.ok(isMutatingTask('log_event'));
    });

    it('returns false for read-only tools', () => {
      assert.ok(!isMutatingTask('get_products'));
      assert.ok(!isMutatingTask('get_media_buys'));
      assert.ok(!isMutatingTask('list_creatives'));
      assert.ok(!isMutatingTask('get_adcp_capabilities'));
    });

    it('excludes si_terminate_session (naturally idempotent via session_id)', () => {
      // The request schema for si_terminate_session keeps idempotency_key optional
      // per the spec; session_id provides natural dedup.
      assert.ok(!isMutatingTask('si_terminate_session'));
    });

    it('returns false for unknown tool names', () => {
      assert.ok(!isMutatingTask('made_up_tool_name'));
    });
  });

  describe('MUTATING_TASKS set', () => {
    it('includes the canonical mutating tools', () => {
      assert.ok(MUTATING_TASKS.has('create_media_buy'));
      assert.ok(MUTATING_TASKS.has('update_media_buy'));
      assert.ok(MUTATING_TASKS.has('sync_creatives'));
      assert.ok(MUTATING_TASKS.has('activate_signal'));
    });
  });
});

describe('IdempotencyConflictError', () => {
  it('extends ADCPError', () => {
    const err = new IdempotencyConflictError('abc-123');
    assert.ok(isADCPError(err));
  });

  it('carries the code and key', () => {
    const err = new IdempotencyConflictError('abc-123');
    assert.equal(err.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(err.idempotencyKey, 'abc-123');
  });

  it('has a default message pointing at recovery', () => {
    const err = new IdempotencyConflictError('abc-123');
    assert.match(err.message, /fresh UUID v4|original payload/i);
  });

  it('accepts a custom message', () => {
    const err = new IdempotencyConflictError('abc-123', 'custom');
    assert.equal(err.message, 'custom');
  });
});

describe('IdempotencyExpiredError', () => {
  it('extends ADCPError with the expected code', () => {
    const err = new IdempotencyExpiredError('abc-123');
    assert.ok(isADCPError(err));
    assert.equal(err.code, 'IDEMPOTENCY_EXPIRED');
  });

  it('default message nudges callers toward natural-key lookup', () => {
    const err = new IdempotencyExpiredError('abc-123');
    assert.match(err.message, /natural key|replay window/i);
  });
});
