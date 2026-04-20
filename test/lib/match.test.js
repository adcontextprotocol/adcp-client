/**
 * Tests for the `match()` helper on the `TaskResult` discriminated union.
 *
 * Runtime behavior only — compile-time exhaustiveness is verified by
 * `tsc` against the examples in `match.ts` JSDoc and the overload
 * signatures themselves.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { match } = require('../../dist/lib/index.js');

/** Build a minimal TaskResult-shaped object for a given status. */
function stubResult(status, overrides = {}) {
  const base = {
    metadata: {
      taskId: 't-1',
      taskName: 'create_media_buy',
      agent: { id: 'a1', name: 'Test', protocol: 'mcp' },
      responseTimeMs: 10,
      timestamp: '2026-04-20T00:00:00Z',
      clarificationRounds: 0,
      status,
    },
    status,
  };
  return { ...base, ...overrides };
}

describe('match()', () => {
  test('dispatches to the arm matching the result status', () => {
    const result = stubResult('completed', { success: true, data: { media_buy_id: 'mb-42' } });
    const rendered = match(result, {
      completed: (r) => `OK:${r.data.media_buy_id}`,
      working: () => 'working',
      submitted: () => 'submitted',
      'input-required': () => 'input',
      deferred: () => 'deferred',
      failed: () => 'failed',
      'governance-denied': () => 'denied',
    });
    assert.strictEqual(rendered, 'OK:mb-42');
  });

  test('each status arm receives the narrowed variant', () => {
    const failed = stubResult('failed', {
      success: false,
      error: 'boom',
      adcpError: { code: 'RATE_LIMITED', message: 'slow down' },
    });
    const denied = stubResult('governance-denied', { success: false, error: 'policy violation' });
    const submitted = stubResult('submitted', { success: true, submitted: { taskId: 'srv-1' } });

    const fHandlers = {
      completed: () => 'never',
      working: () => 'never',
      submitted: (r) => `sub:${r.submitted.taskId}`,
      'input-required': () => 'never',
      deferred: () => 'never',
      failed: (r) => `err:${r.adcpError.code}`,
      'governance-denied': (r) => `den:${r.error}`,
    };

    assert.strictEqual(match(failed, fHandlers), 'err:RATE_LIMITED');
    assert.strictEqual(match(denied, fHandlers), 'den:policy violation');
    assert.strictEqual(match(submitted, fHandlers), 'sub:srv-1');
  });

  test('`_` catchall handles any status when explicit arm is missing', () => {
    const result = stubResult('working', { success: true });
    const label = match(result, {
      completed: (r) => `done:${r.status}`,
      _: (r) => `other:${r.status}`,
    });
    assert.strictEqual(label, 'other:working');
  });

  test('explicit arm takes precedence over `_` catchall', () => {
    const result = stubResult('failed', { success: false, error: 'x' });
    const label = match(result, {
      failed: () => 'explicit',
      _: () => 'catchall',
    });
    assert.strictEqual(label, 'explicit');
  });

  test('throws when status has no matching arm and no `_` catchall', () => {
    const bogus = stubResult('unknown-status', { success: true });
    assert.throws(
      () => match(bogus, { completed: () => 'x', _: undefined }),
      /no handler for status "unknown-status"/
    );
  });

  test('return type is the union of handler return types (runtime check)', () => {
    const result = stubResult('completed', { success: true, data: 42 });
    const out = match(result, {
      completed: (r) => r.data,
      working: () => 'w',
      submitted: () => 'sub',
      'input-required': () => null,
      deferred: () => 0,
      failed: () => false,
      'governance-denied': () => undefined,
    });
    assert.strictEqual(out, 42);
  });
});
