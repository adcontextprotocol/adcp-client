const { describe, it } = require('node:test');
const assert = require('node:assert');
const { runValidations } = require('../../dist/lib/testing/storyboard/validations');
const {
  validateParallelDispatchSpec,
  runParallelDispatches,
  dispatchOnceWithInflightRetry,
  PARALLEL_DISPATCH_DEFAULT_BARRIER_MS,
} = require('../../dist/lib/testing/storyboard/parallel-dispatch');

const baseCtx = {
  taskName: 'create_media_buy',
  agentUrl: 'https://example.com/mcp',
  contributions: new Set(),
};

describe('validateParallelDispatchSpec', () => {
  it('accepts a well-formed spec', () => {
    assert.strictEqual(
      validateParallelDispatchSpec({ count: 2, same_idempotency_key: true, barrier_timeout_ms: 5000 }),
      null
    );
  });

  it('rejects non-integer count', () => {
    const err = validateParallelDispatchSpec({ count: 2.5 });
    assert.ok(err && err.includes('must be an integer'));
  });

  it('rejects count below the spec minimum', () => {
    const err = validateParallelDispatchSpec({ count: 1 });
    assert.ok(err && err.includes('must be in [2, 10]'));
  });

  it('rejects count above the spec maximum', () => {
    const err = validateParallelDispatchSpec({ count: 11 });
    assert.ok(err && err.includes('must be in [2, 10]'));
  });

  it('rejects a non-positive barrier_timeout_ms', () => {
    const err = validateParallelDispatchSpec({ count: 2, barrier_timeout_ms: 0 });
    assert.ok(err && err.includes('barrier_timeout_ms'));
  });

  it('rejects an unknown mode', () => {
    const err = validateParallelDispatchSpec({ count: 2, mode: 'multi_process' });
    assert.ok(err && err.includes('mode must be'));
  });
});

describe('cross_response_field_equal', () => {
  function check(description = 'all dispatches return the same media_buy_id') {
    return { check: 'cross_response_field_equal', path: 'media_buy_id', description };
  }

  it('grades not_applicable on a single-dispatch step (no crossResponses)', () => {
    const [r] = runValidations([check()], baseCtx);
    assert.strictEqual(r.passed, true);
    assert.strictEqual(r.not_applicable, true);
  });

  it('passes when every resolved dispatch carries the same value at the path', () => {
    const crossResponses = {
      dispatches: [
        { correlation_id: 'a', duration_ms: 10, taskResult: { success: true, data: { media_buy_id: 'mb_1' } } },
        { correlation_id: 'b', duration_ms: 12, taskResult: { success: true, data: { media_buy_id: 'mb_1' } } },
      ],
      resolved: [
        { success: true, data: { media_buy_id: 'mb_1' } },
        { success: true, data: { media_buy_id: 'mb_1' } },
      ],
    };
    const [r] = runValidations([check()], { ...baseCtx, crossResponses });
    assert.strictEqual(r.passed, true);
    assert.strictEqual(r.actual, 'mb_1');
  });

  it('fails when resolved dispatches disagree', () => {
    const crossResponses = {
      dispatches: [
        { correlation_id: 'a', duration_ms: 10, taskResult: { success: true, data: { media_buy_id: 'mb_1' } } },
        { correlation_id: 'b', duration_ms: 12, taskResult: { success: true, data: { media_buy_id: 'mb_2' } } },
      ],
      resolved: [
        { success: true, data: { media_buy_id: 'mb_1' } },
        { success: true, data: { media_buy_id: 'mb_2' } },
      ],
    };
    const [r] = runValidations([check()], { ...baseCtx, crossResponses });
    assert.strictEqual(r.passed, false);
    assert.deepStrictEqual(r.actual, ['mb_1', 'mb_2']);
  });

  it('fails when fewer than 2 dispatches resolved', () => {
    const crossResponses = {
      dispatches: [
        { correlation_id: 'a', duration_ms: 10, taskResult: { success: true, data: { media_buy_id: 'mb_1' } } },
        { correlation_id: 'b', duration_ms: 12, timed_out: true },
      ],
      resolved: [{ success: true, data: { media_buy_id: 'mb_1' } }],
    };
    const [r] = runValidations([check()], { ...baseCtx, crossResponses });
    assert.strictEqual(r.passed, false);
    assert.ok(String(r.actual).includes('1 dispatch'));
  });
});

