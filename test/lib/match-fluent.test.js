/**
 * Tests for the fluent `result.match({...})` method form on TaskResult.
 *
 * The free function `match(result, handlers)` is covered by `match.test.js`.
 * These tests verify that the method form (attached by `attachMatch`) behaves
 * identically and is present on results returned from the client.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { match, attachMatch } = require('../../dist/lib/index.js');

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

describe('result.match() fluent method', () => {
  test('dispatches to the completed arm', () => {
    const result = attachMatch(stubResult('completed', { success: true, data: { media_buy_id: 'mb-42' } }));
    const rendered = result.match({
      completed: r => `OK:${r.data.media_buy_id}`,
      working: () => 'working',
      submitted: () => 'submitted',
      'input-required': () => 'input',
      deferred: () => 'deferred',
      failed: () => 'failed',
      'governance-denied': () => 'denied',
    });
    assert.strictEqual(rendered, 'OK:mb-42');
  });

  test('dispatches to the failed arm', () => {
    const result = attachMatch(
      stubResult('failed', {
        success: false,
        error: 'boom',
        adcpError: { code: 'RATE_LIMITED', message: 'slow down' },
      })
    );
    const rendered = result.match({
      completed: () => 'never',
      working: () => 'never',
      submitted: () => 'never',
      'input-required': () => 'never',
      deferred: () => 'never',
      failed: r => `err:${r.adcpError.code}`,
      'governance-denied': () => 'never',
    });
    assert.strictEqual(rendered, 'err:RATE_LIMITED');
  });

  test('dispatches to the working arm', () => {
    const result = attachMatch(stubResult('working', { success: true }));
    const label = result.match({
      completed: () => 'never',
      working: r => `wrk:${r.status}`,
      submitted: () => 'never',
      'input-required': () => 'never',
      deferred: () => 'never',
      failed: () => 'never',
      'governance-denied': () => 'never',
    });
    assert.strictEqual(label, 'wrk:working');
  });

  test('dispatches to the submitted arm', () => {
    const result = attachMatch(stubResult('submitted', { success: true, submitted: { taskId: 'srv-9' } }));
    const label = result.match({
      completed: () => 'never',
      working: () => 'never',
      submitted: r => `sub:${r.submitted.taskId}`,
      'input-required': () => 'never',
      deferred: () => 'never',
      failed: () => 'never',
      'governance-denied': () => 'never',
    });
    assert.strictEqual(label, 'sub:srv-9');
  });

  test('dispatches to the input-required arm', () => {
    const result = attachMatch(stubResult('input-required', { success: true }));
    const label = result.match({
      completed: () => 'never',
      working: () => 'never',
      submitted: () => 'never',
      'input-required': r => `input:${r.status}`,
      deferred: () => 'never',
      failed: () => 'never',
      'governance-denied': () => 'never',
    });
    assert.strictEqual(label, 'input:input-required');
  });

  test('dispatches to the deferred arm', () => {
    const result = attachMatch(stubResult('deferred', { success: true, deferred: { token: 'def-tok' } }));
    const label = result.match({
      completed: () => 'never',
      working: () => 'never',
      submitted: () => 'never',
      'input-required': () => 'never',
      deferred: r => `def:${r.deferred.token}`,
      failed: () => 'never',
      'governance-denied': () => 'never',
    });
    assert.strictEqual(label, 'def:def-tok');
  });

  test('dispatches to the governance-denied arm', () => {
    const result = attachMatch(stubResult('governance-denied', { success: false, error: 'policy violation' }));
    const label = result.match({
      completed: () => 'never',
      working: () => 'never',
      submitted: () => 'never',
      'input-required': () => 'never',
      deferred: () => 'never',
      failed: () => 'never',
      'governance-denied': r => `den:${r.error}`,
    });
    assert.strictEqual(label, 'den:policy violation');
  });

  test('`_` catchall handles any status when explicit arm is missing', () => {
    const result = attachMatch(stubResult('working', { success: true }));
    const label = result.match({
      completed: r => `done:${r.status}`,
      _: r => `other:${r.status}`,
    });
    assert.strictEqual(label, 'other:working');
  });

  test('fluent form returns identical results to the free function', () => {
    const statuses = [
      ['completed', { success: true, data: { media_buy_id: 'x' } }],
      ['failed', { success: false, error: 'nope' }],
      ['working', { success: true }],
      ['submitted', { success: true, submitted: { taskId: 's' } }],
      ['input-required', { success: true }],
      ['deferred', { success: true, deferred: { token: 'd' } }],
      ['governance-denied', { success: false, error: 'policy' }],
    ];
    const handlers = {
      completed: r => `c:${r.status}`,
      failed: r => `f:${r.status}`,
      working: r => `w:${r.status}`,
      submitted: r => `s:${r.status}`,
      'input-required': r => `i:${r.status}`,
      deferred: r => `d:${r.status}`,
      'governance-denied': r => `g:${r.status}`,
    };

    for (const [status, overrides] of statuses) {
      const plain = stubResult(status, overrides);
      const decorated = attachMatch(stubResult(status, overrides));
      assert.strictEqual(
        decorated.match(handlers),
        match(plain, handlers),
        `fluent and free-function results should agree for status "${status}"`
      );
    }
  });

  test('attachMatch is idempotent — repeated calls keep the same method', () => {
    const result = attachMatch(stubResult('completed', { success: true, data: 1 }));
    const methodBefore = result.match;
    const reDecorated = attachMatch(result);
    assert.strictEqual(reDecorated, result, 'attachMatch should return the same object');
    assert.strictEqual(reDecorated.match, methodBefore, 'match method reference should be unchanged');
  });

  test('match method is non-enumerable and does not affect JSON.stringify', () => {
    const result = attachMatch(stubResult('completed', { success: true, data: { id: 'x' } }));
    const keys = Object.keys(result);
    assert.ok(!keys.includes('match'), 'match should not appear in Object.keys');
    const serialized = JSON.parse(JSON.stringify(result));
    assert.ok(!('match' in serialized), 'match should not appear in JSON output');
    assert.strictEqual(serialized.status, 'completed');
  });
});
