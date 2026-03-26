/**
 * Tests for comply() timeout_ms and signal options.
 *
 * These test the abort/timeout plumbing without hitting real agents —
 * we verify that comply() respects AbortSignal and timeout_ms by
 * passing pre-aborted signals and short timeouts.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const { comply } = require('../../dist/lib/testing/compliance/index.js');

describe('comply() signal option', () => {
  test('rejects with AbortError when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      () => comply('https://unreachable.test/mcp', { signal: controller.signal }),
      err => {
        assert.ok(
          err.name === 'AbortError' || err.message?.includes('aborted'),
          `Expected AbortError, got: ${err.name} - ${err.message}`
        );
        return true;
      }
    );
  });

  test('rejects with custom reason when signal aborted with reason', async () => {
    const controller = new AbortController();
    controller.abort(new Error('shutdown'));

    await assert.rejects(
      () => comply('https://unreachable.test/mcp', { signal: controller.signal }),
      err => {
        assert.ok(err.message?.includes('shutdown'), `Expected shutdown reason, got: ${err.message}`);
        return true;
      }
    );
  });
});

describe('comply() timeout_ms option', () => {
  test('timeout_ms creates an abort signal that fires', async () => {
    // With an unreachable host and short timeout, the function will either:
    // - abort due to timeout (throws)
    // - return a discovery failure result (if discovery fails faster than timeout)
    // Both outcomes are valid — the key property is that it doesn't hang.
    const start = Date.now();
    try {
      const result = await comply('https://unreachable.test/mcp', { timeout_ms: 100 });
      assert.ok(result.summary, 'Should return a valid result');
    } catch (err) {
      assert.ok(err, 'Should have an error');
    }
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 30000, `Should complete promptly, took ${elapsed}ms`);
  });

  test('rejects with TypeError for timeout_ms: 0', async () => {
    await assert.rejects(
      () => comply('https://unreachable.test/mcp', { timeout_ms: 0 }),
      err => {
        assert.ok(err instanceof TypeError, `Expected TypeError, got ${err.constructor.name}`);
        assert.ok(err.message.includes('positive finite number'), err.message);
        return true;
      }
    );
  });

  test('rejects with TypeError for negative timeout_ms', async () => {
    await assert.rejects(
      () => comply('https://unreachable.test/mcp', { timeout_ms: -1 }),
      err => {
        assert.ok(err instanceof TypeError);
        return true;
      }
    );
  });

  test('rejects with TypeError for NaN timeout_ms', async () => {
    await assert.rejects(
      () => comply('https://unreachable.test/mcp', { timeout_ms: NaN }),
      err => {
        assert.ok(err instanceof TypeError);
        return true;
      }
    );
  });

  test('rejects with TypeError for Infinity timeout_ms', async () => {
    await assert.rejects(
      () => comply('https://unreachable.test/mcp', { timeout_ms: Infinity }),
      err => {
        assert.ok(err instanceof TypeError);
        return true;
      }
    );
  });
});

describe('comply() combined timeout_ms + signal', () => {
  test('signal abort takes precedence when already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('caller canceled'));

    await assert.rejects(
      () =>
        comply('https://unreachable.test/mcp', {
          timeout_ms: 60000,
          signal: controller.signal,
        }),
      err => {
        assert.ok(err.message?.includes('caller canceled'), `Expected caller reason, got: ${err.message}`);
        return true;
      }
    );
  });
});