describe('cross_response_count_distinct', () => {
  function check(allowed_values = [1]) {
    return {
      check: 'cross_response_count_distinct',
      path: 'media_buy_id',
      allowed_values,
      description: 'exactly one resource created',
    };
  }

  it('grades not_applicable when crossResponses is absent', () => {
    const [r] = runValidations([check()], baseCtx);
    assert.strictEqual(r.passed, true);
    assert.strictEqual(r.not_applicable, true);
  });

  it('passes when the distinct count is in allowed_values', () => {
    const crossResponses = {
      dispatches: [
        { correlation_id: 'a', duration_ms: 10, taskResult: { success: true, data: { media_buy_id: 'mb_1' } } },
        { correlation_id: 'b', duration_ms: 12, taskResult: { success: true, data: { media_buy_id: 'mb_1' } } },
      ],
      resolved: [
        { success: true, data: { media_buy_id: 'mb_1' } },
        { success: true, data: { media_buy_id: 'mb_1' } },
      ],
    };
    const [r] = runValidations([check([1])], { ...baseCtx, crossResponses });
    assert.strictEqual(r.passed, true);
    assert.strictEqual(r.actual, 1);
  });

  it('fails when two resources were created (race not resolved)', () => {
    const crossResponses = {
      dispatches: [
        { correlation_id: 'a', duration_ms: 10, taskResult: { success: true, data: { media_buy_id: 'mb_1' } } },
        { correlation_id: 'b', duration_ms: 12, taskResult: { success: true, data: { media_buy_id: 'mb_2' } } },
      ],
      resolved: [
        { success: true, data: { media_buy_id: 'mb_1' } },
        { success: true, data: { media_buy_id: 'mb_2' } },
      ],
    };
    const [r] = runValidations([check([1])], { ...baseCtx, crossResponses });
    assert.strictEqual(r.passed, false);
    assert.strictEqual(r.actual, 2);
  });

  it('fails when no dispatch resolved successfully', () => {
    const crossResponses = {
      dispatches: [
        { correlation_id: 'a', duration_ms: 10, timed_out: true },
        { correlation_id: 'b', duration_ms: 12, timed_out: true },
      ],
      resolved: [],
    };
    const [r] = runValidations([check([1])], { ...baseCtx, crossResponses });
    assert.strictEqual(r.passed, false);
  });

  it('fails when allowed_values is missing (authoring error)', () => {
    const [r] = runValidations(
      [{ check: 'cross_response_count_distinct', path: 'media_buy_id', description: 'missing allowed_values' }],
      {
        ...baseCtx,
        crossResponses: {
          dispatches: [
            { correlation_id: 'a', duration_ms: 10, taskResult: { success: true, data: { media_buy_id: 'mb_1' } } },
          ],
          resolved: [{ success: true, data: { media_buy_id: 'mb_1' } }],
        },
      }
    );
    assert.strictEqual(r.passed, false);
    assert.ok(String(r.expected).includes('allowed_values'));
  });
});

describe('runParallelDispatches (process_local)', () => {
  function makeStubClient(handler) {
    // executeStoryboardTask falls back to client.executeTask for unmapped task
    // names. Stub that path so the runner can drive arbitrary fake tasks.
    return { executeTask: handler };
  }

  it('fires N concurrent dispatches and collects them in fan-out order', async () => {
    let calls = 0;
    const client = makeStubClient(async () => {
      calls++;
      return { success: true, data: { media_buy_id: 'mb_only', call: calls } };
    });
    const cr = await runParallelDispatches(
      client,
      'fake_task',
      { idempotency_key: 'k1' },
      {
        spec: { count: 3, same_idempotency_key: true },
        keyMinter: () => 'should_not_be_called',
        correlationPrefix: 'step_x',
      }
    );
    assert.strictEqual(cr.dispatches.length, 3);
    assert.strictEqual(cr.resolved.length, 3);
    assert.strictEqual(calls, 3);
    assert.deepStrictEqual(
      cr.dispatches.map(d => d.correlation_id),
      ['step_x#0', 'step_x#1', 'step_x#2']
    );
  });

  it('retries IDEMPOTENCY_IN_FLIGHT with the same idempotency_key until terminal', async () => {
    let attempt = 0;
    const seenKeys = new Set();
    const client = makeStubClient(async (taskName, params) => {
      seenKeys.add(params.idempotency_key);
      attempt++;
      if (attempt < 3) {
        return {
          success: false,
          data: { adcp_error: { code: 'IDEMPOTENCY_IN_FLIGHT', message: 'wait', retry_after: 0.06 } },
        };
      }
      return { success: true, data: { media_buy_id: 'mb_winner' } };
    });
    const cr = await runParallelDispatches(
      client,
      'fake_task',
      { idempotency_key: 'shared_key', context: { correlation_id: 'will_be_overridden' } },
      {
        spec: { count: 2, same_idempotency_key: true, barrier_timeout_ms: 5000 },
        keyMinter: () => 'should_not_be_called',
        correlationPrefix: 'concurrent_retry',
      }
    );
    // All dispatches see the same key — that's the contract.
    assert.strictEqual(seenKeys.size, 1);
    assert.ok(seenKeys.has('shared_key'));
    // The retrying dispatch eventually terminates with the success body.
    const resolvedIds = cr.resolved.map(r => r.data.media_buy_id);
    assert.ok(resolvedIds.length >= 1);
    assert.ok(resolvedIds.every(id => id === 'mb_winner'));
  });

  it('mints distinct idempotency_keys when same_idempotency_key is false', async () => {
    const seenKeys = new Set();
    const client = makeStubClient(async (taskName, params) => {
      seenKeys.add(params.idempotency_key);
      return { success: true, data: { media_buy_id: `mb_${params.idempotency_key}` } };
    });
    let counter = 0;
    const cr = await runParallelDispatches(
      client,
      'fake_task',
      { idempotency_key: 'base_key' },
      {
        spec: { count: 3, same_idempotency_key: false },
        keyMinter: () => `minted_${counter++}`,
        correlationPrefix: 'soak',
      }
    );
    assert.strictEqual(cr.dispatches.length, 3);
    assert.strictEqual(seenKeys.size, 3);
    assert.ok([...seenKeys].every(k => k.startsWith('minted_')));
  });

  it('honors barrier_timeout_ms and marks lagging dispatches timed_out', async () => {
    const client = makeStubClient(async () => {
      await new Promise(r => setTimeout(r, 200));
      return { success: true, data: { media_buy_id: 'mb_slow' } };
    });
    const cr = await runParallelDispatches(
      client,
      'fake_task',
      { idempotency_key: 'shared' },
      {
        spec: { count: 2, same_idempotency_key: true, barrier_timeout_ms: 50 },
        keyMinter: () => 'unused',
        correlationPrefix: 'slow',
      }
    );
    assert.strictEqual(cr.dispatches.length, 2);
    assert.ok(cr.dispatches.every(d => d.timed_out === true));
    assert.strictEqual(cr.resolved.length, 0);
  });
});

describe('dispatchOnceWithInflightRetry', () => {
  it('returns the success TaskResult on first try when seller terminates cleanly', async () => {
    const client = {
      executeTask: async () => ({ success: true, data: { media_buy_id: 'mb_x' } }),
    };
    const out = await dispatchOnceWithInflightRetry(
      client,
      'fake_task',
      { idempotency_key: 'k' },
      {
        deadlineMs: Date.now() + 5000,
      }
    );
    assert.strictEqual(out.taskResult.success, true);
  });

  it('returns immediately on a terminal non-in-flight error', async () => {
    let calls = 0;
    const client = {
      executeTask: async () => {
        calls++;
        return { success: false, data: { adcp_error: { code: 'IDEMPOTENCY_CONFLICT', message: 'no' } } };
      },
    };
    const out = await dispatchOnceWithInflightRetry(
      client,
      'fake_task',
      { idempotency_key: 'k' },
      {
        deadlineMs: Date.now() + 5000,
      }
    );
    assert.strictEqual(out.taskResult.success, false);
    assert.strictEqual(out.taskResult.data.adcp_error.code, 'IDEMPOTENCY_CONFLICT');
    assert.strictEqual(calls, 1);
  });

  it('treats SERVICE_UNAVAILABLE as an in-flight signal for legacy SDKs', async () => {
    let calls = 0;
    const client = {
      executeTask: async () => {
        calls++;
        if (calls === 1) {
          return {
            success: false,
            data: { adcp_error: { code: 'SERVICE_UNAVAILABLE', retry_after: 0.05 } },
          };
        }
        return { success: true, data: { media_buy_id: 'mb_legacy' } };
      },
    };
    const out = await dispatchOnceWithInflightRetry(
      client,
      'fake_task',
      { idempotency_key: 'k' },
      {
        deadlineMs: Date.now() + 5000,
      }
    );
    assert.strictEqual(out.taskResult.success, true);
    assert.strictEqual(calls, 2);
  });

  it('stops retrying when the deadline passes and returns the last in-flight error', async () => {
    const client = {
      executeTask: async () => ({
        success: false,
        data: { adcp_error: { code: 'IDEMPOTENCY_IN_FLIGHT', retry_after: 0.05 } },
      }),
    };
    const deadlineMs = Date.now() + 120;
    const out = await dispatchOnceWithInflightRetry(client, 'fake_task', { idempotency_key: 'k' }, { deadlineMs });
    assert.strictEqual(out.taskResult.success, false);
    assert.strictEqual(out.taskResult.data.adcp_error.code, 'IDEMPOTENCY_IN_FLIGHT');
  });
});

describe('default barrier timeout', () => {
  it('exports a 5s default per the contract YAML', () => {
    assert.strictEqual(PARALLEL_DISPATCH_DEFAULT_BARRIER_MS, 5000);
  });
});
